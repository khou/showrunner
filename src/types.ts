// Shared domain types for the showrunner store, MCP surface, HTTP API, and CLI.
// See DESIGN.md for vocabulary and PLAN.md for the pinned contracts these mirror.

import { timingSafeEqual } from "node:crypto";

export type MemberKind = "claude-local" | "claude-cloud" | "cursor-local" | "cursor-cloud" | "other";

export type MemberRole = "worker" | "director";

export interface Member {
  id: string;
  show: string;
  kind: MemberKind;
  displayName: string | null;
  role: MemberRole;
  registeredAt: number;
  lastSeenAt: number;
  leaseExpiresAt: number;
  currentTaskId: string | null;
  // Self-reported chat link (DESIGN.md "register... session_url/resume_hint"): only the session
  // itself knows this, so it's optional and omitted (not null) when not reported.
  sessionUrl?: string;
  resumeHint?: string;
}

export interface Show {
  name: string;
  createdAt: number;
  config: Record<string, unknown>;
}

// A2A-derived task state machine (see DESIGN.md "Task state machine").
export type TaskStatus =
  | "queued"
  | "assigned"
  | "working"
  | "completed"
  | "failed"
  | "rejected"
  | "input-required"
  | "canceled";

export type TaskArtifact =
  | { kind: "branch"; name: string }
  | { kind: "files"; paths: string[] }
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown };

export interface Task {
  id: string;
  show: string;
  contextId: string | null;
  title: string;
  brief: string;
  filesHint: string[];
  dependsOn: string[];
  priority: number;
  status: TaskStatus;
  assignee: string | null;
  attempt: number;
  createdBy: string;
  leaseExpiresAt: number | null;
  artifacts: TaskArtifact[];
  // False only while withheld by the human release gate (REQUIRE_TASK_RELEASE); an unreleased
  // task is queued but not claimable until a human releases it. Defaults true everywhere else.
  released: boolean;
  createdAt: number;
  updatedAt: number;
}

// Append-only journal entry for a task (task_notes table).
export interface TaskNote {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface CreateTaskInput {
  show: string;
  title: string;
  brief: string;
  createdBy: string;
  contextId?: string;
  dependsOn?: string[];
  filesHint?: string[];
  priority?: number;
  assignee?: string;
  // When false, the task is created withheld (not claimable) until a human releases it. Set by
  // the create_task tool when REQUIRE_TASK_RELEASE is on. Defaults to released.
  released?: boolean;
}

// Advisory-only: files_hint globs on the new task intersect an in-flight task's globs.
export interface OverlapWarning {
  taskId: string;
  title: string;
  globs: string[];
}

// direct_task actions (director-only, epoch-fenced).
export type DirectTaskAction =
  | { type: "cancel" }
  | { type: "requeue" }
  | { type: "assign"; assignee: string }
  | { type: "answer"; body: string }
  | { type: "approve" };

// `to` may be a member id, or one of these role/broadcast addresses (DESIGN.md).
export type MessageTarget = string | "director" | "all" | "human";

// 'note' marks a message delivered by save_note's realtime push (DESIGN.md "Shared notes: push
// on save"), so a recipient's await_work can tell a note from an ordinary message without
// parsing the body.
export type MessageKind = "message" | "note";

export interface Message {
  id: string;
  show: string;
  fromId: string;
  toId: MessageTarget;
  taskId: string | null;
  body: string;
  kind: MessageKind;
  createdAt: number;
}

// Append-only shared memory (DESIGN.md "Shared notes: realtime memory"). Distinct from
// TaskNote (task_notes, one task's journal): a Note is show-wide, FTS5-indexed, and reaches
// other live members through the push-on-save + claim-time-recall machinery.
export interface Note {
  id: string;
  show: string;
  author: string;
  body: string;
  tags: string[];
  filesHint: string[];
  taskId: string | null;
  contextId: string | null;
  createdAt: number;
}

export interface SaveNoteInput {
  body: string;
  tags?: string[];
  filesHint?: string[];
  taskId?: string;
}

// Compact shape shared by search_notes results and the relevant_notes attached at claim time
// (the latter additionally trims `body`; see mcp.ts).
export interface NoteHit {
  id: string;
  author: string;
  tags: string[];
  body: string;
  createdAt: number;
}

export interface DirectionState {
  directorId?: string;
  epoch: number;
  leaseExpiresAt?: number;
}

export type ClaimDirectionResult = { ok: true; epoch: number } | { ok: false; holder: Member; epoch: number };

export interface SweepResult {
  requeuedTasks: string[];
  expiredMembers: string[];
  expiredDirectionShows: string[];
}

export interface BoardMemberView {
  id: string;
  kind: MemberKind;
  displayName: string | null;
  role: MemberRole;
  registeredAt: number;
  lastSeenAt: number;
  leaseExpiresAt: number;
  stale: boolean;
  currentTaskId: string | null;
  sessionUrl?: string;
  resumeHint?: string;
}

export interface BoardTaskView {
  id: string;
  contextId: string | null;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  attempt: number;
  // createdAt lets the callboard order the queued column the way await_work claims
  // (priority DESC, age ASC); updatedAt alone can't reconstruct that.
  createdAt: number;
  updatedAt: number;
  // False when withheld by the human release gate: a queued task that no worker can claim until
  // a human releases it. The callboard surfaces these as a distinct "pending release" state.
  released: boolean;
  notes?: TaskNote[]; // present only when verbose
}

export interface BoardState {
  show: string;
  director:
    | { memberId: string; epoch: number; leaseExpiresAt: number; stale: boolean; sessionUrl?: string; resumeHint?: string }
    | null;
  members: BoardMemberView[];
  taskCounts: Record<TaskStatus, number>;
  tasks: BoardTaskView[];
  escalations: {
    inputRequired: BoardTaskView[];
    humanMessages: Message[];
  };
  recentMessages?: Message[]; // present only when verbose (DESIGN.md "Activity feed": notes + messages)
}

// Thrown by Store.checkEpoch (and surfaced by direct_task/create_task) when a director-only
// call's epoch no longer matches the current holder. The MCP layer returns this as a
// structured tool result, not a protocol error, so the old director reads it and stands down.
export class SupersededError extends Error {
  readonly show: string;
  readonly holder: Member | null;
  readonly epoch: number;

  constructor(show: string, holder: Member | null, epoch: number) {
    super(
      holder
        ? `superseded: you are no longer director of ${show}; ${holder.id} holds epoch ${epoch}. Re-register as a worker or await instructions.`
        : `superseded: you are no longer director of ${show}; direction is unclaimed at epoch ${epoch}. Re-register as a worker or await instructions.`,
    );
    this.name = "SupersededError";
    this.show = show;
    this.holder = holder;
    this.epoch = epoch;
  }
}

// --- Env config (DESIGN.md "Env knobs") ---

export interface LeaseConfig {
  workerLeaseS: number;
  taskLeaseS: number;
  directionLeaseS: number;
}

export interface NoteConfig {
  noteMaxChars: number;
  notesPerTask: number;
}

/** Bearer auth level after matching SHOWRUNNER_TOKEN vs SHOWRUNNER_WORKER_TOKEN. */
export type AuthLevel = "director" | "worker";

export interface EnvConfig extends LeaseConfig, NoteConfig {
  /** Director/admin token (SHOWRUNNER_TOKEN). */
  directorToken: string;
  /** Worker token (SHOWRUNNER_WORKER_TOKEN, or director when unset). */
  workerToken: string;
  /** Alias of directorToken for CLI / magic links / admin. */
  token: string;
  port: number;
  dataDir: string;
  pollHoldSeconds: number;
  sweepIntervalS: number;
  /** When true, director-created tasks are withheld until a human releases them on the callboard
   * (REQUIRE_TASK_RELEASE). Off by default to preserve OOTB automation; turn on when admitting
   * workers you do not fully trust, so a malicious director can't dispatch work unreviewed. */
  requireTaskRelease: boolean;
}

const DEFAULT_LEASES: LeaseConfig = { workerLeaseS: 90, taskLeaseS: 900, directionLeaseS: 600 };
const DEFAULT_NOTES: NoteConfig = { noteMaxChars: 2000, notesPerTask: 4 };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Lease TTLs only; no required vars, safe to call from the store without a token configured. */
export function readLeaseConfig(env: NodeJS.ProcessEnv = process.env): LeaseConfig {
  return {
    workerLeaseS: parsePositiveInt(env.WORKER_LEASE_S, DEFAULT_LEASES.workerLeaseS),
    taskLeaseS: parsePositiveInt(env.TASK_LEASE_S, DEFAULT_LEASES.taskLeaseS),
    directionLeaseS: parsePositiveInt(env.DIRECTION_LEASE_S, DEFAULT_LEASES.directionLeaseS),
  };
}

/** Note-related knobs only; same no-required-vars contract as readLeaseConfig. */
export function readNoteConfig(env: NodeJS.ProcessEnv = process.env): NoteConfig {
  return {
    noteMaxChars: parsePositiveInt(env.NOTE_MAX_CHARS, DEFAULT_NOTES.noteMaxChars),
    notesPerTask: parsePositiveInt(env.NOTES_PER_TASK, DEFAULT_NOTES.notesPerTask),
  };
}

/**
 * Full server config. Throws if SHOWRUNNER_TOKEN is unset.
 * SHOWRUNNER_WORKER_TOKEN is optional; when unset, worker == director (single-token mode).
 */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const directorToken = env.SHOWRUNNER_TOKEN;
  if (!directorToken) {
    throw new Error("SHOWRUNNER_TOKEN is required (server refuses to start without it)");
  }
  const workerRaw = env.SHOWRUNNER_WORKER_TOKEN;
  const workerToken = workerRaw && workerRaw.length > 0 ? workerRaw : directorToken;
  if (workerRaw && workerRaw.length > 0 && workerRaw === directorToken) {
    console.warn(
      "showrunner: SHOWRUNNER_WORKER_TOKEN equals SHOWRUNNER_TOKEN; running in single-token mode (anyone with the token can direct)",
    );
  }
  return {
    directorToken,
    workerToken,
    token: directorToken,
    port: parsePositiveInt(env.PORT, 8080),
    dataDir: env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : "/data",
    pollHoldSeconds: parsePositiveInt(env.POLL_HOLD_SECONDS, 25),
    sweepIntervalS: parsePositiveInt(env.SWEEP_INTERVAL_S, 5),
    requireTaskRelease: parseBool(env.REQUIRE_TASK_RELEASE, false),
    ...readLeaseConfig(env),
    ...readNoteConfig(env),
  };
}

/** Match a presented bearer/cookie/query token to an auth level, or null if neither matches. */
export function resolveAuthLevel(
  presented: string,
  cfg: Pick<EnvConfig, "directorToken" | "workerToken">,
): AuthLevel | null {
  const abuf = Buffer.from(presented);
  const match = (expected: string): boolean => {
    const bbuf = Buffer.from(expected);
    if (abuf.length !== bbuf.length) return false;
    return timingSafeEqual(abuf, bbuf);
  };
  // Prefer director when both match (single-token mode: workerToken === directorToken).
  if (match(cfg.directorToken)) return "director";
  if (match(cfg.workerToken)) return "worker";
  return null;
}
