// MCP tool surface for showrunner (DESIGN.md "MCP tool surface", PLAN.md "MCP tools"
// + "Long-poll semantics"). The 10 pinned tools plus the "join" prompt.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Store } from "./store.js";
import { INSTRUCTIONS } from "./instructions.js";
import {
  SupersededError,
  type BoardTaskView,
  type DirectTaskAction,
  type Member,
  type Message,
  type Note,
  type NoteHit,
  type Task,
} from "../types.js";

/** Subset of EnvConfig this module needs; a full EnvConfig satisfies it structurally. */
export interface McpServerConfig {
  pollHoldSeconds: number;
}

const MEMBER_KIND = z.enum(["claude-local", "claude-cloud", "cursor-local", "cursor-cloud", "other"]);

const ARTIFACT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("files"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("data"), data: z.unknown() }),
]);

const UPDATE_STATUS = z.enum(["working", "input-required", "completed", "failed", "rejected"]);

const DIRECT_ACTION = z.enum(["cancel", "requeue", "assign", "answer", "approve"]);

// register's self-reported chat link (DESIGN.md "session_url/resume_hint are how a human opens
// this session's chat"): only the session itself knows this, so it's optional and validated at
// the boundary rather than trusted verbatim.
const SESSION_URL = z
  .string()
  .max(500)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "session_url must be an http(s) URL" },
  )
  .describe("URL a human can open to chat with this session, e.g. your claude.ai/code or cursor.com agent session URL")
  .optional();

const RESUME_HINT = z
  .string()
  .max(200)
  .describe(
    "for local CLI sessions: the command a human runs to open this session, e.g. claude --resume <session-id>",
  )
  .optional();

function jsonResult(data: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError };
}

function unknownMember(memberId: string): { status: "unknown_member"; member_id: string; hint: string } {
  return { status: "unknown_member", member_id: memberId, hint: "member not found; call register to rejoin the show" };
}

/** Every tool but `register` needs the caller's Member; also renews its lease (DESIGN.md leases table). */
function resolveMember(store: Store, memberId: string): { member: Member } | { result: CallToolResult } {
  const member = store.touchMember(memberId);
  if (!member) return { result: jsonResult(unknownMember(memberId)) };
  return { member };
}

function supersededResult(err: SupersededError): CallToolResult {
  return jsonResult({ status: "superseded", message: err.message, show: err.show, holder: err.holder, epoch: err.epoch });
}

// --- await_work resolution order (PLAN.md "Long-poll semantics") ---

export type AwaitWorkResult =
  | { status: "unknown_member"; member_id: string; hint: string }
  | { status: "messages"; messages: Message[] }
  | { status: "review"; items: BoardTaskView[] }
  | { status: "task"; task: Task; relevant_notes: NoteHit[] }
  | { status: "nothing"; hint: string };

// DESIGN.md "Recall at claim time": bodies trimmed to ~300 chars in the claim-time payload
// (search_notes hits, by contrast, return the full body -- that's an explicit pull, not a cap
// meant to bound an unprompted push).
const RELEVANT_NOTE_BODY_CHARS = 300;

function toRelevantNoteHit(note: Note): NoteHit {
  const truncated = note.body.length > RELEVANT_NOTE_BODY_CHARS;
  return {
    id: note.id,
    author: note.author,
    tags: note.tags,
    // Marked when cut so the reader can tell this isn't the whole note (there's no fetch-by-id
    // path -- notes_fts doesn't index id -- recovery is search_notes on distinctive words from
    // the visible prefix).
    body: truncated ? `${note.body.slice(0, RELEVANT_NOTE_BODY_CHARS)}…` : note.body,
    createdAt: note.createdAt,
  };
}

const REVIEW_STATUSES = new Set(["completed", "failed", "rejected", "input-required"]);

// The review cursor itself is persisted per-member in the store (members.review_cursor), so
// it survives a server restart and a takeover director isn't flooded with the whole show's
// done-history (Store.claimDirection seeds it to "now" for a new holder). What's kept here,
// in-process only, is a much smaller tie-break: the set of task ids already surfaced *at*
// the current cursor timestamp, so two tasks completing within the same millisecond (the
// only case a wall-clock cursor can't order) don't get one of them silently dropped forever.
// Keyed by Store identity so concurrent/successive test stores never leak into each other.
const seenAtCursor = new WeakMap<Store, Map<string, Set<string>>>();

function seenIdsFor(store: Store, memberId: string): Set<string> {
  let byMember = seenAtCursor.get(store);
  if (!byMember) {
    byMember = new Map();
    seenAtCursor.set(store, byMember);
  }
  let ids = byMember.get(memberId);
  if (!ids) {
    ids = new Set();
    byMember.set(memberId, ids);
  }
  return ids;
}

/**
 * Completed/failed/rejected/input-required since the director's last review. Every status is
 * gated through the same cursor (PLAN.md's resolution order previously special-cased
 * input-required as "exists", which fires on every single poll while a blocker sits unanswered
 * -- a busy long-poll loop; here it surfaces once per updatedAt change like everything else.
 * get_board's escalations.inputRequired is unaffected: it's a pull, always shows the current set.
 */
function computeReviewItems(store: Store, member: Member): BoardTaskView[] | null {
  const board = store.getBoard(member.show);
  const cursor = store.getReviewCursor(member.id);
  const seen = seenIdsFor(store, member.id);

  const candidates = board.tasks.filter(
    (t) => REVIEW_STATUSES.has(t.status) && t.updatedAt >= cursor && !(t.updatedAt === cursor && seen.has(t.id)),
  );
  if (candidates.length === 0) return null;

  const maxUpdatedAt = candidates.reduce((m, t) => Math.max(m, t.updatedAt), cursor);
  if (maxUpdatedAt > cursor) {
    store.setReviewCursor(member.id, maxUpdatedAt);
    seen.clear();
    for (const t of candidates) if (t.updatedAt === maxUpdatedAt) seen.add(t.id);
  } else {
    // Every candidate ties the current cursor exactly; the cursor can't move forward, so
    // remember them individually or they'd be re-reported on the very next poll.
    for (const t of candidates) seen.add(t.id);
  }
  return candidates;
}

function checkOnce(store: Store, member: Member): AwaitWorkResult | null {
  const messages = store.drainInbox(member.id);
  if (messages.length > 0) return { status: "messages", messages };

  if (member.role === "director") {
    const items = computeReviewItems(store, member);
    if (items) return { status: "review", items };
  } else {
    const task = store.claimNextTask(member.id);
    if (task) return { status: "task", task, relevant_notes: store.notesForTask(task).map(toRelevantNoteHit) };
  }
  return null;
}

/**
 * Fixed 0-2s jitter (DESIGN.md) would swamp the short holds tests inject to stay under
 * ~100ms; scale it down proportionally instead, capped at the production 2s ceiling.
 */
function jitterMs(holdMs: number): number {
  const maxJitter = Math.min(2000, Math.round(holdMs * 0.1));
  return Math.random() * maxJitter;
}

export async function resolveAwaitWork(
  store: Store,
  memberId: string,
  waitSeconds: number | undefined,
  pollHoldSeconds: number,
): Promise<AwaitWorkResult> {
  const member = store.touchMember(memberId);
  if (!member) return unknownMember(memberId);

  const immediate = checkOnce(store, member);
  if (immediate) return immediate;

  // Default to the configured hold, not a hardcoded 25: POLL_HOLD_SECONDS is meant to be
  // tunable in both directions (DESIGN.md "env-tunable -- Cursor's limit changed three times
  // in a year"), but a hardcoded default here made raising it above 25 a no-op for every
  // instruction-following caller that omits wait_seconds.
  const holdMs = Math.min(waitSeconds ?? pollHoldSeconds, pollHoldSeconds) * 1000;
  const totalMs = holdMs + jitterMs(holdMs);

  return new Promise<AwaitWorkResult>((resolve) => {
    let settled = false;
    const memberWake = `wake:${member.id}`;
    const showWake = `wake:show:${member.show}`;

    const cleanup = (): void => {
      store.events.off(memberWake, onWake);
      store.events.off(showWake, onWake);
      clearTimeout(timer);
    };
    const finish = (result: AwaitWorkResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onWake = (): void => {
      const result = checkOnce(store, member);
      if (result) finish(result);
    };
    const timer = setTimeout(() => finish({ status: "nothing", hint: "re-poll immediately" }), totalMs);
    store.events.on(memberWake, onWake);
    store.events.on(showWake, onWake);
  });
}

function buildDirectTaskAction(args: {
  action: string;
  assignee?: string;
  body?: string;
}): { value: DirectTaskAction } | { error: string } {
  switch (args.action) {
    case "cancel":
      return { value: { type: "cancel" } };
    case "requeue":
      return { value: { type: "requeue" } };
    case "approve":
      return { value: { type: "approve" } };
    case "assign":
      if (!args.assignee) return { error: "action 'assign' requires assignee" };
      return { value: { type: "assign", assignee: args.assignee } };
    case "answer":
      if (!args.body) return { error: "action 'answer' requires body" };
      return { value: { type: "answer", body: args.body } };
    default:
      return { error: `unknown action: ${args.action}` };
  }
}

export function createMcpServer(store: Store, config: McpServerConfig): McpServer {
  const server = new McpServer({ name: "showrunner", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "register",
    {
      description: "Join a show as a new member; returns member_id and the worker/director protocol.",
      inputSchema: {
        show: z.string().min(1).describe("Show name; by convention the repo name (git origin basename, else directory name) unless the user names one explicitly."),
        kind: MEMBER_KIND,
        display_name: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        session_url: SESSION_URL,
        resume_hint: RESUME_HINT,
      },
    },
    async (args) => {
      const member = store.register(
        args.show,
        args.kind,
        args.display_name,
        args.capabilities,
        args.session_url,
        args.resume_hint,
      );
      const board_summary = store.getBoard(member.show);
      const director = store.directionState(member.show).directorId ?? null;
      return jsonResult({ member_id: member.id, show: member.show, director, board_summary, protocol: INSTRUCTIONS });
    },
  );

  server.registerTool(
    "await_work",
    {
      description: "Long-poll for work: unread messages, director review items, or a claimed task.",
      inputSchema: {
        member_id: z.string().min(1),
        wait_seconds: z.number().positive().optional(),
      },
    },
    async (args) => jsonResult(await resolveAwaitWork(store, args.member_id, args.wait_seconds, config.pollHoldSeconds)),
  );

  server.registerTool(
    "update_task",
    {
      description: "Heartbeat, journal, and/or transition a task you hold.",
      inputSchema: {
        member_id: z.string().min(1),
        task_id: z.string().min(1),
        status: UPDATE_STATUS.optional(),
        note: z.string().optional(),
        artifacts: z.array(ARTIFACT_SCHEMA).optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      try {
        const task = store.updateTask(resolved.member.id, args.task_id, {
          status: args.status,
          note: args.note,
          artifacts: args.artifacts,
        });
        // DESIGN.md "The result carries any unread messages, so a heads-down worker hears about
        // notes and answers on its ~10min heartbeat instead of only at its next await_work."
        // Same drainInbox as await_work; omit the key rather than ship an empty array.
        const messages = store.drainInbox(resolved.member.id);
        return jsonResult(messages.length > 0 ? { task, messages } : { task });
      } catch (err) {
        return jsonResult({ status: "error", message: (err as Error).message }, true);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a message to a member id, 'director', 'all', or 'human'.",
      inputSchema: {
        member_id: z.string().min(1),
        to: z.string().min(1),
        body: z.string().min(1),
        task_id: z.string().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      try {
        const message = store.sendMessage(resolved.member.id, args.to, args.body, args.task_id);
        return jsonResult({ message });
      } catch (err) {
        return jsonResult({ status: "error", message: (err as Error).message }, true);
      }
    },
  );

  server.registerTool(
    "get_board",
    {
      description: "Board summary: director card, members, task counts/columns, escalations.",
      inputSchema: {
        member_id: z.string().min(1),
        verbose: z.boolean().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      return jsonResult(store.getBoard(resolved.member.show, args.verbose));
    },
  );

  server.registerTool(
    "save_note",
    {
      description:
        "Save a note to shared memory: pushes to members whose current task overlaps (same task/context or files_hint glob), and it's recalled by search_notes and future claims.",
      inputSchema: {
        member_id: z.string().min(1),
        body: z.string().min(1),
        tags: z.array(z.string()).optional(),
        files_hint: z.array(z.string()).optional(),
        task_id: z.string().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      try {
        const { note, deliveredTo } = store.saveNote(resolved.member.id, {
          body: args.body,
          tags: args.tags,
          filesHint: args.files_hint,
          taskId: args.task_id,
        });
        return jsonResult({ note_id: note.id, delivered_to: deliveredTo });
      } catch (err) {
        return jsonResult({ status: "error", message: (err as Error).message }, true);
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      description: "BM25-ranked search over this member's show's shared notes.",
      inputSchema: {
        member_id: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      const notes = store.searchNotes(resolved.member.show, args.query, args.limit);
      return jsonResult({ notes });
    },
  );

  server.registerTool(
    "claim_direction",
    {
      description: "Claim (or take over) the direction lease for this member's show.",
      inputSchema: {
        member_id: z.string().min(1),
        takeover: z.boolean().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      const result = store.claimDirection(resolved.member.id, args.takeover);
      if (result.ok) {
        return jsonResult({ status: "claimed", epoch: result.epoch, board_summary: store.getBoard(resolved.member.show) });
      }
      return jsonResult({ status: "denied", holder: result.holder, epoch: result.epoch });
    },
  );

  server.registerTool(
    "create_task",
    {
      description: "Director-only: create a task. Epoch-fenced; a stale epoch returns {status:'superseded'}.",
      inputSchema: {
        member_id: z.string().min(1),
        epoch: z.number().int(),
        title: z.string().min(1),
        brief: z.string().min(1),
        context_id: z.string().optional(),
        depends_on: z.array(z.string()).optional(),
        files_hint: z.array(z.string()).optional(),
        priority: z.number().int().optional(),
        assignee: z.string().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      const { member } = resolved;
      try {
        store.checkEpoch(member.show, member.id, args.epoch);
      } catch (err) {
        if (err instanceof SupersededError) return supersededResult(err);
        throw err;
      }
      const { task, overlaps } = store.createTask({
        show: member.show,
        title: args.title,
        brief: args.brief,
        createdBy: member.id,
        contextId: args.context_id,
        dependsOn: args.depends_on,
        filesHint: args.files_hint,
        priority: args.priority,
        assignee: args.assignee,
      });
      return jsonResult({ task_id: task.id, task, overlaps });
    },
  );

  server.registerTool(
    "direct_task",
    {
      description: "Director-only: cancel/requeue/assign/answer/approve a task. Epoch-fenced.",
      inputSchema: {
        member_id: z.string().min(1),
        epoch: z.number().int(),
        task_id: z.string().min(1),
        action: DIRECT_ACTION,
        assignee: z.string().optional(),
        body: z.string().optional(),
      },
    },
    async (args) => {
      const resolved = resolveMember(store, args.member_id);
      if ("result" in resolved) return resolved.result;
      const { member } = resolved;
      const action = buildDirectTaskAction(args);
      if ("error" in action) return jsonResult({ status: "invalid_action", message: action.error }, true);
      try {
        const task = store.directTask(member.id, args.epoch, args.task_id, action.value);
        return jsonResult({ task });
      } catch (err) {
        if (err instanceof SupersededError) return supersededResult(err);
        return jsonResult({ status: "error", message: (err as Error).message }, true);
      }
    },
  );

  server.registerPrompt(
    "join",
    {
      title: "Join a showrunner show",
      description: "The worker/director protocol for showrunner: register, then loop await_work.",
    },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: INSTRUCTIONS } }] }),
  );

  return server;
}

/** Stateless-mode transport (PLAN.md): no session id, so WP B2 can create one per request. */
export function createStatelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
