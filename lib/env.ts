import path from "node:path";

/**
 * Server-only configuration. Every value has a working default so a fresh
 * clone boots without an .env; override in .env.local.
 *
 * IMPORTANT: this module must never build paths to model files. Turbopack
 * constant-folds `path.join()` of string literals, registers the result as a
 * traced asset, and then tries to hash multi-gigabyte .gguf files during
 * `next build` (fails with os error 1450). The app talks to llama-server over
 * HTTP only; the scripts own the model paths.
 *
 * NOTE: uses `node:path` — do not import from a client component.
 */

const root = process.cwd();

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const dataDir = str(process.env.DATA_DIR, path.join(root, "data"));

export const env = {
  root,
  dataDir,
  dbPath: path.join(dataDir, "app.db"),
  uploadDir: path.join(dataDir, "uploads"),

  coordinator: {
    url: str(process.env.COORDINATOR_URL, "http://127.0.0.1:8081"),
    /** Display label only — never a filesystem path. */
    label: str(process.env.COORDINATOR_LABEL, "qwen3.5-4b"),
  },

  vision: {
    url: str(process.env.VISION_URL, "http://127.0.0.1:8082"),
    label: str(process.env.VISION_LABEL, "qwen2.5-omni-7b"),
  },

  /** Request budget for local models. GPU contention is real; fail fast. */
  timeouts: {
    chatMs: num(process.env.LLM_CHAT_TIMEOUT_MS, 120_000),
    visionMs: num(process.env.LLM_VISION_TIMEOUT_MS, 240_000),
    healthMs: num(process.env.LLM_HEALTH_TIMEOUT_MS, 3_000),
    sourceMs: num(process.env.SOURCE_TIMEOUT_MS, 15_000),
  },

  scoring: {
    /** Weight applied to a keyword hit inside the job title. */
    titleMultiplier: num(process.env.SCORE_TITLE_MULTIPLIER, 3),
    /** Days after which the recency contribution halves. */
    recencyHalfLifeDays: num(process.env.SCORE_RECENCY_HALF_LIFE, 7),
  },
} as const;

export type Env = typeof env;
