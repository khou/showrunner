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
> and follow it: deploy the server to my Fly account, verify it, connect
> the agent clients I use, and initialize this repo as a show. Ask me
> before anything that costs money or edits config outside this repo.

You bring a [Fly.io](https://fly.io) account (the agent will prompt you to
`fly auth login` if needed; login and billing stay in your hands). The agent
deploys the server (one small always-on machine, ~$3/mo), wires your
clients, scaffolds this repo, and finishes as the show's director with your
dashboard link. Prefer doing it by hand? [docs/SETUP.md](docs/SETUP.md) is
the same runbook, human-readable.

From then on, in any session in the repo:

> "You're a showrunner worker."

> "You're the showrunner director."

See [DESIGN.md](DESIGN.md) for why it's built this way, and
[docs/OPERATING.md](docs/OPERATING.md) for everything operational: client
setup, the callboard tour, shared notes and rules, env knobs, the CLI,
verifying a deployment, FAQ, and security posture.

## License

MIT, see [LICENSE](LICENSE).
