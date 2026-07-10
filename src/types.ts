// Shared domain types for the showrunner store, MCP surface, HTTP API, and CLI.
// See DESIGN.md for vocabulary and PLAN.md for the pinned contracts these mirror.

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

export interface Message {
  id: string;
  show: string;
  fromId: string;
  toId: MessageTarget;
  taskId: string | null;
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
}

export interface BoardTaskView {
  id: string;
  contextId: string | null;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  attempt: number;
  updatedAt: number;
  notes?: TaskNote[]; // present only when verbose
}

export interface BoardState {
  show: string;
  director: { memberId: string; epoch: number; leaseExpiresAt: number; stale: boolean } | null;
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

export interface EnvConfig extends LeaseConfig {
  token: string;
  port: number;
  dataDir: string;
  pollHoldSeconds: number;
  sweepIntervalS: number;
}

const DEFAULT_LEASES: LeaseConfig = { workerLeaseS: 90, taskLeaseS: 900, directionLeaseS: 600 };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Lease TTLs only; no required vars, safe to call from the store without a token configured. */
export function readLeaseConfig(env: NodeJS.ProcessEnv = process.env): LeaseConfig {
  return {
    workerLeaseS: parsePositiveInt(env.WORKER_LEASE_S, DEFAULT_LEASES.workerLeaseS),
    taskLeaseS: parsePositiveInt(env.TASK_LEASE_S, DEFAULT_LEASES.taskLeaseS),
    directionLeaseS: parsePositiveInt(env.DIRECTION_LEASE_S, DEFAULT_LEASES.directionLeaseS),
  };
}

/** Full server config. Throws if SHOWRUNNER_TOKEN is unset, so the server refuses to start. */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const token = env.SHOWRUNNER_TOKEN;
  if (!token) {
    throw new Error("SHOWRUNNER_TOKEN is required (server refuses to start without it)");
  }
  return {
    token,
    port: parsePositiveInt(env.PORT, 8080),
    dataDir: env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : "/data",
    pollHoldSeconds: parsePositiveInt(env.POLL_HOLD_SECONDS, 25),
    sweepIntervalS: parsePositiveInt(env.SWEEP_INTERVAL_S, 5),
    ...readLeaseConfig(env),
  };
}
