# showrunner

A tiny always-on server that coordinates multiple coding-agent sessions on one
project (a "show"). Deploy it once. Then tell any agent session, local or
cloud, Claude Code or Cursor:

> "You're a worker for the spireash show."

It registers, starts pulling tasks, and reports back. Tell a second session:

> "You're the director for the spireash show."

It takes over planning: breaking work into tasks, answering blockers,
reviewing completions. Kill that session anytime; state lives on the server,
not in the session. Tell a new one "you're now the director" and it picks up
exactly where the last one left off.

One SQLite file. One static dashboard. Eight MCP tools. No queue infra, no
worktree manager, no per-agent push channel (agents poll; that's the only
thing that works for cloud sessions anyway). See [DESIGN.md](DESIGN.md) for
the full rationale.

## 60-second quickstart

```bash
fly launch --no-deploy   # creates the app from fly.toml, skips first deploy
export SHOWRUNNER_TOKEN=$(openssl rand -hex 24)   # keep this shell open, you'll need it below
fly secrets set SHOWRUNNER_TOKEN=$SHOWRUNNER_TOKEN
fly deploy
```

Connect a local Claude Code session (same shell, so `$SHOWRUNNER_TOKEN` is still set):

```bash
claude mcp add --transport http showrunner https://<your-app>.fly.dev/mcp \
  --header "Authorization: Bearer $SHOWRUNNER_TOKEN"
```

(Need the exact command for your deployed URL, or a Cursor config instead?
Clone this repo, `npm install && npm run build`, then run
`node dist/cli/index.js snippets --url https://<your-app>.fly.dev` to print
all of them -- see [CLI](#cli) below for why it's not `npx showrunner`.)

Now say the sentence:

> "You're a worker for the spireash show."

Watch it register and start polling at `https://<your-app>.fly.dev`.

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

Working examples with a placeholder URL are in [examples/](examples/). Or, from
a clone of this repo, run `node dist/cli/index.js snippets --url <your-url>`
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
every 2s. Enter the bearer token once (kept in localStorage). Shows:

- **Director card**: who, epoch, lease freshness, last digest note.
- **Members**: kind (claude-local, cursor-cloud, ...), role, current task,
  a staleness dot.
- **Task columns**: queued / in-flight / needs-input / done+failed. Click a
  task to expand its journal.
- **Activity feed**: last 50 notes and messages.
- **Red escalation banner**: any `input-required` task, or any message
  addressed to `human`. This is the thing you actually watch for.
- **Admin strip**: post a message, create a task by hand, cancel a task,
  clear direction (same token, no separate login).

## How it works

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
showrunner message --show <name> --to <member-id|director|all|human> --body <text>
showrunner instructions
showrunner snippets [--url <url>]
```

This is a human convenience over `/api`, not something agents call. Agents
talk MCP.

## Verifying a deployment

`scripts/live-verify.mts` drives the full lifecycle against a real deployment
with the real MCP SDK client: register, claim direction, create task, worker
claims and completes, director reviews, mid-poll wake latency, takeover and
stale-epoch fencing, callboard, auth rejection.

```bash
SR_URL=https://<your-app>.fly.dev SR_TOKEN=<token> npx tsx scripts/live-verify.mts
```

It creates a throwaway `verify-*` show; safe to run against a server in use.

## FAQ

**The director's session dies mid-run. What happens?**
Nothing is lost. Tasks, journals, and messages are all on the server. Workers
keep pulling from the queue. The callboard marks the director card stale once
its 10-minute lease lapses (or shows "no director" if you use the callboard's
"clear direction" button first). Say "you're the director" to any session and
it calls `claim_direction(takeover: true)` and resumes with full board state
-- a normal `claim_direction` (no takeover) works too once the lease has
actually expired.

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
if it leaks. No per-member tokens or per-show ACLs in v1.

## License

MIT, see [LICENSE](LICENSE).
