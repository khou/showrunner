# Setup runbook

Written for a coding agent (Claude Code, Cursor, or similar with shell
access) executing on the user's behalf. Humans can follow it too. Every
step is idempotent: check before you create, and re-running after a
partial failure is safe.

Agent ground rules:
- Ask before anything account-shaped or persistent: creating the Fly app
  (costs ~$2-3/month), editing shell profiles, installing LaunchAgents,
  changing app configs outside the project repo.
- The bearer token is a secret. Never commit it, never paste it into web
  pages, never echo it in full except in the final callboard link.
- Report progress as you go; finish with the "Final report" section.

## 0. Prerequisites

**The user must bring a Fly.io account.** Signing up (fly.io, needs a
payment method; the server costs ~$2-3/month) and authenticating are the
human's job, in their browser. Agents: never create accounts, never
enter credentials; if auth is missing, stop and ask the user to run
`fly auth login` (or `fly auth signup`) themselves, then re-check.

```bash
flyctl version || brew install flyctl     # or curl -L https://fly.io/install.sh | sh
fly auth whoami                           # must print their account before you continue
node --version                            # need 20+
git --version
```

## 1. Get the code

Clone anywhere durable (the CLI runs from here later):

```bash
git clone https://github.com/khou/showrunner ~/showrunner 2>/dev/null || true
cd ~/showrunner && git pull --ff-only && npm install && npm run build
```

## 2. Deploy the server

Pick an app name (must be globally unique on Fly; `showrunner-<something>`)
and a region near the user (`fly platform regions`; the repo default is
`sjc`).

```bash
cd ~/showrunner
APP=showrunner-<something>
REGION=sjc
fly apps create "$APP" || { echo "name taken, pick another"; }
sed -i '' "s/^app = .*/app = \"$APP\"/" fly.toml
sed -i '' "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml
fly volumes create showrunner_data --size 1 --region "$REGION" -a "$APP" --yes
```

Generate the token. Default home is `~/.showrunner-token`; if that file
already exists, this machine has a deployment already: reuse it only if
you are re-deploying the SAME app, otherwise pick a different filename
and use it consistently below.

```bash
TOKEN_FILE=~/.showrunner-token
[ -f "$TOKEN_FILE" ] || (openssl rand -hex 24 > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE")
fly secrets set SHOWRUNNER_TOKEN="$(cat $TOKEN_FILE)" -a "$APP" --stage
fly deploy -a "$APP"
```

Do not edit `[http_service.tls_options]` in fly.toml: the forced
HTTP/1.1 ALPN works around client HTTP/2 stacks stalling requests behind
the long-poll. Do not commit the fly.toml app-name change.

## 3. Verify the deployment

```bash
URL=https://$APP.fly.dev
curl -sf $URL/healthz                                    # {"ok":true}
curl -s $URL/api/shows | head -1                         # 401 (auth works)
SR_URL=$URL SR_TOKEN=$(cat $TOKEN_FILE) npx tsx scripts/live-verify.mts
```

live-verify drives the full lifecycle (register, direction, long-poll
wake, notes, takeover) with the real MCP client; all checks must PASS.
It creates a throwaway `verify-*` show; clean it up:

```bash
node dist/cli/index.js show delete --show <the verify-* show it printed> --url $URL --token $(cat $TOKEN_FILE)
```

## 4. Connect the user's agent clients

Ask which of these the user actually uses, and do only those.

**Claude Code (CLI + desktop):**

```bash
claude mcp add --transport http --scope user showrunner $URL/mcp \
  --header "Authorization: Bearer $(cat $TOKEN_FILE)"
```

If the `claude mcp` subcommand is unavailable in your session, give the
user the command to run themselves rather than editing `~/.claude.json`
by hand.

**Cursor (desktop):** merge into `~/.cursor/mcp.json` (back it up first,
preserve existing servers):

```json
"showrunner": {
  "url": "<URL>/mcp",
  "headers": { "Authorization": "Bearer ${env:SHOWRUNNER_TOKEN}" }
}
```

`${env:...}` needs the variable in the app's environment:
- Terminal-launched sessions: add to the shell profile (ask first):
  `export SHOWRUNNER_TOKEN="$(cat ~/.showrunner-token)"` and
  `export SHOWRUNNER_URL="https://<APP>.fly.dev"`.
- Dock-launched GUI apps do not read shell profiles: `launchctl setenv
  SHOWRUNNER_TOKEN ...` now, plus (ask first) a LaunchAgent that re-runs
  it at login. Restart the app to pick it up.
- Tell the user: allow/auto-run the showrunner tools in the client's MCP
  settings, or worker poll loops stall on approval prompts.

**Cursor cloud agents:** config lives ONLY in the cursor.com dashboard
(repo `.cursor/mcp.json` is ignored there and env interpolation is
broken, as of Cursor 3.8): the user pastes the server URL + literal
token there themselves. Point them at it; do not handle the token in a
browser for them.

**Claude Code cloud (claude.ai/code):** the committed `.mcp.json` from
step 5 is picked up automatically; the user adds `SHOWRUNNER_TOKEN` to
the cloud environment settings and allowlists the `<APP>.fly.dev` domain.

## 5. Initialize the project repo as a show

In the repo the user wants coordinated (show name defaults to the repo
name; keep it):

```bash
cd <project repo>
SHOWRUNNER_TOKEN=$(cat $TOKEN_FILE) node ~/showrunner/dist/cli/index.js init --show <repo-name> --url $URL
```

This scaffolds `.showrunner` (name pin), `SHOWRUNNER.md` (director
playbook), `.mcp.json` + `.cursor/mcp.json` (client configs), and a
gitignored `.env`. Then:

1. Fill in `SHOWRUNNER.md` for THIS project: read the repo (README,
   docs, build commands) and draft the playbook honestly: what the
   project is, area/file map for `files_hint`, conventions workers must
   follow (build/test commands), what escalates to the human. Show the
   user before committing.
2. Commit `.showrunner`, `SHOWRUNNER.md`, `.mcp.json`,
   `.cursor/mcp.json` (never `.env`).

## 6. Final report

Tell the user, concretely:
- The callboard link: `https://<APP>.fly.dev/?token=<token>` (opening it
  once signs the browser in; the URL cleans itself).
- The two sentences that make any session join:
  "You're a showrunner worker." / "You're the showrunner director."
- Where things live: token file, server app name, the clone path (CLI:
  `node ~/showrunner/dist/cli/index.js`, alias suggestion in
  docs/OPERATING.md).
- Anything you skipped or that needs their hand (cloud dashboards,
  profile edits they declined).
