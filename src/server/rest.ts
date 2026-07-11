// /v1: plain-HTTPS mirror of the MCP tool surface, for clients whose MCP plumbing is broken
// or absent (Cursor cloud ignores repo MCP configs as of 3.8) and for plain scripts. Every
// tool is POST /v1/<tool_name> with the tool's JSON arguments and the same bearer auth as
// /mcp; the definitions come from defineTools (mcp.ts), so the two surfaces cannot drift.
import { Hono } from "hono";
import { z } from "zod";
import { defineTools } from "./mcp.js";
import { INSTRUCTIONS } from "./instructions.js";
import type { Store } from "./store.js";
import type { AuthLevel } from "../types.js";

export function createRestRoutes(store: Store, pollHoldSeconds: number): Hono<{ Variables: { authLevel: AuthLevel } }> {
  const rest = new Hono<{ Variables: { authLevel: AuthLevel } }>();

  // Bootstrap for sessions with no MCP client: the same protocol text `initialize` delivers.
  rest.get("/protocol", (c) => c.text(INSTRUCTIONS));

  rest.get("/tools", (c) => {
    const tools = defineTools(store, { pollHoldSeconds, authLevel: c.get("authLevel") });
    return c.json({
      hint: "POST /v1/<name> with the tool's JSON arguments (Authorization: Bearer <token>)",
      tools: tools.map((t) => ({ name: t.name, description: t.config.description })),
    });
  });

  rest.post("/:tool", async (c) => {
    // Per-request tool set: the handlers close over the caller's bearer level, which is how
    // director-only tools stay director-only here exactly as they do over /mcp.
    const tools = defineTools(store, { pollHoldSeconds, authLevel: c.get("authLevel") });
    const name = c.req.param("tool");
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return c.json({ error: `unknown tool: ${name}`, tools: tools.map((t) => t.name) }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(tool.config.inputSchema).safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid arguments", issues: parsed.error.issues }, 400);
    }
    // Handlers mostly return structured errors, but anything thrown must still come back as
    // JSON (the MCP SDK does this wrapping on /mcp; Hono's default would be a text/plain 500).
    try {
      const result = await tool.handler(parsed.data);
      const text = (result.content ?? []).find(
        (p): p is { type: "text"; text: string } => p.type === "text",
      )?.text;
      return c.json(text ? JSON.parse(text) : {}, result.isError ? 400 : 200);
    } catch (err) {
      return c.json({ error: "internal error", message: (err as Error).message }, 500);
    }
  });

  return rest;
}
