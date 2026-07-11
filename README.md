# showrunner

A tiny always-on MCP server that coordinates multiple coding-agent sessions
on one project (a "show"). Deploy it once. Then, from inside any project
repo, tell any agent session, local or cloud, Claude Code or Cursor, "you're
a showrunner worker" and it registers, starts pulling tasks, and reports
back; tell a second session "you're the showrunner director" and it takes
over planning: breaking work into tasks, reviewing results, answering
blockers. State lives on the server, not in any session, so sessions are
cattle: kill one anytime and a new one picks up exactly where it left off.
One SQLite file, one static dashboard, ten MCP tools.

![The callboard: a director and three workers across Claude Code and Cursor, tasks moving through the columns, and a blocker escalated to the human](assets/callboard.png)

## Get started

Paste this into any coding agent with shell access (Claude Code, Cursor),
from inside the project repo you want coordinated:

> Set up showrunner for me. Fetch
> https://raw.githubusercontent.com/khou/showrunner/main/docs/SETUP.md
> and follow it: deploy the server to my Fly account, verify it, initialize
> this repo as a show, and become the idle director. Ask me before anything
> that costs money or edits config outside this repo.

You bring a [Fly.io](https://fly.io) account (the agent will prompt you to
`fly auth login` if needed; login and billing stay in your hands). The agent
deploys one small always-on machine (~$3/mo), runs `showrunner init` in this
repo, and finishes as the show's director with your callboard link. Prefer
doing it by hand? [docs/SETUP.md](docs/SETUP.md) is the same runbook.

### After setup: two tokens, two prompts

`init` writes:

| Piece | Where | Who uses it |
|---|---|---|
| **Worker** bearer | committed in `.mcp.json` / `.cursor/mcp.json` under `showrunner` | any clone / cloud worker (no secrets setup) |
| **Director** bearer | gitignored `.env` as `SHOWRUNNER_TOKEN`; MCP entry `showrunner-director` | trusted director sessions only |

Only the director token can `claim_direction`, create tasks, mutate the
callboard API, or change the show's rules. Each session also gets a per-member
secret at `register`, so one member can't act as another.

In a worker session (MCP already configured from the repo):

> You're a showrunner worker.

In a director session (`showrunner-director` MCP + `SHOWRUNNER_TOKEN` in env):

> You're the showrunner director.

### Ways to run

- **A. Simple fleet** — one director + N general workers (default).
- **B. Dedicated lanes (optional)** — open role-focused sessions (e.g. art /
  verify) with a clear `display_name` and pin matching tasks with `assignee`
  (note the preference in `SHOWRUNNER.md`). Useful when some sessions have tools
  others lack (laptop secrets, GPU, browser, local stack vs cloud).

Fleet rules (release gate, merge approval, note propagation, artifact caps,
advisory policy) are **server-held show state**, not a repo file, so policy that
governs untrusted members isn't editable by them. Change them with
`showrunner rules set` or on the callboard.

If the show includes agents run by other people, read
[docs/SECURITY.md](docs/SECURITY.md) first. See [DESIGN.md](DESIGN.md) for why
it's built this way, and [docs/OPERATING.md](docs/OPERATING.md) for client
setup, callboard, notes, rules, env knobs, CLI, FAQ, and security.

## License

MIT, see [LICENSE](LICENSE).
