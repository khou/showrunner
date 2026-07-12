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

// Per-member auth: tool calls now require member_secret. store.register() alone doesn't mint one
// (only the MCP register tool does), so tests that drive tools through a store-registered member
// use this to also issue the secret, mirroring what a real register() round-trip hands back.
type Registered = ReturnType<Store["register"]> & { secret: string };
function reg(store: Store, show: string, kind: Parameters<Store["register"]>[1] = "claude-local", displayName?: string): Registered {
  const m = store.register(show, kind, displayName);
  return Object.assign(m, { secret: store.issueMemberSecret(m.id) });
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

  it("a worker's opening plan (assigned -> working) does NOT surface in the director's review feed", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    store.claimDirection(director.id);
    const worker = store.register("myshow", "claude-local");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);
    // The worker records its plan and starts executing. This is a working transition, not a
    // terminal/escalation one, so it must NOT wake the director's review -- otherwise every
    // worker plan would spam the review loop (the whole point of gating review on a status set
    // that excludes "working").
    store.updateTask(worker.id, task.id, { status: "working", note: "Plan: read docs, add X, wire in Y" });

    const result = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(result.status).toBe("nothing");
  });
});

describe("await_work attaches relevant_notes to a claimed task (DESIGN.md 'Recall at claim time')", () => {
  it("trims a note body over ~300 chars in the delivered payload", async () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");

    const longBody = `combat balance ${"y".repeat(500)}`;
    store.saveNote(author.id, { body: longBody });
    store.createTask({ show: "myshow", title: "combat balance", brief: "tune the numbers", createdBy: director.id });

    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(result.status).toBe("task");
    if (result.status !== "task") return;
    expect(result.relevant_notes).toHaveLength(1);
    expect(result.relevant_notes[0]!.body).toHaveLength(301); // 300 chars + truncation marker
    expect(result.relevant_notes[0]!.body).toBe(`${longBody.slice(0, 300)}…`);
  });

  it("caps relevant_notes at NOTES_PER_TASK even when more notes match", async () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");

    for (let i = 0; i < 6; i++) {
      store.saveNote(author.id, { body: `note ${i}`, filesHint: ["src/server/**"] });
    }
    store.createTask({ show: "myshow", title: "server work", brief: "b", createdBy: director.id, filesHint: ["src/server/store.ts"] });

    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(result.status).toBe("task");
    if (result.status === "task") expect(result.relevant_notes).toHaveLength(4); // default NOTES_PER_TASK
  });

  it("attaches an empty relevant_notes array when nothing matches", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    store.createTask({ show: "myshow", title: "unrelated task", brief: "no notes exist yet", createdBy: director.id });

    const result = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(result.status).toBe("task");
    if (result.status === "task") expect(result.relevant_notes).toEqual([]);
  });
});

describe("await_work surfaces message kind so agents can distinguish notes", () => {
  it("a pushed note arrives with kind:'note'; an ordinary send_message arrives with kind:'message'", async () => {
    const { store } = newStore();
    const author = store.register("myshow", "claude-local");
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    store.createTask({
      show: "myshow",
      title: "t",
      brief: "b",
      createdBy: director.id,
      assignee: worker.id,
      filesHint: ["src/server/**"],
    });
    store.claimNextTask(worker.id);

    store.saveNote(author.id, { body: "note body", filesHint: ["src/server/store.ts"] });
    const noteResult = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(noteResult.status).toBe("messages");
    if (noteResult.status === "messages") expect(noteResult.messages[0]!.kind).toBe("note");

    store.sendMessage(director.id, worker.id, "plain message");
    const messageResult = await resolveAwaitWork(store, worker.id, undefined, 0.05);
    expect(messageResult.status).toBe("messages");
    if (messageResult.status === "messages") expect(messageResult.messages[0]!.kind).toBe("message");
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

    // Nothing changed since: a second poll must not re-report it in the REVIEW feed (no
    // busy-loop) and must hold the full poll. It resolves via the timeout path, and that
    // timeout now carries the director's standing pending_input reminder (the escalation is
    // still open) rather than a bare "nothing".
    const started = Date.now();
    const second = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(second.status).toBe("nothing");
    if (second.status === "nothing") {
      expect(second.pending_input).toHaveLength(1);
      expect(second.pending_input![0].task_id).toBe(task.id);
    }
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

  it("other member-scoped tools report a structured unauthorized_member result, not a protocol error", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    // Unknown id (with any secret) and a real id with the wrong secret both return the SAME
    // unauthorized_member shape -- no oracle for which member ids exist.
    const ghost = await callTool(client, "get_board", { member_id: "ghost", member_secret: "whatever" });
    expect(ghost.isError).toBe(false);
    expect(ghost.data).toMatchObject({ status: "unauthorized_member", member_id: "ghost" });

    const real = reg(store, "myshow");
    const wrongSecret = await callTool(client, "get_board", { member_id: real.id, member_secret: "not-the-secret" });
    expect(wrongSecret.isError).toBe(false);
    expect(wrongSecret.data).toMatchObject({ status: "unauthorized_member", member_id: real.id });

    const rightSecret = await callTool(client, "get_board", { member_id: real.id, member_secret: real.secret });
    expect(rightSecret.isError).toBe(false);
    expect(rightSecret.data).toMatchObject({ show: "myshow" });
  });
});

describe("epoch fencing surfaces as a tool result", () => {
  it("create_task returns {status:'superseded'} with isError:false for a stale epoch", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    const claimA = await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    expect((claimA.data as { epoch: number }).epoch).toBe(1);
    store.claimDirection(b.id, true); // takeover: supersedes a at epoch 2

    const result = await callTool(client, "create_task", { member_id: a.id, member_secret: a.secret, epoch: 1, title: "t", brief: "b" });

    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: "superseded", epoch: 2, holder: { id: b.id } });
  });

  it("direct_task returns {status:'superseded'} with isError:false for a stale epoch", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: a.id });
    store.claimDirection(b.id, true);

    const result = await callTool(client, "direct_task", {
      member_id: a.id,
      member_secret: a.secret,
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
    const a = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });

    const result = await callTool(client, "create_task", { member_id: a.id, member_secret: a.secret, epoch: 1, title: "t", brief: "b" });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ task: { title: "t", status: "queued" } });
  });
});

describe("take_input tool", () => {
  it("director takes on an escalation: worker is messaged and the task is marked taken", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const dir = reg(store, "myshow");
    const worker = reg(store, "myshow");
    const claim = await callTool(client, "claim_direction", { member_id: dir.id, member_secret: dir.secret, takeover: true });
    const epoch = (claim.data as { epoch: number }).epoch;
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: dir.id });
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, task.id, { status: "input-required", note: "blocked" });
    store.drainInbox(worker.id);

    const res = await callTool(client, "take_input", { member_id: dir.id, member_secret: dir.secret, epoch, task_id: task.id });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ status: "taken", task: { id: task.id, status: "input-required" } });
    expect((res.data as { task: { inputTakenAt: number | null } }).task.inputTakenAt).not.toBeNull();

    const inbox = store.drainInbox(worker.id);
    expect(inbox.some((m) => m.fromId === dir.id && /on your blocker/i.test(m.body))).toBe(true);

    const board = await callTool(client, "get_board", { member_id: dir.id, member_secret: dir.secret, verbose: true });
    const escalations = (board.data as { escalations: Record<string, unknown> }).escalations;
    expect(escalations).not.toHaveProperty("humanMessages"); // the human channel is gone
    const inputRequired = escalations.inputRequired as { id: string; inputTakenAt: number | null }[];
    expect(inputRequired.find((t) => t.id === task.id)?.inputTakenAt).not.toBeNull();
  });

  it("is director-token gated: a worker-authLevel caller is forbidden", async () => {
    const { store } = newStore();
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const registered = await callTool(workerClient, "register", { show: "authshow", kind: "claude-local" });
    const { member_id: memberId, member_secret: secret } = registered.data as { member_id: string; member_secret: string };
    const res = await callTool(workerClient, "take_input", { member_id: memberId, member_secret: secret, epoch: 1, task_id: "t-x" });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ status: "forbidden", reason: "director token required" });
  });

  it("errors when the task is not awaiting input", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const dir = reg(store, "myshow");
    const claim = await callTool(client, "claim_direction", { member_id: dir.id, member_secret: dir.secret, takeover: true });
    const epoch = (claim.data as { epoch: number }).epoch;
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: dir.id });
    const res = await callTool(client, "take_input", { member_id: dir.id, member_secret: dir.secret, epoch, task_id: task.id });
    expect(res.isError).toBe(true);
    expect((res.data as { message: string }).message).toMatch(/not awaiting input/);
  });
});

describe("save_note / search_notes tools", () => {
  it("save_note pushes to a live overlapping member, and search_notes finds it back", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const author = reg(store, "myshow");
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    store.createTask({
      show: "myshow",
      title: "t",
      brief: "b",
      createdBy: director.id,
      assignee: worker.id,
      filesHint: ["src/server/**"],
    });
    store.claimNextTask(worker.id);

    const saved = await callTool(client, "save_note", {
      member_id: author.id,
      member_secret: author.secret,
      body: "gotcha: fox dens are load-bearing",
      files_hint: ["src/server/store.ts"],
    });
    expect(saved.isError).toBe(false);
    const { note_id, delivered_to } = saved.data as { note_id: string; delivered_to: string[] };
    expect(note_id).toBeTruthy();
    expect(delivered_to).toEqual([worker.id]);

    const searched = await callTool(client, "search_notes", { member_id: author.id, member_secret: author.secret, query: "fox dens" });
    expect(searched.isError).toBe(false);
    const { notes } = searched.data as { notes: { id: string; body: string }[] };
    expect(notes.map((n) => n.id)).toContain(note_id);
  });

  it("save_note reports a body-too-long error as a tool result, not a protocol error", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const author = reg(store, "myshow");

    const result = await callTool(client, "save_note", { member_id: author.id, member_secret: author.secret, body: "x".repeat(2001) });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ status: "error" });
  });

  it("save_note and search_notes report unauthorized_member the same way as the rest", async () => {
    const { store } = newStore();
    const client = await connectClient(store);

    const saveResult = await callTool(client, "save_note", { member_id: "ghost", member_secret: "x", body: "x" });
    expect(saveResult.isError).toBe(false);
    expect(saveResult.data).toMatchObject({ status: "unauthorized_member", member_id: "ghost" });

    const searchResult = await callTool(client, "search_notes", { member_id: "ghost", member_secret: "x", query: "x" });
    expect(searchResult.isError).toBe(false);
    expect(searchResult.data).toMatchObject({ status: "unauthorized_member", member_id: "ghost" });
  });
});

describe("register and the join prompt", () => {
  it("register returns the protocol text and a fresh member id", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const result = await callTool(client, "register", { show: "myshow", kind: "claude-local" });
    expect(result.data).toMatchObject({ show: "myshow", director: null, protocol: INSTRUCTIONS });
    expect((result.data as { member_id: string }).member_id).toMatch(/^[a-z]+-[a-z]+/);
    // register mints a member_secret and hands it back exactly once.
    expect((result.data as { member_secret: string }).member_secret).toMatch(/.{20,}/);
  });

  it("exposes the same protocol text as the 'join' prompt", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const prompt = await client.getPrompt({ name: "join" });
    const content = prompt.messages[0]?.content as { type: string; text?: string };
    expect(content.text).toBe(INSTRUCTIONS);
  });
});

describe("register: self-reported session_url / resume_hint", () => {
  it("accepts a valid http(s) session_url and a resume_hint, and persists both", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const result = await callTool(client, "register", {
      show: "myshow",
      kind: "claude-local",
      session_url: "https://claude.ai/code/session_abc",
    });
    expect(result.isError).toBe(false);
    const memberId = (result.data as { member_id: string }).member_id;
    const member = store.getBoard("myshow").members.find((m) => m.id === memberId);
    expect(member?.sessionUrl).toBe("https://claude.ai/code/session_abc");

    const result2 = await callTool(client, "register", {
      show: "myshow",
      kind: "claude-local",
      resume_hint: "claude --resume 7f3a9c",
    });
    expect(result2.isError).toBe(false);
    const memberId2 = (result2.data as { member_id: string }).member_id;
    const member2 = store.getBoard("myshow").members.find((m) => m.id === memberId2);
    expect(member2?.resumeHint).toBe("claude --resume 7f3a9c");
  });

  it("rejects a session_url that isn't a valid http(s) URL", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await expect(
      callTool(client, "register", { show: "myshow", kind: "claude-local", session_url: "not-a-url" }),
    ).rejects.toThrow();
    await expect(
      callTool(client, "register", { show: "myshow", kind: "claude-local", session_url: "ftp://example.com/x" }),
    ).rejects.toThrow();
  });

  it("rejects a resume_hint over the ~200 char cap", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await expect(
      callTool(client, "register", { show: "myshow", kind: "claude-local", resume_hint: "x".repeat(201) }),
    ).rejects.toThrow();
  });

  it("rejects a session_url over the 500 char cap", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await expect(
      callTool(client, "register", { show: "myshow", kind: "claude-local", session_url: `https://x/${"a".repeat(500)}` }),
    ).rejects.toThrow();
  });
});

describe("update_task drains unread messages (heartbeat delivery)", () => {
  it("returns unread messages once, then omits the key on the next call", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id });
    store.claimNextTask(worker.id);
    store.sendMessage(director.id, worker.id, "how's it going?");

    const first = await callTool(client, "update_task", { member_id: worker.id, member_secret: worker.secret, task_id: task.id, note: "still working" });
    expect(first.isError).toBe(false);
    const firstData = first.data as { task: unknown; messages?: { body: string }[] };
    expect(firstData.messages).toHaveLength(1);
    expect(firstData.messages?.[0]?.body).toBe("how's it going?");

    const second = await callTool(client, "update_task", { member_id: worker.id, member_secret: worker.secret, task_id: task.id, note: "still working" });
    expect(second.isError).toBe(false);
    const secondData = second.data as { task: unknown; messages?: unknown[] };
    expect(secondData.messages).toBeUndefined();
  });
});

describe("register warns when creating a new show that looks like a checkout of an existing one", () => {
  it("suffixed checkout name gets similar_existing_shows and a warning", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await callTool(client, "register", { show: "wavecrash", kind: "claude-local" });
    const result = await callTool(client, "register", { show: "wavecrash-w2", kind: "claude-local" });
    expect(result.data).toMatchObject({
      show: "wavecrash-w2",
      created_new_show: true,
      similar_existing_shows: ["wavecrash"],
    });
    expect((result.data as { warning: string }).warning).toContain("wavecrash");
  });

  it("registering on an existing show never warns", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await callTool(client, "register", { show: "wavecrash", kind: "claude-local" });
    const result = await callTool(client, "register", { show: "wavecrash", kind: "claude-local" });
    expect(result.data).not.toHaveProperty("warning");
    expect(result.data).not.toHaveProperty("similar_existing_shows");
  });

  it("a genuinely different show name does not warn", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await callTool(client, "register", { show: "wavecrash", kind: "claude-local" });
    const result = await callTool(client, "register", { show: "wavecrash-analytics", kind: "claude-local" });
    expect(result.data).not.toHaveProperty("warning");
  });

  it("copy/worktree/numeric suffixes all normalize to the base show", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    await callTool(client, "register", { show: "mygame", kind: "claude-local" });
    for (const name of ["mygame-copy", "mygame_2", "mygame-worktree-fix", "mygame-wt1"]) {
      const result = await callTool(client, "register", { show: name, kind: "claude-local" });
      expect(result.data, name).toHaveProperty("similar_existing_shows");
    }
  });
});

describe("dual-token authLevel gating", () => {
  it("worker authLevel can register but cannot claim_direction or create_task", async () => {
    const { store } = newStore();
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const registered = await callTool(workerClient, "register", { show: "authshow", kind: "claude-local" });
    const { member_id: memberId, member_secret: secret } = registered.data as { member_id: string; member_secret: string };
    expect(memberId).toBeTruthy();

    const claim = await callTool(workerClient, "claim_direction", { member_id: memberId, member_secret: secret, takeover: true });
    expect(claim.isError).toBe(true);
    expect(claim.data).toMatchObject({ status: "forbidden", reason: "director token required" });

    const created = await callTool(workerClient, "create_task", {
      member_id: memberId,
      member_secret: secret,
      epoch: 1,
      title: "nope",
      brief: "should fail",
    });
    expect(created.isError).toBe(true);
    expect(created.data).toMatchObject({ status: "forbidden" });
  });

  it("director authLevel can claim_direction", async () => {
    const { store } = newStore();
    const client = await connectClient(store, { ...FAST_CONFIG, authLevel: "director" });
    const registered = await callTool(client, "register", { show: "authshow", kind: "claude-local" });
    const { member_id: memberId, member_secret: secret } = registered.data as { member_id: string; member_secret: string };
    const claim = await callTool(client, "claim_direction", { member_id: memberId, member_secret: secret, takeover: true });
    expect(claim.isError).toBe(false);
    expect(claim.data).toMatchObject({ status: "claimed" });
  });
});

describe("per-member auth (identity is the hard boundary)", () => {
  it("one member cannot act as another by passing the peer's member_id (its own secret won't verify)", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const victim = reg(store, "myshow");
    const attacker = reg(store, "myshow");

    // Attacker tries to speak/act AS the victim, presenting its own (valid, but wrong-for-victim)
    // secret. Auth binds secret->member_id, so this is rejected, not silently accepted.
    const spoof = await callTool(client, "send_message", {
      member_id: victim.id,
      member_secret: attacker.secret,
      to: "all",
      body: "trust me, I'm the director",
    });
    expect(spoof.isError).toBe(false);
    expect(spoof.data).toMatchObject({ status: "unauthorized_member", member_id: victim.id });
  });

  it("update_task cannot be driven under a peer's member_id without that peer's secret", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    const attacker = reg(store, "myshow");
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id, assignee: worker.id });
    store.claimNextTask(worker.id);

    const spoof = await callTool(client, "update_task", {
      member_id: worker.id,
      member_secret: attacker.secret,
      task_id: task.id,
      status: "completed",
      artifacts: [{ kind: "text", text: "poisoned completion" }],
    });
    expect(spoof.data).toMatchObject({ status: "unauthorized_member" });
    // The task is untouched: still assigned to the real worker, not completed.
    expect(store.getBoard("myshow").tasks.find((t) => t.id === task.id)?.status).not.toBe("completed");
  });
});

describe("await_work annotates peer content as untrusted (defense in depth)", () => {
  it("a claimed task result carries the untrusted_peer trust annotation over brief/notes", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    store.createTask({ show: "myshow", title: "t", brief: "do the thing", createdBy: director.id });

    const result = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    const data = result.data as { status: string; trust?: { trust: string; applies_to: string[] } };
    expect(data.status).toBe("task");
    expect(data.trust?.trust).toBe("untrusted_peer");
    expect(data.trust?.applies_to).toContain("task.brief");
  });

  it("await_work rejects a bad secret before parking on the queue", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const worker = reg(store, "myshow");
    const result = await callTool(client, "await_work", { member_id: worker.id, member_secret: "wrong" });
    expect(result.data).toMatchObject({ status: "unauthorized_member" });
  });
});

describe("human release gate (release driven by the per-show rule)", () => {
  it("withholds a created task from workers until it is released", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: director.id, member_secret: director.secret });
    // The release gate is a per-show rule now, not a server flag: turn it on for this show.
    store.updateShowRules("myshow", { switches: { requireTaskRelease: true } }, "human");

    const created = await callTool(client, "create_task", {
      member_id: director.id,
      member_secret: director.secret,
      epoch: 1,
      title: "risky",
      brief: "point at repo docs",
    });
    expect(created.data).toMatchObject({ pending_release: true });
    const taskId = (created.data as { task_id: string }).task_id;

    // A worker polling finds nothing claimable while the task is withheld.
    const worker = reg(store, "myshow");
    const poll = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    expect((poll.data as { status: string }).status).toBe("nothing");

    // After a human release, the same worker can claim it.
    store.releaseTask(taskId, "human");
    const poll2 = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    expect((poll2.data as { status: string }).status).toBe("task");
  });
});

describe("update_rules (server-held rules mutation)", () => {
  it("is director-token gated: a worker-authLevel caller is forbidden", async () => {
    const { store } = newStore();
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const reg = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local" });
    const { member_id, member_secret } = reg.data as { member_id: string; member_secret: string };
    const res = await callTool(workerClient, "update_rules", {
      member_id,
      member_secret,
      epoch: 1,
      switches: { requireTaskRelease: true },
    });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ status: "forbidden", reason: "director token required" });
  });

  it("is epoch-fenced: a stale epoch returns superseded and does not change rules", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    store.claimDirection(b.id, true); // takeover -> epoch 2, a is stale at epoch 1

    const res = await callTool(client, "update_rules", {
      member_id: a.id,
      member_secret: a.secret,
      epoch: 1,
      switches: { requireTaskRelease: true },
    });
    expect(res.data).toMatchObject({ status: "superseded", epoch: 2 });
    expect(store.getShowRules("myshow").switches.requireTaskRelease).toBe(false);
  });

  it("the current director updates rules, bumps version, and notifies the cast", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: director.id, member_secret: director.secret });

    const res = await callTool(client, "update_rules", {
      member_id: director.id,
      member_secret: director.secret,
      epoch: 1,
      switches: { requireHumanMergeApproval: true },
      policy: "squash-merge only",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ status: "updated", rules: { version: 2, policy: "squash-merge only" } });
    expect((res.data as { rules_trust: { trust: string } }).rules_trust.trust).toBe("authenticated_director_policy");

    // The cast is notified via a send-to-all message: the worker sees it on its next poll.
    const poll = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    const data = poll.data as { status: string; messages?: { body: string }[] };
    expect(data.status).toBe("messages");
    expect(data.messages?.some((m) => /rules updated to v2/.test(m.body))).toBe(true);
  });

  it("rules_version rides on a task claim, and the full rules re-deliver after a change", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });

    const claim = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    const claimData = claim.data as { status: string; rules_version: number; rules?: unknown };
    expect(claimData.status).toBe("task");
    expect(claimData.rules_version).toBe(1);
    expect(claimData.rules).toBeUndefined(); // already seen at register; not re-sent

    // A rule change re-delivers the full text on the worker's next poll.
    store.updateShowRules("myshow", { switches: { requireTaskRelease: true } }, "human");
    const poll = await callTool(client, "await_work", { member_id: worker.id, member_secret: worker.secret });
    const pollData = poll.data as { rules_version: number; rules?: { version: number }; rules_trust?: { trust: string } };
    expect(pollData.rules_version).toBe(2);
    expect(pollData.rules?.version).toBe(2);
    expect(pollData.rules_trust?.trust).toBe("authenticated_director_policy");
  });
});

describe("release_direction + timeout no longer opens the seat", () => {
  it("is director-token gated", async () => {
    const { store } = newStore();
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const reg = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local" });
    const { member_id, member_secret } = reg.data as { member_id: string; member_secret: string };
    const res = await callTool(workerClient, "release_direction", { member_id, member_secret, epoch: 1 });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ status: "forbidden", reason: "director token required" });
  });

  it("is epoch-fenced: a stale caller gets superseded", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    store.claimDirection(b.id, true); // a is now stale at epoch 1
    const res = await callTool(client, "release_direction", { member_id: a.id, member_secret: a.secret, epoch: 1 });
    expect(res.data).toMatchObject({ status: "superseded", epoch: 2 });
  });

  it("release opens the seat for a later plain claim; a stale lease does not", async () => {
    const { store, clock } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret }); // epoch 1

    // Lease expiry alone: b's plain claim is denied with a hint pointing at takeover/release.
    clock.t += 600_001;
    const denied = await callTool(client, "claim_direction", { member_id: b.id, member_secret: b.secret });
    expect(denied.data).toMatchObject({ status: "denied" });
    expect((denied.data as { hint: string }).hint).toMatch(/takeover|release/);

    // a releases; now b's plain claim succeeds.
    const rel = await callTool(client, "release_direction", { member_id: a.id, member_secret: a.secret, epoch: 1 });
    expect(rel.data).toMatchObject({ status: "released", epoch: 2 });
    const claimed = await callTool(client, "claim_direction", { member_id: b.id, member_secret: b.secret });
    expect(claimed.data).toMatchObject({ status: "claimed", epoch: 3 });
  });

  it("takeover still displaces a live-or-stale holder", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    const takeover = await callTool(client, "claim_direction", { member_id: b.id, member_secret: b.secret, takeover: true });
    expect(takeover.data).toMatchObject({ status: "claimed", epoch: 2 });
  });
});

describe("invites + require_invite (director-controlled membership)", () => {
  it("mint_invite is director-gated and epoch-fenced", async () => {
    const { store } = newStore();
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const wreg = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local" });
    const w = wreg.data as { member_id: string; member_secret: string };
    const forbidden = await callTool(workerClient, "mint_invite", { member_id: w.member_id, member_secret: w.member_secret, epoch: 1 });
    expect(forbidden.data).toMatchObject({ status: "forbidden", reason: "director token required" });

    // Director side: epoch fencing.
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    const b = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    store.claimDirection(b.id, true); // a is stale at epoch 1
    const stale = await callTool(client, "mint_invite", { member_id: a.id, member_secret: a.secret, epoch: 1 });
    expect(stale.data).toMatchObject({ status: "superseded" });
  });

  it("require_invite refuses worker registration without an invite, and accepts a minted one", async () => {
    const { store } = newStore();
    const director = reg(store, "myshow");
    store.updateShowRules("myshow", { switches: { requireInvite: true } }, "human");

    // Worker-token registration with no invite is refused.
    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const refused = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local" });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ status: "invite_required" });

    // Director mints an invite (director client), worker exchanges it.
    const dirClient = await connectClient(store);
    await callTool(dirClient, "claim_direction", { member_id: director.id, member_secret: director.secret });
    const minted = await callTool(dirClient, "mint_invite", { member_id: director.id, member_secret: director.secret, epoch: 1 });
    const token = (minted.data as { invite_token: string }).invite_token;
    expect(token).toBeTruthy();

    const joined = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local", invite: token });
    expect(joined.isError).toBe(false);
    expect((joined.data as { member_id: string }).member_id).toBeTruthy();

    // Reusing the same invite is rejected (single-use).
    const reused = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local", invite: token });
    expect(reused.isError).toBe(true);
    expect(reused.data).toMatchObject({ status: "invite_rejected", reason: "used" });
  });

  it("director-token registration is exempt from require_invite", async () => {
    const { store } = newStore();
    reg(store, "myshow");
    store.updateShowRules("myshow", { switches: { requireInvite: true } }, "human");
    const dirClient = await connectClient(store); // director authLevel
    const res = await callTool(dirClient, "register", { show: "myshow", kind: "claude-local" });
    expect(res.isError).toBe(false);
    expect((res.data as { member_id: string }).member_id).toBeTruthy();
  });
});

describe("evict_member", () => {
  it("director-gated, epoch-fenced, and can't evict self", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const a = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: a.id, member_secret: a.secret });
    const self = await callTool(client, "evict_member", { member_id: a.id, member_secret: a.secret, epoch: 1, target: a.id });
    expect(self.isError).toBe(true);
    expect(self.data).toMatchObject({ status: "error" });

    const workerClient = await connectClient(store, { ...FAST_CONFIG, authLevel: "worker" });
    const wreg = await callTool(workerClient, "register", { show: "myshow", kind: "claude-local" });
    const w = wreg.data as { member_id: string; member_secret: string };
    const forbidden = await callTool(workerClient, "evict_member", { member_id: w.member_id, member_secret: w.member_secret, epoch: 1, target: a.id });
    expect(forbidden.data).toMatchObject({ status: "forbidden" });
  });

  it("revokes the target's credential so its next authed call is unauthorized, and requeues its task", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const director = reg(store, "myshow");
    const worker = reg(store, "myshow");
    await callTool(client, "claim_direction", { member_id: director.id, member_secret: director.secret });
    const { task } = store.createTask({ show: "myshow", title: "t", brief: "b", createdBy: director.id });
    store.claimNextTask(worker.id);

    const evicted = await callTool(client, "evict_member", { member_id: director.id, member_secret: director.secret, epoch: 1, target: worker.id });
    expect(evicted.data).toMatchObject({ status: "evicted", member_id: worker.id, requeued_task_id: task.id });

    // The evicted worker's credential no longer authenticates any tool call.
    const afterEvict = await callTool(client, "update_task", { member_id: worker.id, member_secret: worker.secret, task_id: task.id, note: "still here?" });
    expect(afterEvict.data).toMatchObject({ status: "unauthorized_member" });
    // The task is back in the queue for someone else.
    expect(store.getBoard("myshow").tasks.find((t) => t.id === task.id)?.status).toBe("queued");
  });
});

describe("register delivers current rules as authenticated policy", () => {
  it("includes the full rules and a director-policy trust tag", async () => {
    const { store } = newStore();
    const client = await connectClient(store);
    const res = await callTool(client, "register", { show: "myshow", kind: "claude-local" });
    const data = res.data as { rules: { version: number; switches: unknown }; rules_trust: { trust: string } };
    expect(data.rules.version).toBe(1);
    expect(data.rules.switches).toBeTruthy();
    expect(data.rules_trust.trust).toBe("authenticated_director_policy");
  });
});

describe("director idle poll surfaces pending input-required escalations", () => {
  it("re-reminds about a parked escalation the review feed already showed once", async () => {
    const { store } = newStore();
    const director = store.register("myshow", "claude-local");
    const worker = store.register("myshow", "claude-local");
    const claimed = store.claimDirection(director.id, true);
    if (!claimed.ok) throw new Error("claim_direction failed");
    const t = store.createTask({ show: "myshow", title: "needs a call", brief: "b", createdBy: director.id }).task;
    store.claimNextTask(worker.id);
    store.updateTask(worker.id, t.id, { status: "input-required", note: "renew or 410?" });

    // First director poll surfaces it as a review item (cursor advances past it).
    const first = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(first.status).toBe("review");

    // A later idle poll no longer shows it as review, but the standing reminder does.
    const idle = await resolveAwaitWork(store, director.id, undefined, 0.05);
    expect(idle.status).toBe("nothing");
    expect(idle.pending_input).toHaveLength(1);
    expect(idle.pending_input![0].task_id).toBe(t.id);

    // A worker's idle poll never carries the director-only reminder. (A fresh worker with no
    // task and an empty queue -- the escalating worker still holds its parked task.)
    const idleWorker = store.register("myshow", "claude-local");
    const workerIdle = await resolveAwaitWork(store, idleWorker.id, undefined, 0.05);
    expect(workerIdle.status).toBe("nothing");
    if (workerIdle.status === "nothing") {
      expect(workerIdle.pending_input).toBeUndefined();
    }
  });
});
