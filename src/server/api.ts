// Pinned /api routes (PLAN.md "HTTP routes"). Reads and writes go through Store only;
// auth (bearer/cookie) is applied by index.ts before these routes are reached.

import Database from "better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "./store.js";

const createTaskSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  contextId: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).optional(),
  filesHint: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  assignee: z.string().min(1).optional(),
});

const messageSchema = z.object({
  to: z.string().min(1),
  body: z.string().min(1),
});

const rulesPatchSchema = z
  .object({
    switches: z
      .object({
        requireTaskRelease: z.boolean().optional(),
        requireHumanMergeApproval: z.boolean().optional(),
        workerNotePropagation: z.boolean().optional(),
        artifactTextMaxChars: z.number().int().positive().optional(),
        artifactDataMaxBytes: z.number().int().positive().optional(),
      })
      .optional(),
    policy: z.string().optional(),
  })
  .refine((v) => v.switches !== undefined || v.policy !== undefined, {
    message: "provide at least one of switches or policy",
  });

/**
 * Store's pinned API (PLAN.md) has no listShows() method; the `shows` table has no other
 * accessor. This is a narrow read-only fallback until Store grows one -- see final report.
 */
function listShows(dbPath: string): { name: string; createdAt: number }[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT name, created_at as createdAt FROM shows ORDER BY created_at DESC").all() as {
      name: string;
      createdAt: number;
    }[];
  } finally {
    db.close();
  }
}

/**
 * Admin HTTP actions act as "the human" but Store.sendMessage/claimDirection both require an
 * existing member row. Reuses (or creates once) a persistent `kind: "other"` member per show
 * to stand in for the human caller; createTask/updateTask take a plain string and don't need
 * this (see the "human" literal used directly below).
 */
function ensureHumanMember(store: Store, show: string): { id: string } {
  const existing = store.getBoard(show).members.find((m) => m.kind === "other" && m.displayName === "human");
  if (existing) return existing;
  return store.register(show, "other", "human");
}

export function createApiRoutes(store: Store, dbPath: string): Hono {
  const api = new Hono();

  api.get("/shows", (c) => c.json({ shows: listShows(dbPath) }));

  api.get("/shows/:show/state", (c) => {
    const show = c.req.param("show");
    const board = store.getBoard(show, true);
    // Store.recentNotes returns newest-last (chronological, matching getRecentMessages'
    // convention for feeds that get re-merged/sorted elsewhere). The callboard's activity
    // feed re-sorts everything it merges, so the newest-first flip here is only for other
    // /state consumers reading the list directly.
    const recentNotes = store.recentNotes(show, 10).reverse();
    return c.json({ ...board, recentNotes });
  });

  api.post("/shows/:show/message", async (c) => {
    const parsed = messageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const show = c.req.param("show");
    const human = ensureHumanMember(store, show);
    try {
      const message = store.sendMessage(human.id, parsed.data.to, parsed.data.body);
      return c.json({ message });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  api.post("/shows/:show/tasks", async (c) => {
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const show = c.req.param("show");
    ensureHumanMember(store, show); // ensures the show row exists (tasks.show has a FK)
    const { task, overlaps } = store.createTask({ show, createdBy: "human", ...parsed.data });
    return c.json({ task, overlaps });
  });

  api.post("/shows/:show/tasks/:id/cancel", (c) => {
    try {
      const task = store.adminCancelTask(c.req.param("id"), "human");
      return c.json({ task });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // Human release of a task withheld by the release gate. Director-token gated (like every
  // mutating /api route), so this is a genuine human-in-the-loop checkpoint on a brief before any
  // worker can claim it, not something a registered agent can trigger for itself.
  api.post("/shows/:show/tasks/:id/release", (c) => {
    const task = store.releaseTask(c.req.param("id"), "human");
    if (!task) return c.json({ error: `no such task: ${c.req.param("id")}` }, 404);
    return c.json({ task });
  });

  // Read + edit the show's rules from the callboard/CLI (director-token gated). Editing is the
  // human's counterpart to the director's update_rules tool: it bumps the version, is audited as
  // updated_by "human", and notifies the cast via the existing send-to-all pattern.
  api.get("/shows/:show/rules", (c) => c.json({ rules: store.getShowRules(c.req.param("show")) }));

  api.post("/shows/:show/rules", async (c) => {
    const parsed = rulesPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const show = c.req.param("show");
    const human = ensureHumanMember(store, show);
    const rules = store.updateShowRules(show, parsed.data, "human");
    store.sendMessage(human.id, "all", `show rules updated to v${rules.version} by human`);
    return c.json({ rules });
  });

  api.delete("/shows/:show", (c) => {
    const show = c.req.param("show");
    if (!store.deleteShow(show)) return c.json({ error: `no such show: ${show}` }, 404);
    return c.json({ deleted: show });
  });

  api.post("/shows/:show/direction/clear", (c) => {
    const show = c.req.param("show");
    store.clearDirection(show);
    return c.json({ direction: store.directionState(show) });
  });

  return api;
}
