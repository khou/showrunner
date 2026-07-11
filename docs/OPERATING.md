# showrunner: operating guide

Everything past the [README](../README.md) quickstart: every client's setup,
the callboard tour, shared notes, env knobs, the CLI, verifying a
deployment, FAQ, and the security tradeoff. See [DESIGN.md](../DESIGN.md)
for why it's built this way.

## Connecting each client

| Client | How | Notes |
|---|---|---|
| Claude Code local/cloud | committed `.mcp.json` from `init`: hardcoded worker Bearer on `showrunner`; `${SHOWRUNNER_TOKEN}` on `showrunner-director` | workers need no env; director sessions set director token + allowlist host |
| Cursor local | `.cursor/mcp.json` same split (`${env:SHOWRUNNER_TOKEN}` for director) | 3.0+; allowlist/auto-run tools or poll stalls |
| Cursor cloud | Cloud Agents do **not** load repo `.mcp.json`/`.cursor/mcp.json`: add the showrunner HTTP MCP (URL + **worker** token) in the Cursor Cloud Agents / Integrations dashboard so `await_work` is a native tool | best-effort as of 3.8; shell-capable sessions can drive the `/v1` HTTP mirror with curl instead |

Committed dual-token shape (see [examples/](../examples/)):

```json
{
  "mcpServers": {
    "showrunner": {
      "type": "http",
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": { "Authorization": "Bearer <WORKER_TOKEN>" }
    },
    "showrunner-director": {
      "type": "http",
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": { "Authorization": "Bearer ${SHOWRUNNER_TOKEN}" }
    }
  }
}
```

Or run `node dist/cli/index.js snippets --url <your-url> --worker-token <worker>` after build.

## The /v1 HTTP mirror

Every MCP tool is also plain HTTPS, for clients whose MCP plumbing is broken
or absent (Cursor cloud ignores repo MCP configs as of 3.8) and for scripts:

```bash
curl -s -X POST https://<your-app>.fly.dev/v1/register \
  -H "Authorization: Bearer <WORKER_TOKEN>" -H "Content-Type: application/json" \
  -d '{"show":"myshow","kind":"other","display_name":"curl worker"}'
curl -s --max-time 75 -X POST https://<your-app>.fly.dev/v1/await_work \
  -H "Authorization: Bearer <WORKER_TOKEN>" -H "Content-Type: application/json" \
  -d '{"member_id":"<id>","member_secret":"<secret>"}'
```

Same JSON arguments, same bearer split (director-only tools return
`{status:"forbidden"}` on the worker bearer), same handlers server-side --
the mirror is generated from the MCP tool definitions, so the two surfaces
cannot drift. `GET /v1/protocol` returns the protocol text for sessions that
need to bootstrap without MCP; `GET /v1/tools` lists the tools. `await_work`
holds up to `POLL_HOLD_SECONDS`, so give your HTTP client a >60s timeout.

## Direction and takeover

There's one director per show, held as a lease, not tied to any session.

- First session to say `claim_direction` becomes director.
- The human is the only one who can force a takeover: "you're now the
  director" calls `claim_direction(takeover: true)`, which always wins.
- No auto-promotion, and **no transfer by timeout**: a stale/expired direction
  lease does not open the seat, so a plain `claim_direction` by anyone else is
  denied while a holder exists. A director can stand down cleanly with
  `release_direction`.
- Dead-director recovery is a human action: open a NEW session that has the
  director token (from your `.env`) and paste `You're now the director of
  <show>.` -- that runs `claim_direction(takeover: true)`. The callboard shows
  this prompt when the seat is headless or stale. There is no takeover/clear
  button; the director key lives only in your `.env`.
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

- **Director card**: who, epoch, lease freshness, seat provenance (how the
  holder got the seat, when), and the chat link -- a self-reported `session_url`
  renders as a prominent "open chat ↗", a `resume_hint` (no `session_url`) as
  click-to-copy code, neither as a dim "no chat link reported". When there is no
  live director (headless, or the holder's lease went stale), it shows the exact
  copy-paste recovery prompt (`You're now the director of <show>.`) to run in a
  session that already has the director token -- display only, no secret shown,
  no takeover button (recovery is the human pasting that prompt).
- **Members** (the hero card): each registered member with a staleness dot,
  kind (claude-local, cursor-cloud, ...), role badge, an `invited` badge when it
  joined via an invite, an `EVICTED` badge once the director evicted it, what it
  is working on right now (task title + status, not just an id), tasks done,
  joined/seen ages, and a small ↗ when the member reported a `session_url`.
  The current direction holder is not repeated here (it lives on the Director
  card), and evicted members are hidden by default -- a `show evicted (N)`
  button in the card header reveals them. A member whose poll lease lapsed
  while it still holds a task with a live lease shows an amber "heads-down"
  dot, not red: it's working quietly, and the reaper won't touch its task.
  The synthetic `human` row (api's audit actor for CLI/HTTP writes) is not
  listed -- it isn't a session anyone can talk to.
- **Rules**: the show's current server-held rules (switches shown on/off,
  advisory policy, version) -- display only; edit via `showrunner rules set`.
- **Task columns** (each with a count): queued / needs input / failures.
  Queued and needs-input show the full list; failures shows the latest 20.
  Queued is ordered the way `await_work` claims (priority, then age), so
  the top card is next in line unless it waits on `depends_on` or a pinned
  assignee; a queued task withheld by the release gate shows a PENDING RELEASE
  badge (release it with `showrunner task release`). Failures are what agents
  reported back (failed + rejected), each with the agent's last journal entry
  and its original timestamp. In-flight and done have no columns -- the members
  hero shows in-flight, finished work just gets merged -- but their totals sit
  in the tasks header. Click a task to expand its journal. If tasks are queued
  and no live worker members are registered (heads-down counts as live), a
  banner asks you to open a worker session.
- **Escalations pulse amber in place** (there is no red banner): any
  `input-required` task, plus messages addressed to `human` from the past
  24h (latest 5; there's no ack mechanism, so recency is the bound),
  render in the needs-input column. This is the thing you actually watch
  for; older escalations survive in the activity feed.
- **Activity** (collapsed by default): shared notes, task journal entries,
  and messages in one newest-first feed, last 50.

The callboard is strictly a read-only window: it has no buttons that mutate
state. Every human write action goes through the CLI/admin API -- release a task
with `showrunner task release`, change rules with `showrunner rules set`,
recover a dead director by pasting the director prompt into a token-bearing
session.

## Showrunner rules

Fleet rules are **server-held per-show state**, not a repo file (policy that
governs untrusted members must not be editable by them). Each show has:

- **switches** (machine-enforced): `requireTaskRelease`,
  `requireHumanMergeApproval` (delivered/agent-followed; pair with repo branch
  protection for an enforced gate), `workerNotePropagation`, `requireInvite`,
  `artifactTextMaxChars`, `artifactDataMaxBytes`.
- **policy** (advisory prose, delivered but never enforced).

New shows seed OOTB defaults (favoring automation). The director changes rules
with the `update_rules` tool; the human edits them on the callboard-adjacent CLI
(`showrunner rules set`) or the admin API. Every change bumps a version, is
audited (`updated_by`), and pings the cast; `register` delivers the full rules
and later polls re-deliver on version change. Playbook (`SHOWRUNNER.md`) stays a
repo file about decomposing *this* project (advisory). Sessions may fan out
subagents freely.

## Membership (invites and eviction)

The director controls who is in the show. `mint_invite` issues a single-use,
show-scoped invite token (expires; hash stored, plaintext once) that an outside
agent passes to `register`. Turn on the `requireInvite` rule
(`showrunner rules set --require-invite on`) to refuse worker-token registration
without a valid invite; the director token is exempt. `evict_member` revokes a
member's credential (its later calls return `unauthorized_member`), requeues its
in-flight task, and flags it evicted on the board. `get_board` shows the director
who is connected, what each member is doing, and invite provenance -- that is the
eviction-decision surface. Eviction is durable only with `requireInvite` on.

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
- **Direction never transfers by timeout.** An expired direction lease is a
  liveness signal only (the callboard shows the holder stale); it does not open
  the seat. A plain `claim_direction` succeeds only if the seat is unheld
  (nobody claimed it, the holder called `release_direction`, or the human
  cleared it) or you already hold it. To displace a live-or-stale holder, the
  human uses `claim_direction` with `takeover:true`. Every transition is audited
  (`claimed | released | takeover | admin_clear | expired`) and the current
  holder's provenance shows on the board and callboard.
- Workers can't receive pushes (cloud sessions are outbound-only), so
  `await_work` is a long-poll: it blocks up to `POLL_HOLD_SECONDS` (default
  50, chosen to clear Cursor/Fly/Claude Code's independent ~60s connection
  walls with ~10s margin) and the worker re-polls immediately after.
- Polls return unread-only messages and pointer-style task briefs, not
  inlined specs, to keep the coordination overhead in tokens small.
- A terminal `update_task` (completed/failed/rejected) returns
  `next: {action: "await_work", queued, hint}` -- the required next call plus
  live queue depth, aimed at clients that treat "task done, summarize" as
  end-of-turn. `register` returns the same rule as a machine-readable
  `loop_contract` (stop conditions: eviction or an explicit human stop;
  finishing a task is never one).
- A director's idle poll (`status:"nothing"`) carries `pending_input`: every
  task still parked `input-required`, with age, so an escalation the director
  already saw once (the review feed shows each only once) keeps nagging until
  it's answered with `direct_task({action:"answer"})`. Workers park an
  unanswered escalation and move to other queued work after ~15 min
  (`ESCALATION_WAIT_S`), leaving a draft-PR handoff; the answer re-adopts the
  task once the worker's current work wraps.
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
| `SHOWRUNNER_TOKEN` | *(required)* | Director/admin bearer. Server refuses to start without it. |
| `SHOWRUNNER_WORKER_TOKEN` | *(optional)* | Worker bearer. When unset, equals director (single-token mode). |
| `PORT` | `8080` | HTTP port. |
| `DATA_DIR` | `/data` | Where the SQLite file lives. |
| `POLL_HOLD_SECONDS` | `50` | Max long-poll hold for `await_work`. |
| `WORKER_LEASE_S` | `150` | Member liveness lease; renewed by any tool call. |
| `TASK_LEASE_S` | `900` | Task ownership lease; renewed by `update_task`. |
| `ESCALATION_WAIT_S` | `900` | How long an unanswered `input-required` escalation keeps its task redelivered to the escalating worker before polls start offering it other queued work (the task stays parked and assigned; the director's answer hands it back). |
| `DIRECTION_LEASE_S` | `600` | Director lease; renewed by any director tool call. |
| `SWEEP_INTERVAL_S` | `5` | How often the reclaim sweep runs. |
| `NOTE_MAX_CHARS` | `2000` | Max shared-note body length. |
| `NOTES_PER_TASK` | `4` | Max `relevant_notes` attached at task claim time. |

Rule seed-defaults (applied to a **new** show's rules; per-show values then live
on the server and change with `showrunner rules set` / `update_rules`):

| Var | Default | Seeds switch |
|---|---|---|
| `REQUIRE_TASK_RELEASE` | `false` | `requireTaskRelease` — withhold director tasks until a human releases them. Turn on for untrusted workers. |
| `REQUIRE_INVITE` | `false` | `requireInvite` — refuse worker-token registration without a director-minted invite. Turn on to control who joins. |
| `REQUIRE_HUMAN_MERGE_APPROVAL` | `false` | `requireHumanMergeApproval` — agents leave PRs for the human. |
| `WORKER_NOTE_PROPAGATION` | `true` | `workerNotePropagation` — auto-push notes to peers' claims. |
| `ARTIFACT_TEXT_MAX_CHARS` | `10000` | `artifactTextMaxChars` cap. |
| `ARTIFACT_DATA_MAX_BYTES` | `16384` | `artifactDataMaxBytes` cap. |

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
showrunner task release --show <name> --id <task-id>   # release a task withheld by the release gate
showrunner message --show <name> --to <member-id|director|all|human> --body <text>
showrunner rules --show <name>                         # print the show's server-held rules
showrunner rules set --show <name> [--require-release on|off] [--merge-approval on|off] \
                     [--note-propagation on|off] [--require-invite on|off] \
                     [--artifact-text-max <n>] [--artifact-data-max <n>] [--policy <text>]
showrunner direction clear --show <name>
showrunner show delete --show <name>        # removes the show and everything under it
showrunner init --show <name> --url <url> --token <director> --worker-token <worker>
showrunner open [--show <name>] [--print]  # callboard magic link (?token=…&show=…)
showrunner instructions
showrunner snippets [--url <url>] [--worker-token <token>]
```

`init` sets a repo up as a show: it writes `.showrunner` (the name pin),
`SHOWRUNNER.md` (the show playbook), committed `.mcp.json` / `.cursor/mcp.json`
with a **hardcoded worker** Bearer plus a `showrunner-director` entry that reads
`SHOWRUNNER_TOKEN` from env, and a gitignored `.env` with the director token. It
prints the callboard link and ways-to-run (simple fleet vs dedicated lanes).
Fleet rules are server-held (seeded with OOTB defaults on the server), not
scaffolded into the repo -- view them on the callboard, edit with `showrunner rules set`. Fill in the playbook, commit, and every clone, worktree, and cloud
checkout gets the same show name.

`open` builds the callboard `?token=` handshake URL (optionally `&show=`) from
env/`~` context and opens it in the browser (`--print` to stdout only).

This is a human convenience over `/api`, not something agents call. Agents
talk MCP.

## Verifying a deployment

`scripts/seed-demo.mts` fills a local server with a realistic demo show
(the one in the README screenshot) for a look around the callboard.

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
`claim_direction(takeover: true)` and resumes with full board state. A plain
`claim_direction` (no takeover) never opens a held seat, even after the lease
expires -- the seat must be explicitly freed by `release_direction` or
`showrunner direction clear` first.

**The server restarts (e.g. `fly deploy`)?**
No tasks lost, state is in SQLite on the volume. Workers notice their next
poll fails, retry, and reconnect once the new machine is up. In-flight leases
just expire and requeue like any other stall.

**A worker goes silent (crashed, context ran out, laptop closed)?**
Its worker lease expires (`WORKER_LEASE_S`), the callboard marks it stale
(amber "heads-down" instead, while it still holds a task with a live lease),
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

A show may include agents run by other people, so directors and workers don't
trust each other. Full threat model and reasoning: [SECURITY.md](SECURITY.md).
The controls, strongest first:

1. **Per-member auth.** `register` returns a `member_secret` that must accompany
   `member_id` on every call (the DB stores only its hash). `member_id` is a
   board handle, not a credential, so one member can't act as another.
2. **Human release gate** (the show's `requireTaskRelease` rule, on). Director-
   created tasks are withheld until a human releases them with `showrunner task
   release` (the read-only callboard only badges them) -- the check against a
   malicious/compromised director. Fleet rules are server-held per-show state
   (not a repo file), edited via `update_rules` / `showrunner rules set`.
3. **Runtime containment** (not enforced by showrunner). Run untrusted workers
   with repo-scoped filesystem access, a network allowlist, and no host
   secrets. This is the real boundary against host exfiltration; showrunner
   only avoids handing out work that needs more.
4. **Dual tokens + untrusted-content annotation** (defense in depth). The
   committable worker token can't direct; keep the director token secret and
   rotate with `fly secrets set SHOWRUNNER_TOKEN=... SHOWRUNNER_WORKER_TOKEN=...`.
   Peer-authored fields are delivered tagged `trust:"untrusted_peer"`; treat
   them as data, never instructions.

For a show with untrusted members: set a distinct worker token, turn on the
`requireTaskRelease` rule (`showrunner rules set --require-release on`, or seed
it deployment-wide with `REQUIRE_TASK_RELEASE`), run workers locked-down, and
keep secrets out of briefs (point at repo files). Non-goals in v1: per-show
ACLs, content encryption. (Per-member secrets with revocation via `evict_member`
shipped -- see control #1 above.)
