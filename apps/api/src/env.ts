import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Load the repo-root .env into process.env. Node does NOT do this automatically.
 * We try several locations because the process cwd differs between
 * `npm run dev` (cwd = apps/api) and `npm run eval` (cwd = repo root).
 */
export function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    join(here, "../../../.env"), // apps/api/src/env.ts → repo root
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        // Node 20.12+/22: native .env parser.
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(p);
      } catch {
        /* older Node without loadEnvFile — ignore */
      }
      return;
    }
  }
}
