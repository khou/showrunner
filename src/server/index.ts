// Entrypoint: env config, Store, Hono app (bearer auth, /mcp, /api, static callboard) and
// the lease-reclaim sweep. See PLAN.md "HTTP routes" and "Env knobs" for the pinned contract.

import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readEnvConfig, type EnvConfig } from "../types.js";
import { createApiRoutes } from "./api.js";
import { createMcpServer, createStatelessTransport } from "./mcp.js";
import { Store } from "./store.js";

const config = readEnvConfig();

mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, "showrunner.db");
const store = new Store(dbPath);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(moduleDir, "..", "..", "web");

const COOKIE_NAME = "showrunner_token";

function timingSafeEqualStr(a: string, b: string): boolean {
  const abuf = Buffer.from(a);
  const bbuf = Buffer.from(b);
  if (abuf.length !== bbuf.length) return false;
  return timingSafeEqual(abuf, bbuf);
}

/**
 * Bearer auth for /mcp and /api: Authorization header, or ?token= which validates once, sets
 * an httpOnly cookie, and redirects to the same URL without the token (so it never sits in
 * browser history beyond the first hit).
 */
function requireBearer(cfg: EnvConfig): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match && timingSafeEqualStr(match[1], cfg.token)) return next();
      return c.json({ error: "unauthorized" }, 401);
    }

    const queryToken = c.req.query("token");
    if (queryToken !== undefined) {
      if (!timingSafeEqualStr(queryToken, cfg.token)) return c.json({ error: "unauthorized" }, 401);
      setCookie(c, COOKIE_NAME, cfg.token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      const url = new URL(c.req.url);
      url.searchParams.delete("token");
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }

    const cookieToken = getCookie(c, COOKIE_NAME);
    if (cookieToken && timingSafeEqualStr(cookieToken, cfg.token)) return next();

    return c.json({ error: "unauthorized: pass Authorization: Bearer <token> or ?token=<token>" }, 401);
  };
}

/**
 * GET / itself is not gated (see the route below), but a `?token=` hit still runs the
 * "enter it once" handshake: validate, set the cookie, redirect to the clean URL. Unlike
 * requireBearer this never blocks the request -- with no query token it just falls through
 * to serving the page.
 */
function tokenCookieHandshake(cfg: EnvConfig): MiddlewareHandler {
  return async (c, next) => {
    const queryToken = c.req.query("token");
    if (queryToken === undefined) return next();
    if (!timingSafeEqualStr(queryToken, cfg.token)) return c.json({ error: "unauthorized" }, 401);
    setCookie(c, COOKIE_NAME, cfg.token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    const url = new URL(c.req.url);
    url.searchParams.delete("token");
    // Fragment survives the redirect but never reaches a server or its logs; the
    // callboard JS stores it (so /api calls work) and strips it from the URL.
    return c.redirect(`${url.pathname}${url.search}#token=${encodeURIComponent(cfg.token)}`, 302);
  };
}

const app = new Hono<{ Bindings: HttpBindings }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.use("/mcp", requireBearer(config));

// The streamable-HTTP spec expects a 405 (not this server's static-catch-all 404) from a
// server that doesn't offer a standalone SSE stream; the MCP SDK client treats 404 as an
// actual transport error and logs it on every single connect.
app.get("/mcp", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "method not allowed: this endpoint only accepts POST" }, 405);
});
app.delete("/mcp", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "method not allowed: this endpoint only accepts POST" }, 405);
});

app.post("/mcp", async (c) => {
  // createStatelessTransport() (mcp.ts) wraps the Node-style StreamableHTTPServerTransport
  // (sessionIdGenerator: undefined); it writes straight to the raw ServerResponse, so this
  // handler returns RESPONSE_ALREADY_SENT rather than a Hono Response (see @hono/node-server
  // "Direct response from Node.js API").
  const transport = createStatelessTransport();
  try {
    const server = createMcpServer(store, config);
    await server.connect(transport);
    await transport.handleRequest(c.env.incoming, c.env.outgoing);
  } catch (err) {
    console.error("mcp request failed:", err);
    if (!c.env.outgoing.headersSent) {
      c.env.outgoing.writeHead(500, { "Content-Type": "application/json" });
      c.env.outgoing.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal server error" }, id: null }));
    }
  }
  return RESPONSE_ALREADY_SENT;
});

app.use("/api/*", requireBearer(config));
app.route("/api", createApiRoutes(store, dbPath));

// The callboard shell carries no secrets (all data comes from the gated /api), so GET / is
// unauthenticated like the rest of web/ -- gating it was decorative anyway, since the same
// file was already reachable unauthenticated via the catch-all below as /index.html. A
// ?token= hit still does the "enter it once" handshake: validate, set an httpOnly cookie,
// redirect to the clean URL so the token never lingers in browser history.
app.get("/", tokenCookieHandshake(config), serveStatic({ root: webRoot, path: "index.html" }));
app.use("/*", serveStatic({ root: webRoot }));

const sweepTimer = setInterval(() => {
  try {
    store.sweep();
  } catch (err) {
    console.error("sweep failed:", err);
  }
}, config.sweepIntervalS * 1000);

const httpServer = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`showrunner listening on :${info.port} (data: ${dbPath})`);
});

function shutdown(): void {
  clearInterval(sweepTimer);
  httpServer.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
