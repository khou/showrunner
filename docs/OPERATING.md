# showrunner: operating guide

Everything past the [README](../README.md) quickstart: every client's setup,
the callboard tour, shared notes, env knobs, the CLI, verifying a
deployment, FAQ, and the security tradeoff. See [DESIGN.md](../DESIGN.md)
for why it's built this way.

## Connecting each client

| Client | How | Notes |
|---|---|---|
| Claude Code local | `claude mcp add --transport http showrunner <url>/mcp --header "Authorization: Bearer $SHOWRUNNER_TOKEN"` (user scope), or a committed `.mcp.json` with `${SHOWRUNNER_TOKEN}` | v2.1.2xx+; the 25s poll needs no timeout tuning |
| Claude Code cloud | commit `.mcp.json` (see below) + set `SHOWRUNNER_TOKEN` as an env var in the cloud environment + add the server's host to the network allowlist | no browser OAuth in cloud sessions, bearer token only |
| Cursor local | `.cursor/mcp.json` with `url` + `headers: {"Authorization": "Bearer ${env:SHOWRUNNER_TOKEN}"}` | 3.0+ required; allowlist/auto-run the showrunner tools or the poll loop stalls on approval prompts |
| Cursor cloud | paste URL + a **hardcoded** token into the cursor.com/agents dashboard MCP config | best-effort: env interpolation and repo-committed config are both broken there as of 3.8 |

Committed `.mcp.json` (Claude Code, local and cloud):

```json
{
  "mcpServers": {
    "showrunner": {
      "type": "http",
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": { "Authorization": "Bearer ${SHOWRUNNER_TOKEN}" }
    }
  }
}
```

`.cursor/mcp.json` (Cursor local):

```json
{
  "mcpServers": {
    "showrunner": {
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": { "Authorization": "Bearer ${env:SHOWRUNNER_TOKEN}" }
    }
  }
}
```

Working examples with a placeholder URL are in [examples/](../examples/). Or,
from a clone of this repo, run `node dist/cli/index.js snippets --url <your-url>`
(after `npm install && npm run build`) to get all of the above with your URL
already filled in.

## Direction and takeover

There's one director per show, held as a lease, not tied to any session.

- First session to say `claim_direction` becomes director.
- The human is the only one who can force a takeover: "you're now the
  director" calls `claim_direction(takeover: true)`, which always wins.
- No auto-promotion. If the director's session dies, the show runs headless:
  workers keep draining the queue, the callboard shows "no director", and
  nothing self-appoints. You decide who directs next.
- Old director sessions find out they've been superseded the next time they
  call a director-only tool: the server returns a structured `superseded`
  error naming the new holder. That's the whole handoff protocol, no gossip
  between agents required.

## The callboard

A static page at your server's root (`https://<your-app>.fly.dev/`), polling
every 2s. Open it once via the setup magic link or `showrunner open` (stores
the bearer token in localStorage and strips it from the URL). Without a token
the page shows a clear sign-in empty state — not a fake empty board. Deep-link
a show with `?show=<name>` (also accepted on the magic link). It's
deliberately a **window, not a control panel**: no task forms, no message
box, no admin actions. You steer by talking to the director agent in its
own chat -- that's what the chat link opens -- and the director translates
intent into tasks. Manual escape hatches live in the CLI (below), which
drives the same `/api` the callboard reads. Shows:

- **Director card**: who, epoch, lease freshness, last digest note, and
  the chat link -- a self-reported `session_url` renders as a prominent
  "open chat ↗", a `resume_hint` (no `session_url`) as click-to-copy code,
  neither as a dim "no chat link reported".
- **Members**: kind (claude-local, cursor-cloud, ...), role, current task,
  a staleness dot, and a small ↗ when the member reported a `session_url`.
- **Task columns**: queued / in-flight / needs-input / done+failed. Click a
  task to expand its journal. If tasks are queued and no non-stale workers
  are registered, a banner asks you to open a worker session.
- **Notes panel**: the last 10 shared notes, newest first (author, tags,
  trimmed body, age).
- **Activity feed**: last 50 journal entries and messages.
- **Red escalation banner**: any `input-required` task, or any message
  addressed to `human`. This is the thing you actually watch for.

## Showrunner rules

`SHOWRUNNER.rules.md` (scaffolded by `init`) holds user-editable fleet
defaults: open PR / squash-merge when green / verify-is-done, optional soft
dedicated-worker preferences, and project standing rules. The director
propagates them; workers re-read on claim. Playbook (`SHOWRUNNER.md`) stays
about decomposing *this* project. Sessions may fan out subagents freely.

## How it works

- The show name a session joins resolves in priority order: user-named in
  the prompt, else a committed one-line `.showrunner` file at the repo root,
  else the git origin basename, else the directory name. Registering a NEW
  show whose name looks like a checkout of an existing one (`mygame-w2`,
  `mygame-copy`) returns `similar_existing_shows` plus a warning, and the
  protocol tells the agent to re-register on the existing show. Multi-checkout
  and worktree setups should commit `.showrunner` to make this a non-issue.
- State is one SQLite file (`better-sqlite3`, WAL) on a Fly volume. Nothing
  else is stateful.
- Every claim is a lease with a TTL: worker liveness, task ownership,
  direction. A background sweep (every `SWEEP_INTERVAL_S`) expires stale
  leases and requeues their tasks; nothing is trusted to say goodbye.
- Director-only calls carry an `epoch` integer; the server bumps it on every
  claim and rejects stale epochs. That's the entire fencing mechanism.
- Workers can't receive pushes (cloud sessions are outbound-only), so
  `await_work` is a long-poll: it blocks up to `POLL_HOLD_SECONDS` (default
  25, chosen to clear Cursor/Fly/Claude Code's independent ~60s connection
  walls) and the worker re-polls immediately after.
- Polls return unread-only messages and pointer-style task briefs, not
  inlined specs, to keep the coordination overhead in tokens small.
- `register({show, kind, display_name?, session_url?, resume_hint?})` --
  `session_url`/`resume_hint` are how a human opens this session's chat; only
  the session itself knows which, so it self-reports (a `session_url` must
  parse as an http(s) URL). The callboard renders whichever it gets.
- `update_task` heartbeats also drain a worker's unread-message inbox (the
  same one `await_work` drains), included in the result only when non-empty,
  so a heads-down worker hears notes and answers on its ~10min heartbeat
  instead of only at its next `await_work`.
- Agents share a realtime notes journal (gotchas, decisions): pushed to
  related live members on save, recalled at task-claim time, and
  searchable -- see Shared notes below.

## Shared notes (realtime memory)

Agents working in parallel learn things the others need now, not on their
next manual search. Notes are append-only, FTS5-indexed, and reach other
agents through the machinery that already exists:

- `save_note({member_id, body, tags?, files_hint?, task_id?})` -- pushes a
  `kind:"note"` message to any non-author member whose *current, still
  in-flight* task overlaps: same task, same `context_id`, or a `files_hint`
  glob in common -- including a heads-down worker whose member lease has
  gone stale (it only renews every ~10min while working). Delivered on that
  member's next `await_work`; a member with a fresh lease also gets an
  immediate wake. Push criteria are structural on purpose (globs, task,
  context, never fuzzy text match) so pushes stay rare enough that agents
  don't learn to ignore them.
- Claiming a task (`await_work`) attaches `relevant_notes`: up to
  `NOTES_PER_TASK` notes, `files_hint` glob-overlap hits first (the
  structural signal, ranked ahead of fuzzy text), then BM25 over the task's
  title+brief filling whatever's left. Bodies are trimmed to ~300 chars with
  a truncation marker when cut -- there's no fetch-by-id, note ids aren't
  indexed for search; recover the full body with `search_notes` on
  distinctive words from the visible prefix. Knowledge from one worker
  reaches another exactly when it starts related work, unprompted.
- `search_notes({member_id, query, limit?})` -- BM25-ranked search, full
  (untrimmed) bodies, compact hit shape, for anything the push/recall above
  didn't catch. `limit` is capped server-side regardless of what's asked for.

Notes are never edited or deleted; corrections are new notes. Bodies are
capped at `NOTE_MAX_CHARS`. The protocol tells workers to read
`relevant_notes` before starting a task and save one after finishing if they
learned something the next agent would want; directors record generalizable
decisions (especially answers to `input-required`) as notes.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `SHOWRUNNER_TOKEN` | *(required)* | Bearer token gating `/mcp` and `/api`. Server refuses to start without it. |
| `PORT` | `8080` | HTTP port. |
| `DATA_DIR` | `/data` | Where the SQLite file lives. |
| `POLL_HOLD_SECONDS` | `25` | Max long-poll hold for `await_work`. |
| `WORKER_LEASE_S` | `90` | Member liveness lease; renewed by any tool call. |
| `TASK_LEASE_S` | `900` | Task ownership lease; renewed by `update_task`. |
| `DIRECTION_LEASE_S` | `600` | Director lease; renewed by any director tool call. |
| `SWEEP_INTERVAL_S` | `5` | How often the reclaim sweep runs. |
| `NOTE_MAX_CHARS` | `2000` | Max shared-note body length. |
| `NOTES_PER_TASK` | `4` | Max `relevant_notes` attached at task claim time. |

## CLI

This package isn't published to npm (the name `showrunner` is already taken
by an unrelated app, and this is a single-person tool, not a public package),
so it's `node dist/cli/index.js <command>` from a clone, not `npx showrunner`.
Build once (`npm install && npm run build`), then optionally alias it:

```bash
alias showrunner="node $(pwd)/dist/cli/index.js"
```

Reading `SHOWRUNNER_URL` / `SHOWRUNNER_TOKEN` from the environment (or
`--url` / `--token` flags):

```
showrunner status [--show <name>]
showrunner task add --show <name> --title <t> --brief <b> [--priority <n>] [--assignee <id>] ...
showrunner task cancel --show <name> --id <task-id>
showrunner message --show <name> --to <member-id|director|all|human> --body <text>
showrunner direction clear --show <name>
showrunner show delete --show <name>        # removes the show and everything under it
showrunner init --show <name> [--url <url>] # .showrunner, SHOWRUNNER.md, SHOWRUNNER.rules.md, mcp configs
showrunner open [--show <name>] [--print]  # callboard magic link (?token=…&show=…)
showrunner instructions
showrunner snippets [--url <url>]
```

`init` sets a repo up as a show: it writes `.showrunner` (the name pin),
`SHOWRUNNER.md` (the show playbook: how the director should decompose work
for THIS project, area/file map, conventions, escalation rules; the director
protocol reads it right after `claim_direction` and it overrides the generic
defaults), `SHOWRUNNER.rules.md` (fleet automation/role defaults; user-editable),
and `.mcp.json` / `.cursor/mcp.json` pointed at your server.
Fill in the playbook, tweak rules, commit, and every clone, worktree, and
cloud checkout gets the same show name and direction rules.

`open` builds the callboard `?token=` handshake URL (optionally `&show=`) from
env/`~` context and opens it in the browser (`--print` to stdout only).

This is a human convenience over `/api`, not something agents call. Agents
talk MCP.

## Verifying a deployment

`scripts/live-verify.mts` drives the full lifecycle against a real deployment
with the real MCP SDK client: register, claim direction, create task, worker
claims and completes, director reviews, mid-poll wake latency, shared notes
(push on save + claim-time recall + search), takeover and stale-epoch
fencing, callboard, auth rejection.

```bash
SR_URL=https://<your-app>.fly.dev SR_TOKEN=<token> npx tsx scripts/live-verify.mts
```

It creates a throwaway `verify-*` show; safe to run against a server in use.

## FAQ

**The director's session dies mid-run. What happens?**
Nothing is lost. Tasks, journals, and messages are all on the server. Workers
keep pulling from the queue. The callboard marks the director card stale once
its 10-minute lease lapses (or run `showrunner direction clear --show <name>`
to force "no director" immediately, e.g. to stop a runaway director without
waiting out the lease). Say "you're the director" to any session and it calls
`claim_direction(takeover: true)` and resumes with full board state -- a
normal `claim_direction` (no takeover) works too once the lease has actually
expired.

**The server restarts (e.g. `fly deploy`)?**
No tasks lost, state is in SQLite on the volume. Workers notice their next
poll fails, retry, and reconnect once the new machine is up. In-flight leases
just expire and requeue like any other stall.

**A worker goes silent (crashed, context ran out, laptop closed)?**
Its worker lease expires (`WORKER_LEASE_S`), the callboard marks it stale,
and any task it held requeues with `attempt` bumped once its task lease
(`TASK_LEASE_S`) also expires. Nobody has to notice and reassign by hand.

**Token cost discipline?**
`await_work` returns unread-only; `get_board` is a ~300-token summary unless
you ask for `verbose`. Keep task briefs as pointers into the repo ("see
docs/combat.md §3"), not inlined specs. Cheaper, and it also keeps secrets
out of the server.

**Why is Cursor cloud "best-effort"?**
Cursor's cloud dashboard doesn't read MCP config from the repo and doesn't
support `${env:...}` interpolation there as of 3.8, so you paste a hardcoded
token into their UI. It works, but it's outside what the repo-committed
config controls, and it'll need re-pasting if Cursor changes that surface
again.

## Security posture

One shared bearer token gates everything. Anyone with it can read and write
every show on the deployment. That's the intended tradeoff for one person
running several sessions. Rotate it with `fly secrets set SHOWRUNNER_TOKEN=...`
if it leaks. No per-member tokens or per-show ACLs in v1. The server holds
task titles/briefs, journals, and notes -- keep secrets out of them, point at
repo files instead (which also saves tokens).
