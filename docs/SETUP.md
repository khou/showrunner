# Setup runbook

Written for a coding agent (Claude Code, Cursor, or similar with shell
access) executing on the user's behalf. Humans can follow it too. Every
step is idempotent: check before you create, and re-running after a
partial failure is safe.

Agent ground rules:
- Ask before anything account-shaped or persistent: creating the Fly app
  (costs ~$2-3/month), editing shell profiles, installing LaunchAgents,
  changing app configs outside the project repo.
- The **director** bearer token is a secret. Never commit it, never paste it
  into web pages, never echo it in full except in the final callboard link.
  The **worker** token is intended to be committed into project MCP configs.
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

Generate two tokens. Director stays private (`~/.showrunner-token`); worker
may be committed into project MCP configs after init.

```bash
TOKEN_FILE=~/.showrunner-token
WORKER_TOKEN_FILE=~/.showrunner-worker-token
[ -f "$TOKEN_FILE" ] || (openssl rand -hex 24 > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE")
[ -f "$WORKER_TOKEN_FILE" ] || (openssl rand -hex 24 > "$WORKER_TOKEN_FILE" && chmod 600 "$WORKER_TOKEN_FILE")
fly secrets set \
  SHOWRUNNER_TOKEN="$(cat $TOKEN_FILE)" \
  SHOWRUNNER_WORKER_TOKEN="$(cat $WORKER_TOKEN_FILE)" \
  -a "$APP" --stage
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
SR_URL=$URL SR_TOKEN=$(cat $TOKEN_FILE) \
  SR_WORKER_TOKEN=$(cat $WORKER_TOKEN_FILE) \
  npx tsx scripts/live-verify.mts
```

live-verify drives the full lifecycle (register, direction, long-poll
wake, notes, takeover) with the real MCP client; when `SR_WORKER_TOKEN` is
set it also asserts the worker bearer cannot claim direction. All checks
must PASS. It creates a throwaway `verify-*` show; clean it up:

```bash
node dist/cli/index.js show delete --show <the verify-* show it printed> --url $URL --token $(cat $TOKEN_FILE)
```

## 4. Connect the user's agent clients

Prefer repo-committed MCP from step 5 (`init`) over user-global MCP adds.
Workers use the hardcoded worker token in `.mcp.json` / `.cursor/mcp.json`.
Director sessions need `SHOWRUNNER_TOKEN` (director) in the local/cloud env
for the `showrunner-director` entry.

**Cursor cloud agents:** dashboard-only as of 3.8 — paste URL + literal
**worker** token for workers; director sessions need the director token
separately. Point the user at it; do not handle tokens in a browser for them.

**Claude Code cloud:** committed `.mcp.json` is enough for workers. Director
sessions add `SHOWRUNNER_TOKEN` to cloud env and allowlist `<APP>.fly.dev`.

## 5. Initialize the project repo as a show

In the repo the user wants coordinated (show name defaults to the repo
name; keep it):

```bash
cd <project repo>
node ~/showrunner/dist/cli/index.js init \
  --show <repo-name> \
  --url $URL \
  --token "$(cat $TOKEN_FILE)" \
  --worker-token "$(cat $WORKER_TOKEN_FILE)"
```

This scaffolds `.showrunner`, `SHOWRUNNER.md`, `SHOWRUNNER.rules.md`,
committed dual-token MCP configs (worker Bearer hardcoded), and a gitignored
`.env` with the director token. It prints the callboard link and ways-to-run.
Then:

1. Fill in `SHOWRUNNER.md` for THIS project: read the repo (README,
   docs, build commands) and draft the playbook honestly. Show the
   user before committing.
2. Commit `.showrunner`, `SHOWRUNNER.md`, `SHOWRUNNER.rules.md`, `.mcp.json`,
   `.cursor/mcp.json` (never `.env`).

## 6. Take direction

You, the setup agent, become the show's first director: call `register`
(with `session_url`/`resume_hint` if you can determine them) and
`claim_direction({takeover: true})`, and read the playbook per protocol.
**Create no tasks.** Planning starts when the user tells you what they
want; setup ends with a healthy, idle show.

## 7. Final report and hand-off

Tell the user, concretely:

- **The callboard link**, without pasting the raw secret into the
  transcript:
  ```bash
  open "https://<APP>.fly.dev/?token=$(cat <token file>)"
  ```
  Opening it once signs the browser in; the URL cleans itself. The board
  should show this session as director, no tasks, no escalations.
- **The status check** they can run anytime to confirm everything is
  healthy:
  ```bash
  curl -s https://<APP>.fly.dev/healthz
  node ~/showrunner/dist/cli/index.js status --show <show> --url https://<APP>.fly.dev --token $(cat <token file>)
  ```
  Healthy means: `{"ok":true}`, the status shows a live director (this
  session), and zero stale members.
- **The suggested next step**: open another agent session in this repo
  and say "You're a showrunner worker." It appears on the callboard
  within seconds. Then tell THIS session what to build; as director it
  turns intent into tasks and the workers pick them up.
- Where things live: token file, server app name, the clone path (CLI:
  `node ~/showrunner/dist/cli/index.js`, alias suggestion in
  docs/OPERATING.md).
- Anything you skipped or that needs their hand (cloud dashboards,
  profile edits they declined).
