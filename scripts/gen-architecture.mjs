/**
 * Generates docs/architecture.excalidraw — a UEFA-themed architecture diagram
 * for the UCL Matchday Concierge agent. Run: node scripts/gen-architecture.mjs
 *
 * Hand-maintaining Excalidraw JSON (positions, arrow bindings, boundElements) is
 * tedious and error-prone, so this builds it programmatically.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "docs", "architecture.excalidraw");
const now = Date.now();
const els = [];
let nonce = 1;
const rnd = () => (nonce = (nonce * 1103515245 + 12345) & 0x7fffffff);

// ── palette (dark UCL look) ──────────────────────────────────
const C = {
  bg: "#0b1020",
  text: "#e7ecff",
  dim: "#9fb3e0",
  arrow: "#8aa0c8",
  blue: "#4f7cff",
  blueFill: "#15224a",
  violet: "#a970ff",
  gold: "#f5b301",
  goldFill: "#2a2410",
  green: "#39d98a",
  greenFill: "#122a22",
  red: "#ff6b6b",
  redFill: "#2a1618",
  grey: "#8aa0c8",
  greyFill: "#18203a",
  cyan: "#22d3ee",
  cyanFill: "#102a33",
};

function rect({ id, x, y, w, h, fill = "transparent", stroke = C.blue, sw = 2, dash = "solid", round = true, opacity = 100 }) {
  const el = {
    type: "rectangle", id, x, y, width: w, height: h,
    strokeColor: stroke, backgroundColor: fill, fillStyle: "solid",
    strokeWidth: sw, strokeStyle: dash, roughness: 0, opacity, angle: 0,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false,
    groupIds: [], frameId: null, roundness: round ? { type: 3 } : null,
    boundElements: [], updated: now, link: null, locked: false,
  };
  els.push(el);
  return el;
}

function text({ id, x, y, w, str, size = 16, color = C.text, align = "center", font = 2 }) {
  const lines = str.split("\n").length;
  const lineHeight = 1.25;
  const el = {
    type: "text", id, x, y, width: w, height: Math.round(size * lineHeight * lines),
    strokeColor: color, backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false,
    groupIds: [], frameId: null, roundness: null, boundElements: [], updated: now, link: null, locked: false,
    fontSize: size, fontFamily: font, text: str, textAlign: align, verticalAlign: "top",
    containerId: null, originalText: str, lineHeight, baseline: Math.round(size * 0.9),
  };
  els.push(el);
  return el;
}

// Box with vertically-centered multi-line label.
function node(id, x, y, w, h, str, { fill = C.blueFill, stroke = C.blue, size = 15, color = C.text, font = 2 } = {}) {
  const r = rect({ id: `${id}-r`, x, y, w, h, fill, stroke });
  const lines = str.split("\n").length;
  const th = size * 1.25 * lines;
  text({ id: `${id}-t`, x: x + 10, y: y + (h - th) / 2, w: w - 20, str, size, color, font });
  return r;
}

function side(r, s) {
  if (s === "r") return { x: r.x + r.width, y: r.y + r.height / 2 };
  if (s === "l") return { x: r.x, y: r.y + r.height / 2 };
  if (s === "t") return { x: r.x + r.width / 2, y: r.y };
  return { x: r.x + r.width / 2, y: r.y + r.height };
}

function arrow(id, from, fs, to, ts, { dashed = false, color = C.arrow, both = false } = {}) {
  const p = side(from, fs);
  const q = side(to, ts);
  const el = {
    type: "arrow", id, x: p.x, y: p.y, width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y),
    points: [[0, 0], [q.x - p.x, q.y - p.y]],
    strokeColor: color, backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: dashed ? "dashed" : "solid", roughness: 0, opacity: 100, angle: 0,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false, groupIds: [], frameId: null,
    roundness: { type: 2 }, boundElements: [], updated: now, link: null, locked: false,
    startBinding: { elementId: from.id, focus: 0, gap: 6 },
    endBinding: { elementId: to.id, focus: 0, gap: 6 },
    lastCommittedPoint: null, startArrowhead: both ? "arrow" : null, endArrowhead: "arrow",
  };
  els.push(el);
  from.boundElements.push({ id, type: "arrow" });
  to.boundElements.push({ id, type: "arrow" });
  return el;
}

// Small free-floating caption near a point.
function caption(id, x, y, str, color = C.dim, size = 11) {
  text({ id, x, y, w: 200, str, size, color, align: "left", font: 2 });
}

// ── Title ────────────────────────────────────────────────────
text({ id: "title", x: 40, y: 24, w: 1300, str: "UEFA Champions League — Matchday Concierge · Architecture", size: 28, color: C.text, align: "left", font: 2 });
text({ id: "subtitle", x: 40, y: 64, w: 1300, str: "Defense-in-depth agent runtime: probabilistic LLM reasoning fenced by deterministic code. One core, two transports (text SSE + voice WebRTC).", size: 14, color: C.dim, align: "left", font: 2 });

// ── Clients ──────────────────────────────────────────────────
text({ id: "lbl-client", x: 40, y: 120, w: 240, str: "CLIENT (React + TypeScript)", size: 12, color: C.cyan, align: "left", font: 2 });
const console_ = node("console", 40, 145, 240, 95, "FDE Console\nChat UI · live FDE Inspector\n(tool calls · guardrails · latency)", { fill: C.blueFill, stroke: C.blue, size: 13 });
const voice = node("voice", 40, 255, 240, 80, "Voice (WebRTC)\nmic ↔ speaker\nOpenAI Realtime", { fill: C.cyanFill, stroke: C.cyan, size: 13 });

// ── Gateway ──────────────────────────────────────────────────
const gw = node("gw", 340, 170, 190, 150, "API Gateway (Hono)\n\n/chat  → SSE stream\n/voice/session\n/voice/tool\n/health", { fill: C.greyFill, stroke: C.grey, size: 13 });

// ── Agent core ───────────────────────────────────────────────
rect({ id: "core", x: 590, y: 120, w: 400, h: 470, fill: "transparent", stroke: C.violet, dash: "dashed" });
text({ id: "lbl-core", x: 606, y: 132, w: 380, str: "AGENT CORE  (transport-agnostic)", size: 13, color: C.violet, align: "left", font: 2 });

const orch = node("orch", 612, 168, 356, 70, "Conversation Orchestrator\nexplicit state machine · turn loop", { fill: C.blueFill, stroke: C.blue, size: 14 });
const llm = node("llm", 612, 258, 168, 92, "LLM Reasoning\nOpenAI function\ncalling (streamed)", { fill: C.blueFill, stroke: C.blue, size: 13 });
const guard = node("guard", 800, 258, 168, 92, "Deterministic\nGuardrail Gate\npre-exec rules", { fill: C.goldFill, stroke: C.gold, size: 13, color: C.text });
const telem = node("telem", 612, 372, 356, 58, "Telemetry Bus  →  SSE events", { fill: C.greyFill, stroke: C.grey, size: 13 });
text({ id: "core-note", x: 624, y: 448, w: 334, str: "READ tools → auto-execute.\nWRITE tools → guardrail gate + two-turn\nconfirmation (lock set AND released in code).", size: 12, color: C.dim, align: "left", font: 2 });

// ── Tools ────────────────────────────────────────────────────
text({ id: "lbl-tools", x: 1050, y: 120, w: 320, str: "TOOLS (two-tier)", size: 12, color: C.cyan, align: "left", font: 2 });
const readT = node("read", 1050, 145, 330, 100, "READ · auto-exec\nget_supporter_context\nsearch_stadium_policy (RAG)\nget_match_status · search_available_matches", { fill: C.greenFill, stroke: C.green, size: 12, font: 3 });
const writeT = node("write", 1050, 258, 330, 110, "WRITE · guardrail-gated + confirm\ntransfer_match_ticket · book_match_ticket\nupgrade_ticket_to_hospitality\nmanage_subscription_retention · escalate", { fill: C.redFill, stroke: C.red, size: 12, font: 3 });

// ── Backing services ─────────────────────────────────────────
text({ id: "lbl-back", x: 1050, y: 392, w: 320, str: "BACKING SERVICES (mocked)", size: 12, color: C.cyan, align: "left", font: 2 });
const db = node("db", 1050, 416, 330, 50, "Mock Postgres + Ticket Ledger", { fill: C.greyFill, stroke: C.grey, size: 13 });
const rag = node("rag", 1050, 476, 330, 55, "Hybrid RAG (BM25 + vector)\nUEFA policy corpus", { fill: C.greyFill, stroke: C.grey, size: 12 });
const esc = node("esc", 1050, 541, 330, 48, "Human Escalation Queue", { fill: C.greyFill, stroke: C.grey, size: 13 });

// ── Arrows: data flow ────────────────────────────────────────
arrow("a-con-gw", console_, "r", gw, "l", { both: true });
caption("c-con-gw", 285, 170, "SSE: tokens\n+ telemetry");
arrow("a-voice-gw", voice, "r", gw, "l");
caption("c-voice-gw", 285, 300, "WebRTC +\n/voice/tool");
arrow("a-gw-orch", gw, "r", orch, "l", { both: true });
caption("c-gw-orch", 540, 190, "turn");
arrow("a-orch-llm", orch, "b", llm, "t", { both: true });
arrow("a-orch-guard", orch, "b", guard, "t");
caption("c-orch-guard", 858, 240, "WRITE");
arrow("a-telem-gw", telem, "l", gw, "r", { dashed: true, color: C.green });

arrow("a-read-tools", orch, "r", readT, "l");
caption("c-read", 996, 150, "READ");
arrow("a-guard-write", guard, "r", writeT, "l");
caption("c-guard-write", 980, 300, "allowed");
arrow("a-read-rag", readT, "b", rag, "t", { dashed: true });
arrow("a-write-db", writeT, "b", db, "t", { dashed: true });
arrow("a-write-esc", writeT, "r", esc, "r", { dashed: true });
// voice shares the same guardrail gate
arrow("a-voice-guard", voice, "b", guard, "l", { dashed: true, color: C.cyan });
caption("c-voice-guard", 300, 360, "same tools + guardrails", C.cyan, 11);

// ── State machine strip ──────────────────────────────────────
text({ id: "lbl-sm", x: 40, y: 630, w: 600, str: "CONVERSATION STATE MACHINE", size: 13, color: C.cyan, align: "left", font: 2 });
const sA = node("sA", 40, 660, 180, 54, "AUTHENTICATING", { fill: C.greyFill, stroke: C.grey, size: 13 });
const sT = node("sT", 270, 660, 180, 54, "TRIAGE_READY", { fill: C.blueFill, stroke: C.blue, size: 13 });
const sC = node("sC", 500, 660, 220, 54, "AWAITING_CONFIRMATION", { fill: C.goldFill, stroke: C.gold, size: 13 });
const sE = node("sE", 770, 660, 200, 54, "EXECUTING_MUTATION", { fill: C.blueFill, stroke: C.blue, size: 13 });
const sP = node("sP", 500, 740, 220, 50, "ESCALATION_PREP", { fill: C.redFill, stroke: C.red, size: 13 });
const sH = node("sH", 770, 740, 200, 50, "HUMAN_HANDOFF", { fill: C.redFill, stroke: C.red, size: 13 });
arrow("sm1", sA, "r", sT, "l");
caption("csm1", 222, 648, "verify ✓", C.dim, 10);
arrow("sm2", sT, "r", sC, "l");
caption("csm2", 452, 648, "propose WRITE", C.dim, 10);
arrow("sm3", sC, "r", sE, "l");
caption("csm3", 722, 648, "\"yes\"", C.dim, 10);
arrow("sm4", sE, "t", sT, "b", { dashed: true });
arrow("sm5", sT, "b", sP, "t", { dashed: true, color: C.red });
arrow("sm6", sP, "r", sH, "l", { color: C.red });

// ── ADLC / CI ────────────────────────────────────────────────
const adlc = node("adlc", 1050, 640, 330, 150, "ADLC  —  own it end-to-end\n\n• 35-case eval suite (τ-bench style)\n• 12 offline guardrail unit tests\n• CI gate: safety = 100%,\n  task completion ≥ 80%\n• live FDE trace + report.md scorecard", { fill: C.cyanFill, stroke: C.cyan, size: 12 });
void adlc;

// ── Legend ───────────────────────────────────────────────────
text({ id: "legend", x: 40, y: 815, w: 1340, str: "Legend:  solid = request / tool call     dashed = async result, telemetry or shared path     gold = deterministic guardrail (never bypassed by the model)", size: 12, color: C.dim, align: "left", font: 2 });

// ── Emit ─────────────────────────────────────────────────────
const doc = {
  type: "excalidraw",
  version: 2,
  source: "ucl-matchday-concierge/scripts/gen-architecture.mjs",
  elements: els,
  appState: { gridSize: null, viewBackgroundColor: C.bg },
  files: {},
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log(`wrote ${OUT} — ${els.length} elements`);
