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

async function connectClient(baseUrl: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
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
      env: { ...process.env, SHOWRUNNER_TOKEN: TOKEN, PORT: String(port), DATA_DIR: dataDir },
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

  it(
    "register -> claim_direction -> create_task -> worker claims+completes -> director reviews -> takeover supersedes the old epoch",
    async () => {
      const director1 = await connectClient(baseUrl, "e2e-director-1");
      const worker = await connectClient(baseUrl, "e2e-worker");

      const regDirector = await callTool(director1, "register", { show: "myshow", kind: "claude-local", display_name: "director-one" });
      const directorId = (regDirector.data as { member_id: string }).member_id;

      const regWorker = await callTool(worker, "register", { show: "myshow", kind: "claude-local", display_name: "worker-one" });
      const workerId = (regWorker.data as { member_id: string }).member_id;

      const claim = await callTool(director1, "claim_direction", { member_id: directorId });
      expect(claim.data).toMatchObject({ status: "claimed", epoch: 1 });

      const created = await callTool(director1, "create_task", {
        member_id: directorId,
        epoch: 1,
        title: "write a haiku",
        brief: "see README.md",
      });
      expect(created.isError).toBe(false);
      const taskId = (created.data as { task_id: string }).task_id;
      expect(taskId).toBeTruthy();

      const claimed = await callTool(worker, "await_work", { member_id: workerId });
      expect(claimed.data).toMatchObject({ status: "task", task: { id: taskId } });

      const completed = await callTool(worker, "update_task", {
        member_id: workerId,
        task_id: taskId,
        status: "completed",
        note: "done",
        artifacts: [{ kind: "text", text: "five-seven-five" }],
      });
      expect(completed.isError).toBe(false);
      expect((completed.data as { task: { status: string } }).task.status).toBe("completed");

      const review = await callTool(director1, "await_work", { member_id: directorId });
      expect(review.data).toMatchObject({ status: "review" });
      expect((review.data as { items: { id: string }[] }).items.map((i) => i.id)).toContain(taskId);

      // A second director takes over: the human said "you're now the director".
      const director2 = await connectClient(baseUrl, "e2e-director-2");
      const regDirector2 = await callTool(director2, "register", { show: "myshow", kind: "claude-local", display_name: "director-two" });
      const director2Id = (regDirector2.data as { member_id: string }).member_id;

      const takeover = await callTool(director2, "claim_direction", { member_id: director2Id, takeover: true });
      expect(takeover.data).toMatchObject({ status: "claimed", epoch: 2 });

      // director1 still believes it holds epoch 1; the server fences it as a structured result,
      // not a protocol error, so the old director can read it and stand down.
      const stale = await callTool(director1, "create_task", { member_id: directorId, epoch: 1, title: "t2", brief: "b2" });
      expect(stale.isError).toBe(false);
      expect(stale.data).toMatchObject({ status: "superseded", epoch: 2, holder: { id: director2Id } });

      await director1.close();
      await worker.close();
      await director2.close();
    },
    10_000,
  );

  it(
    "await_work wakes on a task created ~1s later, well under the 25s hold",
    async () => {
      const show = "myshow-poll";
      const director = await connectClient(baseUrl, "e2e-poll-director");
      const worker = await connectClient(baseUrl, "e2e-poll-worker");

      const regDirector = await callTool(director, "register", { show, kind: "claude-local" });
      const directorId = (regDirector.data as { member_id: string }).member_id;
      await callTool(director, "claim_direction", { member_id: directorId });

      const regWorker = await callTool(worker, "register", { show, kind: "claude-local" });
      const workerId = (regWorker.data as { member_id: string }).member_id;

      const started = Date.now();
      const pending = callTool(worker, "await_work", { member_id: workerId });

      await new Promise((r) => setTimeout(r, 1000));
      await callTool(director, "create_task", { member_id: directorId, epoch: 1, title: "late task", brief: "b" });

      const result = await pending;
      const elapsed = Date.now() - started;

      expect(result.data).toMatchObject({ status: "task" });
      expect(elapsed).toBeLessThan(2000);

      await director.close();
      await worker.close();
    },
    8_000,
  );
});
