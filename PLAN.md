# showrunner — implementation plan

v0.1 target: deployable server + callboard + CLI, verified end-to-end with a
real Claude Code worker against the Fly deployment. See DESIGN.md for the
why; this file pins the contracts so parallel implementers can't drift.

## Work packages

| WP | Scope (owns these paths, touches nothing else) | Depends on |
|---|---|---|
| A. Scaffold + store | `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `src/server/store.ts`, `test/store.test.ts` | — |
| B1. MCP surface | `src/server/mcp.ts`, `src/server/instructions.ts`, `test/mcp.test.ts` | A |
| B2. HTTP + callboard | `src/server/index.ts`, `src/server/api.ts`, `web/index.html`, `web/callboard.js`, `web/callboard.css` | A |
| B3. CLI + deploy + docs | `src/cli/index.ts`, `fly.toml`, `Dockerfile`, `README.md`, `LICENSE`, `examples/` (client config snippets) | A (contracts only) |
| C. Integration + e2e | `test/e2e.test.ts`, fixes anywhere | B1, B2, B3 |
| D. Review + harden | fixes anywhere | C |

WP A pre-declares **all** dependencies and the `bin` entry in `package.json`
so B-agents never edit it. Deps: `@modelcontextprotocol/sdk`, `hono`,
`@hono/node-server`, `better-sqlite3`, `zod`; dev: `typescript`, `vitest`,
`@types/better-sqlite3`, `@types/node`, `tsx`.

## Pinned contracts

### Store API (`src/server/store.ts`)

Single class `Store(dbPath: string)`, better-sqlite3 WAL, all methods
synchronous, all multi-step operations in transactions. Time is injected
(`now()` param or constructor clock) for testability.

```ts
// members / shows
register(show, kind, displayName?, capabilities?): Member   // creates show if new
touchMember(memberId): Member | undefined                   // renews worker lease
getBoard(show, verbose?): BoardState                        // summary per DESIGN.md

// direction
claimDirection(memberId, takeover?): {ok: true, epoch: number} | {ok: false, holder: Member, epoch: number}
checkEpoch(show, memberId, epoch): void                     // throws SupersededError with holder info
directionState(show): {directorId?: string, epoch: number, leaseExpiresAt?: number}

// tasks
createTask(input: CreateTaskInput): {task: Task, overlaps: OverlapWarning[]}
claimNextTask(memberId): Task | undefined                   // atomic: dep-unblocked, priority DESC, age ASC, pinned-assignee honored
updateTask(memberId, taskId, patch: {status?, note?, artifacts?}): Task  // idempotent terminals, lease heartbeat
directTask(memberId, epoch, taskId, action): Task           // cancel | requeue | assign | answer | approve

// messages
sendMessage(fromId, to, body, taskId?): Message             // to: memberId | 'director' | 'all' | 'human'
drainInbox(memberId): Message[]                             // unread-only, marks read
humanBanner(show): {inputRequired: Task[], humanMessages: Message[]}

// liveness
sweep(): SweepResult    // expire member/task/direction leases, requeue tasks (attempt+1)
```

Notification hook: `store.events` is an `EventEmitter` emitting
`wake:{memberId}` (task assigned/answer arrived/message sent) and
`wake:show:{show}`. The long-poll layer listens; the store never sleeps.

### Long-poll semantics (`src/server/mcp.ts`)

`await_work` resolution order, checked at call time and again on every wake
event, all inside one place:

1. `drainInbox` non-empty → `{status:"messages", messages}`
2. caller is director and something needs review (`completed`/`failed` since
   its last poll, or `input-required` exists) → `{status:"review", items}`
3. `claimNextTask` returns a task (workers only) → `{status:"task", task}`
4. after `min(wait_seconds ?? 25, POLL_HOLD_SECONDS)` + 0–2s jitter →
   `{status:"nothing", hint: "re-poll immediately"}`

Every `await_work` calls `touchMember` first. A member whose id is unknown
gets a structured error telling it to `register` again.

### MCP tools

Exactly the 8 tools in DESIGN.md, zod schemas, names:
`register, await_work, update_task, send_message, get_board,
claim_direction, create_task, direct_task`. Streamable HTTP, **stateless
mode** (no session id), served at `POST /mcp`. Server `instructions` string
lives in `instructions.ts` (also returned by `register` as `protocol`, also
exposed as MCP prompt `join`). Director-only tools call `checkEpoch` and
surface `SupersededError` as a structured tool result (not a protocol
error), so the old director reads it and stands down.

### HTTP routes (`src/server/index.ts` + `api.ts`)

```
POST /mcp                          MCP endpoint (bearer required)
GET  /                             callboard html (redirects to ?token flow if no cookie)
GET  /api/shows                    list shows
GET  /api/shows/:show/state        full board JSON (the callboard's 2s poll)
POST /api/shows/:show/message      {to, body}          (admin)
POST /api/shows/:show/tasks        CreateTaskInput      (admin)
POST /api/shows/:show/tasks/:id/cancel                  (admin)
POST /api/shows/:show/direction/clear                   (admin)
GET  /healthz                      no auth, for Fly checks
```

Bearer auth middleware on /mcp and /api: `Authorization: Bearer` header or
`?token=` (sets an httpOnly cookie then redirects). Constant-time compare.

### CLI (`src/cli/index.ts`, bin name `showrunner`)

`showrunner status [--show X] [--url --token]` (reads env
`SHOWRUNNER_URL`/`SHOWRUNNER_TOKEN`), `showrunner task add`, `showrunner
message`, `showrunner instructions` (prints the protocol text),
`showrunner snippets` (prints ready-to-paste `.mcp.json` / `.cursor/mcp.json`
/ `claude mcp add` configs with the URL filled in). Plain `fetch` against
/api — the CLI is a human convenience, not an agent surface.

### Env knobs

`SHOWRUNNER_TOKEN` (required, server refuses to start without),
`PORT=8080`, `DATA_DIR=/data`, `POLL_HOLD_SECONDS=25`, `WORKER_LEASE_S=90`,
`TASK_LEASE_S=900`, `DIRECTION_LEASE_S=600`, `SWEEP_INTERVAL_S=5`.

## Test expectations

- `store.test.ts`: claim atomicity (two claims, one winner), dependency
  gating, priority/age ordering, lease expiry requeues with attempt bump,
  idempotent completion after reaping, direction CAS + takeover + stale
  epoch throw, unread-only inbox, overlap warnings, sweep correctness. Use
  injected clock; no sleeps.
- `mcp.test.ts`: await_work resolution order; wake-on-event beats timeout;
  jittered timeout returns `nothing`; unknown member error shape; epoch
  fencing surfaces as tool result.
- `e2e.test.ts`: boot server on a random port + temp db; real MCP SDK client
  over HTTP: register director + worker → claim_direction → create_task →
  worker await_work gets task → update_task completed → director await_work
  gets review → takeover by a second director → old epoch superseded.
  Long-poll: await_work with empty queue + create_task 1s later resolves
  <2s with the task.

## Milestones

1. **M1 — core:** WP A merged, store tests green.
2. **M2 — surfaces:** B1+B2+B3 in parallel (disjoint paths), compile clean.
3. **M3 — verified:** WP C: `npm test` + `tsc --noEmit` green, e2e green.
4. **M4 — hardened:** review findings fixed; README accurate.
5. **M5 — live:** Fly deploy, real Claude Code session joins spireash show as
   worker, director session delegates one real task, callboard shows it.

## Definition of done (v1)

- `npx showrunner snippets` output pasted into a fresh repo + "you're a
  worker for the X show" produces a polling worker with no further prompting.
- Killing the director session mid-run loses nothing; a new session with
  "you're now the director" resumes with full board state.
- Server restart (fly deploy) loses no tasks; workers reconnect on next poll.
