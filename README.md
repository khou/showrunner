# showrunner

A tiny always-on MCP server that coordinates multiple coding-agent sessions
on one project (a "show"). Deploy it once. Then, from inside any project
repo, tell any agent session, local or cloud, Claude Code or Cursor, "you're
a showrunner worker" and it registers, starts pulling tasks, and reports
back; tell a second session "you're the showrunner director" and it takes
over planning: breaking work into tasks, reviewing results, answering
blockers. State lives on the server, not in any session, so sessions are
cattle: kill one anytime and a new one picks up exactly where it left off.
One SQLite file, one read-only dashboard, a small fixed MCP tool surface.

![The callboard: a director and three workers across Claude Code and Cursor, tasks moving through the columns, and a blocker escalated to the human](assets/callboard.png)

## Get started

1. Paste into any coding agent with shell access (Claude Code, Cursor), from inside the project repo you want coordinated:

   > Set up showrunner for me. Fetch
   > https://raw.githubusercontent.com/khou/showrunner/main/docs/SETUP.md
   > and follow it: deploy the server to my Fly account, verify it, initialize
   > this repo as a show, and become the idle director. Ask me before anything
   > that costs money or edits config outside this repo.

2. Paste into each session opened in this repo that you want doing work:

   > You're a showrunner worker.

3. Paste into a session that holds the director token (the setup session already does):

   > You're the showrunner director.
