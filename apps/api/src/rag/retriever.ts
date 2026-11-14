/**
 * Hybrid retriever over the UEFA policy corpus.
 *
 * - Keyword leg: BM25 over heading-aware chunks (pure TS, zero network).
 * - Vector leg: OpenAI embeddings cosine similarity, fused with BM25 via
 *   reciprocal-rank fusion (RRF). If no EMBEDDING_MODEL / API key is configured,
 *   it degrades gracefully to keyword-only so evals and offline dev still run.
 *
 * Grounded, policy-faithful answers with zero hallucination on strict rules are
 * exactly what the "search_stadium_and_ticket_policy" tool is for.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");
const CACHE_FILE = join(__dirname, "..", "..", ".rag-embeddings-cache.json");

export interface Chunk {
  docId: string;
  venue: string; // venue code this doc applies to, or GENERAL
  heading: string;
  text: string;
  tokens: string[];
}

export interface Retrieved {
  docId: string;
  heading: string;
  text: string;
  score: number;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Load + chunk the markdown corpus by `##` headings. */
function loadCorpus(): Chunk[] {
  if (!existsSync(CORPUS_DIR)) return [];
  const chunks: Chunk[] = [];
  for (const file of readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md"))) {
    const raw = readFileSync(join(CORPUS_DIR, file), "utf8");
    const venue = (raw.match(/^venue:\s*(\w+)/m)?.[1] ?? "GENERAL").toUpperCase();
    const sections = raw.split(/^##\s+/m).slice(1);
    for (const sec of sections) {
      const nl = sec.indexOf("\n");
      const heading = sec.slice(0, nl).trim();
      const body = sec.slice(nl + 1).trim();
      if (!body) continue;
      const text = `${heading}\n${body}`;
      chunks.push({ docId: file.replace(/\.md$/, ""), venue, heading, text, tokens: tokenize(text) });
    }
  }
  return chunks;
}

function bm25(chunks: Chunk[], queryTokens: string[], k = 1.5, b = 0.75): Map<number, number> {
  const N = chunks.length;
  const avgdl = chunks.reduce((s, c) => s + c.tokens.length, 0) / Math.max(N, 1);
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const scores = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const c = chunks[i]!;
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const qt of queryTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k + 1)) / (f + k * (1 - b + (b * c.tokens.length) / avgdl)));
    }
    if (score > 0) scores.set(i, score);
  }
  return scores;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export class HybridRetriever {
  private chunks: Chunk[];
  private embeddings: number[][] | null = null;
  private client: OpenAI | null;
  private embedModel = process.env.EMBEDDING_MODEL?.trim() || "";

  constructor() {
    this.chunks = loadCorpus();
    this.client = process.env.OPENAI_API_KEY ? new OpenAI() : null;
  }

  get ready(): boolean {
    return this.chunks.length > 0;
  }

  /** Pre-compute (and disk-cache) corpus embeddings for the vector leg. */
  async warm(): Promise<void> {
    if (!this.client || !this.embedModel || this.chunks.length === 0) return;
    const key = `${this.embedModel}:${this.chunks.length}`;
    if (existsSync(CACHE_FILE)) {
      try {
        const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
        if (cache.key === key) {
          this.embeddings = cache.vectors;
          return;
        }
      } catch { /* rebuild on parse failure */ }
    }
    const res = await this.client.embeddings.create({ model: this.embedModel, input: this.chunks.map((c) => c.text) });
    this.embeddings = res.data.map((d) => d.embedding as number[]);
    try {
      writeFileSync(CACHE_FILE, JSON.stringify({ key, vectors: this.embeddings }));
    } catch { /* cache is best-effort */ }
  }

  async search(query: string, venue: string, topK = 3): Promise<Retrieved[]> {
    const pool = this.chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => venue === "GENERAL" || c.venue === venue || c.venue === "GENERAL");
    if (pool.length === 0) return [];

    const localChunks = pool.map((p) => p.c);
    const bm = bm25(localChunks, tokenize(query));
    const bmRank = [...bm.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);

    let vecRank: number[] = [];
    if (this.embeddings && this.client && this.embedModel) {
      try {
        const q = await this.client.embeddings.create({ model: this.embedModel, input: query });
        const qv = q.data[0]!.embedding as number[];
        const sims = localChunks.map((_, li) => ({ li, s: cosine(qv, this.embeddings![pool[li]!.i]!) }));
        vecRank = sims.sort((a, b) => b.s - a.s).map((x) => x.li);
      } catch { /* vector leg optional */ }
    }

    // Reciprocal-rank fusion.
    const rrf = new Map<number, number>();
    const add = (ranks: number[]) => ranks.forEach((li, r) => rrf.set(li, (rrf.get(li) ?? 0) + 1 / (60 + r)));
    add(bmRank);
    if (vecRank.length) add(vecRank);

    return [...rrf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([li, score]) => {
        const c = localChunks[li]!;
        return { docId: c.docId, heading: c.heading, text: c.text, score: Number(score.toFixed(4)) };
      });
  }
}
