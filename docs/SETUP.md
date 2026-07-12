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
`sjc`). This is a separate Fly app from any other project the user already
runs on Fly (e.g. a game world); names and secrets do not collide.

```bash
cd ~/showrunner
APP=showrunner-<something>
REGION=sjc
fly apps create "$APP" || { echo "name taken, pick another"; }
sed -i '' "s/^app = .*/app = \"$APP\"/" fly.toml
sed -i '' "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml
fly volumes create showrunner_data --size 1 --region "$REGION" -a "$APP" --yes
```

Generate **two** tokens and store them on the machine (not in git):

| File | Env on Fly | Role |
|---|---|---|
| `~/.showrunner-token` | `SHOWRUNNER_TOKEN` | director / admin (secret) |
| `~/.showrunner-worker-token` | `SHOWRUNNER_WORKER_TOKEN` | worker (safe to commit into MCP later) |

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
wake, notes, takeover) with the real MCP client; with `SR_WORKER_TOKEN` set
it also asserts the worker bearer cannot claim direction or mutate `/api`.
All checks must PASS. It creates a throwaway `verify-*` show; clean it up:

```bash
node dist/cli/index.js show delete --show <the verify-* show it printed> \
  --url $URL --token $(cat $TOKEN_FILE)
```

## 4. Initialize the project repo as a show

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

`init` requires both tokens (fails loudly if either is missing or they are
equal). It writes:

| Path | Committed? | Contents |
|---|---|---|
| `.showrunner` | yes | show name pin |
| `SHOWRUNNER.md` | yes | director playbook template |
| `.mcp.json` / `.cursor/mcp.json` | yes | `showrunner` = hardcoded **worker** Bearer; `showrunner-director` = `${SHOWRUNNER_TOKEN}` / `${env:SHOWRUNNER_TOKEN}` |
| `.env` | **no** | `SHOWRUNNER_TOKEN` (director) + `SHOWRUNNER_URL` |

Fleet rules are **not** a repo file: they are server-held per-show state, seeded
with OOTB defaults on the server and edited with `showrunner rules set` (the
callboard only displays them). `init` also prints the callboard magic link and copy-paste
worker/director prompts (ways to run: simple fleet vs dedicated lanes).

Then:

1. Fill in `SHOWRUNNER.md` for THIS project (README, docs, build commands,
   area/`files_hint` map, escalation). Show the user before committing.
2. Commit `.showrunner`, `SHOWRUNNER.md`, `.mcp.json`, `.cursor/mcp.json`.
   Never commit `.env`. Adjust fleet rules later with `showrunner rules set`
   (e.g. `--require-release on` for a show with untrusted workers).

## 5. How clients connect (after init)

Prefer the **repo-committed** MCP from step 4. Do not add a user-global
showrunner MCP that hardcodes the director token for everyone.

- **Workers (local or Claude Code cloud):** open the project; committed
  `showrunner` MCP is enough. No env var required. Paste (the loop rule goes
  in the FIRST line -- cloud clients treat "task done, summarize" as
  end-of-turn if it isn't):
  `You're a showrunner worker. Loop forever: await_work -> plan the task
  (record the plan with update_task) -> execute -> update_task -> await_work.
  Finishing a task is never a reason to stop; only eviction or my stop message
  ends the loop.`
- **Director (this setup session and later trusted sessions):** need the
  `showrunner-director` MCP entry plus `SHOWRUNNER_TOKEN` in the process
  env (from `.env` / shell / cloud Runtime Secret). Paste:
  `You're the showrunner director.`
- **Cursor cloud:** Cloud Agents do NOT load repo `.mcp.json` /
  `.cursor/mcp.json` (as of 3.8). The operator must add the showrunner HTTP
  MCP in the Cursor Cloud Agents / Integrations dashboard (URL + literal
  **worker** token) so `await_work` is a native tool; director sessions need
  the **director** token separately. Point the user at the dashboard; do not
  handle tokens in a browser for them. Sessions with shell access can skip
  MCP entirely and drive the `/v1` HTTP mirror with curl (same tools, same
  tokens; see docs/OPERATING.md "The /v1 HTTP mirror").
- **Claude Code cloud directors:** add `SHOWRUNNER_TOKEN` to cloud env and
  allowlist `$APP.fly.dev`. Workers need neither.

## 6. Take direction

You, the setup agent, become the show's first director: use the
**showrunner-director** tools, call `register` (with `session_url` /
`resume_hint` if you can determine them) and then `claim_direction` with
`takeover: true` plus the `member_id` and `member_secret` register
returned, and read the playbook per protocol.
**Create no tasks.** Planning starts when the user tells you what they
want; setup ends with a healthy, idle show.

## 7. Final report and hand-off

Tell the user, concretely:

- **Callboard** (director token; do not paste the raw secret into chat):
  ```bash
  open "https://$APP.fly.dev/?token=$(cat $TOKEN_FILE)&show=<show>"
  ```
  Opening it once signs the browser in; the URL cleans itself. The board
  should show this session as director, no tasks, no escalations.
- **Status check:**
  ```bash
  curl -s https://$APP.fly.dev/healthz
  node ~/showrunner/dist/cli/index.js status --show <show> \
    --url https://$APP.fly.dev --token $(cat $TOKEN_FILE)
  ```
  Healthy means: `{"ok":true}`, a live director (this session), zero stale
  members.
- **Next step:** open another agent session in this repo and paste the
  worker prompt from step 5 (`You're a showrunner worker. Loop forever: ...`).
  It appears on the callboard within seconds.
  Then tell THIS (director) session what to build.
- **Optional dedicated lane:** if they want capability routing, open a
  role-focused worker and note the preference in `SHOWRUNNER.md`, e.g.
  `You're a showrunner worker focused on art. Register display_name art.`
- **Adding someone else's agent:** the director turns on `requireInvite`
  (`showrunner rules set --require-invite on`), mints a single-use token
  (`mint_invite`), and hands it over; the guest passes it to register.
  `evict_member` removes one. The callboard is read-only; membership is
  controlled through the director.
- **Recovering a dead/stale director:** open a NEW session that has the director
  token (from `.env`) and paste `You're now the director of <show>.` (this runs
  `claim_direction` with `takeover:true`). There is no takeover button; the
  director key lives only in the primary user's `.env`.
- Where things live: `~/.showrunner-token` (director),
  `~/.showrunner-worker-token` (worker), Fly app `$APP`, CLI at
  `node ~/showrunner/dist/cli/index.js` (alias tip in docs/OPERATING.md).
- Anything you skipped or that needs their hand (Cursor cloud dashboard,
  profile edits they declined).
