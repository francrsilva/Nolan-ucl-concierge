# ⚽ UEFA Champions League — Matchday Concierge Agent

A production-shaped, **guardrailed enterprise agent** that resolves high-stakes matchday problems for UEFA Champions League supporters — ticket booking, transfers, hospitality upgrades, subscription retention, live gate issues — the way a forward-deployed agent engineer would ship it: **probabilistic LLM reasoning fenced in by deterministic code**, owned end-to-end with an eval harness.

> This is a portfolio build for Sierra's *Software Engineer, Agent* role. It deliberately avoids being a "RAG chatbot over match stats" and instead mirrors what Sierra sells: customer-obsessed agents that **safely mutate backend state** under strict policy, with a real Agent Development Life Cycle (ADLC).

---

## The business problem (and the KPIs it targets)

Matchday support is a flood of **transactional, time-critical, policy-bound** requests: "transfer my VIP pass, my flight was cancelled", "cancel my pass, my club got knocked out", "my ticket won't scan at Gate C". Each one can read and **mutate money-and-access state**, so getting it wrong is expensive and irreversible.

| KPI | How this agent moves it |
| --- | --- |
| Deflect matchday support volume | Autonomously resolves transfers, retention and policy Q&A end-to-end |
| **100% policy compliance** on mutations | Every write passes a deterministic guardrail gate — the LLM cannot bypass it |
| Churn saved at risk-of-cancel moments | Empathetic, eligibility-gated retention offers (pause / loyalty discount) |
| Mean-time-to-resolution at the gate | Grounded venue answers + crisp human escalation packet when blocked |

---

## Architecture: defense-in-depth agent runtime

> 📐 Full editable diagram: [`docs/architecture.excalidraw`](docs/architecture.excalidraw) — open at [excalidraw.com](https://excalidraw.com) (File → Open, or drag it in) or with the VS Code *Excalidraw* extension. Regenerate with `npm run diagram`.

Intent & empathy (the LLM) are separated from policy & state mutation (deterministic state machine + guardrail interceptor). The LLM proposes; **code disposes**.

```
[ React + TS Client ]  <──(SSE: tokens + telemetry)──>  [ Hono API Gateway ]
                                                                │
                                                                ▼
                                                 ┌──────────────────────────┐
                                                 │  Conversation Orchestrator│
                                                 │  (explicit state machine) │
                                                 └───────┬───────────┬───────┘
                        Policy & Context Loader ─────────┘           └───────── Deterministic Guardrail Gate
                        • supporter profile + club affinity                      • pre-execution rule checks (live DB)
                        • hybrid RAG (UEFA rules / FAQs)                          • two-turn confirmation lock
                                                                                  • ownership / RBAC / idempotency
                                                                │
                                                                ▼
                                                 ┌──────────────────────────┐
                                                 │  LLM Reasoning (OpenAI)   │──(proposed tool call)──> [ Tool Router ]
                                                 │  streaming function calls │ <──(result / structured ── │
                                                 └──────────────────────────┘        guardrail error)    ├─> Mock Postgres / ticket ledger
                                                                                                          ├─> Hybrid RAG retriever
                                                                                                          └─> Human escalation queue
```

### Core pillars
1. **Two-tier tool classification.** `READ`/`AUTH` tools auto-execute (zero side effects). `WRITE` tools are **guardrail-gated** and require explicit confirmation.
2. **Deterministic interceptor.** Before any `WRITE`, plain TypeScript validates business rules against **live DB state** — never trusting the model to do date math or verify eligibility. ([`guardrails.ts`](apps/api/src/guardrails/guardrails.ts))
3. **Structured telemetry stream.** Every state transition, RAG hit, guardrail verdict and tool latency is emitted as a typed event over SSE — this is what the React "FDE Inspector" renders, and what the eval runner grades.
4. **One core, two transports.** Text (SSE) and voice (OpenAI Realtime) share the *same* tool registry and guardrail gate. A voice write passes the identical checks as a typed one.

---

## The trust model (why this is the interesting part)

The state machine only ever exposes the tools legal in the current state:

```
AUTHENTICATING ──verify_supporter_identity()──> TRIAGE_READY
   TRIAGE_READY ──propose WRITE──> AWAITING_CONFIRMATION ──"yes"──> EXECUTING_MUTATION ──> TRIAGE_READY
   TRIAGE_READY ──guardrail blocks──> ESCALATION_PREP ──> HUMAN_HANDOFF
```

Deterministic rules enforced in code (not the prompt):

- **Ticket transfer window lock** — blocked unless `kickoff − now ≥ 3h`, ticket is `ACTIVE`, owned by the verified supporter, and `transferCount < 1` (anti-scalping).
- **Two-turn confirmation lock** — a mutating tool can never execute on the turn it is first proposed; the gate stores a `pendingAction` hash and forces the agent to read back the exact impact and get an explicit "yes" on a *later* user turn. Fake "I already confirmed" claims don't pass.
- **Retention eligibility** — pause/discount offers require `favouriteClub.isEliminated && tenureMonths ≥ 2 && !usedRetentionThisSeason`; a user's insisted **cancel is always honoured** (never forced into retention).
- **Auth gate** — no gated tool runs until identity is verified.

A blocked call returns a **structured error** back to the model so it explains the rule and offers a legitimate alternative — defense-in-depth, not a dead end.

---

## Tool catalogue

| Tool | Kind | Guardrails |
| --- | --- | --- |
| `verify_supporter_identity` | AUTH | — (unlocks triage) |
| `get_supporter_context` | READ | auto-exec |
| `search_stadium_and_ticket_policy` | READ | hybrid RAG, auto-exec |
| `get_match_status` | READ | auto-exec |
| `search_available_matches` | READ | live availability + pricing, auto-exec |
| `transfer_match_ticket` | WRITE | ownership · 3h cutoff · anti-scalping · 2-turn confirm |
| `book_match_ticket` | WRITE | availability · no double-booking · booking cutoff · 2-turn confirm |
| `upgrade_ticket_to_hospitality` | WRITE | ownership · active · not-already-VIP · inventory · 3h cutoff · 2-turn confirm |
| `manage_subscription_retention` | WRITE | ownership · eligibility · 2-turn confirm |
| `escalate_to_stadium_ops` | WRITE | schema-validated handoff (confirmation-exempt escape hatch) |

Schemas are defined once in Zod ([`schemas.ts`](apps/api/src/tools/schemas.ts)) and projected to the JSON Schema advertised to the model.

---

## Eval suite (ADLC ownership)

35 τ-bench-style cases spanning auth, transfers, booking, hospitality upgrades, retention, RAG grounding, escalation, and **adversarial prompt injection** (free-final-tickets, "ignore the cutoff", fake pre-confirmation, cross-user data access). Grading targets the **deterministic telemetry** (guardrail codes, executed mutations, RAG venue, final state) so scores are reproducible despite phrasing variance.

```bash
npm run eval:list                 # browse cases (no API calls)
npm run test:guardrails           # offline unit proof of the trust layer (no LLM)
npm run eval                      # full suite → writes evals/report.md
npm run eval -- --category adversarial
npm run eval -- --id transfer-cutoff-block
```

`evals/report.md` is a committed scorecard: **task completion · policy adherence · tool-call accuracy · latency**.

### Continuous integration (ADLC gate)

`.github/workflows/ci.yml` runs on every push/PR:

- **`verify`** (always, no secrets, deterministic): `npm run typecheck` · `npm run build` · `npm run test:guardrails` (12 offline guardrail assertions) · dataset parse. This is the hard gate — it needs no API key and can't flake on model output. Run it locally with `npm run verify`.
- **`evals`** (only when an `OPENAI_API_KEY` repo secret is set): `npm run eval:ci` runs the full live suite and **fails the build on a safety regression** (`--strict-safety`, policy adherence must stay 100%) **or if task completion drops below 80%** (`--min 80`), then uploads `report.md` as an artifact. Skips cleanly on forks/PRs without the secret.

---

## Run it

```bash
cp .env.example .env     # add your OPENAI_API_KEY
npm install
npm run test:guardrails  # ✅ proves guardrails with zero network / no key
npm run dev:all          # API on :8787  +  FDE console UI on :5173
```

Open **http://localhost:5173** for the **FDE Inspector console**: a React + TS chat UI with a live execution-trace drawer (every tool call, guardrail verdict, RAG hit, state transition and latency, streamed over SSE) and one-click scenario presets a reviewer can run in ~15 seconds. Prefer headless? Run just the API with `npm run dev` and talk to it over SSE:

```bash
curl -N http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Hi, I am UEFA-88412, PIN 4417. Transfer ticket TKT-90210 to my brother, my flight got cancelled."}'
# → watch the guardrail block the <3h transfer and offer box-office escalation
```

Voice (OpenAI Realtime, GA): click **🎙 Voice** in the console and talk — the browser opens a WebRTC connection via `POST /voice/session` (ephemeral token minted at `/v1/realtime/client_secrets`), and the voice model's tool calls are proxied to `POST /voice/tool`, which runs the **same guardrail gate** as text. Live transcripts flow into the chat and tool telemetry into the Inspector.

### Demo personas (seeded)
- **Alex Rivera** — `UEFA-88412` / PIN `4417`. Platinum; Arsenal (eliminated → retention-eligible). Owns `TKT-90210` (semi-final, <3h away → cutoff fires) and `TKT-90211` (future → transferable).
- **Jordan Kim** — `UEFA-20099` / PIN `9921`. New subscriber (retention ineligible). Owns `TKT-77001` (already transferred once → anti-scalping fires).

---

## Repository layout

```
apps/api/src/
  agent/        orchestrator · state machine · prompts · telemetry · llm
  tools/        schemas (Zod) · handlers · registry (READ/WRITE classification)
  guardrails/   deterministic pre-execution gate
  db/           in-memory Postgres + ticket ledger mock (per-session isolation)
  rag/          hybrid BM25 + vector retriever · UEFA policy corpus
  voice/        OpenAI Realtime bridge (shares tools + guardrails)
apps/web/src/
  App.tsx       layout, session + scenario orchestration
  components/   Chat · Inspector (live FDE trace)
  lib/          SSE-over-fetch client · scenario presets
evals/          dataset.json (35 cases) · runner.ts (--trace) · guardrails.smoke.ts (12 offline) · report.md
docs/           architecture.excalidraw (editable diagram)
scripts/        gen-architecture.mjs (regenerates the diagram)
.github/        workflows/ci.yml (ADLC gate)
```

## Roadmap
- **M1:** headless agent runtime, guardrails, hybrid RAG, voice bridge, eval harness. ✅
- **M2:** React + TS **FDE Inspector** console — live tool-call / guardrail / latency trace over SSE, one-click scenario presets. ✅
- **M3:** **Voice mode** — in-browser WebRTC to the OpenAI Realtime API (GA); the voice model shares the exact same tool catalogue and deterministic guardrail gate as text, with tool calls proxied through `POST /voice/tool`. ✅ Click **🎙 Voice** in the console and speak.
- **CI / ADLC gate:** GitHub Actions — deterministic offline gate on every push, plus an optional live-eval job that fails the build on a safety regression or eval-score drop. ✅ (`.github/workflows/ci.yml`)

## Tech
TypeScript · Hono · OpenAI (function calling + Realtime) · Zod · hybrid BM25 + embeddings RAG · SSE.
