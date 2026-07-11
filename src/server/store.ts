import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import {
  type BoardState,
  type BoardTaskView,
  type ClaimDirectionResult,
  type CreateTaskInput,
  type DirectionState,
  type DirectTaskAction,
  type Member,
  type MemberKind,
  type MemberRole,
  type Message,
  type MessageKind,
  type MessageTarget,
  type Note,
  type NoteHit,
  type OverlapWarning,
  type SaveNoteInput,
  type SweepResult,
  type Task,
  type TaskArtifact,
  type TaskNote,
  type TaskStatus,
  readLeaseConfig,
  readNoteConfig,
  SupersededError,
} from "../types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shows (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  show TEXT NOT NULL REFERENCES shows(name),
  kind TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'worker',
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  current_task_id TEXT,
  review_cursor INTEGER NOT NULL DEFAULT 0,
  session_url TEXT,
  resume_hint TEXT
);
CREATE INDEX IF NOT EXISTS members_show_idx ON members(show);

CREATE TABLE IF NOT EXISTS direction (
  show TEXT PRIMARY KEY REFERENCES shows(name),
  director_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  show TEXT NOT NULL REFERENCES shows(name),
  context_id TEXT,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  files_hint_json TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  assignee TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  lease_expires_at INTEGER,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_show_status_idx ON tasks(show, status);

CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_notes_task_idx ON task_notes(task_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  show TEXT NOT NULL REFERENCES shows(name),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  task_id TEXT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_show_idx ON messages(show, to_id);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id),
  member_id TEXT NOT NULL,
  PRIMARY KEY (message_id, member_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  show TEXT NOT NULL REFERENCES shows(name),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  files_hint_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  context_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_show_idx ON notes(show, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, show UNINDEXED, body, tags);
`;

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "rejected", "canceled"]);
const IN_FLIGHT_STATUSES: TaskStatus[] = ["queued", "assigned", "working", "input-required"];

// getBoard summary-mode bounds (DESIGN.md "Summary by default (~300 tokens)"): only the tail
// of finished-task/human-message history is kept; everything still in flight is unbounded.
const NON_VERBOSE_TASK_LIMIT = 20;
const NON_VERBOSE_MESSAGE_LIMIT = 20;

// search_notes token discipline (DESIGN.md "search results compact"): caller-supplied limit is
// clamped here so it can't return the whole notes table with full bodies regardless of caller.
const MAX_SEARCH_NOTES_LIMIT = 25;

// notesForTask's glob-overlap branch can't push the overlap check into SQL (files_hint_json is
// arbitrary globs, not a column filter), so it scans notes newest-first; bounded here so an
// unbounded, ever-growing notes table can't turn every claim into a full table scan.
const NOTES_GLOB_SCAN_LIMIT = 500;

// save_note tag caps: not an env knob (DESIGN.md's Env knobs table pins the note-related knobs
// to NOTE_MAX_CHARS/NOTES_PER_TASK only) -- tags are metadata, not the payload NOTE_MAX_CHARS
// bounds, but left fully unbounded they'd blow the same claim-time/search token budget.
const NOTE_MAX_TAGS = 8;
const NOTE_TAG_MAX_CHARS = 32;

const ADJECTIVES = [
  "amber", "brave", "calm", "dusty", "eager", "faded", "gentle", "honest", "ivory", "jolly",
  "keen", "lucky", "misty", "noble", "olive", "plain", "quiet", "rusty", "sunny", "tidy",
];
const ANIMALS = [
  "fox", "owl", "wolf", "hawk", "otter", "lynx", "crow", "deer", "seal", "moth",
  "heron", "viper", "mole", "swan", "stoat", "crane", "marten", "falcon", "badger", "raven",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Longest literal prefix before the first glob metacharacter. */
function globPrefix(glob: string): string {
  const idx = glob.search(/[*?[]/);
  return idx === -1 ? glob : glob.slice(0, idx);
}

/** Advisory-only heuristic: two globs "overlap" if either's literal prefix contains the other. */
function globsOverlap(a: string, b: string): boolean {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** True if any glob in `a` overlaps any glob in `b` (notes push/recall, DESIGN.md "files_hint
 * glob overlap"). */
function anyGlobOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (globsOverlap(x, y)) return true;
    }
  }
  return false;
}

/**
 * Builds a safe FTS5 MATCH expression from a free-text query: each whitespace-separated token
 * is wrapped as a quoted FTS5 string literal (internal `"` doubled per FTS5 escaping rules), so
 * operators/column-filters/syntax in a hostile query (`NEAR(`, `col:`, stray quotes, `--`) are
 * never interpreted -- they become literal tokens to match, and MATCH never throws. Tokens are
 * OR'd together so bm25 can rank partial matches instead of requiring every token to hit.
 */
function buildFtsMatchQuery(query: string): string | null {
  const tokens = query
    .replace(/\0/g, "") // FTS5's query scanner treats NUL as an unterminated-string error even
    // inside a doubled-quote literal, so it must go before quoting or "MATCH never throws" is a lie.
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

interface MemberRow {
  id: string;
  show: string;
  kind: string;
  display_name: string | null;
  role: string;
  registered_at: number;
  last_seen_at: number;
  lease_expires_at: number;
  current_task_id: string | null;
  review_cursor: number;
  session_url: string | null;
  resume_hint: string | null;
}

interface TaskRow {
  id: string;
  show: string;
  context_id: string | null;
  title: string;
  brief: string;
  files_hint_json: string;
  depends_on_json: string;
  priority: number;
  status: string;
  assignee: string | null;
  attempt: number;
  created_by: string;
  lease_expires_at: number | null;
  artifacts_json: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  show: string;
  from_id: string;
  to_id: string;
  task_id: string | null;
  body: string;
  kind: string;
  created_at: number;
}

interface DirectionRow {
  show: string;
  director_id: string | null;
  epoch: number;
  lease_expires_at: number;
}

// task_notes: a task's append-only journal (TaskNote). Not to be confused with NoteRow below,
// which is the notes table (show-wide shared memory, Note).
interface TaskNoteRow {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

interface NoteRow {
  id: string;
  show: string;
  author: string;
  body: string;
  tags_json: string;
  files_hint_json: string;
  task_id: string | null;
  context_id: string | null;
  created_at: number;
}

function mapMember(r: MemberRow): Member {
  return {
    id: r.id,
    show: r.show,
    kind: r.kind as MemberKind,
    displayName: r.display_name,
    role: r.role as MemberRole,
    registeredAt: r.registered_at,
    lastSeenAt: r.last_seen_at,
    leaseExpiresAt: r.lease_expires_at,
    currentTaskId: r.current_task_id,
    ...(r.session_url ? { sessionUrl: r.session_url } : {}),
    ...(r.resume_hint ? { resumeHint: r.resume_hint } : {}),
  };
}

function mapTask(r: TaskRow): Task {
  return {
    id: r.id,
    show: r.show,
    contextId: r.context_id,
    title: r.title,
    brief: r.brief,
    filesHint: JSON.parse(r.files_hint_json) as string[],
    dependsOn: JSON.parse(r.depends_on_json) as string[],
    priority: r.priority,
    status: r.status as TaskStatus,
    assignee: r.assignee,
    attempt: r.attempt,
    createdBy: r.created_by,
    leaseExpiresAt: r.lease_expires_at,
    artifacts: JSON.parse(r.artifacts_json) as TaskArtifact[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMessage(r: MessageRow): Message {
  return {
    id: r.id,
    show: r.show,
    fromId: r.from_id,
    toId: r.to_id as MessageTarget,
    taskId: r.task_id,
    body: r.body,
    kind: r.kind as MessageKind,
    createdAt: r.created_at,
  };
}

function mapTaskNote(r: TaskNoteRow): TaskNote {
  return { id: r.id, taskId: r.task_id, author: r.author, body: r.body, createdAt: r.created_at };
}

function mapNote(r: NoteRow): Note {
  return {
    id: r.id,
    show: r.show,
    author: r.author,
    body: r.body,
    tags: JSON.parse(r.tags_json) as string[],
    filesHint: JSON.parse(r.files_hint_json) as string[],
    taskId: r.task_id,
    contextId: r.context_id,
    createdAt: r.created_at,
  };
}

function mapNoteHit(r: NoteRow): NoteHit {
  return { id: r.id, author: r.author, tags: JSON.parse(r.tags_json) as string[], body: r.body, createdAt: r.created_at };
}

export class Store {
  readonly events = new EventEmitter();
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly leases: ReturnType<typeof readLeaseConfig>;
  private readonly noteConfig: ReturnType<typeof readNoteConfig>;

  constructor(dbPath: string, now: () => number = Date.now) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.migrateMessagesKindColumn();
    this.migrateMemberSessionColumns();
    this.now = now;
    this.leases = readLeaseConfig();
    this.noteConfig = readNoteConfig();
    // Every parked await_work adds a wake:* listener; a healthy show can easily have more
    // than the EventEmitter default of 10 concurrent pollers. Listener count is bounded by
    // concurrent polls and provably cleaned up (see mcp.test.ts), so unbound this rather
    // than spam MaxListenersExceededWarning in production logs.
    this.events.setMaxListeners(0);
  }

  /** Guarded upgrade-in-place (DESIGN.md data model): messages predates `kind`; a deployed DB
   * gets the column added with its default backfilled, instead of needing a destructive
   * recreate. No-op on a fresh DB, where SCHEMA_SQL already declares the column. */
  private migrateMessagesKindColumn(): void {
    const cols = this.db.pragma("table_info(messages)") as { name: string }[];
    if (!cols.some((c) => c.name === "kind")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
    }
  }

  /** Guarded upgrade-in-place: members predates session_url/resume_hint (the self-reported chat
   * link, DESIGN.md "register... session_url/resume_hint"); a deployed DB gets both columns
   * added -- nullable, no default, unlike messages.kind there's no meaningful backfill value --
   * instead of needing a destructive recreate. No-op on a fresh DB, where SCHEMA_SQL already
   * declares them. */
  private migrateMemberSessionColumns(): void {
    const cols = this.db.pragma("table_info(members)") as { name: string }[];
    if (!cols.some((c) => c.name === "session_url")) {
      this.db.exec("ALTER TABLE members ADD COLUMN session_url TEXT");
    }
    if (!cols.some((c) => c.name === "resume_hint")) {
      this.db.exec("ALTER TABLE members ADD COLUMN resume_hint TEXT");
    }
  }

  private txn<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- row lookups ---

  private getMemberRowRaw(id: string): MemberRow | undefined {
    return this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined;
  }

  private getTaskRowRaw(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  private getDirectionRow(show: string): DirectionRow | undefined {
    return this.db.prepare("SELECT * FROM direction WHERE show = ?").get(show) as DirectionRow | undefined;
  }

  private getMessageRowRaw(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  private getNoteRowRaw(id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  }

  private getNotes(taskId: string): TaskNote[] {
    const rows = this.db
      .prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as TaskNoteRow[];
    return rows.map(mapTaskNote);
  }

  /** Most recent messages of any kind (not just human-addressed) for the callboard activity feed. */
  private getRecentMessages(show: string, limit = 50): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE show = ? ORDER BY created_at DESC LIMIT ?")
      .all(show, limit) as MessageRow[];
    return rows.map(mapMessage).reverse();
  }

  private insertNote(taskId: string, author: string, body: string, at: number): void {
    this.db
      .prepare("INSERT INTO task_notes (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`n-${randomHex(6)}`, taskId, author, body, at);
  }

  private insertMessageRow(
    id: string,
    show: string,
    fromId: string,
    toId: string,
    taskId: string | null,
    body: string,
    at: number,
    kind: MessageKind = "message",
  ): void {
    this.db
      .prepare(
        "INSERT INTO messages (id, show, from_id, to_id, task_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, show, fromId, toId, taskId, body, at, kind);
  }

  // --- id generation ---

  private generateMemberId(): string {
    for (let i = 0; i < 50; i++) {
      const candidate = `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
      if (!this.getMemberRowRaw(candidate)) return candidate;
    }
    return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${randomHex(3)}`;
  }

  private generateTaskId(): string {
    for (let i = 0; i < 10; i++) {
      const candidate = `t-${randomHex(5)}`;
      if (!this.getTaskRowRaw(candidate)) return candidate;
    }
    throw new Error("failed to generate a unique task id");
  }

  private generateMessageId(): string {
    for (let i = 0; i < 10; i++) {
      const candidate = `m-${randomHex(5)}`;
      if (!this.getMessageRowRaw(candidate)) return candidate;
    }
    throw new Error("failed to generate a unique message id");
  }

  private generateNoteId(): string {
    for (let i = 0; i < 10; i++) {
      const candidate = `note-${randomHex(5)}`;
      if (!this.getNoteRowRaw(candidate)) return candidate;
    }
    throw new Error("failed to generate a unique note id");
  }

  // --- members / shows ---

  register(
    show: string,
    kind: MemberKind,
    displayName?: string,
    _capabilities?: string[],
    sessionUrl?: string,
    resumeHint?: string,
  ): Member {
    return this.txn(() => {
      const at = this.now();
      this.db
        .prepare("INSERT OR IGNORE INTO shows (name, created_at, config_json) VALUES (?, ?, '{}')")
        .run(show, at);
      this.db
        .prepare("INSERT OR IGNORE INTO direction (show, director_id, epoch, lease_expires_at) VALUES (?, NULL, 0, 0)")
        .run(show);

      const id = this.generateMemberId();
      const leaseExpiresAt = at + this.leases.workerLeaseS * 1000;
      this.db
        .prepare(
          `INSERT INTO members (id, show, kind, display_name, role, registered_at, last_seen_at, lease_expires_at, current_task_id, session_url, resume_hint)
           VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, show, kind, displayName ?? null, at, at, leaseExpiresAt, sessionUrl ?? null, resumeHint ?? null);
      return mapMember(this.getMemberRowRaw(id)!);
    });
  }

  /** Deletes a show and every record under it. Returns false if the show doesn't exist. */
  deleteShow(show: string): boolean {
    return this.txn(() => {
      const exists = this.db.prepare("SELECT 1 FROM shows WHERE name = ?").get(show);
      if (!exists) return false;
      this.db
        .prepare("DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE show = ?)")
        .run(show);
      this.db.prepare("DELETE FROM messages WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM task_notes WHERE task_id IN (SELECT id FROM tasks WHERE show = ?)").run(show);
      this.db.prepare("DELETE FROM notes_fts WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM notes WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM tasks WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM members WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM direction WHERE show = ?").run(show);
      this.db.prepare("DELETE FROM shows WHERE name = ?").run(show);
      // Parked polls of deleted members resolve on their next check with unknown_member.
      this.events.emit(`wake:show:${show}`);
      return true;
    });
  }

  showNames(): string[] {
    return this.db
      .prepare("SELECT name FROM shows ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
  }

  touchMember(memberId: string): Member | undefined {
    return this.txn(() => {
      const row = this.getMemberRowRaw(memberId);
      if (!row) return undefined;
      const at = this.now();
      const leaseExpiresAt = at + this.leases.workerLeaseS * 1000;
      this.db
        .prepare("UPDATE members SET last_seen_at = ?, lease_expires_at = ? WHERE id = ?")
        .run(at, leaseExpiresAt, memberId);
      return mapMember(this.getMemberRowRaw(memberId)!);
    });
  }

  getBoard(show: string, verbose = false): BoardState {
    const now = this.now();
    const dir = this.getDirectionRow(show);
    const directorMemberRow = dir?.director_id ? this.getMemberRowRaw(dir.director_id) : undefined;
    const director =
      dir && dir.director_id
        ? {
            memberId: dir.director_id,
            epoch: dir.epoch,
            leaseExpiresAt: dir.lease_expires_at,
            stale: dir.lease_expires_at < now,
            ...(directorMemberRow?.session_url ? { sessionUrl: directorMemberRow.session_url } : {}),
            ...(directorMemberRow?.resume_hint ? { resumeHint: directorMemberRow.resume_hint } : {}),
          }
        : null;

    const memberRows = this.db
      .prepare("SELECT * FROM members WHERE show = ? ORDER BY registered_at ASC")
      .all(show) as MemberRow[];
    const members = memberRows.map((m) => ({
      id: m.id,
      kind: m.kind as MemberKind,
      displayName: m.display_name,
      role: m.role as MemberRole,
      registeredAt: m.registered_at,
      lastSeenAt: m.last_seen_at,
      leaseExpiresAt: m.lease_expires_at,
      stale: m.lease_expires_at < now,
      currentTaskId: m.current_task_id,
      ...(m.session_url ? { sessionUrl: m.session_url } : {}),
      ...(m.resume_hint ? { resumeHint: m.resume_hint } : {}),
    }));

    const taskRows = this.db.prepare("SELECT * FROM tasks WHERE show = ? ORDER BY updated_at DESC").all(show) as TaskRow[];
    const taskCounts: Record<TaskStatus, number> = {
      queued: 0,
      assigned: 0,
      working: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      "input-required": 0,
      canceled: 0,
    };
    // Counts always cover every task regardless of verbosity; only the returned `tasks` list
    // (and human-addressed messages below) are bounded in summary mode.
    const allTasks: BoardTaskView[] = taskRows.map((t) => {
      const status = t.status as TaskStatus;
      taskCounts[status]++;
      const view: BoardTaskView = {
        id: t.id,
        contextId: t.context_id,
        title: t.title,
        status,
        assignee: t.assignee,
        priority: t.priority,
        attempt: t.attempt,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      };
      if (verbose) view.notes = this.getNotes(t.id);
      return view;
    });

    let tasks: BoardTaskView[];
    if (verbose) {
      tasks = allTasks;
    } else {
      // DESIGN.md "Summary by default (~300 tokens)": everything still in flight (it's what
      // needs attention) plus a bounded tail of recent done/canceled/rejected history --
      // never the full lifetime task list, which grows without bound on a long-running show.
      const inFlight = allTasks.filter((t) => IN_FLIGHT_STATUSES.includes(t.status));
      const done = allTasks.filter((t) => !IN_FLIGHT_STATUSES.includes(t.status));
      tasks = [...inFlight, ...done.slice(0, NON_VERBOSE_TASK_LIMIT)];
    }

    const { humanMessages: allHumanMessages } = this.humanBanner(show);
    const humanMessages = verbose ? allHumanMessages : allHumanMessages.slice(-NON_VERBOSE_MESSAGE_LIMIT);

    return {
      show,
      director,
      members,
      taskCounts,
      tasks,
      escalations: {
        inputRequired: tasks.filter((t) => t.status === "input-required"),
        humanMessages,
      },
      ...(verbose ? { recentMessages: this.getRecentMessages(show) } : {}),
    };
  }

  // --- direction ---

  claimDirection(memberId: string, takeover = false): ClaimDirectionResult {
    return this.txn(() => {
      const member = this.getMemberRowRaw(memberId);
      if (!member) throw new Error(`unknown member: ${memberId}`);
      const now = this.now();
      const dir = this.getDirectionRow(member.show)!;
      const currentValid = dir.director_id !== null && dir.lease_expires_at > now;
      const isNewHolder = dir.director_id !== memberId;

      if (takeover || !currentValid || dir.director_id === memberId) {
        const newEpoch = dir.epoch + 1;
        this.db
          .prepare("UPDATE direction SET director_id = ?, epoch = ?, lease_expires_at = ? WHERE show = ?")
          .run(memberId, newEpoch, now + this.leases.directionLeaseS * 1000, member.show);
        if (dir.director_id && dir.director_id !== memberId) {
          this.db.prepare("UPDATE members SET role = 'worker' WHERE id = ?").run(dir.director_id);
        }
        this.db.prepare("UPDATE members SET role = 'director' WHERE id = ?").run(memberId);
        if (isNewHolder) {
          // A fresh claim or a takeover from someone else starts this director's review
          // cursor at "now": it should see completions/input-required from here on, not
          // replay the show's entire done-history in its first await_work.
          this.db.prepare("UPDATE members SET review_cursor = ? WHERE id = ?").run(now, memberId);
        }
        return { ok: true, epoch: newEpoch };
      }

      const holder = mapMember(this.getMemberRowRaw(dir.director_id!)!);
      return { ok: false, holder, epoch: dir.epoch };
    });
  }

  /** Clears direction (admin action, e.g. `showrunner direction clear` demoting a runaway
   * director): bumps epoch to fence the old holder like a takeover would, but actually leaves
   * the show with no director instead of installing the human pseudo-member as one. */
  clearDirection(show: string): void {
    this.txn(() => {
      const dir = this.getDirectionRow(show);
      if (!dir) return;
      const now = this.now();
      if (dir.director_id) {
        this.db.prepare("UPDATE members SET role = 'worker' WHERE id = ?").run(dir.director_id);
      }
      this.db
        .prepare("UPDATE direction SET director_id = NULL, epoch = epoch + 1, lease_expires_at = ? WHERE show = ?")
        .run(now, show);
    });
  }

  getReviewCursor(memberId: string): number {
    return this.getMemberRowRaw(memberId)?.review_cursor ?? 0;
  }

  setReviewCursor(memberId: string, value: number): void {
    this.db.prepare("UPDATE members SET review_cursor = ? WHERE id = ?").run(value, memberId);
  }

  /** Throws SupersededError on mismatch; on success, renews the direction lease (heartbeat). */
  checkEpoch(show: string, memberId: string, epoch: number): void {
    const dir = this.getDirectionRow(show);
    if (!dir || dir.director_id !== memberId || dir.epoch !== epoch) {
      const holder = dir?.director_id ? (this.getMemberRowRaw(dir.director_id) ?? null) : null;
      throw new SupersededError(show, holder ? mapMember(holder) : null, dir?.epoch ?? 0);
    }
    const now = this.now();
    this.db
      .prepare("UPDATE direction SET lease_expires_at = ? WHERE show = ?")
      .run(now + this.leases.directionLeaseS * 1000, show);
  }

  directionState(show: string): DirectionState {
    const dir = this.getDirectionRow(show);
    if (!dir || dir.director_id === null) return { epoch: dir?.epoch ?? 0 };
    return { directorId: dir.director_id, epoch: dir.epoch, leaseExpiresAt: dir.lease_expires_at };
  }

  // --- tasks ---

  private computeOverlaps(show: string, newTaskId: string, filesHint: string[]): OverlapWarning[] {
    if (filesHint.length === 0) return [];
    const placeholders = IN_FLIGHT_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT id, title, files_hint_json FROM tasks WHERE show = ? AND id <> ? AND status IN (${placeholders})`)
      .all(show, newTaskId, ...IN_FLIGHT_STATUSES) as { id: string; title: string; files_hint_json: string }[];

    const warnings: OverlapWarning[] = [];
    for (const row of rows) {
      const otherGlobs = JSON.parse(row.files_hint_json) as string[];
      const matched = new Set<string>();
      for (const g of filesHint) {
        for (const og of otherGlobs) {
          if (globsOverlap(g, og)) matched.add(og);
        }
      }
      if (matched.size > 0) warnings.push({ taskId: row.id, title: row.title, globs: [...matched] });
    }
    return warnings;
  }

  createTask(input: CreateTaskInput): { task: Task; overlaps: OverlapWarning[] } {
    return this.txn(() => {
      const at = this.now();
      const id = this.generateTaskId();
      const filesHint = input.filesHint ?? [];
      const dependsOn = input.dependsOn ?? [];
      const priority = input.priority ?? 0;

      this.db
        .prepare(
          `INSERT INTO tasks
             (id, show, context_id, title, brief, files_hint_json, depends_on_json, priority,
              status, assignee, attempt, created_by, lease_expires_at, artifacts_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, '[]', ?, ?)`,
        )
        .run(
          id,
          input.show,
          input.contextId ?? null,
          input.title,
          input.brief,
          JSON.stringify(filesHint),
          JSON.stringify(dependsOn),
          priority,
          input.assignee ?? null,
          input.createdBy,
          at,
          at,
        );

      const overlaps = this.computeOverlaps(input.show, id, filesHint);
      if (input.assignee) {
        this.events.emit(`wake:${input.assignee}`);
      } else {
        this.events.emit(`wake:show:${input.show}`);
      }
      return { task: mapTask(this.getTaskRowRaw(id)!), overlaps };
    });
  }

  claimNextTask(memberId: string): Task | undefined {
    return this.txn(() => {
      const member = this.getMemberRowRaw(memberId);
      if (!member) return undefined;

      // Idempotent redelivery: if this member already holds a live task (its previous
      // await_work response may have been lost in transit, or it re-polled while still
      // working), hand back that same task instead of claiming a second one and stranding
      // the first, unheartbeated, until its lease reaps it.
      if (member.current_task_id) {
        const current = this.getTaskRowRaw(member.current_task_id);
        if (current && !TERMINAL_STATUSES.has(current.status as TaskStatus)) {
          return mapTask(current);
        }
      }

      const now = this.now();
      const candidates = this.db
        .prepare(
          "SELECT * FROM tasks WHERE show = ? AND status = 'queued' AND (assignee IS NULL OR assignee = ?) ORDER BY priority DESC, created_at ASC",
        )
        .all(member.show, memberId) as TaskRow[];

      for (const row of candidates) {
        const dependsOn = JSON.parse(row.depends_on_json) as string[];
        if (dependsOn.length > 0) {
          const allDone = dependsOn.every((depId) => {
            const dep = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(depId) as
              | { status: string }
              | undefined;
            return dep?.status === "completed";
          });
          if (!allDone) continue;
        }

        const leaseExpiresAt = now + this.leases.taskLeaseS * 1000;
        this.db
          .prepare("UPDATE tasks SET status = 'assigned', assignee = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
          .run(memberId, leaseExpiresAt, now, row.id);
        this.db.prepare("UPDATE members SET current_task_id = ? WHERE id = ?").run(row.id, memberId);
        this.insertNote(row.id, "system", `claimed by ${memberId}`, now);
        return mapTask(this.getTaskRowRaw(row.id)!);
      }
      return undefined;
    });
  }

  updateTask(
    memberId: string,
    taskId: string,
    patch: { status?: TaskStatus; note?: string; artifacts?: TaskArtifact[] },
  ): Task {
    return this.txn(() => {
      const row = this.getTaskRowRaw(taskId);
      if (!row) throw new Error(`unknown task: ${taskId}`);

      const caller = this.getMemberRowRaw(memberId);
      if (!caller) throw new Error(`unknown member: ${memberId}`);
      if (caller.show !== row.show) throw new Error(`task ${taskId} belongs to a different show`);

      // Fencing: once a live assignee holds the task, only that assignee may report on it.
      // row.assignee === null covers the pinned "requeued but not yet re-claimed" late-report
      // case; anything else means a reaped/superseded worker is trying to clobber whoever
      // re-claimed it (or renew a lease it no longer owns).
      if (row.assignee !== null && row.assignee !== memberId) {
        throw new Error(
          `task ${taskId} is held by ${row.assignee}, not ${memberId}; your claim on it was reaped -- stop working it and re-poll for new work`,
        );
      }

      // Terminal statuses are sticky: DESIGN.md's state machine has no transitions out of a
      // terminal status. Allow only an idempotent same-status re-report (plus notes/artifacts);
      // reject anything else so a stale worker's heartbeat can't silently undo a director's
      // cancel or resurrect a completed task.
      if (TERMINAL_STATUSES.has(row.status as TaskStatus) && patch.status && patch.status !== row.status) {
        throw new Error(`task ${taskId} is already ${row.status}; ignoring status change to ${patch.status}`);
      }

      const at = this.now();

      let artifacts = JSON.parse(row.artifacts_json) as TaskArtifact[];
      if (patch.artifacts && patch.artifacts.length > 0) {
        artifacts = artifacts.concat(patch.artifacts);
      }

      let status = row.status as TaskStatus;
      let assignee = row.assignee;
      let leaseExpiresAt = row.lease_expires_at;

      if (patch.status) {
        status = patch.status;
        if (TERMINAL_STATUSES.has(status)) {
          leaseExpiresAt = null;
        } else {
          leaseExpiresAt = at + this.leases.taskLeaseS * 1000;
        }
        // Late report after a lease-expiry requeue that nobody has re-claimed yet: the report
        // wins and is attributed to the reporter (idempotent-by-task-id semantics). Cancellation
        // is never a worker self-report though -- it must not stamp an assignee onto a task
        // nobody was working.
        if (assignee === null && status !== "canceled") assignee = memberId;
      } else if (status === "assigned" || status === "working" || status === "input-required") {
        leaseExpiresAt = at + this.leases.taskLeaseS * 1000;
      }

      this.db
        .prepare("UPDATE tasks SET status = ?, assignee = ?, lease_expires_at = ?, artifacts_json = ?, updated_at = ? WHERE id = ?")
        .run(status, assignee, leaseExpiresAt, JSON.stringify(artifacts), at, taskId);

      if (patch.status && patch.status !== row.status) {
        this.insertNote(taskId, memberId, `status: ${row.status} -> ${patch.status}`, at);
      }
      if (patch.note) {
        this.insertNote(taskId, memberId, patch.note, at);
      }

      if (TERMINAL_STATUSES.has(status)) {
        this.db.prepare("UPDATE members SET current_task_id = NULL WHERE current_task_id = ?").run(taskId);
      } else if (assignee) {
        this.db.prepare("UPDATE members SET current_task_id = ? WHERE id = ?").run(taskId, assignee);
      }

      if (patch.status) {
        this.events.emit(`wake:show:${row.show}`);
      }
      return mapTask(this.getTaskRowRaw(taskId)!);
    });
  }

  directTask(memberId: string, epoch: number, taskId: string, action: DirectTaskAction): Task {
    return this.txn(() => {
      const row = this.getTaskRowRaw(taskId);
      if (!row) throw new Error(`unknown task: ${taskId}`);
      this.checkEpoch(row.show, memberId, epoch);
      const at = this.now();
      const status = row.status as TaskStatus;

      switch (action.type) {
        case "cancel": {
          if (status === "canceled") break; // idempotent no-op: already canceled
          if (TERMINAL_STATUSES.has(status)) {
            throw new Error(`task ${taskId} is already ${status}; cannot cancel a finished task`);
          }
          this.db.prepare("UPDATE tasks SET status = 'canceled', lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, taskId);
          if (row.assignee) {
            this.db.prepare("UPDATE members SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(row.assignee, taskId);
            this.insertMessageRow(
              this.generateMessageId(),
              row.show,
              memberId,
              row.assignee,
              taskId,
              "this task was canceled by the director; stop working it",
              at,
            );
            this.events.emit(`wake:${row.assignee}`);
          }
          this.insertNote(taskId, memberId, "canceled by director", at);
          break;
        }
        case "requeue": {
          if (TERMINAL_STATUSES.has(status)) {
            throw new Error(`task ${taskId} is already ${status}; cannot requeue a finished task`);
          }
          this.db
            .prepare("UPDATE tasks SET status = 'queued', assignee = NULL, lease_expires_at = NULL, attempt = attempt + 1, updated_at = ? WHERE id = ?")
            .run(at, taskId);
          if (row.assignee) {
            this.db.prepare("UPDATE members SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(row.assignee, taskId);
          }
          this.insertNote(taskId, memberId, "requeued by director", at);
          this.events.emit(`wake:show:${row.show}`);
          break;
        }
        case "assign": {
          if (!TERMINAL_STATUSES.has(row.status as TaskStatus)) {
            if (row.assignee && row.assignee !== action.assignee) {
              this.db.prepare("UPDATE members SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(row.assignee, taskId);
            }
            this.db
              .prepare("UPDATE tasks SET assignee = ?, status = 'queued', lease_expires_at = NULL, updated_at = ? WHERE id = ?")
              .run(action.assignee, at, taskId);
          } else {
            this.db.prepare("UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?").run(action.assignee, at, taskId);
          }
          this.insertNote(taskId, memberId, `assigned to ${action.assignee}`, at);
          this.events.emit(`wake:${action.assignee}`);
          break;
        }
        case "answer": {
          if (status !== "input-required") {
            throw new Error(`task ${taskId} is not awaiting input (status: ${status}); answer is only valid for input-required tasks`);
          }
          this.db
            .prepare("UPDATE tasks SET status = 'working', lease_expires_at = ?, updated_at = ? WHERE id = ?")
            .run(at + this.leases.taskLeaseS * 1000, at, taskId);
          this.insertNote(taskId, memberId, `answer: ${action.body}`, at);
          if (row.assignee) {
            this.insertMessageRow(this.generateMessageId(), row.show, memberId, row.assignee, taskId, action.body, at);
            this.events.emit(`wake:${row.assignee}`);
          }
          break;
        }
        case "approve": {
          this.insertNote(taskId, memberId, "approved by director", at);
          break;
        }
      }
      return mapTask(this.getTaskRowRaw(taskId)!);
    });
  }

  /**
   * Admin/system cancel (the CLI's `task cancel` or a direct /api call, authenticated by bearer
   * token, not membership): mirrors directTask's cancel action but bypasses epoch fencing, and
   * -- unlike routing this through updateTask -- never touches the `assignee` column, so
   * canceling a queued (unassigned) task doesn't stamp the acting admin onto it as if they'd
   * worked it.
   */
  adminCancelTask(taskId: string, actor: string): Task {
    return this.txn(() => {
      const row = this.getTaskRowRaw(taskId);
      if (!row) throw new Error(`unknown task: ${taskId}`);
      const status = row.status as TaskStatus;
      if (!TERMINAL_STATUSES.has(status)) {
        const at = this.now();
        this.db.prepare("UPDATE tasks SET status = 'canceled', lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, taskId);
        if (row.assignee) {
          this.db.prepare("UPDATE members SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(row.assignee, taskId);
          this.events.emit(`wake:${row.assignee}`);
        }
        this.insertNote(taskId, actor, "canceled via admin API", at);
      }
      return mapTask(this.getTaskRowRaw(taskId)!);
    });
  }

  // --- messages ---

  sendMessage(fromId: string, to: MessageTarget, body: string, taskId?: string): Message {
    return this.txn(() => {
      const from = this.getMemberRowRaw(fromId);
      if (!from) throw new Error(`unknown member: ${fromId}`);

      // A typo'd or stale member id would otherwise black-hole the message: it inserts fine,
      // nothing ever wakes for it, and drainInbox never matches it against any live inbox.
      if (to !== "director" && to !== "all" && to !== "human") {
        const target = this.getMemberRowRaw(to);
        if (!target || target.show !== from.show) throw new Error(`unknown member: ${to}`);
      }

      const at = this.now();
      const id = this.generateMessageId();
      this.insertMessageRow(id, from.show, fromId, to, taskId ?? null, body, at);

      if (to === "all") {
        this.events.emit(`wake:show:${from.show}`);
      } else if (to === "director") {
        const dir = this.getDirectionRow(from.show);
        if (dir?.director_id) this.events.emit(`wake:${dir.director_id}`);
        this.events.emit(`wake:show:${from.show}`);
      } else if (to !== "human") {
        this.events.emit(`wake:${to}`);
      }
      return mapMessage(this.getMessageRowRaw(id)!);
    });
  }

  drainInbox(memberId: string): Message[] {
    return this.txn(() => {
      const member = this.getMemberRowRaw(memberId);
      if (!member) return [];
      const dir = this.getDirectionRow(member.show);
      const isDirector = dir?.director_id === memberId ? 1 : 0;

      const rows = this.db
        .prepare(
          `SELECT m.* FROM messages m
             LEFT JOIN message_reads r ON r.message_id = m.id AND r.member_id = ?
            WHERE m.show = ? AND r.message_id IS NULL
              AND (m.to_id = ? OR m.to_id = 'all' OR (m.to_id = 'director' AND ? = 1))
            ORDER BY m.created_at ASC`,
        )
        .all(memberId, member.show, memberId, isDirector) as MessageRow[];

      const insertRead = this.db.prepare("INSERT OR IGNORE INTO message_reads (message_id, member_id) VALUES (?, ?)");
      for (const r of rows) insertRead.run(r.id, memberId);
      return rows.map(mapMessage);
    });
  }

  humanBanner(show: string): { inputRequired: Task[]; humanMessages: Message[] } {
    const inputRequired = (
      this.db.prepare("SELECT * FROM tasks WHERE show = ? AND status = 'input-required' ORDER BY updated_at ASC").all(show) as TaskRow[]
    ).map(mapTask);
    const humanMessages = (
      this.db.prepare("SELECT * FROM messages WHERE show = ? AND to_id = 'human' ORDER BY created_at ASC").all(show) as MessageRow[]
    ).map(mapMessage);
    return { inputRequired, humanMessages };
  }

  // --- notes (DESIGN.md "Shared notes: realtime memory") ---

  /**
   * Push a note to shared memory. Recipients (DESIGN.md "push on save") are non-author members
   * whose *current* task is live (non-terminal) and structurally overlaps: same task, same
   * context, or files_hint glob intersection -- never fuzzy text match, so pushes stay rare
   * enough that agents don't learn to ignore them. Each recipient gets a kind:"note" message,
   * plus an immediate wake if their member lease says they're actually polling right now (see
   * pushNote); the author gets the note back with who it reached.
   */
  saveNote(memberId: string, input: SaveNoteInput): { note: Note; deliveredTo: string[] } {
    return this.txn(() => {
      const author = this.getMemberRowRaw(memberId);
      if (!author) throw new Error(`unknown member: ${memberId}`);

      if (input.body.length > this.noteConfig.noteMaxChars) {
        throw new Error(
          `note body exceeds NOTE_MAX_CHARS (${this.noteConfig.noteMaxChars} chars); got ${input.body.length} -- shorten it instead of relying on truncation`,
        );
      }
      const tags = input.tags ?? [];
      if (tags.length > NOTE_MAX_TAGS) {
        throw new Error(`too many tags (max ${NOTE_MAX_TAGS}); got ${tags.length}`);
      }
      for (const tag of tags) {
        if (tag.length > NOTE_TAG_MAX_CHARS) {
          throw new Error(`tag exceeds ${NOTE_TAG_MAX_CHARS} chars: "${tag.slice(0, 40)}..."`);
        }
      }

      // contextId is derived, not caller-supplied (DESIGN.md "derives contextId from taskId"):
      // a note about a task inherits that task's thread so context-wide recall/push still find it.
      let contextId: string | null = null;
      if (input.taskId) {
        const task = this.getTaskRowRaw(input.taskId);
        if (!task) throw new Error(`unknown task: ${input.taskId}`);
        if (task.show !== author.show) throw new Error(`task ${input.taskId} belongs to a different show`);
        contextId = task.context_id;
      }

      const at = this.now();
      const id = this.generateNoteId();
      const filesHint = input.filesHint ?? [];

      this.db
        .prepare(
          `INSERT INTO notes (id, show, author, body, tags_json, files_hint_json, task_id, context_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, author.show, memberId, input.body, JSON.stringify(tags), JSON.stringify(filesHint), input.taskId ?? null, contextId, at);
      // Same txn, no triggers (append-only): the two tables are written together here instead
      // of relying on an FTS5 content-table/trigger sync.
      this.db.prepare("INSERT INTO notes_fts (id, show, body, tags) VALUES (?, ?, ?, ?)").run(id, author.show, input.body, tags.join(" "));

      const note = mapNote(this.getNoteRowRaw(id)!);
      const deliveredTo = this.pushNote(author.show, memberId, note);
      return { note, deliveredTo };
    });
  }

  private pushNote(show: string, authorId: string, note: Note): string[] {
    const now = this.now();
    // Delivery is gated on the recipient's *current task* being live, not the 90s member
    // lease: a worker heads-down executing only has to heartbeat every ~10min (see the sweep()
    // comment below), so it's routinely outside its member lease window while still genuinely
    // working -- exactly the primary intended recipient of a note about the task it's on. The
    // task's own lease already bounds staleness (a stale task's assignee gets reaped and
    // current_task_id cleared), so a non-terminal current task is enough. The member lease is
    // consulted only below, to decide whether an immediate wake is worth emitting; the message
    // itself is inserted either way and picked up on the recipient's next drainInbox regardless.
    const candidates = this.db
      .prepare("SELECT * FROM members WHERE show = ? AND id <> ? AND current_task_id IS NOT NULL")
      .all(show, authorId) as MemberRow[];

    const delivered: string[] = [];
    for (const m of candidates) {
      const task = this.getTaskRowRaw(m.current_task_id!);
      if (!task || TERMINAL_STATUSES.has(task.status as TaskStatus)) continue;

      const sameTask = note.taskId !== null && task.id === note.taskId;
      const sameContext = note.contextId !== null && task.context_id !== null && task.context_id === note.contextId;
      const taskFilesHint = JSON.parse(task.files_hint_json) as string[];
      const overlapsFiles = note.filesHint.length > 0 && anyGlobOverlap(note.filesHint, taskFilesHint);
      if (!sameTask && !sameContext && !overlapsFiles) continue;

      this.insertMessageRow(this.generateMessageId(), show, authorId, m.id, note.taskId, note.body, now, "note");
      // Only worth waking a parked await_work if the member's lease says it's actually polling;
      // a heads-down worker well past its lease still gets the message, just via its next
      // drainInbox instead of an immediate wake.
      if (m.lease_expires_at > now) this.events.emit(`wake:${m.id}`);
      delivered.push(m.id);
    }
    return delivered;
  }

  /** BM25-ranked search over a show's notes. Query is tokenized and each token is quoted as an
   * FTS5 string literal (buildFtsMatchQuery) so a hostile query string can never throw or be
   * interpreted as FTS5 syntax. An all-whitespace/empty query matches nothing. `limit` is
   * clamped to MAX_SEARCH_NOTES_LIMIT regardless of what the caller asks for (DESIGN.md "search
   * results compact"). */
  searchNotes(show: string, query: string, limit = 8): NoteHit[] {
    const match = buildFtsMatchQuery(query);
    if (!match) return [];
    const cappedLimit = Math.min(limit, MAX_SEARCH_NOTES_LIMIT);
    try {
      const rows = this.db
        .prepare(
          `SELECT n.* FROM notes_fts f
             JOIN notes n ON n.id = f.id
            WHERE f.show = ? AND notes_fts MATCH ?
            ORDER BY bm25(notes_fts) ASC, n.created_at DESC
            LIMIT ?`,
        )
        .all(show, match, cappedLimit) as NoteRow[];
      return rows.map(mapNoteHit);
    } catch {
      // Belt-and-suspenders on top of buildFtsMatchQuery's own sanitizing: MATCH must never
      // throw (this function's contract), whatever FTS5 edge case slips past the quoting.
      return [];
    }
  }

  /**
   * Notes relevant to a task at claim time (DESIGN.md "Recall at claim time"): files_hint
   * glob-overlap hits first -- the structural signal DESIGN.md privileges over fuzzy text match
   * -- then BM25-over-title+brief hits fill whatever budget is left, deduped, newest-first
   * tiebreak. Returns full Notes; the caller (mcp.ts, building the delivered task payload) trims
   * bodies to the ~300-char relevant_notes shape.
   */
  notesForTask(task: Pick<Task, "show" | "title" | "brief" | "filesHint">, limit = this.noteConfig.notesPerTask): Note[] {
    const seen = new Set<string>();
    const result: Note[] = [];

    if (task.filesHint.length > 0) {
      // notes is append-only and unbounded; bound the scan to the most recent slice instead of
      // the whole show's history so a long-running show can't turn every claim into a full
      // table scan (glob overlap isn't expressible as a SQL predicate over files_hint_json).
      const rows = this.db
        .prepare("SELECT * FROM notes WHERE show = ? ORDER BY created_at DESC LIMIT ?")
        .all(task.show, NOTES_GLOB_SCAN_LIMIT) as NoteRow[];
      for (const row of rows) {
        if (result.length >= limit) break;
        if (seen.has(row.id)) continue;
        const noteFilesHint = JSON.parse(row.files_hint_json) as string[];
        if (noteFilesHint.length === 0 || !anyGlobOverlap(noteFilesHint, task.filesHint)) continue;
        seen.add(row.id);
        result.push(mapNote(row));
      }
    }

    if (result.length < limit) {
      const match = buildFtsMatchQuery(`${task.title} ${task.brief}`);
      if (match) {
        try {
          const rows = this.db
            .prepare(
              `SELECT n.* FROM notes_fts f
                 JOIN notes n ON n.id = f.id
                WHERE f.show = ? AND notes_fts MATCH ?
                ORDER BY bm25(notes_fts) ASC, n.created_at DESC
                LIMIT ?`,
            )
            .all(task.show, match, limit) as NoteRow[];
          for (const row of rows) {
            if (result.length >= limit) break;
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            result.push(mapNote(row));
          }
        } catch {
          // A recall failure must degrade to fewer notes, never poison the claim that's
          // handing this task out (see buildFtsMatchQuery / searchNotes for the same contract).
        }
      }
    }

    return result.slice(0, limit);
  }

  /** Most recent notes for a show (API layer / callboard), newest-last like getRecentMessages. */
  recentNotes(show: string, limit = 10): Note[] {
    const rows = this.db.prepare("SELECT * FROM notes WHERE show = ? ORDER BY created_at DESC LIMIT ?").all(show, limit) as NoteRow[];
    return rows.map(mapNote).reverse();
  }

  // --- liveness ---

  sweep(): SweepResult {
    return this.txn(() => {
      const now = this.now();
      const requeuedTasks: string[] = [];
      const showsTouched = new Set<string>();

      const staleMembers = this.db.prepare("SELECT id FROM members WHERE lease_expires_at < ?").all(now) as { id: string }[];
      const expiredMembers = staleMembers.map((m) => m.id);
      const staleMemberIds = new Set(expiredMembers);

      const active = this.db
        .prepare("SELECT id, show, status, assignee, attempt, lease_expires_at FROM tasks WHERE status IN ('assigned', 'working', 'input-required')")
        .all() as { id: string; show: string; status: string; assignee: string | null; attempt: number; lease_expires_at: number | null }[];

      for (const t of active) {
        const memberDead = t.assignee !== null && staleMemberIds.has(t.assignee);
        const taskLeaseExpired = t.lease_expires_at !== null && t.lease_expires_at < now;

        // assigned/working: the worker lease (90s) is renewed only by a tool call, but the
        // protocol has it heartbeat every ~10min while heads-down executing -- it may not
        // touch any tool for long stretches well inside the 90s window. Using memberDead here
        // would requeue (and duplicate) a task that's still being worked on perfectly fine; the
        // task lease (15min, matched to the heartbeat cadence) is the sole liveness signal.
        // input-required: the worker is legitimately idle awaiting an answer, not required to
        // heartbeat, so the task lease alone is exempted -- but a member that's gone fully
        // stale (not even polling) still needs reaping.
        const shouldRequeue = t.status === "input-required" ? memberDead : taskLeaseExpired;

        if (shouldRequeue) {
          this.db
            .prepare("UPDATE tasks SET status = 'queued', assignee = NULL, lease_expires_at = NULL, attempt = attempt + 1, updated_at = ? WHERE id = ?")
            .run(now, t.id);
          if (t.assignee) {
            this.db.prepare("UPDATE members SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(t.assignee, t.id);
          }
          this.insertNote(t.id, "system", `requeued: lease expired (attempt ${t.attempt + 1})`, now);
          requeuedTasks.push(t.id);
          showsTouched.add(t.show);
        }
      }

      const expiredDirectionRows = this.db
        .prepare("SELECT show FROM direction WHERE director_id IS NOT NULL AND lease_expires_at < ?")
        .all(now) as { show: string }[];
      const expiredDirectionShows = expiredDirectionRows.map((d) => d.show);

      for (const show of showsTouched) this.events.emit(`wake:show:${show}`);

      return { requeuedTasks, expiredMembers, expiredDirectionShows };
    });
  }
}
