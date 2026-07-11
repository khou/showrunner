#!/usr/bin/env node
// showrunner CLI: a human convenience wrapper around GET/POST /api/* (never /mcp, that's
// the agent surface). Reads SHOWRUNNER_URL / SHOWRUNNER_TOKEN from env, overridable by flags.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardState, CreateTaskInput, DirectionState, Message, MessageTarget, OverlapWarning, Task } from "../types.js";
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

Read by the director right after \`claim_direction\`. Everything here overrides
the generic protocol defaults. Keep it short; briefs should point at docs, not
duplicate them.

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

function cmdInit(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      show: { type: "string" },
      url: { type: "string" },
      dir: { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.show) throw new UsageError("init requires --show <name>");
  const dir = values.dir ?? process.cwd();
  const base = optionalUrl(values) ?? "https://<your-app>.fly.dev";
  const mcpEntry = {
    mcpServers: {
      showrunner: {
        type: "http",
        url: `${base}/mcp`,
        headers: { Authorization: "Bearer ${SHOWRUNNER_TOKEN}" },
      },
    },
  };
  const cursorEntry = {
    mcpServers: {
      showrunner: {
        url: `${base}/mcp`,
        headers: { Authorization: "Bearer ${env:SHOWRUNNER_TOKEN}" },
      },
    },
  };

  process.stdout.write(`initializing showrunner for show "${values.show}" in ${dir}\n`);
  scaffold(join(dir, ".showrunner"), values.show + "\n");
  scaffold(join(dir, "SHOWRUNNER.md"), PLAYBOOK_TEMPLATE);
  scaffold(join(dir, ".mcp.json"), JSON.stringify(mcpEntry, null, 2) + "\n");
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  scaffold(join(dir, ".cursor", "mcp.json"), JSON.stringify(cursorEntry, null, 2) + "\n");
  process.stdout.write(`
next steps:
  1. Fill in SHOWRUNNER.md (the director's playbook for this show) and commit all four files.
  2. Make sure SHOWRUNNER_TOKEN is set in the environment of every client
     (shell env for local sessions, environment settings for cloud sessions).
  3. In any session in this repo: "You're a showrunner worker." / "You're the showrunner director."
`);
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
    },
    allowPositionals: false,
  });
  const base = optionalUrl(values) ?? "https://<your-app>.fly.dev";
  const mcpUrl = `${base}/mcp`;

  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        showrunner: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: "Bearer ${SHOWRUNNER_TOKEN}" },
        },
      },
    },
    null,
    2,
  );

  const cursorJson = JSON.stringify(
    {
      mcpServers: {
        showrunner: {
          url: mcpUrl,
          headers: { Authorization: "Bearer ${env:SHOWRUNNER_TOKEN}" },
        },
      },
    },
    null,
    2,
  );

  const out = `# Claude Code (local): one-time, user scope
claude mcp add --transport http showrunner ${mcpUrl} --header "Authorization: Bearer $SHOWRUNNER_TOKEN"

# Claude Code (local or cloud): committed .mcp.json
# \${SHOWRUNNER_TOKEN} is interpolated from the environment at connect time.
${mcpJson}

Claude Code cloud: commit the .mcp.json above, set SHOWRUNNER_TOKEN as an env var in the
cloud environment's secrets, and add this server's host to the network allowlist. No OAuth
in cloud sessions, bearer token only.

# Cursor (local): .cursor/mcp.json
${cursorJson}

Cursor 3.0+ required. Allowlist/auto-run the showrunner tools, or the poll loop stalls on
approval prompts.

Cursor cloud: config is dashboard-only (cursor.com/agents), not read from the repo. Paste the
same URL and a hardcoded token there (no \${env:...} interpolation works in that surface as of
Cursor 3.8). Treat Cursor-cloud workers as best-effort.
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
  showrunner message --show <name> --to <member-id|director|all|human> --body <text>
                      [--url <url>] [--token <token>]
  showrunner direction clear --show <name> [--url <url>] [--token <token>]
  showrunner show delete --show <name> [--url <url>] [--token <token>]
  showrunner init --show <name> [--url <url>] [--dir <path>]
  showrunner instructions
  showrunner snippets [--url <url>]

Env:
  SHOWRUNNER_URL     base URL of the showrunner server (e.g. https://my-showrunner.fly.dev)
  SHOWRUNNER_TOKEN   bearer token (required for status/task add/message)
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
        else throw new UsageError(`unknown "task" subcommand: ${rest[0] ?? "(none)"} (expected: task add|cancel)`);
        break;
      case "message":
        await cmdMessage(rest);
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
