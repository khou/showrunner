import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/server/store.js";
import { SupersededError } from "../src/types.js";

// Injected clock: tests advance `clock.t` directly, no sleeps, no timers.
function makeClock(start = 1_000_000) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

function newStore() {
  const { clock, now } = makeClock();
  const store = new Store(":memory:", now);
  return { store, clock };
}

describe("register / touchMember", () => {
  it("creates a show on first register and returns a member with a memorable id", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local", "kevin's laptop");
    expect(m.show).toBe("myshow");
    expect(m.kind).toBe("claude-local");
    expect(m.displayName).toBe("kevin's laptop");
    expect(m.role).toBe("worker");
    expect(m.id).toMatch(/^[a-z]+-[a-z]+/);
  });

  it("touchMember renews the lease and returns undefined for unknown ids", () => {
    const { store, clock } = newStore();
    const m = store.register("myshow", "claude-local");
    const before = m.leaseExpiresAt;
    clock.t += 10_000;
    const touched = store.touchMember(m.id);
    expect(touched?.leaseExpiresAt).toBeGreaterThan(before);
    expect(store.touchMember("nobody")).toBeUndefined();
  });
});

describe("register: session_url / resume_hint (self-reported chat link)", () => {
  it("persists whichever is given and exposes it on the member and the board", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local", "planning session", undefined, "https://claude.ai/code/session_abc");
    expect(director.sessionUrl).toBe("https://claude.ai/code/session_abc");
    expect(director.resumeHint).toBeUndefined();

    const worker = store.register("myshow", "claude-local", undefined, undefined, undefined, "claude --resume 7f3a9c");
    expect(worker.resumeHint).toBe("claude --resume 7f3a9c");
    expect(worker.sessionUrl).toBeUndefined();

    const board = store.getBoard("myshow");
    expect(board.members.find((m) => m.id === director.id)?.sessionUrl).toBe("https://claude.ai/code/session_abc");
    expect(board.members.find((m) => m.id === worker.id)?.resumeHint).toBe("claude --resume 7f3a9c");
  });

  it("omits both keys entirely (not null) when neither is reported", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local");
    expect(m).not.toHaveProperty("sessionUrl");
    expect(m).not.toHaveProperty("resumeHint");

    const board = store.getBoard("myshow");
    const boardMember = board.members.find((x) => x.id === m.id)!;
    expect(boardMember).not.toHaveProperty("sessionUrl");
    expect(boardMember).not.toHaveProperty("resumeHint");
  });

  it("exposes the director's session_url/resume_hint on the board's director card", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local", undefined, undefined, "https://claude.ai/code/session_dir");
    store.claimDirection(director.id);

    const board = store.getBoard("myshow");
    expect(board.director?.sessionUrl).toBe("https://claude.ai/code/session_dir");
  });
});

describe("claim atomicity", () => {
  it("two claims for the same queued task produce exactly one winner", () => {
    const { store } = newStore();
    const w1 = store.register("myshow", "claude-local");
    const w2 = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "one task", brief: "b", createdBy: director.id });

    const claim1 = store.claimNextTask(w1.id);
    const claim2 = store.claimNextTask(w2.id);

    expect(claim1).toBeDefined();
    expect(claim2).toBeUndefined();
    expect(claim1!.assignee).toBe(w1.id);
    expect(claim1!.status).toBe("assigned");
  });
});

describe("dependency gating", () => {
  it("does not claim a task until its dependency is completed", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const worker2 = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { task: base } = store.createTask({ show: "myshow", title: "base", brief: "b", createdBy: director.id });
    store.createTask({
      show: "myshow",
      title: "dependent",
      brief: "b",
      createdBy: director.id,
      dependsOn: [base.id],
    });

    // Only "base" is claimable; the dependent stays blocked for anyone, even a member with no
    // task of its own (worker2, so idempotent-redelivery on worker doesn't muddy the result).
    const first = store.claimNextTask(worker.id);
    expect(first!.title).toBe("base");
    expect(store.claimNextTask(worker2.id)).toBeUndefined();

    store.updateTask(worker.id, first!.id, { status: "completed" });
    const second = store.claimNextTask(worker2.id);
    expect(second!.title).toBe("dependent");
  });
});

describe("idempotent redelivery", () => {
  it("returns the same task on a repeat claim while it's still held, instead of claiming a second one", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t1", brief: "b", createdBy: director.id });
    store.createTask({ show: "myshow", title: "t2", brief: "b", createdBy: director.id });

    const first = store.claimNextTask(worker.id);
    const again = store.claimNextTask(worker.id);
    expect(again!.id).toBe(first!.id);
    expect(again!.status).toBe("assigned");

    // The second task is still sitting untouched in the queue, not silently stranded.
    expect(store.getBoard("myshow").taskCounts.queued).toBe(1);
  });

  it("claims a fresh task once the held one reaches a terminal status", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t1", brief: "b", createdBy: director.id });
    store.createTask({ show: "myshow", title: "t2", brief: "b", createdBy: director.id });

    const first = store.claimNextTask(worker.id)!;
    store.updateTask(worker.id, first.id, { status: "completed" });
    const second = store.claimNextTask(worker.id);
    expect(second!.id).not.toBe(first.id);
    expect(second!.title).toBe("t2");
  });
});

describe("priority / age ordering", () => {
  it("claims highest priority first, then oldest among equal priority", () => {
    // Three separate claimants: claimNextTask returns the same held task on a repeat call by
    // one member (idempotent redelivery), so ordering across successive claims is tested with
    // members that don't already hold anything.
    const { store, clock } = newStore();
    const w1 = store.register("myshow", "claude-local");
    const w2 = store.register("myshow", "claude-local");
    const w3 = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");

    store.createTask({ show: "myshow", title: "low-pri", brief: "b", createdBy: director.id, priority: 0 });
    clock.t += 1000;
    const { task: oldHighPri } = store.createTask({ show: "myshow", title: "high-pri-old", brief: "b", createdBy: director.id, priority: 5 });
    clock.t += 1000;
    store.createTask({ show: "myshow", title: "high-pri-new", brief: "b", createdBy: director.id, priority: 5 });

    const first = store.claimNextTask(w1.id);
    expect(first!.id).toBe(oldHighPri.id);
    const second = store.claimNextTask(w2.id);
    expect(second!.title).toBe("high-pri-new");
    const third = store.claimNextTask(w3.id);
    expect(third!.title).toBe("low-pri");
  });

  it("honors a pinned assignee: only that member can claim it", () => {
    const { store } = newStore();
    const w1 = store.register("myshow", "claude-local");
    const w2 = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "pinned", brief: "b", createdBy: director.id, assignee: w2.id });

    expect(store.claimNextTask(w1.id)).toBeUndefined();
    const claimed = store.claimNextTask(w2.id);
    expect(claimed!.assignee).toBe(w2.id);
  });
});

describe("lease expiry requeues", () => {
  it("requeues an assigned task past its task lease and bumps attempt", () => {
    const { store, clock } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    const claimed = store.claimNextTask(worker.id)!;
    expect(claimed.attempt).toBe(0);

    clock.t += 900_001; // past default TASK_LEASE_S (900s)
    const result = store.sweep();
    expect(result.requeuedTasks).toEqual([claimed.id]);

    const board = store.getBoard("myshow");
    const task = board.tasks.find((t) => t.id === claimed.id)!;
    expect(task.status).toBe("queued");
    expect(task.assignee).toBeNull();
    expect(task.attempt).toBe(1);
  });

  it("does not requeue an assigned/working task just because its member's poll-lease went stale", () => {
    // A worker heads-down executing (running tools, editing files) may not touch the MCP
    // server at all for long stretches -- it only has to heartbeat every ~10min, well inside
    // the 15min task lease, but the 90s worker (poll) lease has no such guarantee. Treating a
    // stale worker lease as task abandonment would requeue -- and duplicate -- live work.
    const { store, clock } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    const claimed = store.claimNextTask(worker.id)!;

    clock.t += 90_001; // past default WORKER_LEASE_S (90s), well under the 900s task lease
    const result = store.sweep();
    expect(result.expiredMembers).toContain(worker.id); // still shown stale on the callboard
    expect(result.requeuedTasks).toEqual([]); // but the task itself is untouched

    const board = store.getBoard("myshow");
    const task = board.tasks.find((t) => t.id === claimed.id)!;
    expect(task.status).toBe("assigned");
    expect(task.assignee).toBe(worker.id);
  });

  it("does not churn an input-required task on task-lease expiry alone", () => {
    const { store, clock } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    const claimed = store.claimNextTask(worker.id)!;
    store.updateTask(worker.id, claimed.id, { status: "input-required", note: "need a decision" });

    clock.t += 900_001;
    // Renew the worker's own lease so only the task lease is "expired"; member stays alive.
    store.touchMember(worker.id);
    const result = store.sweep();
    expect(result.requeuedTasks).toEqual([]);
  });
});

describe("idempotent completion after reaping", () => {
  it("accepts a late completion report after the task was requeued but not yet re-claimed", () => {
    const { store, clock } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    const claimed = store.claimNextTask(worker.id)!;

    clock.t += 900_001;
    store.sweep(); // requeues; nobody has re-claimed it yet

    const completed = store.updateTask(worker.id, claimed.id, {
      status: "completed",
      artifacts: [{ kind: "text", text: "done anyway" }],
    });
    expect(completed.status).toBe("completed");
    expect(completed.attempt).toBe(1); // attempt bump from the requeue is preserved
    expect(completed.artifacts).toEqual([{ kind: "text", text: "done anyway" }]);
  });
});

describe("updateTask fencing", () => {
  it("rejects a report from a member other than the current assignee", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    const claimed = store.claimNextTask(a.id)!;

    clock.t += 900_001; // reap a's lease
    store.sweep();
    store.claimNextTask(b.id); // b re-claims

    expect(() => store.updateTask(a.id, claimed.id, { status: "completed" })).toThrow(/held by/);
  });

  it("keeps terminal statuses sticky: a stale worker's report can't undo a director's cancel", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.directTask(director.id, 1, task.id, { type: "cancel" });

    expect(() => store.updateTask(worker.id, task.id, { status: "working" })).toThrow(/already canceled/);
    expect(store.getBoard("myshow").tasks.find((t) => t.id === task.id)!.status).toBe("canceled");
  });

  it("allows an idempotent same-status re-report on a terminal task", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "completed" });

    const again = store.updateTask(worker.id, task.id, { status: "completed", note: "retry" });
    expect(again.status).toBe("completed");
  });
});

describe("directTask status validation", () => {
  it("rejects 'answer' on a task that isn't awaiting input", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });

    expect(() => store.directTask(director.id, 1, task.id, { type: "answer", body: "sure" })).toThrow(/not awaiting input/);
  });

  it("rejects 'cancel' on an already-completed task, but allows canceling an already-canceled one", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const { task: done } = store.createTask({ show: "myshow", title: "done", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, done.id, { status: "completed" });
    expect(() => store.directTask(director.id, 1, done.id, { type: "cancel" })).toThrow(/already completed/);

    const { task: canceled } = store.createTask({ show: "myshow", title: "c", brief: "b", createdBy: director.id });
    store.directTask(director.id, 1, canceled.id, { type: "cancel" });
    expect(() => store.directTask(director.id, 1, canceled.id, { type: "cancel" })).not.toThrow();
  });

  it("rejects 'requeue' on a terminal task", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "failed" });

    expect(() => store.directTask(director.id, 1, task.id, { type: "requeue" })).toThrow(/already failed/);
  });
});

describe("direction: CAS, takeover, stale epoch", () => {
  it("first claim always succeeds and starts at epoch 1", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local");
    const result = store.claimDirection(m.id);
    expect(result).toEqual({ ok: true, epoch: 1 });
  });

  it("a second member cannot claim while the lease is valid, unless taking over", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);

    const blocked = store.claimDirection(b.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.holder.id).toBe(a.id);
      expect(blocked.epoch).toBe(1);
    }

    const takeover = store.claimDirection(b.id, true);
    expect(takeover).toEqual({ ok: true, epoch: 2 });
  });

  it("an expired lease does NOT open the seat for a plain claim (no implicit transfer by timeout)", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    clock.t += 600_001; // past default DIRECTION_LEASE_S (600s): a's lease is now stale
    const result = store.claimDirection(b.id);
    expect(result.ok).toBe(false); // still held by a; staleness is liveness-only
    if (!result.ok) expect(result.holder.id).toBe(a.id);
    // b must use takeover (human authority) to displace a stale holder.
    expect(store.claimDirection(b.id, true)).toEqual({ ok: true, epoch: 2 });
  });

  it("release_direction opens the seat so a later plain claim succeeds", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id); // epoch 1
    const released = store.releaseDirection(a.id, 1); // a stands down
    expect(released.epoch).toBe(2);
    expect(store.directionState("myshow").directorId).toBeUndefined();
    expect(store.getBoard("myshow").members.find((m) => m.id === a.id)!.role).toBe("worker");
    // Now the seat is unheld; b's plain claim (no takeover) succeeds.
    expect(store.claimDirection(b.id)).toEqual({ ok: true, epoch: 3 });
  });

  it("release_direction is epoch-fenced: a non-holder or stale epoch is rejected", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id); // a holds epoch 1
    expect(() => store.releaseDirection(b.id, 1)).toThrow(SupersededError); // b isn't the holder
    expect(() => store.releaseDirection(a.id, 99)).toThrow(SupersededError); // wrong epoch
    // a is still the director; nothing changed.
    expect(store.directionState("myshow").directorId).toBe(a.id);
  });

  it("checkEpoch throws SupersededError with the new holder once superseded", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    store.claimDirection(b.id, true);

    expect(() => store.checkEpoch("myshow", a.id, 1)).toThrow(SupersededError);
    try {
      store.checkEpoch("myshow", a.id, 1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SupersededError);
      expect((err as SupersededError).holder?.id).toBe(b.id);
      expect((err as SupersededError).epoch).toBe(2);
    }
    // The current holder with the current epoch passes and renews the lease.
    expect(() => store.checkEpoch("myshow", b.id, 2)).not.toThrow();
  });

  it("directTask surfaces SupersededError for a stale epoch instead of acting", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: a.id });
    store.claimDirection(b.id, true); // supersedes a

    expect(() => store.directTask(a.id, 1, task.id, { type: "cancel" })).toThrow(SupersededError);
  });

  it("seeds a new/takeover director's review cursor to the claim time, not 0", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    clock.t += 5000;

    store.claimDirection(a.id); // fresh claim
    expect(store.getReviewCursor(a.id)).toBe(clock.t);

    clock.t += 1000;
    store.claimDirection(b.id, true); // takeover
    expect(store.getReviewCursor(b.id)).toBe(clock.t);
    // a's own cursor (from its now-superseded claim) is untouched by b's takeover.
    expect(store.getReviewCursor(a.id)).toBeLessThan(clock.t);
  });

  it("does not reset an active director's cursor on a same-holder re-claim", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    clock.t += 5000;
    store.setReviewCursor(a.id, clock.t);

    store.claimDirection(a.id); // same holder, renewing its own lease
    expect(store.getReviewCursor(a.id)).toBe(clock.t); // untouched, not reset to "now"
  });
});

describe("clearDirection", () => {
  it("nulls the director instead of installing a stand-in, and fences the old epoch", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    store.claimDirection(a.id); // epoch 1

    store.clearDirection("myshow");

    const dirState = store.directionState("myshow");
    expect(dirState.directorId).toBeUndefined();
    expect(dirState.epoch).toBe(2);
    const board = store.getBoard("myshow");
    expect(board.director).toBeNull();
    expect(board.members.find((m) => m.id === a.id)!.role).toBe("worker");

    // The old director is fenced: its stale epoch is rejected like any other takeover.
    expect(() => store.checkEpoch("myshow", a.id, 1)).toThrow(SupersededError);
  });

  it("is a no-op for a show that was never directed", () => {
    const { store } = newStore();
    store.register("myshow", "claude-local");
    expect(() => store.clearDirection("myshow")).not.toThrow();
    expect(store.directionState("myshow").directorId).toBeUndefined();
  });
});

describe("direction audit + provenance", () => {
  it("records an event per transition with actor, method, and epoch", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id); // claimed @1
    store.releaseDirection(a.id, 1); // released @2
    store.claimDirection(b.id); // claimed @3 (unheld seat)
    store.claimDirection(a.id, true); // takeover @4 (displaces b)
    store.clearDirection("myshow"); // admin_clear @5

    const events = store.directionEvents("myshow").map((e) => ({ actor: e.actor, method: e.method, epoch: e.epoch }));
    expect(events).toEqual([
      { actor: a.id, method: "claimed", epoch: 1 },
      { actor: a.id, method: "released", epoch: 2 },
      { actor: b.id, method: "claimed", epoch: 3 },
      { actor: a.id, method: "takeover", epoch: 4 },
      { actor: "human", method: "admin_clear", epoch: 5 },
    ]);
  });

  it("surfaces the current holder's provenance on the board", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    clock.t += 1000;
    store.claimDirection(b.id, true); // takeover @2

    const board = store.getBoard("myshow");
    expect(board.director?.memberId).toBe(b.id);
    expect(board.director?.provenance).toMatchObject({ method: "takeover", actor: b.id, epoch: 2, at: clock.t });
  });

  it("sweep logs an expired event once per holding, without opening the seat", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id); // epoch 1
    clock.t += 600_001; // a's direction lease expires
    store.sweep();
    store.sweep(); // idempotent: still one expired event at epoch 1

    const expired = store.directionEvents("myshow").filter((e) => e.method === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ actor: a.id, epoch: 1 });
    // The seat is still held (staleness is liveness-only): a plain claim by b still fails.
    expect(store.claimDirection(b.id).ok).toBe(false);
  });
});

describe("messages: unread-only inbox", () => {
  it("throws for an unknown message recipient instead of black-holing it", () => {
    const { store } = newStore();
    const sender = store.register("myshow", "claude-local");
    expect(() => store.sendMessage(sender.id, "not-a-real-member", "hi")).toThrow(/unknown member/);
  });

  it("delivers unread messages once and marks them read", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    store.sendMessage(director.id, worker.id, "hello");

    const first = store.drainInbox(worker.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toBe("hello");

    const second = store.drainInbox(worker.id);
    expect(second).toHaveLength(0);
  });

  it("delivers 'director'-addressed messages to whoever currently holds direction", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    const sender = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    store.sendMessage(sender.id, "director", "status?");

    expect(store.drainInbox(b.id)).toHaveLength(0);
    expect(store.drainInbox(a.id)).toHaveLength(1);
  });

  it("delivers 'all'-addressed messages to every member independently", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.sendMessage(a.id, "all", "heads up");

    expect(store.drainInbox(a.id)).toHaveLength(1);
    expect(store.drainInbox(b.id)).toHaveLength(1);
    expect(store.drainInbox(a.id)).toHaveLength(0);
    expect(store.drainInbox(b.id)).toHaveLength(0);
  });
});

describe("overlap warnings", () => {
  it("warns (never blocks) when files_hint globs intersect an in-flight task", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.createTask({
      show: "myshow",
      title: "server work",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/**"],
    });

    const { task, overlaps } = store.createTask({
      show: "myshow",
      title: "store work",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/store.ts"],
    });

    expect(task.status).toBe("queued"); // never blocked
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.title).toBe("server work");
  });

  it("does not warn when globs don't intersect", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "cli work", brief: "b", createdBy: director.id, filesHint: ["src/cli/**"] });
    const { overlaps } = store.createTask({
      show: "myshow",
      title: "web work",
      brief: "b",
      createdBy: director.id,
      filesHint: ["web/**"],
    });
    expect(overlaps).toHaveLength(0);
  });

  it("ignores completed tasks when computing overlaps", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { task: done } = store.createTask({
      show: "myshow",
      title: "old",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/**"],
    });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, done.id, { status: "completed" });

    const { overlaps } = store.createTask({
      show: "myshow",
      title: "new",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/store.ts"],
    });
    expect(overlaps).toHaveLength(0);
  });
});

describe("sweep correctness", () => {
  it("reports expired members and direction, requeues both stale-task cases, in one pass", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: a.id });
    store.claimNextTask(worker.id);

    clock.t += 900_001; // past task, worker, and direction leases alike
    const result = store.sweep();

    expect(result.requeuedTasks).toHaveLength(1);
    expect(result.expiredMembers.sort()).toEqual([a.id, worker.id].sort());
    expect(result.expiredDirectionShows).toEqual(["myshow"]);
  });

  it("is idempotent: a second sweep with nothing new expired changes nothing further", () => {
    const { store, clock } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);

    clock.t += 900_001;
    const first = store.sweep();
    expect(first.requeuedTasks).toHaveLength(1);

    const second = store.sweep();
    expect(second.requeuedTasks).toEqual([]);
  });
});

describe("wake events", () => {
  it("emits wake:show:{show} when an unpinned task is created", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    let woke = false;
    store.events.once("wake:show:myshow", () => (woke = true));
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    expect(woke).toBe(true);
  });

  it("emits wake:{memberId} when a task is created with a pinned assignee", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    let woke = false;
    store.events.once(`wake:${worker.id}`, () => (woke = true));
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id });
    expect(woke).toBe(true);
  });
});

describe("saveNote: validation", () => {
  it("throws for an unknown member", () => {
    const { store } = newStore();
    expect(() => store.saveNote("nobody", { body: "x" })).toThrow(/unknown member/);
  });

  it("rejects a body over NOTE_MAX_CHARS instead of truncating it silently", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const atCap = "x".repeat(2000); // default NOTE_MAX_CHARS
    expect(() => store.saveNote(author.id, { body: atCap })).not.toThrow();

    const overCap = "x".repeat(2001);
    expect(() => store.saveNote(author.id, { body: overCap })).toThrow(/NOTE_MAX_CHARS/);
  });

  it("rejects too many tags, or a single tag that's unreasonably long, instead of shipping them untrimmed into every claim/search payload", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    expect(() => store.saveNote(author.id, { body: "x", tags: Array(9).fill("t") })).toThrow(/too many tags/);
    expect(() => store.saveNote(author.id, { body: "x", tags: Array(8).fill("t") })).not.toThrow();

    expect(() => store.saveNote(author.id, { body: "x", tags: ["y".repeat(33)] })).toThrow(/tag exceeds/);
    expect(() => store.saveNote(author.id, { body: "x", tags: ["y".repeat(32)] })).not.toThrow();
  });

  it("throws for an unknown or cross-show task_id instead of silently dropping the link", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    expect(() => store.saveNote(author.id, { body: "x", taskId: "t-nope" })).toThrow(/unknown task/);

    const otherShowAuthor = store.register("othershow", "claude-local");
    const { task: otherShowTask } = store.createTask({ show: "othershow", title: "t", brief: "b", createdBy: otherShowAuthor.id });
    expect(() => store.saveNote(author.id, { body: "x", taskId: otherShowTask.id })).toThrow(/different show/);
  });

  it("derives contextId from the given taskId's task", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, contextId: "ctx-9" });

    const { note } = store.saveNote(author.id, { body: "x", taskId: task.id });
    expect(note.contextId).toBe("ctx-9");
    expect(note.taskId).toBe(task.id);
  });
});

describe("saveNote: realtime push", () => {
  it("delivers to non-author members whose *current, non-terminal* task overlaps by task_id, context_id, or files_hint glob -- including a heads-down worker whose member lease has gone stale", () => {
    const { store, clock } = newStore();
    const author = store.register("myshow", "claude-local");
    const sameTaskWorker = store.register("myshow", "claude-local");
    const sameContextWorker = store.register("myshow", "claude-local");
    const globWorker = store.register("myshow", "claude-local");
    const unrelatedWorker = store.register("myshow", "claude-local");
    const headsDownWorker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");

    const { task: theTask } = store.createTask({
      show: "myshow",
      title: "the task",
      brief: "b",
      createdBy: director.id,
      contextId: "ctx-1",
      assignee: sameTaskWorker.id,
    });
    store.claimNextTask(sameTaskWorker.id);

    store.createTask({
      show: "myshow",
      title: "same context",
      brief: "b",
      createdBy: director.id,
      contextId: "ctx-1",
      assignee: sameContextWorker.id,
    });
    store.claimNextTask(sameContextWorker.id);

    store.createTask({
      show: "myshow",
      title: "glob overlap",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/**"],
      assignee: globWorker.id,
    });
    store.claimNextTask(globWorker.id);

    store.createTask({
      show: "myshow",
      title: "unrelated",
      brief: "b",
      createdBy: director.id,
      filesHint: ["web/**"],
      assignee: unrelatedWorker.id,
    });
    store.claimNextTask(unrelatedWorker.id);

    // Also glob-overlapping, and heads-down: its member lease (90s) goes stale because the
    // protocol only requires a heartbeat every ~10min while working, but its task is still
    // very much in flight (task lease is 15min) -- it must still receive the note.
    store.createTask({
      show: "myshow",
      title: "heads-down but still in flight",
      brief: "b",
      createdBy: director.id,
      filesHint: ["src/server/**"],
      assignee: headsDownWorker.id,
    });
    store.claimNextTask(headsDownWorker.id);

    clock.t += 100_000; // past WORKER_LEASE_S (90s); renew everyone but headsDownWorker
    for (const m of [author, sameTaskWorker, sameContextWorker, globWorker, unrelatedWorker, director]) {
      store.touchMember(m.id);
    }

    let headsDownWoke = false;
    store.events.once(`wake:${headsDownWorker.id}`, () => (headsDownWoke = true));

    const { deliveredTo } = store.saveNote(author.id, {
      body: "gotcha about the task",
      filesHint: ["src/server/store.ts"],
      taskId: theTask.id,
    });

    expect(deliveredTo.sort()).toEqual(
      [sameTaskWorker.id, sameContextWorker.id, globWorker.id, headsDownWorker.id].sort(),
    );
    expect(deliveredTo).not.toContain(unrelatedWorker.id);
    expect(deliveredTo).not.toContain(author.id);
    // Delivered (queued for its next poll) but not worth an immediate wake -- its stale member
    // lease means it isn't parked in await_work right now anyway.
    expect(headsDownWoke).toBe(false);
    expect(store.drainInbox(headsDownWorker.id).map((m) => m.body)).toEqual(["gotcha about the task"]);
  });

  it("wakes each delivered recipient and inserts a kind:'note' message carrying the note's task_id", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id });
    store.claimNextTask(worker.id);

    let woke = false;
    store.events.once(`wake:${worker.id}`, () => (woke = true));
    store.saveNote(author.id, { body: "gotcha", taskId: task.id });
    expect(woke).toBe(true);

    const inbox = store.drainInbox(worker.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe("note");
    expect(inbox[0]!.body).toBe("gotcha");
    expect(inbox[0]!.taskId).toBe(task.id);
    expect(inbox[0]!.fromId).toBe(author.id);
  });

  it("delivers to nobody (empty deliveredTo, no throw) when no live member's current task overlaps", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    store.register("myshow", "claude-local"); // idle: no current task, can never overlap

    const { deliveredTo } = store.saveNote(author.id, { body: "solo thought" });
    expect(deliveredTo).toEqual([]);
  });
});

describe("searchNotes: FTS5 bm25 ranking + hostile query safety", () => {
  it("ranks a note mentioning the term more by relevance, scoped to the given show", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("othershow", "claude-local");
    store.saveNote(a.id, { body: "the fox jumps over the lazy dog" });
    const { note: densest } = store.saveNote(a.id, { body: "fox fox fox: everything about foxes and fox dens" });
    store.saveNote(b.id, { body: "fox in a different show must never surface here" });

    const hits = store.searchNotes("myshow", "fox");
    expect(hits).toHaveLength(2); // othershow's note excluded
    expect(hits[0]!.id).toBe(densest.id); // the denser mention ranks first
  });

  it("never throws or lets FTS5 operators/syntax through on a hostile query string", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    store.saveNote(a.id, { body: "fox hunting tips" });

    const hostile = 'fox" OR 1=1 -- NEAR(a b) column:x *';
    expect(() => store.searchNotes("myshow", hostile)).not.toThrow();
  });

  it("returns nothing for an empty/whitespace-only query instead of matching everything", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    store.saveNote(a.id, { body: "fox hunting tips" });
    expect(store.searchNotes("myshow", "   ")).toEqual([]);
  });

  it("caps results at the given limit", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    for (let i = 0; i < 5; i++) store.saveNote(a.id, { body: `fox note number ${i}` });
    expect(store.searchNotes("myshow", "fox", 2)).toHaveLength(2);
  });

  it("clamps a caller-supplied limit above MAX_SEARCH_NOTES_LIMIT instead of returning everything", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    for (let i = 0; i < 30; i++) store.saveNote(a.id, { body: `fox note number ${i}` });
    expect(store.searchNotes("myshow", "fox", 100_000).length).toBeLessThanOrEqual(25);
  });

  it("never throws on a NUL byte in the query, which FTS5's scanner rejects even inside a quoted literal", () => {
    const { store } = newStore();
    const a = store.register("myshow", "claude-local");
    store.saveNote(a.id, { body: "fox hunting tips" });

    const withNul = `fox${String.fromCharCode(0)}hunt`;
    expect(() => store.searchNotes("myshow", withNul)).not.toThrow();
  });
});

describe("notesForTask: claim-time recall", () => {
  it("unions BM25-over-title+brief hits with files_hint glob-overlap hits, deduped, excluding irrelevant notes", () => {
    const { store, clock } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");

    const { note: textNote } = store.saveNote(author.id, { body: "combat balance gotcha: numbers stack oddly" });
    clock.t += 1000;
    const { note: globNote } = store.saveNote(author.id, { body: "totally unrelated topic", filesHint: ["src/server/store.ts"] });
    clock.t += 1000;
    store.saveNote(author.id, { body: "completely irrelevant filler about lunch" });

    const { task } = store.createTask({
      show: "myshow",
      title: "combat balance",
      brief: "tune the numbers",
      createdBy: director.id,
      filesHint: ["src/server/**"],
    });

    const notes = store.notesForTask(task);
    const ids = notes.map((n) => n.id);
    expect(ids).toContain(textNote.id);
    expect(ids).toContain(globNote.id);
    expect(ids).toHaveLength(2);
  });

  it("caps at the given limit", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    for (let i = 0; i < 6; i++) store.saveNote(author.id, { body: `alpha beta gamma note ${i}` });
    const { task } = store.createTask({ show: "myshow", title: "alpha beta gamma", brief: "b", createdBy: director.id });
    expect(store.notesForTask(task, 3)).toHaveLength(3);
  });

  it("breaks ties newest-first among glob-only hits with no text relevance to the task", () => {
    const { store, clock } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const { note: older } = store.saveNote(author.id, { body: "xyzzy plugh filler words", filesHint: ["src/server/**"] });
    clock.t += 1000;
    const { note: newer } = store.saveNote(author.id, { body: "xyzzy plugh more filler words", filesHint: ["src/server/**"] });

    const { task } = store.createTask({
      show: "myshow",
      title: "totally different topic",
      brief: "nothing textually in common",
      createdBy: director.id,
      filesHint: ["src/server/store.ts"],
    });

    const notes = store.notesForTask(task);
    expect(notes.map((n) => n.id)).toEqual([newer.id, older.id]);
  });

  it("gives a files_hint glob-overlap hit priority over the NOTES_PER_TASK budget, not just whatever BM25-over-common-words fills first", () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");

    // 4 notes (== default NOTES_PER_TASK) that all share only a common word with the brief,
    // and have no files_hint at all.
    for (let i = 0; i < 4; i++) {
      store.saveNote(author.id, { body: `see the docs for background, item ${i}` });
    }
    // The one note that structurally matters: files_hint exactly overlaps the task's, but
    // shares no vocabulary with the brief at all.
    const { note: gotcha } = store.saveNote(author.id, { body: "xyzzy plugh gotcha", filesHint: ["src/persist/**"] });

    const { task } = store.createTask({
      show: "myshow",
      title: "writer refactor",
      brief: "see the docs before touching this",
      createdBy: director.id,
      filesHint: ["src/persist/writer.ts"],
    });

    const notes = store.notesForTask(task);
    expect(notes.map((n) => n.id)).toContain(gotcha.id);
  });

  it("never throws when the task title/brief contains a NUL byte", () => {
    const { store } = newStore();
    const task = { show: "myshow", title: `foo${String.fromCharCode(0)}bar`, brief: "b", filesHint: [] };
    expect(() => store.notesForTask(task)).not.toThrow();
    expect(store.notesForTask(task)).toEqual([]);
  });
});

describe("recentNotes", () => {
  it("returns a show's notes newest-last, capped at the given limit", () => {
    const { store, clock } = newStore();
    const author = store.register("myshow", "claude-local");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { note } = store.saveNote(author.id, { body: `note ${i}` });
      ids.push(note.id);
      clock.t += 1000;
    }
    const recent = store.recentNotes("myshow", 2);
    expect(recent.map((n) => n.id)).toEqual(ids.slice(-2));
  });
});

describe("messages.kind migration", () => {
  it("adds the kind column in place to a DB file created before this migration, backfilling the default on existing rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "showrunner-store-test-"));
    const dbPath = path.join(dir, "showrunner.db");
    try {
      // Minimal pre-migration schema: shows/members/messages exactly as SCHEMA_SQL declared
      // them before `kind` existed. Store's own SCHEMA_SQL is all CREATE ... IF NOT EXISTS, so
      // reopening this file must leave these rows intact and only ALTER the messages table.
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE shows (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE members (
          id TEXT PRIMARY KEY, show TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT,
          role TEXT NOT NULL DEFAULT 'worker', registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL, current_task_id TEXT, review_cursor INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, show TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
          task_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL
        );
      `);
      legacy.prepare("INSERT INTO shows (name, created_at, config_json) VALUES (?, ?, '{}')").run("myshow", 1);
      legacy
        .prepare(
          `INSERT INTO members (id, show, kind, display_name, role, registered_at, last_seen_at, lease_expires_at, current_task_id, review_cursor)
           VALUES ('legacy-member', 'myshow', 'claude-local', NULL, 'worker', 1, 1, ?, NULL, 0)`,
        )
        .run(Date.now() + 10_000_000);
      legacy
        .prepare(
          "INSERT INTO messages (id, show, from_id, to_id, task_id, body, created_at) VALUES ('m-legacy', 'myshow', 'legacy-member', 'legacy-member', NULL, 'pre-migration message', 1)",
        )
        .run();
      legacy.close();

      const store = new Store(dbPath);
      const inbox = store.drainInbox("legacy-member");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.body).toBe("pre-migration message");
      expect(inbox[0]!.kind).toBe("message"); // backfilled default for the pre-existing row

      // The migrated schema is fully functional for new kind:'note' rows too.
      const director = store.register("myshow", "claude-local");
      const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: "legacy-member" });
      store.claimNextTask("legacy-member");
      const { deliveredTo } = store.saveNote(director.id, { body: "post-migration note", taskId: task.id });
      expect(deliveredTo).toContain("legacy-member");

      const inbox2 = store.drainInbox("legacy-member");
      expect(inbox2).toHaveLength(1);
      expect(inbox2[0]!.kind).toBe("note");
      expect(inbox2[0]!.body).toBe("post-migration note");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("members.session_url/resume_hint migration", () => {
  it("adds both columns in place to a DB file created before this migration", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "showrunner-store-test-"));
    const dbPath = path.join(dir, "showrunner.db");
    try {
      // Minimal pre-migration schema: members exactly as SCHEMA_SQL declared it before
      // session_url/resume_hint existed. Reopening this file must leave the existing row
      // intact and only ALTER the members table.
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE shows (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE members (
          id TEXT PRIMARY KEY, show TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT,
          role TEXT NOT NULL DEFAULT 'worker', registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL, current_task_id TEXT, review_cursor INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, show TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
          task_id TEXT, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message', created_at INTEGER NOT NULL
        );
      `);
      legacy.prepare("INSERT INTO shows (name, created_at, config_json) VALUES (?, ?, '{}')").run("myshow", 1);
      legacy
        .prepare(
          `INSERT INTO members (id, show, kind, display_name, role, registered_at, last_seen_at, lease_expires_at, current_task_id, review_cursor)
           VALUES ('legacy-member', 'myshow', 'claude-local', NULL, 'worker', 1, 1, ?, NULL, 0)`,
        )
        .run(Date.now() + 10_000_000);
      legacy.close();

      const store = new Store(dbPath);

      // Pre-existing row has no chat link: both keys omitted, not null.
      const board = store.getBoard("myshow");
      const legacyMember = board.members.find((m) => m.id === "legacy-member")!;
      expect(legacyMember).not.toHaveProperty("sessionUrl");
      expect(legacyMember).not.toHaveProperty("resumeHint");

      // The migrated schema accepts new registrations with both columns populated.
      const fresh = store.register(
        "myshow",
        "claude-local",
        undefined,
        undefined,
        "https://claude.ai/code/session_x",
        "claude --resume abc",
      );
      expect(fresh.sessionUrl).toBe("https://claude.ai/code/session_x");
      expect(fresh.resumeHint).toBe("claude --resume abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deleteShow", () => {
  it("removes the show and every record under it, including FTS rows", () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id, true);
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "working", note: "n" });
    store.sendMessage(director.id, "all", "hello");
    store.saveNote(worker.id, { body: "distinctive gotcha zanzibar", tags: ["gotcha"] });

    expect(store.deleteShow("myshow")).toBe(true);
    expect(store.showNames()).not.toContain("myshow");
    expect(store.touchMember(worker.id)).toBeUndefined();
    expect(store.directionState("myshow").directorId).toBeUndefined();
    expect(store.searchNotes("myshow", "zanzibar")).toEqual([]);
    const counts = store.getBoard("myshow").taskCounts;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("returns false for a show that does not exist", () => {
    const { store } = newStore();
    expect(store.deleteShow("ghost")).toBe(false);
  });

  it("does not touch other shows", () => {
    const { store } = newStore();
    const a = store.register("keep", "claude-local");
    store.createTask({ show: "keep", title: "t", brief: "b", createdBy: a.id });
    store.register("drop", "claude-local");
    store.deleteShow("drop");
    expect(store.showNames()).toEqual(["keep"]);
    expect(store.getBoard("keep").taskCounts.queued).toBe(1);
  });
});

describe("member secrets (per-member auth)", () => {
  it("issueMemberSecret returns a high-entropy secret that verifies, and a wrong one does not", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local");
    const secret = store.issueMemberSecret(m.id);
    expect(secret.length).toBeGreaterThanOrEqual(20);
    expect(store.verifyMemberSecret(m.id, secret)).toBe(true);
    expect(store.verifyMemberSecret(m.id, secret + "x")).toBe(false);
    expect(store.verifyMemberSecret(m.id, "")).toBe(false);
  });

  it("a member with no issued secret (e.g. the human pseudo-member) verifies nothing", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local");
    // No issueMemberSecret call: the stored hash is NULL, so nothing authenticates as this member.
    expect(store.verifyMemberSecret(m.id, "")).toBe(false);
    expect(store.verifyMemberSecret(m.id, "anything")).toBe(false);
  });

  it("an unknown member id verifies nothing (no oracle) and re-issuing rotates the secret", () => {
    const { store } = newStore();
    expect(store.verifyMemberSecret("nobody", "x")).toBe(false);
    const m = store.register("myshow", "claude-local");
    const first = store.issueMemberSecret(m.id);
    const second = store.issueMemberSecret(m.id);
    expect(second).not.toBe(first);
    expect(store.verifyMemberSecret(m.id, first)).toBe(false); // old secret no longer valid
    expect(store.verifyMemberSecret(m.id, second)).toBe(true);
  });

  it("secrets survive a reopen (hash persisted, not just in memory)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "showrunner-secret-"));
    try {
      const dbPath = path.join(dir, "s.db");
      let store = new Store(dbPath);
      const m = store.register("myshow", "claude-local");
      const secret = store.issueMemberSecret(m.id);
      store = new Store(dbPath);
      expect(store.verifyMemberSecret(m.id, secret)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("human release gate (released column)", () => {
  it("a released task is claimable; a withheld one is not until released", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");

    const { task: held } = store.createTask({ show: "myshow", title: "held", brief: "b", createdBy: director.id, released: false });
    expect(held.released).toBe(false);
    // Nothing claimable while withheld.
    expect(store.claimNextTask(worker.id)).toBeUndefined();

    const released = store.releaseTask(held.id, "human");
    expect(released?.released).toBe(true);
    const claimed = store.claimNextTask(worker.id);
    expect(claimed?.id).toBe(held.id);
  });

  it("tasks default to released (backward compatible) and the board exposes the flag", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    expect(task.released).toBe(true);
    const view = store.getBoard("myshow").tasks.find((t) => t.id === task.id);
    expect(view?.released).toBe(true);
  });

  it("releaseTask is idempotent and returns undefined for an unknown task", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, released: false });
    const first = store.releaseTask(task.id, "human");
    const second = store.releaseTask(task.id, "human");
    expect(first?.released).toBe(true);
    expect(second?.released).toBe(true);
    expect(store.releaseTask("no-such-task", "human")).toBeUndefined();
  });

  it("a withheld task is skipped in favor of a released one, regardless of priority", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    // Higher-priority task is withheld; lower-priority one is released. The released one wins.
    store.createTask({ show: "myshow", title: "held-high", brief: "b", createdBy: director.id, priority: 10, released: false });
    const { task: open } = store.createTask({ show: "myshow", title: "open-low", brief: "b", createdBy: director.id, priority: 1 });
    const claimed = store.claimNextTask(worker.id);
    expect(claimed?.id).toBe(open.id);
  });
});

describe("show rules (server-held policy)", () => {
  it("seeds OOTB defaults on first touch (version 1, automation-friendly)", () => {
    const { store } = newStore();
    store.register("myshow", "claude-local");
    const rules = store.getShowRules("myshow");
    expect(rules.version).toBe(1);
    expect(rules.switches.requireTaskRelease).toBe(false);
    expect(rules.switches.requireHumanMergeApproval).toBe(false);
    expect(rules.switches.workerNotePropagation).toBe(true);
    expect(rules.switches.artifactTextMaxChars).toBeGreaterThan(0);
    expect(rules.updatedBy).toBe("default");
    // The board exposes the current rules.
    expect(store.getBoard("myshow").rules.version).toBe(1);
  });

  it("updateShowRules merges a partial patch, bumps version, and records who", () => {
    const { store } = newStore();
    store.register("myshow", "claude-local");
    const v2 = store.updateShowRules("myshow", { switches: { requireTaskRelease: true }, policy: "no force-push" }, "amber-fox");
    expect(v2.version).toBe(2);
    expect(v2.switches.requireTaskRelease).toBe(true);
    expect(v2.switches.workerNotePropagation).toBe(true); // untouched fields keep their value
    expect(v2.policy).toBe("no force-push");
    expect(v2.updatedBy).toBe("amber-fox");
    // A non-positive cap patch is ignored (can't disable a cap by setting 0).
    const v3 = store.updateShowRules("myshow", { switches: { artifactTextMaxChars: 0 } }, "amber-fox");
    expect(v3.switches.artifactTextMaxChars).toBe(v2.switches.artifactTextMaxChars);
    expect(v3.version).toBe(3);
  });

  it("delivers full rules once per change: seeded-seen at register, re-delivered after a bump", () => {
    const { store } = newStore();
    const m = store.register("myshow", "claude-local");
    // register seeds the member's cursor to current, so nothing to re-deliver yet.
    expect(store.consumeRulesDelivery(m.id)).toEqual({ version: 1 });
    store.updateShowRules("myshow", { switches: { requireHumanMergeApproval: true } }, "human");
    const delivered = store.consumeRulesDelivery(m.id);
    expect(delivered.version).toBe(2);
    expect(delivered.rules?.switches.requireHumanMergeApproval).toBe(true);
    // Consumed: not delivered again until the next change.
    expect(store.consumeRulesDelivery(m.id)).toEqual({ version: 2 });
  });

  it("enforces workerNotePropagation: off suppresses push and claim-time recall, search still works", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    const author = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id, filesHint: ["src/**"] });
    store.claimNextTask(worker.id);

    store.updateShowRules("myshow", { switches: { workerNotePropagation: false } }, "human");
    const { deliveredTo } = store.saveNote(author.id, { body: "distinctive zebra note", filesHint: ["src/app.ts"] });
    expect(deliveredTo).toEqual([]); // no push to the working peer
    expect(store.notesForTask({ show: "myshow", title: "t", brief: "b", filesHint: ["src/**"] })).toEqual([]); // no claim-time recall
    expect(store.searchNotes("myshow", "zebra").length).toBe(1); // explicit pull still works
  });

  it("enforces artifact caps in updateTask (text over the cap is rejected)", () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id });
    store.claimNextTask(worker.id);
    store.updateShowRules("myshow", { switches: { artifactTextMaxChars: 10 } }, "human");
    expect(() =>
      store.updateTask(worker.id, task.id, { artifacts: [{ kind: "text", text: "x".repeat(11) }] }),
    ).toThrow(/artifactTextMaxChars/);
    // At the cap it's accepted.
    const ok = store.updateTask(worker.id, task.id, { artifacts: [{ kind: "text", text: "x".repeat(10) }] });
    expect(ok.artifacts.length).toBe(1);
  });
});
