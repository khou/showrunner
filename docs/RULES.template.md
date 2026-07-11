# Showrunner rules

User-editable. The director reads this after `claim_direction` and reminds
workers; every worker re-reads it when claiming a task. Playbook
(`SHOWRUNNER.md`) is how to decompose this project; this file is how the
fleet behaves.

## Automation defaults (flip to change)

**Default path: feature branch → PR → squash-merge when green.**
Do **not** commit or push directly to `main` unless you flip that below.

| Default | Setting |
|---|---|
| **ON** | Open a PR when a task has a reviewable unit |
| **ON** | Squash-merge that PR when verify is green (do not wait for the human) |
| **OFF** | Require human approval before merge |
| **OFF** | Allow direct commits/pushes to `main` (keep off; use PR → squash-merge) |
| **ON** | Close superseded / abandoned drafts in the same session |
| **ON** | Verification is part of done (see verify step in `SHOWRUNNER.md`) |

To require human merge approval: set "Require human approval before merge" to
**ON**. The path remains PR → squash-merge after approval — still not
direct-to-main.

## Dedicated workers (optional)

Use this when some sessions have tools others lack (laptop with local secrets,
GPU, browser, or a running stack vs a cloud VM). Soft preferences only: list
lanes below, open a role-focused worker with a clear `display_name`, and the
director pins matching tasks with `assignee`.

By default assign any idle registered worker:

- *(none)* — example: prefer one worker for visual/art; prefer one for verify/playtest

## Subagents

Sessions may fan out their own subagents to speed up work. Encouraged when it
helps. Showrunner task ownership stays with the registered session.

## Models (optional)

Model choice is normally up to whoever opens the session. Edit only if the
director itself spawns cloud agents via API keys:

- Smarter models for strategic / architectural / design-direction work
- Cheaper/faster models for routine implementation
- Prefer plan-included models when cost matters; still prefer capable over weak when the task is hard
- Do not hardcode vendor-specific model IDs unless you want to

## Project rules

Add show-specific standing rules below. Keep them short; point at docs.
