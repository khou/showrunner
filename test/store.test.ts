import { describe, expect, it } from "vitest";
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

  it("claim succeeds again once the lease has expired", () => {
    const { store, clock } = newStore();
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    store.claimDirection(a.id);
    clock.t += 600_001; // past default DIRECTION_LEASE_S (600s)
    const result = store.claimDirection(b.id);
    expect(result).toEqual({ ok: true, epoch: 2 });
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
