import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import { upsertJob, type NormalizedJob } from "@/lib/db/jobs";
import { isFresh, recordSourceFailure, recordSourceSuccess } from "@/lib/db/sources";
import { getSources } from "./registry";
import type { SearchQuery } from "./types";

/**
 * Fan-out + cache + persistence for all enabled sources.
 *
 * Two rules that matter in practice:
 *  1. Never fetch a source that succeeded inside its TTL. Remotive documents a
 *     ~4 requests/day cap, and hammering any of these boards is rude.
 *  2. One dead source must not fail the search. Everything is isolated.
 */

export interface SourceOutcome {
  source: string;
  ok: boolean;
  cached: boolean;
  fetched: number;
  inserted: number;
  error?: string;
  ms: number;
}

export interface CollectResult {
  jobs: NormalizedJob[];
  outcomes: SourceOutcome[];
  /** True when every source was served from cache (no network was touched). */
  allCached: boolean;
}

export interface CollectOptions {
  sourceIds?: string[];
  /** Ignore TTL and refetch everything. */
  force?: boolean;
  db?: DatabaseSync;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function collectJobs(
  query: SearchQuery = {},
  options: CollectOptions = {},
): Promise<CollectResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now();
  const sources = getSources(options.sourceIds);
  const jobs: NormalizedJob[] = [];
  const outcomes: SourceOutcome[] = [];

  for (const source of sources) {
    const started = Date.now();
    const cached = !options.force && isFresh(source.id, source.ttlMs, db, now);

    if (cached) {
      outcomes.push({ source: source.id, ok: true, cached: true, fetched: 0, inserted: 0, ms: 0 });
      continue;
    }

    try {
      const fetched = await source.fetchJobs(query, { fetchImpl: options.fetchImpl });
      let inserted = 0;
      for (const job of fetched) {
        if (!job.title || !job.applyUrl) continue;
        const result = upsertJob(job, db);
        if (result.inserted) inserted += 1;
      }
      jobs.push(...fetched);
      recordSourceSuccess(source.id, { jobCount: fetched.length }, db);
      outcomes.push({
        source: source.id,
        ok: true,
        cached: false,
        fetched: fetched.length,
        inserted,
        ms: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordSourceFailure(source.id, error, db);
      outcomes.push({
        source: source.id,
        ok: false,
        cached: false,
        fetched: 0,
        inserted: 0,
        error: message.slice(0, 300),
        ms: Date.now() - started,
      });
    }
  }

  return {
    jobs,
    outcomes,
    allCached: outcomes.length > 0 && outcomes.every((o) => o.cached),
  };
}
