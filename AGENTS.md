## Learned User Preferences

- Prefer dual-token auth: a shareable/commitable worker token so remote agents can join without cloud secrets; keep the director token secret and alone able to claim direction or mutate admin APIs.
- `showrunner init` should write the director token to `.env`, document worker registration from committed showrunner/MCP files, and keep README/SETUP examples aligned.
- Onboard may guide optional role specialization via show rules (dedicated workers for art, local tools, etc.) when the user wants that pattern.
- Leave subagent fan-out to workers; directors may nudge workers to use their own subagents without over-documenting ownership mechanics.
- For cross-user worker shows, prefer hard security boundaries beyond protocol rules (identity, admission gates, runtime posture); server-held rules should be mutable only with the director token.
- Keep README, SETUP, and agent-facing instructions in sync whenever the auth or security model changes.
- Product changes belong in the showrunner repo; consumer projects should re-init rather than hand-patching old scaffolding.

## Learned Workspace Facts

- Auth uses `SHOWRUNNER_TOKEN` (director) and `SHOWRUNNER_WORKER_TOKEN` (worker); the worker token is intended to be shareable/committable for remote agents.
- The maintainer's production Fly app is separate from consumer project Fly apps; names and secrets do not collide.
- Worker role specialization is expressed through show rules, not by showrunner owning or routing subagents.
