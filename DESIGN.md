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

> "You're a showrunner worker."

The show name doesn't need saying: the session derives it from the repo it
was opened in (a committed `.showrunner` file, else git origin basename, else
directory name). Naming a show
explicitly ("a worker for the mygame show") always overrides.

The server is the only stateful thing. Sessions are cattle: they register,
pull work, report, and can die at any time without losing anything.
Directorship is a lease in the server, not a property of a session, which is
why it can be transferred at runtime with one sentence — the one thing no
prior system ships.

Deliberately **not**: a runner UI, a worktree manager, an A2A node, a product.
State is one SQLite file; the dashboard is one static page; the tool surface
is 15 tools.

## Constraints that shaped the design (research findings)

1. **Workers are outbound-only MCP clients.** Cloud sessions can't accept
   inbound connections. Everything is pull; "push" is approximated by a
   blocking long-poll tool call.
2. **Three independent ~60s walls** bound the long-poll: Cursor kills MCP tool
   calls at ~60s (error -32001, not configurable, progress notifications do
   NOT reset its timer); Claude Code's HTTP first-byte budget has a 60s
   minimum; Fly's proxy drops connections after 60s with no bytes. So the
   server holds `await_work` for **50s** (env-tunable — Cursor's limit changed
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
   return unread-only, task briefs are substantial but bounded (goal, acceptance
   criteria, constraints; they point at docs for long specs rather than
   re-pasting them, and stand on their own), board reads are summaries.
6. **A2A is overkill** (assumes every agent is an addressable server) but its
   task state machine, taskId/contextId split, artifacts-as-typed-parts, and
   agent-card registration record are borrowed as internal data shapes.

## Vocabulary

| Term | Meaning |
|---|---|
| **show** | A project, named after its repo (e.g. `mygame`). One server hosts many shows. |
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
        human ── browser ── callboard (/) ───────────────────┴────────────────────┘
```

One Node process. No queue infra, no websockets to agents, no A2A. In-process
`EventEmitter` wakes parked long-polls when work arrives (single process, so
no cross-node coordination problem exists).

## Data model

SQLite (better-sqlite3, WAL). All rows plain JSON-friendly; `sqlite3` CLI or
`showrunner status` can always answer "what is the state".

```
shows      { name PK, created_at, config_json }
show_rules { show PK, version, switches_json, policy, directives_json, updated_at, updated_by }
members    { id PK, show, kind, display_name, role, registered_at,
             last_seen_at, lease_expires_at, current_task_id, secret_hash,
             review_cursor, session_url, resume_hint, rules_version_seen,
             invite_id, evicted_at, evicted_by }
invites    { id PK, show, token_hash, minted_by, minted_at, expires_at,
             used_at, used_by }   -- single-use, show-scoped, hash-only
direction  { show PK, director_id, epoch, lease_expires_at }   -- one row per show
direction_events { id PK, show, actor, method, epoch, created_at }  -- audit log
tasks      { id PK, show, context_id, title, brief, files_hint_json,
             depends_on_json, priority, status, assignee, attempt,
             created_by, lease_expires_at, artifacts_json, released, status_changed_at,
             created_at, updated_at }
task_notes { id PK, task_id, author, body, created_at }         -- append-only journal
messages   { id PK, show, from_id, to_id, task_id, body, kind, created_at }
message_reads { message_id, member_id }                         -- unread-only delivery
notes      { id PK, show, author, body, tags_json, files_hint_json,
             task_id, context_id, created_at }                  -- append-only shared memory
notes_fts  ( FTS5 over body + tags, bm25-ranked )
```

- `kind`: `claude-local | claude-cloud | cursor-local | cursor-cloud | other`
  (A2A agent card, flattened).
- `context_id` groups tasks belonging to one feature/thread so the director
  can cancel or reassign a whole thread at once (A2A borrow).
- `to_id` of a message may be a member id, `director` (role-addressed —
  resolves at delivery time, so it survives director changes), or `all`.
  There is no `human` target: a director needing the human's input asks in
  its own agent session (the human is present there), not through the server.

### Task state machine (A2A-derived)

```
queued ──▶ assigned ──▶ working ──▶ completed   (requireValidationOnComplete: needs a validation claim)
   ▲           │           │──────▶ failed
   │           │           │──────▶ rejected      (worker declines: wrong skills/env)
   │           │           └──────▶ input-required ──▶ working   (director answers; take_input holds the worker meanwhile)
   │           └── lease expiry / requeue ──┘
   ├── director/human: requeue a failed|rejected|in-flight task ──▶ queued (attempt+1)
   └── director: cancel ──▶ canceled
```

- `queued → assigned` happens inside `await_work` (atomic claim in a SQLite
  transaction; dependency-unblocked, `released = 1`, priority DESC, age ASC;
  honors a pinned `assignee` if the director set one).
- **Release gate:** when the show's `requireTaskRelease` rule is on, `create_task`
  inserts the task with `released = 0`; it stays `queued` but is not claimable
  until a human releases it (`showrunner task release`, i.e. `POST
  /api/.../release`; the callboard is read-only and only badges it PENDING
  RELEASE). Off by default (the `REQUIRE_TASK_RELEASE` env sets the seed default
  for new shows), so OOTB automation is unchanged; the security lever for
  untrusted workers (see Security posture).
- `input-required` is distinct from `failed` on purpose: it means "a decision
  is needed", pings the director's poll, and pulses amber on the callboard.
- Terminal statuses are idempotent by task id: a worker whose lease was
  reaped can still report `completed`; if the task was requeued but not yet
  re-claimed, the report wins and the task completes (attempt noted).

### Leases (the only liveness mechanism)

| Lease | TTL (env) | Renewed by | On expiry |
|---|---|---|---|
| worker | 150s | any tool call by that member (polling is the heartbeat) | member shown stale on callboard (amber "heads-down" while it still holds a live-leased task); a task it holds requeues only when the owner is fully gone (see below) |
| task | 15 min | `update_task` (status/note/heartbeat) by assignee, or redelivery on the owner's next poll | task requeues, `attempt`+1, journal preserved |
| direction | 10 min | any tool call by the director | liveness only: callboard shows the holder stale and the show effectively headless, but the seat stays held -- expiry never lets anyone else claim it (see "Direction") |

A worker's `assigned`/`working` task is reaped **only** by the task lease, never by the
worker lease alone: a worker heads-down executing may not touch any tool for long stretches
well inside the 150s worker-lease window (it only has to heartbeat every ~10min), so treating a
stale worker lease as task abandonment would requeue -- and duplicate -- work that's still in
progress. `input-required` is similar under escalation parking: a parked task requeues only
when its owner is fully gone -- stale poll lease AND holding no other live-leased task -- so an
escalation the worker parked to take other work survives while that worker keeps making
progress. The sweep's owner-liveness guard treats "polling, or heartbeating any live task" as
alive.

No auto-promotion of workers to director, deliberately: every field report
says unattended swarms drift; a dead director costs nothing (state is in the
server) and the human appoints a new one with one sentence.

### Direction: election, transfer, fencing

One row per show: `{director_id, epoch, lease_expires_at}`, plus an append-only
`direction_events` audit log.

**Authority never transfers implicitly by timeout.** A non-takeover
`claim_direction` succeeds only when the seat is *unheld* -- never claimed,
explicitly released, or admin-cleared (`director_id IS NULL`) -- or when the
caller already holds it (renewal). A merely expired lease does **not** open the
seat: expiry keeps its liveness effects (callboard staleness, effectively
headless show) but the recorded holder stays put, so no one else can plain-claim
it. This closes the "wait out the lease, then grab the seat" path.

Three ways the seat legitimately changes hands, all explicit:

- `release_direction({epoch})` — the current holder stands down (epoch-fenced),
  clearing the holder and creating the unheld state a later plain claim can take.
- `claim_direction(takeover: true)` — succeeds unconditionally; the explicit
  human-authority recovery path for a dead director, and now the *only* way to
  displace a live-or-stale holder. The human is the authority (there is exactly
  one human).
- admin clear (`/api .../direction/clear`) — the human clears a runaway holder.

Every director-only tool takes the caller's `epoch`; the server rejects stale
epochs with a structured `superseded: ...` error, so the old director demotes
itself on its next call (no gossip protocol; the server is the sole arbiter, so
fencing is one integer compare). Every transition (`claimed | released |
takeover | admin_clear | expired`) is appended to `direction_events` with actor,
epoch, and timestamp; `get_board` and the callboard surface the current holder's
provenance (how they got the seat, when), so an unexpected holder is easy to
spot.

### The show playbook (SHOWRUNNER.md)

Generic protocol tells a director *how to direct*; it can't know how to
decompose *this* project. That knowledge lives in the repo, next to the code
it describes: `showrunner init` scaffolds `SHOWRUNNER.md` (area/file map,
task-granularity guidance, conventions, escalation rules) alongside
`.showrunner`, and the director protocol reads it immediately after
`claim_direction`, treating it as an override of the generic defaults. Repo
placement means it travels with every clone, worktree, and cloud checkout,
and a takeover director in a brand-new session picks it up with zero server
machinery. The server never stores or parses it.

### Showrunner rules (server-held show state)

Playbook is *how to break down this project*. Rules are *how the fleet
behaves*. Rules are **server-held per-show state, not a repo file** -- policy
that governs untrusted members must not be writable by them, and every worker
used to read `SHOWRUNNER.rules.md` from its own checkout. A show's rules split
into three layers, and the schema is explicit about which is which:

- **`switches`** -- structured, machine-enforced. The server reads each on the
  code path it governs: `requireTaskRelease` (the release gate, in
  `createTask`/`claimNextTask`), `workerNotePropagation` (in `pushNote` +
  `notesForTask`), `artifactTextMaxChars`/`artifactDataMaxBytes` (in
  `updateTask`), `requireInvite` (in `register`), `requireValidationOnComplete`
  (in `updateTask` -- a transition into `completed` is refused without a
  validation claim), and `requireHumanMergeApproval` (delivered, agent-followed
  -- there is no merge through the server to block; pair with the repo's branch
  protection for an enforced gate).
- **`directives`** -- named, individually-addressable **binding** hard rules
  (each `{id, text, severity: must|should, ...}`). Delivered as authenticated
  director policy and framed to the fleet as must-follow (not suggestions); the
  director CRUDs them by id (`add_directives`/`edit_directives`/`remove_directives`).
  Most are behavioral (e.g. "close superseded draft PRs", a project's
  definition-of-done): the server can't judge compliance, so `directives` are
  authoritative *policy* the fleet obeys, with `switches` as the mechanical
  backstop for the few rules the server can enforce.
- **`policy`** -- advisory prose, delivered but **never enforced**.

New shows are seeded with OOTB defaults (automation-favoring switches: release
gate off, merge approval off, notes propagate, validation-on-complete on) plus a
generic set of default `directives` (pull latest main before creating tasks,
plan-first + escalate design questions,
adversarially validate before done, PR hygiene / no orphaned superseded drafts,
escalate human-authority decisions) that the director can edit or remove.
`REQUIRE_TASK_RELEASE` and `REQUIRE_VALIDATION_ON_COMPLETE` are the
deployment-wide env defaults for those switches on new shows. The
director changes rules with the `update_rules` tool (director-token-gated,
epoch-fenced); the human edits them with `showrunner rules
set` / `showrunner rules directive` (admin `/api`); the callboard only displays them. Every change bumps `version`, records `updated_by`, and
notifies the cast via `send_message` to `all`. Delivery has token discipline:
`rules_version` rides on every task claim, and the full text is delivered at
`register` and re-delivered on the first poll after the version changes.
Delivered rules are tagged authenticated director policy, distinct from the
`untrusted_peer` envelope on peer content.

Sessions may fan out their own subagents to speed work; showrunner membership
and task ownership stay with the registered session.

### Membership: invites and eviction (director-controlled)

Who is in a show is the director's call, not anyone holding the shared worker
token. Two director-token, epoch-fenced tools plus one rule switch:

- `mint_invite` issues a **single-use, show-scoped** invite that expires; the DB
  stores only its SHA-256 (member-secret discipline), plaintext shown once.
  `register` exchanges an invite for the member's individual credential,
  consuming it atomically and recording provenance (which invite, minted by
  whom) on the member row.
- The `requireInvite` switch (default off) gates worker-token registration on a
  valid invite; the director token is exempt. Off keeps solo shows frictionless;
  on is how a show admits a specific outside agent.
- `evict_member` revokes the target's credential (`secret_hash -> NULL`, so every
  later call is `unauthorized_member`), requeues its in-flight task (attempt+1,
  journal kept), stamps the membership evicted (actor/time -- the audit trail on
  the row), and notifies the cast. Evicted members stay visible on `get_board`
  and the callboard, flagged. Eviction is durable only with `requireInvite` on;
  otherwise an evicted party can re-register with the shared worker token.

A compromised director can mint/evict at will -- membership control is only as
trustworthy as the director token; recovery is takeover + token rotation (see
docs/SECURITY.md).

## Shared notes: realtime memory

Agents working in parallel learn things the others need *now*, not on their
next manual search. Notes are append-only records (gotchas, decisions, env
quirks) in the same SQLite file, FTS5-indexed, and they reach other agents
through the machinery that already exists:

- **Push on save.** `save_note` finds non-author members whose *current,
  still-in-flight task* is related: `files_hint` glob overlap, same
  `task_id`, or same `context_id`. Each gets a `kind:"note"` message in its
  inbox regardless of whether its member lease is fresh -- a worker heads-down
  executing renews that lease only every ~10min, well inside the 150s window,
  and is exactly who a note about its task needs to reach. An unexpired lease
  additionally gets an immediate wake, so a parked `await_work` resolves
  within seconds; a stale one picks the note up on its next poll instead.
  Push criteria are structural on purpose (globs/task/context, never fuzzy
  text match): pushes must not be noisy, or agents learn to ignore them.
- **Recall at claim time.** When `await_work` hands out a task, the server
  attaches `relevant_notes`: files_hint glob-overlap hits first (the
  structural signal, privileged over fuzzy text), then BM25 over the task's
  title+brief fills the rest of the `NOTES_PER_TASK=4` budget. Bodies are
  trimmed to ~300 chars with a truncation marker when cut; there's no
  fetch-by-id (note ids aren't indexed for search) -- recover the full body
  with `search_notes` on distinctive words from the visible prefix. Knowledge
  from worker A reaches worker B exactly when B starts related work,
  unprompted.
- **Explicit search.** `search_notes({query})` -- BM25-ranked hits, compact
  shape (id/author/tags/body/timestamp, not the full Note row), untrimmed
  bodies, result count capped server-side regardless of the requested limit.

Caps keep the token discipline: bodies max `NOTE_MAX_CHARS=2000`, claim-time
attachment max 4 trimmed notes, search results capped server-side. Notes are
never edited or deleted (corrections are new notes, same as the rest of the
system). No vector search in v1; the FTS5 module is isolated so sqlite-vec
can slot in later if semantic recall earns its keep.

The protocol tells workers: read `relevant_notes` before starting a task;
after finishing one, save a note if you learned something the next agent
would want (with `files_hint` of the affected globs). Directors record
generalizable decisions (especially answers to `input-required`) as notes.

## MCP tool surface (15 tools)

Everything takes/returns compact JSON. `member_id` is explicit in every call
(the server is stateless per-request; reconnects and session restarts don't
matter).

**Shared:**

1. `register({show, kind, display_name?, capabilities?, session_url?,
   resume_hint?})` → `{member_id, member_secret, show, director,
   board_summary, rules, protocol}` — creates the show if new; `member_secret`
   is issued once and must accompany `member_id` on every later call (per-member
   auth); `rules` is the show's current server-held policy (authenticated,
   distinct from peer content); `protocol` is the full worker/director loop
   contract (~3k tokens), so even a client that ignored the server
   instructions knows what to do next. `session_url`/`resume_hint` are how
   a human opens this session's chat: only the session knows this, so it
   self-reports (cloud sessions their URL, local CLI sessions a resume
   command); the callboard renders it.
2. `await_work({member_id, wait_seconds?})` — **the long-poll.** Holds up to
   `min(wait_seconds, POLL_HOLD_SECONDS=50)`. Returns first-available of:
   a newly claimed task (worker), unread messages, direction-change or
   review-needed notices (director), else `{status:"nothing", hint}`.
   Renews the member lease. Callers re-poll immediately; the server adds
   0–2s jitter to the hold to de-synchronize herds.
3. `update_task({member_id, task_id, status?, note?, validation?, artifacts?})` —
   heartbeats the task lease; appends to the journal; sets status
   (`working|input-required|completed|failed|rejected`). Artifacts are typed
   parts: `{kind: branch|files|text|data, ...}` — e.g. the branch the worker
   pushed, files touched, a 3-line summary. `validation` is a claim of how the
   work was adversarially checked; when `requireValidationOnComplete` is on, a
   transition into `completed` without it (or a `note`) is refused. On a
   `failed`/`rejected` transition the reason (from `note`) becomes the task's
   `lastNote`, which rides along to the director's review item. The result
   carries any unread `messages`, so a heads-down worker hears about notes and
   answers on its ~10min heartbeat instead of only at its next `await_work`.
4. `send_message({member_id, to, body, task_id?})` — to a member id,
   `director`, or `all`. Delivered via the recipient's next `await_work`.
   There is no `human` target: a director needing the human's input asks in
   its own agent session, where the human is present.
5. `get_board({member_id, verbose?})` — director card, member list with
   staleness, task counts by status, in-flight task titles, escalations.
   Summary by default (~300 tokens); `verbose` adds journals.
6. `save_note({member_id, body, tags?, files_hint?, task_id?})` →
   `{note_id, delivered_to}` — see Shared notes above.
7. `search_notes({member_id, query, limit?})` → BM25-ranked hits, compact
   shape and untrimmed bodies; `limit` is capped server-side.

**Director-only (epoch-fenced):**

8. `claim_direction({member_id, takeover?})` → `{epoch, board_summary}`.
   Without `takeover`, succeeds only if the seat is unheld or the caller already
   holds it; a merely expired lease does not open it. `takeover:true` displaces
   any holder (the human-authority path). `release_direction({member_id,
   epoch})` → `{epoch}` lets the current holder give the seat up so a later plain
   claim can take it.
9. `create_task({member_id, epoch, title, brief, context_id?, depends_on?,
   files_hint?, priority?, assignee?})` → `{task_id}` — write a **substantial**
   brief (goal, context, acceptance criteria, constraints, how to verify) so the
   worker can plan and start without guessing; point at docs for the long stuff,
   but the brief must stand on its own (a bare pointer is not enough).
   `files_hint` globs power advisory overlap warnings: creating a task whose
   globs intersect an in-flight task's returns a warning (never a block) —
   partition, don't lock.
10. `direct_task({member_id, epoch, task_id, action, ...})` — `cancel`,
   `requeue`, `assign {assignee}`, `answer {body}` (for `input-required` →
   flips back to `working` and delivers the answer), `approve` (records a
   director-approval journal note; no gating today). `requeue` and `assign`
   work on a `failed`/`rejected` task (read its reason, then re-run it,
   attempt+1) as well as an in-flight one; only `completed`/`canceled` are final.
11. `take_input({member_id, epoch, task_id})` — take on an `input-required`
   escalation: messages the waiting worker that an answer is coming and stamps
   `input_taken_at` so the worker's escalation-wait clock re-bases (it keeps
   holding the parked task past `ESCALATION_WAIT_S` while the director fetches
   an answer). Does not resolve the task — the director still answers via
   `direct_task`; the director's `pending_input` age stays the true blocked age.
12. `update_rules({member_id, epoch, switches?, policy?, add_directives?,
   edit_directives?, remove_directives?})` → `{rules}` — set the show's
   server-held rules: machine-enforced `switches`, advisory `policy` prose,
   and/or the binding `directives` (named hard rules, edited by id). Bumps
   `version`, is audited (`updated_by`), and notifies the cast. The human's
   equivalent is the admin `/api` route (`showrunner rules set` / `rules directive`).
13. `mint_invite({member_id, epoch, ttl_seconds?})` → `{invite_token}` — mint a
   single-use, show-scoped invite (hash stored, plaintext once, expires) so a
   specific outside agent can register when `requireInvite` is on.
14. `evict_member({member_id, epoch, target})` — revoke a member's credential
   (all later calls `unauthorized_member`), requeue its in-flight task
   (attempt+1, journal kept), stamp the membership evicted, notify the cast.

### The one-line-prompt trick

The server's MCP `initialize` response carries `instructions` (~11KB,
auto-loaded into Claude Code context; also exposed as MCP prompt
`/showrunner:join` for Cursor and manual use):

> If the user tells you that you are a **worker** for show X: call
> `register`, then loop `await_work` forever; for each claimed task, sketch a
> short plan (approach, steps, files, risks) and record it as the task's
> opening journal entry before executing; execute in the current repo on a
> fresh branch named `show/<task_id>-<slug>`; heartbeat
> with `update_task` at least every 10 minutes while working; report
> `completed` with branch + summary artifacts; if blocked, set
> `input-required`, message the director, and keep polling. Do not stop
> polling because the queue is empty. If the user tells you that you are the
> **director**: `register` then `claim_direction(takeover: true)`; read the
> project state; break work into 5–20 minute tasks with substantial briefs
> (goal, acceptance criteria, constraints, how to verify) and non-overlapping
> `files_hint`; then loop `await_work`, reviewing completions, reading the reason
> on any `failed`/`rejected` task and requeuing or canceling it, answering
> `input-required`, creating follow-on tasks, and posting a digest note to the
> board every ~30 minutes.

That is the entire integration: configure the MCP server once per machine or
repo, and any future session understands "you're a showrunner worker".

### Plan before execute

A worker that starts editing the instant it claims a task underperforms one
that first reasons about the whole task — a substantial brief sets the *what*
(goal, acceptance criteria, constraints), but the *how* still has to be worked
out, and that reasoning should land somewhere durable. The worker
protocol makes it explicit: with the brief, `files_hint`, and `relevant_notes`
in hand, the worker sketches a short plan (approach, concrete steps, files it
expects to touch, risks/unknowns) and records it as the task's **opening
journal entry** — the same `update_task` call that flips the task
`assigned → working`, giving that documented-but-otherwise-dead state edge its
meaning: *has a plan and is executing*. No new tool, status, or schema; the
plan rides the journal that already exists, and a note+`working` update writes
it without disturbing the escalation clock or the current-task pointer.

Recording the plan, rather than merely forming it, is what makes it fit the
cattle model. A plan that lives only in the session dies with the session; a
plan in the task journal is server state — it renders on the callboard, so the
human and director see the intended approach *before* the work lands; it
survives the session being killed, so a replacement worker resumes from the
plan instead of re-deriving it; and it converts completion-time review into
early course-correction (the director's review loop is told to skim opening
plans and redirect an off-track approach cheaply). Planning also front-loads
the reject/escalate decision: a task that turns out wrong-fit or
under-specified is caught while the plan is being sketched, before work is
wasted, not at the end.

Crucially, planning is **not** a stop-and-wait approval gate. The worker
records the plan and proceeds; it never blocks on the human (who is not
watching its session), and a plan that surfaces a genuine decision goes to the
*director* through the ordinary `input-required` escalation — the same path as
any blocker — never to the user. That preserves showrunner's core rule that a
worker's only interface to the human is the director, and keeps the long-poll
loop moving instead of parking a session on local input that will never come.
This is a protocol/prompt change, consistent with "the prompt is the entire
integration surface" — the server enforces nothing here beyond delivering the
journal it already delivers.

### Worker context depletion

A polling worker slowly burns context. The protocol tells workers to prefer
finishing a task and letting the human recycle the session over heroics, and
the callboard shows per-member `age`/`tasks done` so the human can see when a
worker is long in the tooth. (Claude Code auto-compaction makes this mostly a
non-issue; Cursor sessions may need manual recycling.)

## Callboard (dashboard)

Single static HTML page served at `/`, polling `GET /api/shows/:show/state`
every 2s. No build step, no framework — one file, fetch + DOM.

- Director card: who, epoch, lease freshness, and **the
  chat link**: `session_url` renders as an "open chat ↗" link,
  `resume_hint` as click-to-copy code, neither as a dim hint that the
  session didn't report one.
- Members (the hero card: who is on, and on what): freshness dot, memorable
  id, kind + role badges, the current task rendered by **title and status**
  (joined from the task list, not an opaque id), tasks done, joined/seen
  ages, ↗ when a session_url was reported. **Sorted so whoever is actually
  working floats to the top** (on a live task, then live-idle, then stale).
  Director-affiliated members (role `director`, or the `director …`
  display-name convention) render under the director card, not here — a
  best-effort split, since there is no server-side "spawned by the director"
  flag. Long-stale sessions ("dormant") and evicted ones collapse behind
  toggles: leases only mark staleness (there is no eviction timer), so an
  8h-old row would otherwise bury the live cast.
- Task columns, each with a count: **queued** / **needs input** /
  **failures**. Queued and needs-input grow to the full list; failures
  shows the latest 20. Queued is ordered the way `await_work` claims
  (priority DESC, age ASC), so the top card is next in line, modulo
  unmet `depends_on` and pinned assignees, which the claim also honors.
  Failures (failed + rejected, the statuses agents report back) carry the
  agent's last journal entry with its original timestamp. In-flight has no
  column (it is what the members hero shows) and completed work just gets
  merged; both stay visible as totals in the tasks header. Click a task →
  journal.
- **Escalations pulse amber in place** (no banner): `input-required` tasks
  render in the needs-input column, so decisions waiting on the director have
  one home. Once a director has `take_input`-ed one, it shows a "director on
  it" badge (being handled, not just sitting). There is no `human`-message
  surface — a director asks the human directly in its own session.
- Rules and activity share the bottom row below the task board: rules in the
  narrow rail (display-only switches, binding directives, and advisory policy),
  the activity feed beside it.
- Activity (one demoted feed, collapsed by default): shared notes, task
  journal entries, and messages interleaved newest-first, last 50. The
  audit trail; the page stays read-only.

The callboard is deliberately a **window, not a control panel**: no task
forms, no message box, no admin actions. The human steers by talking to
the director agent in its own chat (that is what the chat link opens); the
director translates intent into tasks. Manual escape hatches live in the
CLI (`showrunner task add`, `message`, and the rest), which drives the
same `/api` endpoints the callboard reads.

Auth: `Authorization: Bearer` (or `?token=` once → cookie). Two tokens:

- `SHOWRUNNER_TOKEN` (required) — **director/admin**. Gates
  `claim_direction` / `create_task` / `direct_task` and mutating `/api`.
- `SHOWRUNNER_WORKER_TOKEN` (optional) — **worker**. When unset, equals the
  director token (single-token fallback). Safe to commit into project MCP
  configs so clones can register as workers without cloud secrets.

## Server & deploy

- **Stack:** TypeScript, Node 20+, `@modelcontextprotocol/sdk` (streamable
  HTTP, stateless mode), Hono for routing, better-sqlite3, Vitest.
- **Fly.io:** `shared-cpu-1x`, one machine, `auto_stop_machines = "off"`
  (autostop + long-poll is exactly the wrong pair), 1GB volume mounted at
  `/data` for SQLite. `fly secrets set SHOWRUNNER_TOKEN=... SHOWRUNNER_WORKER_TOKEN=...`.
- **Env knobs:** `SHOWRUNNER_TOKEN` (required), `SHOWRUNNER_WORKER_TOKEN`
  (optional), `PORT`, `DATA_DIR`, `POLL_HOLD_SECONDS=50`, `WORKER_LEASE_S=150`,
  `TASK_LEASE_S=900`, `DIRECTION_LEASE_S=600`, `ESCALATION_WAIT_S=900`, `NOTE_MAX_CHARS=2000`,
  `NOTES_PER_TASK=4`. Rule seed-defaults for new shows: `REQUIRE_TASK_RELEASE=false`,
  `REQUIRE_HUMAN_MERGE_APPROVAL=false`, `WORKER_NOTE_PROPAGATION=true`,
  `REQUIRE_INVITE=false`, `ARTIFACT_TEXT_MAX_CHARS=10000`,
  `ARTIFACT_DATA_MAX_BYTES=16384` (per-show values live in the show's rules and
  are changed with `update_rules`).
- **Reclaim sweep:** one `setInterval` (5s) expires leases, requeues tasks,
  wakes relevant waiters. Restart-safe because all state is in SQLite.

## Client configuration (README material)

| Client | How | Notes |
|---|---|---|
| Claude Code local/cloud | committed `.mcp.json`: hardcoded worker Bearer on `showrunner`; `${SHOWRUNNER_TOKEN}` on `showrunner-director` | workers need no env; director sessions set director token |
| Cursor local | `.cursor/mcp.json` same split (`${env:SHOWRUNNER_TOKEN}` for director) | 3.0+; allowlist/auto-run tools |
| Cursor cloud | dashboard MCP: paste URL + hardcoded *worker* token | best-effort; director needs director token separately (as of 3.8) |

## Security posture

A show may include agents run by other people, so directors and workers do not
trust each other. The design goal is not "no agent is ever fooled" (prompt
injection makes that unreachable for any system that feeds an LLM
attacker-controlled text); it is that a fooled agent still can't cause harm,
because the capabilities that would let it aren't reachable through showrunner.
See [SECURITY.md](docs/SECURITY.md) for the threat model and the full layering.
The four controls, strongest first:

1. **Per-member auth (real boundary).** `register` issues a per-member secret;
   the DB stores only its SHA-256; every later tool call must present it
   (constant-time check). `member_id` is a board-visible handle, not a
   credential -- without this, anyone holding the shared worker bearer could
   pass any `member_id` and act as that member (impersonate a peer, speak as the
   director, complete/poison another worker's task). Unknown member and wrong
   secret return the same `unauthorized_member` result, so there's no member-id
   oracle.
2. **Human release gate (real boundary, opt-in).** With the show's
   `requireTaskRelease` rule on, a director-created task is withheld (not
   claimable) until a human releases it (`showrunner task release`; the
   read-only callboard badges it PENDING RELEASE) -- the deterministic check
   against a malicious or compromised director admitting work no human vetted.
   This and the other fleet rules are server-held per-show state, not a
   repo file a worker could edit (see "Showrunner rules").
3. **Runtime containment (the real host boundary, not ours).** showrunner
   cannot stop a worker's host from running `curl`; only the agent runtime's
   own permissions can. So "can't upload host files" is enforced by running
   workers under a locked-down runtime (repo-scoped FS, network allowlist, no
   host-secret access) and by never handing out work that needs more. SECURITY.md
   states this as a precondition.
4. **Dual bearer tokens + untrusted-content annotation (defense in depth).**
   The committable worker token can register/pull/write but not direct; keep the
   director token secret and rotate via `fly secrets set`. On delivery, every
   peer-authored field (brief, note, message, artifact) is tagged
   `trust:"untrusted_peer"` with fixed guidance. This is a mitigation, not a
   boundary: it labels data as data, it does not sanitize it.

Non-goals (v1): show-level ACLs, task-content encryption, and server-side
content classification. Keep secrets out of task briefs; point at repo files.

## What v1 explicitly skips

- Auto-promotion / worker consensus on a new director (human appoints).
- MCP Tasks (SEP-1686 call-now/fetch-later) — poll loop is isolated in one
  module so it can be swapped when client support matures.
- MCP channels push for Claude Code (optional enhancement; Cursor has no
  equivalent, long-poll must exist anyway).
- Slack notifications (callboard is the v1 escalation surface).
- Git integration (workers use ordinary branches; the artifacts convention
  carries branch names; merging is a director task like any other).
