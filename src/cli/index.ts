#!/usr/bin/env node
// showrunner CLI: a human convenience wrapper around GET/POST /api/* (never /mcp, that's
// the agent surface). Reads SHOWRUNNER_URL / SHOWRUNNER_TOKEN from env, overridable by flags.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { BoardState, CreateTaskInput, DirectionState, Message, MessageTarget, OverlapWarning, ShowRules, Task } from "../types.js";
import { INSTRUCTIONS } from "../server/instructions.js";

class UsageError extends Error {}

interface Config {
  url: string;
  token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Resolves {url, token} from flags first, then env. Throws UsageError if either is missing. */
function requireConfig(values: Record<string, string | undefined>): Config {
  const url = values.url ?? process.env.SHOWRUNNER_URL;
  const token = values.token ?? process.env.SHOWRUNNER_TOKEN;
  if (!url) throw new UsageError("missing showrunner URL: set SHOWRUNNER_URL or pass --url");
  if (!token) throw new UsageError("missing showrunner token: set SHOWRUNNER_TOKEN or pass --token");
  return { url: trimTrailingSlash(url), token };
}

/** Same as requireConfig but token/url are optional (used by commands that only render text). */
function optionalUrl(values: Record<string, string | undefined>): string | undefined {
  const url = values.url ?? process.env.SHOWRUNNER_URL;
  return url ? trimTrailingSlash(url) : undefined;
}

async function apiRequest<T>(cfg: Config, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // not JSON; use raw text
    }
    throw new Error(`${method} ${path} -> ${res.status}: ${detail || res.statusText}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

// --- status ---

function freshness(stale: boolean): string {
  return stale ? "STALE" : "ok";
}

function printBoard(state: BoardState): void {
  const lines: string[] = [];
  lines.push(`show: ${state.show}`);
  lines.push(
    state.director
      ? `director: ${state.director.memberId} (epoch ${state.director.epoch}, ${freshness(state.director.stale)})`
      : "director: none",
  );

  lines.push(`members (${state.members.length}):`);
  for (const m of state.members) {
    const task = m.currentTaskId ?? "-";
    lines.push(`  ${m.id.padEnd(14)} ${m.kind.padEnd(13)} ${m.role.padEnd(8)} ${freshness(m.stale).padEnd(6)} task:${task}`);
  }

  const counts = Object.entries(state.taskCounts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status}=${n}`)
    .join(" ");
  lines.push(`tasks: ${counts || "none"}`);

  const pendingRelease = state.tasks.filter((t) => t.status === "queued" && t.released === false);
  if (pendingRelease.length > 0) {
    lines.push("pending release (human must approve before workers can claim):");
    for (const t of pendingRelease) {
      lines.push(`  ${t.id}  "${t.title}"  -- release with: showrunner task release --show ${state.show} --id ${t.id}`);
    }
  }

  if (state.escalations.inputRequired.length > 0 || state.escalations.humanMessages.length > 0) {
    lines.push("escalations:");
    for (const t of state.escalations.inputRequired) {
      lines.push(`  INPUT-REQUIRED  ${t.id}  "${t.title}"  (assignee: ${t.assignee ?? "-"})`);
    }
    for (const m of state.escalations.humanMessages) {
      lines.push(`  MESSAGE from ${m.fromId}: ${m.body}`);
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

function printShowList(data: unknown): void {
  const raw: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { shows?: unknown[] } | undefined)?.shows)
      ? (data as { shows: unknown[] }).shows
      : [];
  const names = raw.map((entry) => (typeof entry === "string" ? entry : (entry as { name: string }).name));

  if (names.length === 0) {
    process.stdout.write("no shows yet\n");
    return;
  }
  process.stdout.write(names.map((n) => `${n}\n`).join(""));
  process.stdout.write("\npass --show <name> for full status\n");
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (values.show) {
    const state = await apiRequest<BoardState>(cfg, "GET", `/api/shows/${encodeURIComponent(values.show)}/state`);
    printBoard(state);
  } else {
    const shows = await apiRequest<unknown>(cfg, "GET", "/api/shows");
    printShowList(shows);
  }
}

// --- task add ---

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

async function cmdTaskAdd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      title: { type: "string" },
      brief: { type: "string" },
      "context-id": { type: "string" },
      "depends-on": { type: "string" },
      "files-hint": { type: "string" },
      priority: { type: "string" },
      assignee: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("task add requires --show");
  if (!values.title) throw new UsageError("task add requires --title");
  if (!values.brief) throw new UsageError("task add requires --brief");

  let priority: number | undefined;
  if (values.priority !== undefined) {
    priority = Number(values.priority);
    if (!Number.isFinite(priority)) throw new UsageError(`--priority must be a number, got: ${values.priority}`);
  }

  const body: CreateTaskInput = {
    show: values.show,
    title: values.title,
    brief: values.brief,
    createdBy: "human", // the server hardcodes this for /api-created tasks regardless
    ...(values["context-id"] ? { contextId: values["context-id"] } : {}),
    ...(splitList(values["depends-on"]) ? { dependsOn: splitList(values["depends-on"]) } : {}),
    ...(splitList(values["files-hint"]) ? { filesHint: splitList(values["files-hint"]) } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(values.assignee ? { assignee: values.assignee } : {}),
  };

  const result = await apiRequest<{ task: Task; overlaps: OverlapWarning[] }>(
    cfg,
    "POST",
    `/api/shows/${encodeURIComponent(values.show)}/tasks`,
    body,
  );
  process.stdout.write(`created task ${result.task.id}: "${result.task.title}" (status: ${result.task.status})\n`);
  for (const w of result.overlaps) {
    process.stdout.write(`  warning: overlaps ${w.taskId} "${w.title}" on ${w.globs.join(", ")}\n`);
  }
}

// --- task cancel ---

async function cmdTaskCancel(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      id: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("task cancel requires --show");
  if (!values.id) throw new UsageError("task cancel requires --id");

  const result = await apiRequest<{ task: Task }>(
    cfg,
    "POST",
    `/api/shows/${encodeURIComponent(values.show)}/tasks/${encodeURIComponent(values.id)}/cancel`,
  );
  process.stdout.write(`canceled task ${result.task.id}: "${result.task.title}" (status: ${result.task.status})\n`);
}

// --- task release (human release gate) ---

async function cmdTaskRelease(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      id: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("task release requires --show");
  if (!values.id) throw new UsageError("task release requires --id");

  const result = await apiRequest<{ task: Task }>(
    cfg,
    "POST",
    `/api/shows/${encodeURIComponent(values.show)}/tasks/${encodeURIComponent(values.id)}/release`,
  );
  process.stdout.write(`released task ${result.task.id}: "${result.task.title}" -- workers can now claim it\n`);
}

// --- rules (server-held show rules) ---

function printRules(rules: ShowRules): void {
  const s = rules.switches;
  const lines = [
    `rules v${rules.version} (updated by ${rules.updatedBy})`,
    "switches (machine-enforced):",
    `  requireTaskRelease        ${s.requireTaskRelease}`,
    `  requireHumanMergeApproval ${s.requireHumanMergeApproval}`,
    `  workerNotePropagation     ${s.workerNotePropagation}`,
    `  requireInvite             ${s.requireInvite}`,
    `  artifactTextMaxChars      ${s.artifactTextMaxChars}`,
    `  artifactDataMaxBytes      ${s.artifactDataMaxBytes}`,
    `policy (advisory prose, delivered but never enforced):`,
    rules.policy ? `  ${rules.policy.replace(/\n/g, "\n  ")}` : "  (none)",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdRules(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { show: { type: "string" }, url: { type: "string" }, token: { type: "string" } },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("rules requires --show");
  const { rules } = await apiRequest<{ rules: ShowRules }>(cfg, "GET", `/api/shows/${encodeURIComponent(values.show)}/rules`);
  printRules(rules);
}

function parseOnOff(flag: string, raw: string): boolean {
  if (/^(on|true|1|yes)$/i.test(raw)) return true;
  if (/^(off|false|0|no)$/i.test(raw)) return false;
  throw new UsageError(`${flag} expects on|off, got "${raw}"`);
}

async function cmdRulesSet(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      "require-release": { type: "string" },
      "merge-approval": { type: "string" },
      "note-propagation": { type: "string" },
      "require-invite": { type: "string" },
      "artifact-text-max": { type: "string" },
      "artifact-data-max": { type: "string" },
      policy: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("rules set requires --show");

  const switches: Record<string, unknown> = {};
  if (values["require-release"] !== undefined) switches.requireTaskRelease = parseOnOff("--require-release", values["require-release"]);
  if (values["merge-approval"] !== undefined) switches.requireHumanMergeApproval = parseOnOff("--merge-approval", values["merge-approval"]);
  if (values["note-propagation"] !== undefined) switches.workerNotePropagation = parseOnOff("--note-propagation", values["note-propagation"]);
  if (values["require-invite"] !== undefined) switches.requireInvite = parseOnOff("--require-invite", values["require-invite"]);
  if (values["artifact-text-max"] !== undefined) switches.artifactTextMaxChars = Number(values["artifact-text-max"]);
  if (values["artifact-data-max"] !== undefined) switches.artifactDataMaxBytes = Number(values["artifact-data-max"]);

  const payload: { switches?: Record<string, unknown>; policy?: string } = {};
  if (Object.keys(switches).length > 0) payload.switches = switches;
  if (values.policy !== undefined) payload.policy = values.policy;
  if (payload.switches === undefined && payload.policy === undefined) {
    throw new UsageError("rules set needs at least one switch flag or --policy");
  }

  const { rules } = await apiRequest<{ rules: ShowRules }>(cfg, "POST", `/api/shows/${encodeURIComponent(values.show)}/rules`, payload);
  printRules(rules);
}

async function cmdShowDelete(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("show delete requires --show");

  await apiRequest<{ deleted: string }>(cfg, "DELETE", `/api/shows/${encodeURIComponent(values.show)}`);
  process.stdout.write(`deleted show ${values.show} and all its members, tasks, notes, and messages\n`);
}

// --- message ---

async function cmdMessage(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      to: { type: "string" },
      body: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("message requires --show");
  if (!values.to) throw new UsageError("message requires --to <member-id|director|all|human>");
  if (!values.body) throw new UsageError("message requires --body");

  const payload: { to: MessageTarget; body: string } = { to: values.to as MessageTarget, body: values.body };
  const result = await apiRequest<{ message: Message }>(cfg, "POST", `/api/shows/${encodeURIComponent(values.show)}/message`, payload);
  process.stdout.write(`sent message ${result.message.id} to ${result.message.toId}\n`);
}

// --- direction clear ---

async function cmdDirectionClear(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig(values);
  if (!values.show) throw new UsageError("direction clear requires --show");

  await apiRequest<{ direction: DirectionState }>(cfg, "POST", `/api/shows/${encodeURIComponent(values.show)}/direction/clear`);
  process.stdout.write(`cleared direction for ${values.show}; show is headless until a new claim_direction\n`);
}

// --- init ---

const PLAYBOOK_TEMPLATE = `# Show playbook

Read by the director right after \`claim_direction\`. Advisory context that
overrides the generic protocol defaults. Keep it short; briefs should point at
docs, not duplicate them. Fleet automation/role rules are NOT here -- they are
server-held show rules (see update_rules / the callboard), so a worker can't
edit policy by editing a repo file.

## What this project is

<one paragraph: what the project does and where to read more (README, docs/)>

## How to break down work

- Task size: 5-20 minutes of agent work; one concern per task.
- Areas and their files (keep \`files_hint\` globs inside one area per task):
  - <area>: <globs>
- Ordering: <what must land before what; use depends_on>

## Conventions workers must follow

- Branch per task: \`show/<task_id>-<slug>\` (protocol default).
- <build/test command a task is not done without>
- <code style, commit style, or review notes>

## Escalation

- Decisions the director may make alone: <...>
- Decisions that must go to the human (\`send_message\` to \`human\`): <...>
`;

/** Writes a file unless it exists; reports either way. */
function scaffold(path: string, content: string): void {
  if (existsSync(path)) {
    process.stdout.write(`  exists, left alone: ${path}\n`);
    return;
  }
  writeFileSync(path, content);
  process.stdout.write(`  wrote ${path}\n`);
}

function dualMcpConfigs(base: string, workerToken: string): { mcpEntry: object; cursorEntry: object } {
  const mcpUrl = `${base}/mcp`;
  const mcpEntry = {
    mcpServers: {
      showrunner: {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${workerToken}` },
      },
      "showrunner-director": {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: "Bearer ${SHOWRUNNER_TOKEN}" },
      },
    },
  };
  const cursorEntry = {
    mcpServers: {
      showrunner: {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${workerToken}` },
      },
      "showrunner-director": {
        url: mcpUrl,
        headers: { Authorization: "Bearer ${env:SHOWRUNNER_TOKEN}" },
      },
    },
  };
  return { mcpEntry, cursorEntry };
}

function cmdInit(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      dir: { type: "string" },
      token: { type: "string" },
      "worker-token": { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.show) throw new UsageError("init requires --show <name>");
  const dir = values.dir ?? process.cwd();
  const base = optionalUrl(values) ?? "https://<your-app>.fly.dev";
  const directorToken = values.token ?? process.env.SHOWRUNNER_TOKEN;
  const workerToken = values["worker-token"] ?? process.env.SHOWRUNNER_WORKER_TOKEN;
  if (!directorToken) {
    throw new UsageError(
      "init requires the director token: set SHOWRUNNER_TOKEN or pass --token (goes in gitignored .env; never commit it)",
    );
  }
  if (!workerToken) {
    throw new UsageError(
      "init requires the worker token: set SHOWRUNNER_WORKER_TOKEN or pass --worker-token (hardcoded into committed MCP configs)",
    );
  }
  if (workerToken === directorToken) {
    throw new UsageError(
      "worker token must differ from director token; generate a separate SHOWRUNNER_WORKER_TOKEN on the server",
    );
  }

  const { mcpEntry, cursorEntry } = dualMcpConfigs(base, workerToken);

  process.stdout.write(`initializing showrunner for show "${values.show}" in ${dir}\n`);
  scaffold(join(dir, ".showrunner"), values.show + "\n");
  scaffold(join(dir, "SHOWRUNNER.md"), PLAYBOOK_TEMPLATE);
  // No SHOWRUNNER.rules.md: fleet rules are server-held show state now (seeded with OOTB defaults
  // on the server, editable via `showrunner rules set` or the callboard), so policy that governs
  // untrusted members isn't writable by them in a repo file.
  scaffold(join(dir, ".mcp.json"), JSON.stringify(mcpEntry, null, 2) + "\n");
  // Director token only: MCP ${VAR} interpolation reads process env, not .env files,
  // so this feeds shells/direnv/tooling for showrunner-director. Never committed.
  scaffold(join(dir, ".env"), `SHOWRUNNER_TOKEN=${directorToken}\nSHOWRUNNER_URL=${base}\n`);
  const giPath = join(dir, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (!gi.split("\n").some((l) => l.trim() === ".env")) {
    writeFileSync(giPath, gi + (gi.endsWith("\n") || gi === "" ? "" : "\n") + ".env\n");
    process.stdout.write(`  added .env to ${giPath}\n`);
  }
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  scaffold(join(dir, ".cursor", "mcp.json"), JSON.stringify(cursorEntry, null, 2) + "\n");

  const callboardQs = new URLSearchParams({ token: directorToken, show: values.show });
  const callboard = `${base}/?${callboardQs.toString()}`;
  process.stdout.write(`
next steps:
  1. Fill in SHOWRUNNER.md (playbook), then commit
     (.showrunner, playbook, .mcp.json, .cursor/mcp.json — never .env).
     Fleet rules are server-held: view/edit with \`showrunner rules\` or on the callboard.
  2. Callboard (director token): ${callboard}
  3. Director session (needs showrunner-director MCP + SHOWRUNNER_TOKEN in env):
       You're the showrunner director.

  Workers (anyone with the repo — no secrets; worker token is in committed MCP):
       You're a showrunner worker.

  Ways to run:
    A. Simple fleet — one director + N general workers (default).
    B. Dedicated lanes (optional) — open role-focused sessions and note the
       preference in SHOWRUNNER.md, e.g.:
         You're a showrunner worker focused on art. Register display_name art.
       Why: some sessions have tools others lack (laptop .env / GPU / browser /
       local stack vs cloud). Director pins matching tasks with assignee.

  Fleet rules (release gate, merge approval, note propagation, artifact caps,
  policy) are server-held: view/edit with 'showrunner rules [set]' or the callboard.
`);
}

// --- open (callboard magic link) ---

function cmdOpen(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      print: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const cfg = requireConfig({ url: values.url, token: values.token });
  const show =
    values.show ??
    (existsSync(".showrunner") ? readFileSync(".showrunner", "utf8").trim().split("\n")[0] : undefined);
  const qs = new URLSearchParams({ token: cfg.token });
  if (show) qs.set("show", show);
  const link = `${cfg.url}/?${qs.toString()}`;
  if (values.print) {
    process.stdout.write(link + "\n");
    return;
  }
  process.stdout.write(`opening ${cfg.url}/?token=…${show ? `&show=${show}` : ""}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", link] : [link];
  spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
}

// --- instructions ---

function cmdInstructions(): void {
  // The same text register() returns as `protocol` and the server exposes as the MCP
  // `initialize` instructions / "join" prompt -- one source (server/instructions.ts), not a
  // second copy that drifts from what the server actually ships.
  process.stdout.write(INSTRUCTIONS + "\n");
}

// --- snippets ---

function cmdSnippets(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      "worker-token": { type: "string" },
    },
    allowPositionals: false,
  });
  const base = optionalUrl(values) ?? "https://<your-app>.fly.dev";
  const mcpUrl = `${base}/mcp`;
  const workerToken = values["worker-token"] ?? process.env.SHOWRUNNER_WORKER_TOKEN ?? "<WORKER_TOKEN>";
  const { mcpEntry, cursorEntry } = dualMcpConfigs(base, workerToken);

  const out = `# Dual-token MCP (commit worker Bearer; keep director in env)

# Claude Code (local): worker MCP (or rely on committed .mcp.json)
claude mcp add --transport http showrunner ${mcpUrl} --header "Authorization: Bearer ${workerToken}"

# Claude Code: committed .mcp.json
# showrunner = hardcoded worker token; showrunner-director = \${SHOWRUNNER_TOKEN} from env
${JSON.stringify(mcpEntry, null, 2)}

Claude Code cloud: commit .mcp.json above. Workers need no cloud secret.
Director sessions set SHOWRUNNER_TOKEN (director) in cloud env + allowlist the host.

# Cursor (local): .cursor/mcp.json
${JSON.stringify(cursorEntry, null, 2)}

Cursor 3.0+ required. Allowlist/auto-run the showrunner tools, or the poll loop stalls on
approval prompts.

Cursor cloud: dashboard-only as of 3.8 — paste URL + hardcoded *worker* token for workers;
director sessions need the director token pasted (or Runtime Secret) separately.
`;
  process.stdout.write(out);
}

// --- dispatch ---

function printUsage(): void {
  process.stdout.write(`showrunner: CLI for the showrunner coordination server

Usage:
  showrunner status [--show <name>] [--url <url>] [--token <token>]
  showrunner task add --show <name> --title <t> --brief <b>
                       [--context-id <id>] [--depends-on <id,id>] [--files-hint <glob,glob>]
                       [--priority <n>] [--assignee <id>] [--url <url>] [--token <token>]
  showrunner task cancel --show <name> --id <task-id> [--url <url>] [--token <token>]
  showrunner task release --show <name> --id <task-id> [--url <url>] [--token <token>]
  showrunner message --show <name> --to <member-id|director|all|human> --body <text>
                      [--url <url>] [--token <token>]
  showrunner rules --show <name>                    # print the show's server-held rules
  showrunner rules set --show <name> [--require-release on|off] [--merge-approval on|off]
                       [--note-propagation on|off] [--require-invite on|off]
                       [--artifact-text-max <n>] [--artifact-data-max <n>] [--policy <text>]
  showrunner direction clear --show <name> [--url <url>] [--token <token>]
  showrunner show delete --show <name> [--url <url>] [--token <token>]
  showrunner init --show <name> --url <url> --token <director> --worker-token <worker> [--dir <path>]
  showrunner open [--show <name>] [--url <url>] [--token <token>] [--print]
  showrunner instructions
  showrunner snippets [--url <url>] [--worker-token <token>]

Env:
  SHOWRUNNER_URL            base URL (e.g. https://my-showrunner.fly.dev)
  SHOWRUNNER_TOKEN          director/admin bearer (CLI admin + showrunner-director MCP)
  SHOWRUNNER_WORKER_TOKEN   worker bearer (committed into MCP configs by init)
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "status":
        await cmdStatus(rest);
        break;
      case "task":
        if (rest[0] === "add") await cmdTaskAdd(rest.slice(1));
        else if (rest[0] === "cancel") await cmdTaskCancel(rest.slice(1));
        else if (rest[0] === "release") await cmdTaskRelease(rest.slice(1));
        else throw new UsageError(`unknown "task" subcommand: ${rest[0] ?? "(none)"} (expected: task add|cancel|release)`);
        break;
      case "message":
        await cmdMessage(rest);
        break;
      case "rules":
        if (rest[0] === "set") await cmdRulesSet(rest.slice(1));
        else await cmdRules(rest);
        break;
      case "direction":
        if (rest[0] !== "clear") throw new UsageError(`unknown "direction" subcommand: ${rest[0] ?? "(none)"} (expected: direction clear)`);
        await cmdDirectionClear(rest.slice(1));
        break;
      case "show":
        if (rest[0] !== "delete") throw new UsageError(`unknown "show" subcommand: ${rest[0] ?? "(none)"} (expected: show delete)`);
        await cmdShowDelete(rest.slice(1));
        break;
      case "init":
        cmdInit(rest);
        break;
      case "open":
        cmdOpen(rest);
        break;
      case "instructions":
        cmdInstructions();
        break;
      case "snippets":
        cmdSnippets(rest);
        break;
      case undefined:
      case "-h":
      case "--help":
        printUsage();
        break;
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n\n`);
      printUsage();
    } else {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

main();
