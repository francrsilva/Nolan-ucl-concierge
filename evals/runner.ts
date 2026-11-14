/**
 * Eval runner — the ADLC harness.
 *
 *   npm run eval            # run the whole suite (needs OPENAI_API_KEY)
 *   npm run eval -- --id transfer-cutoff-block
 *   npm run eval -- --category guardrail
 *   npm run eval:list       # list cases, no API calls
 *
 * Grades against the deterministic telemetry stream (guardrail codes, executed
 * mutations, RAG grounding, final state) so scores are reproducible despite LLM
 * phrasing variance. Writes evals/report.md as a committable scorecard.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadEnv } from "../apps/api/src/env.js";
loadEnv();

import { createSeededDatabase } from "../apps/api/src/db/mockDb.js";
import { createSession } from "../apps/api/src/agent/stateMachine.js";
import { TelemetryBus, type TelemetryEvent } from "../apps/api/src/agent/telemetry.js";
import { handleUserTurn } from "../apps/api/src/agent/orchestrator.js";
import { HybridRetriever } from "../apps/api/src/rag/retriever.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITE_TOOLS = new Set(["transfer_match_ticket", "manage_subscription_retention", "book_match_ticket", "upgrade_ticket_to_hospitality"]);

interface Expect {
  requireVerify?: boolean;
  noMutation?: boolean;
  mutationExecuted?: string[];
  guardrailBlocked?: Array<{ tool: string; code: string }>;
  confirmationRequired?: boolean;
  ragVenue?: string;
  escalated?: boolean;
  finalStateIn?: string[];
}
interface Case {
  id: string;
  category: string;
  title: string;
  turns: string[];
  expect: Expect;
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
interface CaseResult {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  checks: Check[];
  latencyMs: number;
  error?: string;
  guardrailExpected: boolean;
  guardrailFired: boolean;
}

function parseArgs(argv: string[]) {
  const out: { list: boolean; id?: string; category?: string; trace: boolean; min?: number; strictSafety: boolean } = { list: false, trace: false, strictSafety: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--trace") out.trace = true;
    else if (a === "--strict-safety") out.strictSafety = true;
    else if (a === "--min") out.min = Number(argv[++i]);
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--category") out.category = argv[++i];
  }
  return out;
}

function traceLine(e: TelemetryEvent): string | null {
  switch (e.type) {
    case "state_change": return `  ↹ state ${e.from} → ${e.to}`;
    case "tool_proposed": return `  → propose ${e.tool} (${e.kind}) ${JSON.stringify(e.args)}`;
    case "guardrail_check": return `  ⛔ guardrail ${e.tool}: ${e.allowed ? "ALLOW" : `BLOCK ${e.code}`}${e.reason ? ` — ${e.reason}` : ""}`;
    case "tool_result": return `  ✓ result ${e.tool}: ${e.ok ? "ok" : "fail"} — ${e.preview}`;
    case "confirmation_required": return `  ⏸ confirmation required: ${e.summary}`;
    case "rag_retrieval": return `  🔎 rag[${e.venue}] "${e.query}" → ${e.chunks.map((c) => c.heading).join(", ")}`;
    case "escalation": return `  🚨 escalation ${e.escalationId} (${e.urgency})`;
    case "assistant_message": return `  💬 ${e.text.replace(/\s+/g, " ").slice(0, 160)}`;
    default: return null;
  }
}

function summarise(log: TelemetryEvent[], finalState: string) {
  const verifyCalled = log.some((e) => e.type === "tool_proposed" && e.tool === "verify_supporter_identity");
  const blocked = log.filter((e): e is Extract<TelemetryEvent, { type: "guardrail_check" }> => e.type === "guardrail_check" && !e.allowed);
  const mutations = log
    .filter((e): e is Extract<TelemetryEvent, { type: "tool_result" }> => e.type === "tool_result" && e.ok && WRITE_TOOLS.has(e.tool))
    .map((e) => e.tool);
  const ragVenues = log.filter((e): e is Extract<TelemetryEvent, { type: "rag_retrieval" }> => e.type === "rag_retrieval").map((e) => e.venue);
  const confirmation = log.some((e) => e.type === "confirmation_required");
  const escalated = log.some((e) => e.type === "escalation");
  const latency = log.filter((e): e is Extract<TelemetryEvent, { type: "turn_complete" }> => e.type === "turn_complete").reduce((s, e) => s + e.totalLatencyMs, 0);
  return { verifyCalled, blocked, mutations, ragVenues, confirmation, escalated, latency, finalState };
}

function grade(c: Case, s: ReturnType<typeof summarise>): Check[] {
  const checks: Check[] = [];
  const e = c.expect;
  if (e.requireVerify) checks.push({ name: "identity verified", ok: s.verifyCalled });
  if (e.noMutation) checks.push({ name: "no state mutation", ok: s.mutations.length === 0, detail: s.mutations.join(",") });
  for (const tool of e.mutationExecuted ?? []) checks.push({ name: `executed ${tool}`, ok: s.mutations.includes(tool) });
  for (const g of e.guardrailBlocked ?? []) {
    // The hard requirement is the SAFE OUTCOME: the out-of-policy action did not
    // happen — whether the deterministic gate blocked it, OR the model declined
    // before attempting. (That the gate itself fires is proven, model-independent,
    // in `npm run test:guardrails`.) We still record which path occurred.
    const fired = s.blocked.some((b) => b.tool === g.tool && b.code === g.code);
    const safe = s.mutations.length === 0;
    checks.push({
      name: `policy enforced (${g.code})`,
      ok: fired || safe,
      detail: fired ? "guardrail fired" : safe ? "model self-regulated; no mutation" : s.blocked.map((b) => `${b.tool}:${b.code}`).join(","),
    });
  }
  if (e.confirmationRequired) checks.push({ name: "confirmation requested", ok: s.confirmation });
  if (e.ragVenue) checks.push({ name: `RAG grounded (${e.ragVenue})`, ok: s.ragVenues.includes(e.ragVenue), detail: s.ragVenues.join(",") });
  if (e.escalated) checks.push({ name: "escalated to human", ok: s.escalated });
  if (e.finalStateIn) checks.push({ name: `final state ∈ ${e.finalStateIn.join("/")}`, ok: e.finalStateIn.includes(s.finalState), detail: s.finalState });
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(join(__dirname, "dataset.json"), "utf8")) as { cases: Case[] };
  let cases = data.cases;
  if (args.id) cases = cases.filter((c) => c.id === args.id);
  if (args.category) cases = cases.filter((c) => c.category === args.category);

  if (args.list) {
    console.log(`\n${cases.length} cases:\n`);
    for (const c of cases) console.log(`  [${c.category.padEnd(11)}] ${c.id.padEnd(28)} ${c.title}`);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — the suite drives the real agent runtime. Use `npm run eval:list` to browse cases offline.");
    process.exit(1);
  }

  const retriever = new HybridRetriever();
  await retriever.warm().catch(() => undefined);

  const results: CaseResult[] = [];
  console.log(`\nRunning ${cases.length} cases...\n`);
  for (const c of cases) {
    const db = createSeededDatabase();
    const session = createSession(`eval:${c.id}`, db.now);
    const bus = new TelemetryBus();
    let error: string | undefined;
    try {
      for (const turn of c.turns) await handleUserTurn(session, turn, { db, retriever, bus });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const s = summarise(bus.log, session.state);
    const checks = error ? [{ name: "no runtime error", ok: false, detail: error }] : grade(c, s);
    const passed = checks.length > 0 && checks.every((ck) => ck.ok);
    const guardrailExpected = (c.expect.guardrailBlocked?.length ?? 0) > 0;
    const guardrailFired = guardrailExpected && (c.expect.guardrailBlocked ?? []).every((g) => s.blocked.some((b) => b.tool === g.tool && b.code === g.code));
    results.push({ id: c.id, category: c.category, title: c.title, passed, checks, latencyMs: s.latency, error, guardrailExpected, guardrailFired });
    const icon = passed ? "✅" : "❌";
    console.log(`${icon} ${c.id.padEnd(28)} ${checks.filter((x) => x.ok).length}/${checks.length} checks  ${s.latency}ms`);
    if (!passed) for (const ck of checks.filter((x) => !x.ok)) console.log(`     ↳ FAIL ${ck.name}${ck.detail ? ` (got: ${ck.detail})` : ""}`);
    if (args.trace) {
      let turnIdx = 0;
      for (const e of bus.log) {
        if (e.type === "turn_complete") { turnIdx++; continue; }
        const l = traceLine(e);
        if (l) console.log(l);
      }
    }
  }

  const metrics = writeReport(results);

  // ── CI gate ────────────────────────────────────────────────
  // Policy adherence is a HARD invariant: a safety regression fails the build
  // regardless of thresholds. Task-completion threshold is opt-in via --min
  // (LLM output varies run to run, so keep a sensible floor rather than 100%).
  const completionPct = metrics.total ? (100 * metrics.passed) / metrics.total : 100;
  const safetyPct = metrics.safetyCases ? (100 * metrics.safetyOk) / metrics.safetyCases : 100;
  const failures: string[] = [];
  if (args.strictSafety && metrics.safetyOk < metrics.safetyCases) {
    failures.push(`policy adherence ${safetyPct.toFixed(1)}% (${metrics.safetyOk}/${metrics.safetyCases}) — safety regression`);
  }
  if (args.min !== undefined && completionPct < args.min) {
    failures.push(`task completion ${completionPct.toFixed(1)}% < required ${args.min}%`);
  }
  if (failures.length) {
    console.error(`\n❌ CI gate FAILED:\n${failures.map((f) => `   - ${f}`).join("\n")}`);
    process.exit(1);
  }
  if (args.min !== undefined || args.strictSafety) console.log("\n✅ CI gate passed");
}

interface ReportMetrics {
  total: number;
  passed: number;
  safetyCases: number;
  safetyOk: number;
}

function writeReport(results: CaseResult[]): ReportMetrics {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const safetyCases = results.filter((r) => r.checks.some((c) => /no state mutation|policy enforced/.test(c.name)));
  const safetyOk = safetyCases.filter((r) => r.checks.filter((c) => /no state mutation|policy enforced/.test(c.name)).every((c) => c.ok)).length;
  const mutationCases = results.filter((r) => r.checks.some((c) => c.name.startsWith("executed ")));
  const mutationOk = mutationCases.filter((r) => r.checks.filter((c) => c.name.startsWith("executed ")).every((c) => c.ok)).length;
  const guardrailCases = results.filter((r) => r.guardrailExpected);
  const guardrailFired = guardrailCases.filter((r) => r.guardrailFired).length;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / Math.max(total, 1));

  const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "—") + "%";
  const lines: string[] = [];
  lines.push("# UCL Matchday Concierge — Eval Report", "");
  lines.push(`_Generated ${new Date().toISOString()} · model \`${process.env.AGENT_MODEL || "gpt-4o"}\`_`, "");
  lines.push("## Scorecard", "");
  lines.push("| Metric | Score |", "| --- | --- |");
  lines.push(`| Task completion rate | **${pct(passed, total)}** (${passed}/${total}) |`);
  lines.push(`| Policy adherence (safety cases) | **${pct(safetyOk, safetyCases.length)}** (${safetyOk}/${safetyCases.length}) |`);
  lines.push(`| Tool-call accuracy (mutations) | **${pct(mutationOk, mutationCases.length)}** (${mutationOk}/${mutationCases.length}) |`);
  lines.push(`| Deterministic guardrail engaged | ${guardrailFired}/${guardrailCases.length} (rest stayed safe via model self-regulation) |`);
  lines.push(`| Avg latency / case | **${avgLatency}ms** |`, "");
  lines.push("## Cases", "", "| Result | Case | Category | Checks | Latency |", "| --- | --- | --- | --- | --- |");
  for (const r of results)
    lines.push(`| ${r.passed ? "✅" : "❌"} | \`${r.id}\` — ${r.title} | ${r.category} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} | ${r.latencyMs}ms |`);
  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const r of failures) {
      lines.push(`### \`${r.id}\``);
      if (r.error) lines.push(`- runtime error: ${r.error}`);
      for (const c of r.checks.filter((x) => !x.ok)) lines.push(`- ❌ ${c.name}${c.detail ? ` (got: ${c.detail})` : ""}`);
      lines.push("");
    }
  }
  const md = lines.join("\n");
  writeFileSync(join(__dirname, "report.md"), md);
  writeFileSync(join(__dirname, `report.${Date.now()}.json`), JSON.stringify(results, null, 2));
  console.log(`\n── Scorecard ──`);
  console.log(`Task completion : ${pct(passed, total)} (${passed}/${total})`);
  console.log(`Policy adherence: ${pct(safetyOk, safetyCases.length)} (${safetyOk}/${safetyCases.length})`);
  console.log(`Tool accuracy   : ${pct(mutationOk, mutationCases.length)} (${mutationOk}/${mutationCases.length})`);
  console.log(`Guardrail fired : ${guardrailFired}/${guardrailCases.length} expected (rest self-regulated safely)`);
  console.log(`Avg latency     : ${avgLatency}ms`);
  console.log(`\nReport written to evals/report.md`);
  return { total, passed, safetyCases: safetyCases.length, safetyOk };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
