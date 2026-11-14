import { loadEnv } from "./env.js";
loadEnv(); // must run before anything reads process.env (OPENAI_API_KEY, model, …)

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";

import { createSession, type SessionContext } from "./agent/stateMachine.js";
import { createSeededDatabase, MockDatabase } from "./db/mockDb.js";
import { HybridRetriever } from "./rag/retriever.js";
import { TelemetryBus } from "./agent/telemetry.js";
import { handleUserTurn } from "./agent/orchestrator.js";
import { createRealtimeSession, executeVoiceTool } from "./voice/realtime.js";

// ── Shared singletons ────────────────────────────────────────
const retriever = new HybridRetriever();
await retriever.warm().catch(() => undefined); // best-effort vector warm-up

interface Live {
  session: SessionContext;
  db: MockDatabase;
}
const sessions = new Map<string, Live>();

function getOrCreate(sessionId?: string): { id: string; live: Live } {
  const id = sessionId && sessions.has(sessionId) ? sessionId : sessionId ?? randomUUID();
  let live = sessions.get(id);
  if (!live) {
    live = { session: createSession(id), db: createSeededDatabase() };
    sessions.set(id, live);
  }
  return { id, live };
}

// ── App ──────────────────────────────────────────────────────
const app = new Hono();
app.use("*", cors());

app.get("/", (c) =>
  c.json({
    name: "UCL Matchday Concierge API",
    status: "ok",
    endpoints: {
      "GET /health": "runtime status (model, RAG, API key)",
      "POST /chat": "{ sessionId?, message } → SSE stream of the turn",
      "GET /session/:id": "inspect a session's state",
      "POST /voice/session": "mint an OpenAI Realtime token",
      "POST /voice/tool": "execute a voice tool call through the guardrail gate",
    },
    hint: "This is a JSON API, not a web page. Try GET /health, or POST /chat. The React UI is Milestone 2.",
  })
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    model: process.env.AGENT_MODEL || "gpt-4o",
    ragReady: retriever.ready,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    sessions: sessions.size,
  })
);

/**
 * POST /chat  { sessionId?, message }
 * Streams the full turn as Server-Sent Events: one frame per telemetry event
 * (token, tool_proposed, guardrail_check, tool_result, state_change, …) plus a
 * final `done` frame carrying the assistant reply and session id.
 */
app.post("/chat", async (c) => {
  const body = await c.req.json<{ sessionId?: string; message: string }>().catch(() => null);
  if (!body?.message) return c.json({ error: "message is required" }, 400);
  if (!process.env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set" }, 500);

  const { id, live } = getOrCreate(body.sessionId);

  return streamSSE(c, async (sse) => {
    const bus = new TelemetryBus();
    const unsub = bus.on((e) => {
      void sse.writeSSE({ event: e.type, data: JSON.stringify(e) });
    });
    try {
      const reply = await handleUserTurn(live.session, body.message, { db: live.db, retriever, bus });
      await sse.writeSSE({ event: "done", data: JSON.stringify({ sessionId: id, reply, state: live.session.state }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sse.writeSSE({ event: "error", data: JSON.stringify({ message }) });
    } finally {
      unsub();
    }
  });
});

/** Inspect a session's current state + full telemetry-free history (debug). */
app.get("/session/:id", (c) => {
  const live = sessions.get(c.req.param("id"));
  if (!live) return c.json({ error: "not found" }, 404);
  return c.json({ state: live.session.state, authenticated: live.session.authenticated, supporterId: live.session.supporterId });
});

// ── Voice (OpenAI Realtime) ──────────────────────────────────
/**
 * Mints an ephemeral Realtime session token for the browser to open a WebRTC
 * voice connection. The voice model shares the SAME tool catalogue; tool calls
 * are proxied back to POST /voice/tool so they pass the identical guardrail gate.
 */
app.post("/voice/session", async (c) => {
  if (!process.env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set" }, 500);
  const { id } = getOrCreate((await c.req.json().catch(() => ({})))?.sessionId);
  try {
    const token = await createRealtimeSession();
    return c.json({ sessionId: id, ...token });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** Executes one voice-originated tool call through the shared guardrail+handler path. */
app.post("/voice/tool", async (c) => {
  const body = await c.req.json<{ sessionId: string; name: string; arguments: unknown }>().catch(() => null);
  if (!body?.sessionId || !body?.name) return c.json({ error: "sessionId and name required" }, 400);
  const live = sessions.get(body.sessionId);
  if (!live) return c.json({ error: "unknown session" }, 404);
  const bus = new TelemetryBus();
  const result = await executeVoiceTool(live.session, live.db, retriever, bus, body.name, body.arguments);
  return c.json({ result, telemetry: bus.log, state: live.session.state });
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port });
console.log(`⚽  UCL Matchday Concierge API on http://localhost:${port}  (model=${process.env.AGENT_MODEL || "gpt-4o"}, rag=${retriever.ready})`);
