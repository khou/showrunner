#!/usr/bin/env node
// showrunner CLI: a human convenience wrapper around GET/POST /api/* (never /mcp, that's
// the agent surface). Reads SHOWRUNNER_URL / SHOWRUNNER_TOKEN from env, overridable by flags.
import { parseArgs } from "node:util";
import type { BoardState, CreateTaskInput, Message, MessageTarget, OverlapWarning, Task } from "../types.js";
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
  showrunner message --show <name> --to <member-id|director|all|human> --body <text>
                      [--url <url>] [--token <token>]
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
        if (rest[0] !== "add") throw new UsageError(`unknown "task" subcommand: ${rest[0] ?? "(none)"} (expected: task add)`);
        await cmdTaskAdd(rest.slice(1));
        break;
      case "message":
        await cmdMessage(rest);
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
