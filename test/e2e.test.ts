// Full-stack e2e (PLAN.md "Test expectations" e2e section): boots the real server as a child
// process (random free port, temp DATA_DIR, a throwaway bearer token) and drives it with the
// real MCP SDK client over streamable HTTP -- no in-process shortcuts, no InMemoryTransport.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TOKEN = "e2e-test-token";
const WORKER_TOKEN = "e2e-worker-token";

/**
 * A free port from the OS, released immediately. Passed to the server as PORT: cheaper and
 * more portable than parsing "listening on :N" from stdout, and PORT=0 doesn't work for this
 * (readEnvConfig's parsePositiveInt rejects 0 and falls back to the 8080 default).
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close(() => (port ? resolve(port) : reject(new Error("failed to allocate a free port"))));
    });
  });
}

async function waitForHealthy(baseUrl: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  let exited: string | undefined;
  proc.once("exit", (code, signal) => {
    exited = `exit code=${code} signal=${signal}`;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server process exited before becoming healthy (${exited})`);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch {
      // connection refused: not listening yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not answer /healthz within ${timeoutMs}ms`);
}

function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
}

async function connectClient(baseUrl: string, name: string, token: string = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  return client;
}

type ToolContent = { type: string; text?: string };

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as ToolContent[];
  const first = content[0];
  const data = first && first.type === "text" && first.text !== undefined ? JSON.parse(first.text) : undefined;
  return { data, isError: result.isError === true };
}

describe("showrunner e2e (real server, real MCP client, streamable HTTP)", () => {
  let proc: ChildProcess;
  let baseUrl: string;
  let dataDir: string;
  let stderr = "";

  beforeAll(async () => {
    const port = await getFreePort();
    dataDir = mkdtempSync(path.join(tmpdir(), "showrunner-e2e-"));
    baseUrl = `http://127.0.0.1:${port}`;

    proc = spawn(TSX_BIN, [path.join(REPO_ROOT, "src", "server", "index.ts")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SHOWRUNNER_TOKEN: TOKEN,
        SHOWRUNNER_WORKER_TOKEN: WORKER_TOKEN,
        PORT: String(port),
        DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await waitForHealthy(baseUrl, proc, 10_000);
  }, 15_000);

  afterAll(async () => {
    if (proc) await stopServer(proc);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a bad bearer on /mcp and /api", async () => {
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcpRes.status).toBe(401);

    const apiRes = await fetch(`${baseUrl}/api/shows`, { headers: { Authorization: "Bearer wrong-token" } });
    expect(apiRes.status).toBe(401);
  });

  it("worker token can read /api but cannot mutate; cannot claim_direction via MCP", async () => {
    const getRes = await fetch(`${baseUrl}/api/shows`, { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } });
    expect(getRes.status).toBe(200);

    const postRes = await fetch(`${baseUrl}/api/shows/e2e-dual/direction/clear`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
    });
    expect(postRes.status).toBe(403);

    const worker = await connectClient(baseUrl, "e2e-dual-worker", WORKER_TOKEN);
    const reg = await callTool(worker, "register", { show: "e2e-dual", kind: "claude-local" });
    const { member_id: memberId, member_secret: secret } = reg.data as { member_id: string; member_secret: string };
    const claim = await callTool(worker, "claim_direction", { member_id: memberId, member_secret: secret, takeover: true });
    expect(claim.isError).toBe(true);
    expect(claim.data).toMatchObject({ status: "forbidden" });
    await worker.close();
  });

  it(
    "register -> claim_direction -> create_task -> worker claims+completes -> director reviews -> takeover supersedes the old epoch",
    async () => {
      const director1 = await connectClient(baseUrl, "e2e-director-1");
      const worker = await connectClient(baseUrl, "e2e-worker");

      const regDirector = await callTool(director1, "register", { show: "myshow", kind: "claude-local", display_name: "director-one" });
      const { member_id: directorId, member_secret: directorSecret } = regDirector.data as { member_id: string; member_secret: string };

      const regWorker = await callTool(worker, "register", { show: "myshow", kind: "claude-local", display_name: "worker-one" });
      const { member_id: workerId, member_secret: workerSecret } = regWorker.data as { member_id: string; member_secret: string };

      const claim = await callTool(director1, "claim_direction", { member_id: directorId, member_secret: directorSecret });
      expect(claim.data).toMatchObject({ status: "claimed", epoch: 1 });

      const created = await callTool(director1, "create_task", {
        member_id: directorId,
        member_secret: directorSecret,
        epoch: 1,
        title: "write a haiku",
        brief: "see README.md",
      });
      expect(created.isError).toBe(false);
      const taskId = (created.data as { task_id: string }).task_id;
      expect(taskId).toBeTruthy();

      const claimed = await callTool(worker, "await_work", { member_id: workerId, member_secret: workerSecret });
      expect(claimed.data).toMatchObject({ status: "task", task: { id: taskId } });

      const completed = await callTool(worker, "update_task", {
        member_id: workerId,
        member_secret: workerSecret,
        task_id: taskId,
        status: "completed",
        note: "done",
        artifacts: [{ kind: "text", text: "five-seven-five" }],
      });
      expect(completed.isError).toBe(false);
      expect((completed.data as { task: { status: string } }).task.status).toBe("completed");

      const review = await callTool(director1, "await_work", { member_id: directorId, member_secret: directorSecret });
      expect(review.data).toMatchObject({ status: "review" });
      expect((review.data as { items: { id: string }[] }).items.map((i) => i.id)).toContain(taskId);

      // A second director takes over: the human said "you're now the director".
      const director2 = await connectClient(baseUrl, "e2e-director-2");
      const regDirector2 = await callTool(director2, "register", { show: "myshow", kind: "claude-local", display_name: "director-two" });
      const { member_id: director2Id, member_secret: director2Secret } = regDirector2.data as { member_id: string; member_secret: string };

      const takeover = await callTool(director2, "claim_direction", { member_id: director2Id, member_secret: director2Secret, takeover: true });
      expect(takeover.data).toMatchObject({ status: "claimed", epoch: 2 });

      // director1 still believes it holds epoch 1; the server fences it as a structured result,
      // not a protocol error, so the old director can read it and stand down.
      const stale = await callTool(director1, "create_task", { member_id: directorId, member_secret: directorSecret, epoch: 1, title: "t2", brief: "b2" });
      expect(stale.isError).toBe(false);
      expect(stale.data).toMatchObject({ status: "superseded", epoch: 2, holder: { id: director2Id } });

      await director1.close();
      await worker.close();
      await director2.close();
    },
    10_000,
  );

  it(
    "await_work wakes on a task created ~1s later, well under the 50s hold",
    async () => {
      const show = "myshow-poll";
      const director = await connectClient(baseUrl, "e2e-poll-director");
      const worker = await connectClient(baseUrl, "e2e-poll-worker");

      const regDirector = await callTool(director, "register", { show, kind: "claude-local" });
      const { member_id: directorId, member_secret: directorSecret } = regDirector.data as { member_id: string; member_secret: string };
      await callTool(director, "claim_direction", { member_id: directorId, member_secret: directorSecret });

      const regWorker = await callTool(worker, "register", { show, kind: "claude-local" });
      const { member_id: workerId, member_secret: workerSecret } = regWorker.data as { member_id: string; member_secret: string };

      const started = Date.now();
      const pending = callTool(worker, "await_work", { member_id: workerId, member_secret: workerSecret });

      await new Promise((r) => setTimeout(r, 1000));
      await callTool(director, "create_task", { member_id: directorId, member_secret: directorSecret, epoch: 1, title: "late task", brief: "b" });

      const result = await pending;
      const elapsed = Date.now() - started;

      expect(result.data).toMatchObject({ status: "task" });
      expect(elapsed).toBeLessThan(2000);

      await director.close();
      await worker.close();
    },
    8_000,
  );

  it(
    "serves the same tools over the /v1 HTTP mirror (worker loop, director gate, bootstrap)",
    async () => {
      const show = `rest-${Date.now() % 100000}`;
      const post = async (tool: string, args: Record<string, unknown>, token: string = TOKEN) => {
        const res = await fetch(`${baseUrl}/v1/${tool}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        return { status: res.status, data: (await res.json()) as any };
      };

      const protocol = await fetch(`${baseUrl}/v1/protocol`, { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } });
      expect(protocol.status).toBe(200);
      expect(await protocol.text()).toContain("showrunner coordinates");
      expect((await fetch(`${baseUrl}/v1/protocol`)).status).toBe(401);

      const regD = await post("register", { show, kind: "other", display_name: "rest director" });
      expect(regD.status).toBe(200);
      expect(regD.data.member_secret).toBeTruthy();
      const claim = await post("claim_direction", {
        member_id: regD.data.member_id, member_secret: regD.data.member_secret, takeover: true,
      });
      expect(claim.status).toBe(200);
      const created = await post("create_task", {
        member_id: regD.data.member_id, member_secret: regD.data.member_secret,
        epoch: claim.data.epoch, title: "rest task", brief: "b",
      });
      expect(created.status).toBe(200);

      const regW = await post("register", { show, kind: "other", display_name: "rest worker" }, WORKER_TOKEN);
      expect(regW.status).toBe(200);
      expect(regW.data.loop_contract.after_update_task).toBe("await_work");
      const got = await post("await_work", {
        member_id: regW.data.member_id, member_secret: regW.data.member_secret, wait_seconds: 1,
      }, WORKER_TOKEN);
      expect(got.data.status).toBe("task");
      const done = await post("update_task", {
        member_id: regW.data.member_id, member_secret: regW.data.member_secret,
        task_id: got.data.task.id, status: "completed", note: "done via /v1",
      }, WORKER_TOKEN);
      expect(done.status).toBe(200);
      // Terminal report must carry the required-next-call pointer with live queue depth.
      expect(done.data.next.action).toBe("await_work");
      expect(done.data.next.queued).toBe(0);
      expect(done.data.next.hint).toContain("await_work");

      const forbidden = await post("claim_direction", {
        member_id: regW.data.member_id, member_secret: regW.data.member_secret, takeover: true,
      }, WORKER_TOKEN);
      expect(forbidden.status).toBe(400);
      expect(forbidden.data.status).toBe("forbidden");

      const invalid = await post("update_task", { member_id: regW.data.member_id }, WORKER_TOKEN);
      expect(invalid.status).toBe(400);
      const unknown = await post("no_such_tool", {}, WORKER_TOKEN);
      expect(unknown.status).toBe(404);
    },
    15_000,
  );
});
