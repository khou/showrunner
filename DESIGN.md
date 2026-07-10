# showrunner — design

*v0.1, 2026-07-10. One human, many agent sessions, one tiny server. Informed by
a 6-topic research pass (feasibility facts cited inline where they constrain a
decision).*

## Thesis

Every coding-agent orchestrator today either lives inside one session (Claude
Code agent teams, Cursor subagents: single machine, fixed lead, dies with the
session) or inside one vendor's cloud. showrunner is the missing piece for one
person running several sessions at once: a **tiny always-on MCP server** that
holds the task board, so that *any* agent session — Claude Code or Cursor,
local Mac or cloud VM — can join a project ("show") as a **worker** or take
over as **director** with a one-line prompt:

> "You're a worker for the spireash show."

The server is the only stateful thing. Sessions are cattle: they register,
pull work, report, and can die at any time without losing anything.
Directorship is a lease in the server, not a property of a session, which is
why it can be transferred at runtime with one sentence — the one thing no
prior system ships.

Deliberately **not**: a runner UI, a worktree manager, an A2A node, a product.
State is one SQLite file; the dashboard is one static page; the tool surface
is 8 tools.

## Constraints that shaped the design (research findings)

1. **Workers are outbound-only MCP clients.** Cloud sessions can't accept
   inbound connections. Everything is pull; "push" is approximated by a
   blocking long-poll tool call.
2. **Three independent ~60s walls** bound the long-poll: Cursor kills MCP tool
   calls at ~60s (error -32001, not configurable, progress notifications do
   NOT reset its timer); Claude Code's HTTP first-byte budget has a 60s
   minimum; Fly's proxy drops connections after 60s with no bytes. So the
   server holds `await_work` for **25s** (env-tunable — Cursor's limit changed
   three times in a year), returns an explicit `nothing` result, and the
   worker immediately re-polls.
3. **Static bearer tokens are the only auth that works everywhere.** Cloud
   sessions cannot do browser OAuth. Claude cloud reads the repo's committed
   `.mcp.json` (with `${VAR}` header interpolation + an env var set in the
   cloud environment); Cursor cloud only takes MCP config from its dashboard
   with a hardcoded token (treat Cursor-cloud workers as best-effort).
4. **Agents reliably fail to report completion or death** (agent teams: stuck
   tasks; Gas Town: 141 orphaned processes). Every claim is a lease with a
   TTL; the server reclaims silently-abandoned work. Nothing trusts an agent
   to say goodbye.
5. **Multi-session coordination costs ~10x tokens if you're sloppy.** Polls
   return unread-only, task briefs are pointers into the repo (not inlined
   specs), board reads are summaries.
6. **A2A is overkill** (assumes every agent is an addressable server) but its
   task state machine, taskId/contextId split, artifacts-as-typed-parts, and
   agent-card registration record are borrowed as internal data shapes.

## Vocabulary

| Term | Meaning |
|---|---|
| **show** | A project (e.g. `spireash`). One server hosts many shows. |
| **member** | One agent session registered to a show. Gets a memorable id (`amber-fox`). |
| **worker** | Member that pulls tasks and executes them in its own repo checkout. |
| **director** | The one member per show holding the direction lease. Plans, creates tasks, reviews, answers blockers. |
| **callboard** | The web dashboard. Backstage board where the cast checks assignments. |

## Architecture

```
┌─ Claude Code (local) ──┐
├─ Claude Code (cloud) ──┤   MCP over streamable HTTP        ┌────────────────────┐
├─ Cursor (local) ───────┼──────────────────────────────────▶│  showrunner server  │
├─ Cursor (cloud) ───────┤   Authorization: Bearer <token>   │  Fly.io, 1 machine  │
└─ anything MCP ─────────┘                                   │  SQLite on volume   │
                                                             │  /mcp  /  /api      │
        Kevin ── browser ── callboard (/) ───────────────────┴────────────────────┘
```

One Node process. No queue infra, no websockets to agents, no A2A. In-process
`EventEmitter` wakes parked long-polls when work arrives (single process, so
no cross-node coordination problem exists).

## Data model

SQLite (better-sqlite3, WAL). All rows plain JSON-friendly; `sqlite3` CLI or
`showrunner status` can always answer "what is the state".

```
shows      { name PK, created_at, config_json }
members    { id PK, show, kind, display_name, role, registered_at,
             last_seen_at, lease_expires_at, current_task_id }
direction  { show PK, director_id, epoch, lease_expires_at }   -- one row per show
tasks      { id PK, show, context_id, title, brief, files_hint_json,
             depends_on_json, priority, status, assignee, attempt,
             created_by, lease_expires_at, artifacts_json, created_at, updated_at }
task_notes { id PK, task_id, author, body, created_at }         -- append-only journal
messages   { id PK, show, from_id, to_id, task_id, body, created_at }
message_reads { message_id, member_id }                         -- unread-only delivery
```

- `kind`: `claude-local | claude-cloud | cursor-local | cursor-cloud | other`
  (A2A agent card, flattened).
- `context_id` groups tasks belonging to one feature/thread so the director
  can cancel or reassign a whole thread at once (A2A borrow).
- `to_id` of a message may be a member id, `director` (role-addressed —
  resolves at delivery time, so it survives director changes), `all`, or
  `human` (lands on the callboard escalation banner).

### Task state machine (A2A-derived)

```
queued ──▶ assigned ──▶ working ──▶ completed
   ▲           │           │──────▶ failed
   │           │           │──────▶ rejected      (worker declines: wrong skills/env)
   │           │           └──────▶ input-required ──▶ working   (director/human answers)
   │           └── lease expiry / requeue ──┘
   └── director: requeue / cancel ──▶ canceled
```

- `queued → assigned` happens inside `await_work` (atomic claim in a SQLite
  transaction; dependency-unblocked, priority DESC, age ASC; honors a pinned
  `assignee` if the director set one).
- `input-required` is distinct from `failed` on purpose: it means "a decision
  is needed", pings the director's poll, and lights the callboard red.
- Terminal statuses are idempotent by task id: a worker whose lease was
  reaped can still report `completed`; if the task was requeued but not yet
  re-claimed, the report wins and the task completes (attempt noted).

### Leases (the only liveness mechanism)

| Lease | TTL (env) | Renewed by | On expiry |
|---|---|---|---|
| worker | 90s | any tool call by that member (polling is the heartbeat) | member shown stale on callboard; its `assigned/working` tasks requeue |
| task | 15 min | `update_task` (status/note/heartbeat) by assignee | task requeues, `attempt`+1, journal preserved |
| direction | 10 min | any tool call by the director | show runs headless: workers keep draining the queue; callboard shows "no director"; nothing self-promotes |

No auto-promotion of workers to director, deliberately: every field report
says unattended swarms drift; a dead director costs nothing (state is in the
server) and the human appoints a new one with one sentence.

### Direction: election, transfer, fencing

One row per show: `{director_id, epoch, lease_expires_at}`.

- `claim_direction` is a compare-and-swap: succeeds if the lease is expired,
  unheld, or the caller already holds it — and always bumps `epoch`.
- `claim_direction(takeover: true)` succeeds unconditionally (the human said
  "you're now the leader"; the human is the authority — there is exactly one
  human).
- Every director-only tool takes the caller's `epoch`; the server rejects
  stale epochs with a structured error: `superseded: you are no longer
  director of <show>; <new-id> holds epoch <n>. Re-register as a worker or
  await instructions.` That error is how "the pool figures it out amongst
  themselves": the old director demotes itself on its next call, no gossip
  protocol needed. The server is the sole arbiter, so fencing is one integer
  compare.

## MCP tool surface (8 tools)

Everything takes/returns compact JSON. `member_id` is explicit in every call
(the server is stateless per-request; reconnects and session restarts don't
matter).

**Shared:**

1. `register({show, kind, display_name?, capabilities?})`
   → `{member_id, show, director, board_summary, protocol}` — creates the
   show if new; `protocol` is the full worker/director loop contract in
   ~600 tokens, so even a client that ignored the server instructions knows
   what to do next.
2. `await_work({member_id, wait_seconds?})` — **the long-poll.** Holds up to
   `min(wait_seconds, POLL_HOLD_SECONDS=25)`. Returns first-available of:
   a newly claimed task (worker), unread messages, direction-change or
   review-needed notices (director), else `{status:"nothing", hint}`.
   Renews the member lease. Callers re-poll immediately; the server adds
   0–2s jitter to the hold to de-synchronize herds.
3. `update_task({member_id, task_id, status?, note?, artifacts?})` —
   heartbeats the task lease; appends to the journal; sets status
   (`working|input-required|completed|failed|rejected`). Artifacts are typed
   parts: `{kind: branch|files|text|data, ...}` — e.g. the branch the worker
   pushed, files touched, a 3-line summary.
4. `send_message({member_id, to, body, task_id?})` — to a member id,
   `director`, `all`, or `human`. Delivered via the recipient's next
   `await_work`; `human` lands on the callboard banner.
5. `get_board({member_id, verbose?})` — director card, member list with
   staleness, task counts by status, in-flight task titles, escalations.
   Summary by default (~300 tokens); `verbose` adds journals.

**Director-only (epoch-fenced):**

6. `claim_direction({member_id, takeover?})` → `{epoch, board_summary}`.
7. `create_task({member_id, epoch, title, brief, context_id?, depends_on?,
   files_hint?, priority?, assignee?})` → `{task_id}` — brief should be
   pointers ("see docs/combat.md §3; branch off main"), not inlined specs.
   `files_hint` globs power advisory overlap warnings: creating a task whose
   globs intersect an in-flight task's returns a warning (never a block) —
   partition, don't lock.
8. `direct_task({member_id, epoch, task_id, action, ...})` — `cancel`,
   `requeue`, `assign {assignee}`, `answer {body}` (for `input-required` →
   flips back to `working` and delivers the answer), `approve` (optional
   review gate, see config).

### The one-line-prompt trick

The server's MCP `initialize` response carries `instructions` (~1.5KB,
auto-loaded into Claude Code context; also exposed as MCP prompt
`/showrunner:join` for Cursor and manual use):

> If the user tells you that you are a **worker** for show X: call
> `register`, then loop `await_work` forever; execute each task in the
> current repo on a fresh branch named `show/<task_id>-<slug>`; heartbeat
> with `update_task` at least every 10 minutes while working; report
> `completed` with branch + summary artifacts; if blocked, set
> `input-required`, message the director, and keep polling. Do not stop
> polling because the queue is empty. If the user tells you that you are the
> **director**: `register` then `claim_direction(takeover: true)`; read the
> project state; break work into 5–20 minute tasks with pointer-style briefs
> and non-overlapping `files_hint`; then loop `await_work`, reviewing
> completions, answering `input-required`, creating follow-on tasks, and
> posting a digest note to the board every ~30 minutes.

That is the entire integration: configure the MCP server once per machine or
repo, and any future session understands "you're a worker for spireash".

### Worker context depletion

A polling worker slowly burns context. The protocol tells workers to prefer
finishing a task and letting the human recycle the session over heroics, and
the callboard shows per-member `age`/`tasks done` so Kevin can see when a
worker is long in the tooth. (Claude Code auto-compaction makes this mostly a
non-issue; Cursor sessions may need manual recycling.)

## Callboard (dashboard)

Single static HTML page served at `/`, polling `GET /api/shows/:show/state`
every 2s. No build step, no framework — one file, fetch + DOM.

- Director card: who, epoch, lease freshness, last digest note.
- Members: kind badge, role, current task, last-seen freshness dot.
- Task columns: queued / in-flight (assigned+working) / needs-input /
  done+failed. Click a task → journal + artifacts.
- Activity feed: last 50 journal notes + messages.
- **Red escalation banner**: `input-required` tasks and messages addressed to
  `human`.
- Admin strip (same bearer token, entered once, kept in localStorage):
  post a message to `director`/`all`, create a task by hand, cancel a task,
  clear direction (demote a runaway director).

Auth: `Authorization: Bearer` (or `?token=` once → cookie). One token, env
`SHOWRUNNER_TOKEN`, gates /mcp and /api alike. v1 keeps a single token
(documented risk: cloud env editors can see it; it's revocable by rotating
the Fly secret).

## Server & deploy

- **Stack:** TypeScript, Node 20+, `@modelcontextprotocol/sdk` (streamable
  HTTP, stateless mode), Hono for routing, better-sqlite3, Vitest.
- **Fly.io:** `shared-cpu-1x`, one machine, `auto_stop_machines = "off"`
  (autostop + long-poll is exactly the wrong pair), 1GB volume mounted at
  `/data` for SQLite. `fly launch && fly secrets set SHOWRUNNER_TOKEN=...`.
- **Env knobs:** `SHOWRUNNER_TOKEN` (required), `PORT`, `DATA_DIR`,
  `POLL_HOLD_SECONDS=25`, `WORKER_LEASE_S=90`, `TASK_LEASE_S=900`,
  `DIRECTION_LEASE_S=600`.
- **Reclaim sweep:** one `setInterval` (5s) expires leases, requeues tasks,
  wakes relevant waiters. Restart-safe because all state is in SQLite.

## Client configuration (README material)

| Client | How | Notes |
|---|---|---|
| Claude Code local | `claude mcp add --transport http showrunner <url>/mcp --header "Authorization: Bearer $SHOWRUNNER_TOKEN"` (user scope) or committed `.mcp.json` with `${SHOWRUNNER_TOKEN}` | v2.1.2xx+; 25s poll needs zero timeout tuning |
| Claude Code cloud | committed `.mcp.json` + env var in the cloud environment + network allowlist for the Fly domain | no OAuth in cloud; bearer only |
| Cursor local | `.cursor/mcp.json` with `url` + `headers: {"Authorization": "Bearer ${env:SHOWRUNNER_TOKEN}"}` | 3.0+ required; allowlist/auto-run showrunner tools or the poll loop stalls on approval prompts |
| Cursor cloud | cursor.com/agents dashboard MCP config, token hardcoded there | best-effort: env interpolation broken there, config ignored from repo (as of 3.8) |

## Security posture (v1, honest)

Single shared bearer token; anyone with it can read/write every show on the
deployment. Acceptable for one-person use; rotate via `fly secrets set`.
Non-goals in v1: per-member tokens, show-level ACLs, task-content encryption.
The server holds task titles/briefs and journals — keep secrets out of
briefs; point at repo files instead (which also saves tokens).

## What v1 explicitly skips

- Auto-promotion / worker consensus on a new director (human appoints).
- MCP Tasks (SEP-1686 call-now/fetch-later) — poll loop is isolated in one
  module so it can be swapped when client support matures.
- MCP channels push for Claude Code (optional enhancement; Cursor has no
  equivalent, long-poll must exist anyway).
- Slack notifications (callboard is the v1 escalation surface).
- Git integration (workers use ordinary branches; the artifacts convention
  carries branch names; merging is a director task like any other).
