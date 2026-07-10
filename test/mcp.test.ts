import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/server/store.js";
import { createMcpServer, resolveAwaitWork, type McpServerConfig } from "../src/server/mcp.js";
import { INSTRUCTIONS } from "../src/server/instructions.js";

// Injected clock for Store's own timestamps (task.updatedAt etc.); the long-poll's real
// setTimeout still runs on the wall clock, which is why FAST_CONFIG below keeps holds tiny.
function makeClock(start = 1_000_000) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

function newStore() {
  const { clock, now } = makeClock();
  return { store: new Store(":memory:", now), clock };
}

// 50ms hold; jitter scales to at most 10% of the hold (see mcp.ts), so worst case ~55ms --
// comfortably inside the "nothing sleeps more than ~100ms" budget for this suite.
const FAST_CONFIG: McpServerConfig = { pollHoldSeconds: 0.05 };

async function connectClient(store: Store, config: McpServerConfig = FAST_CONFIG): Promise<Client> {
  const server = createMcpServer(store, config);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolContent = { type: string; text?: string };

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as ToolContent[];
  const first = content[0];
  const data = first && first.type === "text" && first.text !== undefined ? JSON.parse(first.text) : undefined;
  return { data, isError: result.isError === true };
}

describe("await_work resolution order (PLAN.md pinned order)", () => {
  it("messages take precedence over a claimable task", async () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.sendMessage(director.id, worker.id, "hello");

    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(result.status).toBe("messages");
    if (result.status === "messages") expect(result.messages).toHaveLength(1);
    // the queued task was never touched by the messages branch
    expect(store.getBoard("myshow").taskCounts.queued).toBe(1);
  });

  it("messages take precedence over a director's review items", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "input-required" });
    store.sendMessage(worker.id, director.id, "question inbound");

    const result = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(result.status).toBe("messages");
  });

  it("a director's review surfaces input-required tasks", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "input-required", note: "need a call" });

    const result = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(result.status).toBe("review");
    if (result.status === "review") expect(result.items.map((i) => i.id)).toEqual([task.id]);
  });

  it("claims a task for a worker when nothing else is pending", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });

    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(result.status).toBe("task");
    if (result.status === "task") expect(result.task.id).toBe(task.id);
  });

  it("a director never claims a task, even one pinned to them", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: director.id });

    const result = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(result.status).toBe("nothing");
  });

  it("a director's review surfaces rejected tasks too", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "rejected", note: "wrong env" });

    const result = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(result.status).toBe("review");
    if (result.status === "review") expect(result.items.map((i) => i.id)).toEqual([task.id]);
  });
});

describe("review does not busy-loop on an unanswered input-required task", () => {
  it("surfaces an input-required task once, then holds the full poll on the next call", async () => {
    const { store, clock } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "input-required" });
    clock.t += 1; // separate this update's timestamp from the director's claim-time cursor

    const first = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(first.status).toBe("review");

    // Nothing changed since: a second poll must not re-report the same still-open blocker.
    // With a real 50ms hold and no wake, this only resolves via the timeout path.
    const started = Date.now();
    const second = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(second).toEqual({ status: "nothing", hint: "re-poll immediately" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe("a takeover director doesn't replay the show's completed-task history", () => {
  it("only sees completions from after it claimed direction", async () => {
    const { store, clock } = newStore();
    const director1 = store.register("myshow", "claude-local");
    store.claimDirection(director1.id);
    const worker = store.register("myshow", "claude-local");
    const { task: oldTask } = store.createTask({ show: "myshow", title: "old", brief: "b", createdBy: director1.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, oldTask.id, { status: "completed" });
    clock.t += 1000;

    const director2 = store.register("myshow", "claude-local");
    store.claimDirection(director2.id, true); // takeover, well after oldTask completed

    const result = await resolveAwaitWork(store, director2.id, undefined, 0.05);
    expect(result).toEqual({ status: "nothing", hint: "re-poll immediately" });
  });
});

describe("wake beats timeout", () => {
  it("resolves as soon as a task is created, well before a long hold would expire", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");

    const started = Date.now();
    const pending = resolveAwaitWork(store, worker.id, 5, 5); // up to a 5s hold
    setTimeout(() => {
      store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    }, 20);

    const result = await pending;
    const elapsed = Date.now() - started;
    expect(result.status).toBe("task");
    expect(elapsed).toBeLessThan(1000); // nowhere near the 5s hold: the wake won the race
  });
});

describe("jittered timeout returns nothing", () => {
  it("returns nothing quickly when the queue stays empty", async () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");

    const started = Date.now();
    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    const elapsed = Date.now() - started;

    expect(result).toEqual({ status: "nothing", hint: "re-poll immediately" });
    expect(elapsed).toBeLessThan(150);
  });

  it("always cleans up its wake listeners after resolving", async () => {
    const { store } = newStore();
    const worker = store.register("myshow", "claude-local");
    const countBefore =
      store.events.listenerCount(`wake:${worker.id}`) + store.events.listenerCount("wake:show:myshow");

    await resolveAwaitWork(store, worker.id, undefined, 0.05);

    const countAfter =
      store.events.listenerCount(`wake:${worker.id}`) + store.events.listenerCount("wake:show:myshow");
    expect(countAfter).toBe(countBefore);
  });
});

describe("unknown member", () => {
  it("await_work returns a structured unknown_member result instead of throwing", async () => {
    const { store } = newStore();
    const result = await resolveAwaitWork(store, "nobody-home", undefined, 0.05);
    expect(result).toEqual({
      status: "unknown_member",
      member_id: "nobody-home",
      hint: expect.stringContaining("register"),
    });
  });

  it("other member-scoped tools report the same shape, not a protocol error", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const result = await callTool(client, "get_board", { member_id: "ghost" });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: "unknown_member", member_id: "ghost" });
  });
});

describe("epoch fencing surfaces as a tool result", () => {
  it("create_task returns {status:'superseded'} with isError:false for a stale epoch", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    const claimA = await callTool(client, "claim_direction", { member_id: a.id });
    expect((claimA.data as { epoch: number }).epoch).toBe(1);
    store.claimDirection(b.id, true); // takeover: supersedes a at epoch 2

    const result = await callTool(client, "create_task", { member_id: a.id, epoch: 1, title: "t", brief: "b" });

    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: "superseded", epoch: 2, holder: { id: b.id } });
  });

  it("direct_task returns {status:'superseded'} with isError:false for a stale epoch", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = store.register("myshow", "claude-local");
    const b = store.register("myshow", "claude-local");
    await callTool(client, "claim_direction", { member_id: a.id });
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: a.id });
    store.claimDirection(b.id, true);

    const result = await callTool(client, "direct_task", {
      member_id: a.id,
      epoch: 1,
      task_id: task.id,
      action: "cancel",
    });

    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: "superseded", epoch: 2 });
  });

  it("the current epoch still succeeds", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = store.register("myshow", "claude-local");
    await callTool(client, "claim_direction", { member_id: a.id });

    const result = await callTool(client, "create_task", { member_id: a.id, epoch: 1, title: "t", brief: "b" });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ task: { title: "t", status: "queued" } });
  });
});

describe("register and the join prompt", () => {
  it("register returns the protocol text and a fresh member id", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const result = await callTool(client, "register", { show: "myshow", kind: "claude-local" });
    expect(result.data).toMatchObject({ show: "myshow", director: null, protocol: INSTRUCTIONS });
    expect((result.data as { member_id: string }).member_id).toMatch(/^[a-z]+-[a-z]+/);
  });

  it("exposes the same protocol text as the 'join' prompt", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const prompt = await client.getPrompt({ name: "join" });
    const content = prompt.messages[0]?.content as { type: string; text?: string };
    expect(content.text).toBe(INSTRUCTIONS);
  });
});
