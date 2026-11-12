import type { DatabaseSync } from "node:sqlite";
import { getDb, nowMs } from "./index";

/**
 * Per-source fetch bookkeeping. Doubles as the rate-limit guard: Remotive
 * documents a ~4 requests/day cap and delivers data 24 h late, so refetching on
 * page load would both trip the limit and burn nothing of value.
 */

export interface SourceRun {
  source: string;
  lastOkAt: number | null;
  lastError: string | null;
  cursor: string | null;
  jobCount: number;
}

interface RawSourceRow {
  source: string;
  last_ok_at: number | null;
  last_error: string | null;
  cursor: string | null;
  job_count: number;
}

export function getSourceRun(source: string, db: DatabaseSync = getDb()): SourceRun | null {
  const row = db.prepare("SELECT * FROM source_runs WHERE source = ?").get(source) as
    | RawSourceRow
    | undefined;
  if (!row) return null;
  return {
    source: row.source,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    cursor: row.cursor,
    jobCount: Number(row.job_count),
  };
}

export function listSourceRuns(db: DatabaseSync = getDb()): SourceRun[] {
  const rows = db.prepare("SELECT * FROM source_runs ORDER BY source").all() as unknown as RawSourceRow[];
  return rows.map((row) => ({
    source: row.source,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    cursor: row.cursor,
    jobCount: Number(row.job_count),
  }));
}

export function recordSourceSuccess(
  source: string,
  data: { jobCount: number; cursor?: string | null },
  db: DatabaseSync = getDb(),
): void {
  db.prepare(
    `INSERT INTO source_runs (source, last_ok_at, last_error, cursor, job_count)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (source) DO UPDATE SET
       last_ok_at = excluded.last_ok_at,
       last_error = NULL,
       cursor = COALESCE(excluded.cursor, source_runs.cursor),
       job_count = excluded.job_count`,
  ).run(source, nowMs(), data.cursor ?? null, data.jobCount);
}

export function recordSourceFailure(
  source: string,
  error: unknown,
  db: DatabaseSync = getDb(),
): void {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(
    `INSERT INTO source_runs (source, last_ok_at, last_error, cursor, job_count)
     VALUES (?, NULL, ?, NULL, 0)
     ON CONFLICT (source) DO UPDATE SET last_error = excluded.last_error`,
  ).run(source, message.slice(0, 500));
}

/**
 * True when the last successful fetch for `source` is still within `ttlMs`.
 * A source that has only ever failed is NOT fresh — it gets retried.
 */
export function isFresh(
  source: string,
  ttlMs: number,
  db: DatabaseSync = getDb(),
  at: number = nowMs(),
): boolean {
  const run = getSourceRun(source, db);
  if (!run || run.lastOkAt === null) return false;
  return at - run.lastOkAt < ttlMs;
}
