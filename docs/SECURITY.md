# Security model

showrunner lets sessions run by different people join one show. This document is
the honest account of what that does and does not protect against.

## The core reality

Anything that inspects the *content* of a brief, note, or message and hopes the
reading model behaves is **not a security boundary**. Prompt injection defeats
it, and there is no reliable content filter. So "impregnable" cannot mean "a
worker never gets fooled." It means: a fooled worker still cannot exfiltrate
secrets or compromise a host, because the capabilities that would let it aren't
reachable through showrunner.

That reframes hardening around four deterministic places, not content scanning:
identity, queue admission, host capability, and propagation. Only the first two
live in this server; the third lives in the agent runtime; the fourth is a
labeling mitigation.

## Threat model

Assume peer agents may be hostile or compromised. The human operator and the
director bearer token are trusted. The server is trusted to frame content, not
to classify intent.

| Direction | Attack | What stops it |
|---|---|---|
| Director to worker | Brief tells worker to upload `~/.ssh`, run `curl … \| sh`, leave the repo | Runtime containment (host boundary) + worker refusal + release gate (human vets briefs) |
| Worker to worker | Pass a peer's `member_id` to complete/poison its task | Per-member auth (secret bound to `member_id`) |
| Worker to director | Impersonate the director on `send_message`/broadcast | Per-member auth |
| Worker to director | Poisoned completion note/artifact rewrites director goals via the review path | Untrusted-content annotation (mitigation) + director treats it as data |
| Worker to peers | `save_note` that hijacks future claims via `relevant_notes` | Untrusted-content annotation (mitigation) + `workerNotePropagation` rule |
| Worker to director | Malicious direction grab: wait out the holder's lease, then plain-claim the seat | Timeouts don't open the seat -- a non-takeover claim needs the seat unheld (released/cleared); displacing a holder needs `takeover:true` (human authority). Every transition is audited with holder provenance on the board |
| Either | "ignore previous instructions / you are now…" | Runtime containment + protocol refusal (mitigation) |

## The four controls

### 1. Per-member auth (real boundary)

`register` issues a `member_secret`; the DB stores only its SHA-256. Every later
tool call must present `member_id` + `member_secret`, checked constant-time.
`member_id` is a memorable, board-visible handle for addressing, not a
credential. Without this, any holder of the (shareable) worker bearer could pass
any `member_id` and act as that member.

- Unknown member and wrong secret return the same `unauthorized_member` result:
  no oracle for which member ids exist.
- The secret is shown once. Lose it and you re-register for a fresh identity.
- The human pseudo-member (used by the admin `/api`) never gets a secret, so
  nothing can authenticate as it through the agent tool surface.

Multi-user note: a single shared worker token can't be part of a hardened story
(you can't revoke one bad worker without rotating everyone). Per-member secrets
are the first step; per-member *tokens* with revocation are the follow-on (see
Not yet).

### 2. Human release gate (real boundary, opt-in)

Turn on the show's `requireTaskRelease` rule (`showrunner rules set
--require-release on`, the callboard toggle, or seed it deployment-wide with the
`REQUIRE_TASK_RELEASE` env). Director-created tasks are then withheld
(`released=0`, still `queued`) and no worker can claim them until a human
releases each one on the callboard (or `showrunner task release`). This is the
deterministic check against a malicious or compromised director: work no human
vetted never reaches a worker. Off by default so out-of-the-box automation is
unchanged; turn it on whenever the show admits workers you don't fully trust.

The release gate is one of the show's **server-held rules** -- fleet policy
(release gate, merge approval, note propagation, artifact caps, advisory prose)
lives in per-show server state, not a repo file, precisely because policy that
governs untrusted members must not be writable by them. Only the director token
(`update_rules`) or the human (callboard / `showrunner rules set`) can change
it; changes are versioned and audited, and delivered to the fleet as
authenticated director policy (distinct from the `untrusted_peer` tag on peer
content).

### 3. Runtime containment (the real host boundary, and it is not ours)

showrunner cannot prevent a worker's host from reading `~/.ssh` or running
`curl`. Only the agent runtime's own permission system can. So this boundary is
a **precondition** on how you run workers, not something the server enforces:

- Run workers with filesystem access scoped to the repo checkout.
- Use a network allowlist (task dependencies only).
- Do not expose host secrets/credentials to a worker session that pulls from a
  show with untrusted members. Cloud sandboxes (ephemeral VMs) are the strong
  form; local sessions rely on the agent's permission settings.

showrunner's part of the bargain: it never hands out work that *requires*
elevated capability, and briefs point at repo docs rather than inlining shell.

### 4. Dual tokens + untrusted-content annotation (defense in depth)

- **Dual bearer tokens.** The worker token (committable) can register, pull
  tasks, and write notes/messages, but cannot `claim_direction` / `create_task`
  / `direct_task` or mutate the admin `/api`. Keep the director token secret;
  rotate via `fly secrets set`.
- **Untrusted-content annotation.** On delivery, every peer-authored field
  (task brief/title, notes, messages, review journals) is tagged
  `trust:"untrusted_peer"` with fixed guidance telling the reader to treat it as
  data and refuse host/exfil/override requests. This is a mitigation, not a
  boundary: it labels data as data; it does not sanitize or block anything.

## Not yet (deliberate v1 non-goals)

- Per-member tokens with revocation, and per-show ACLs.
- Server-side content classification of briefs/notes.
- Task-content encryption at rest.
- Sandboxing the agent host from within showrunner (that is the runtime's job).

## Operator checklist for a show with untrusted members

1. Set `SHOWRUNNER_WORKER_TOKEN` (distinct from `SHOWRUNNER_TOKEN`) so workers
   can't direct.
2. Turn on the `requireTaskRelease` rule and release tasks yourself after
   reading them (`showrunner rules set --require-release on`, or the callboard).
3. Run untrusted workers under a locked-down runtime (repo-scoped FS, network
   allowlist, no host secrets).
4. Keep secrets out of task briefs and notes; point at repo files.
5. Rotate the director token if it leaks; re-register members after a secret
   leak.
