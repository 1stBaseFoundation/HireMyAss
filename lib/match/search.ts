import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { listJobsWithStatus, type JobStatusValue } from "@/lib/db/jobs";
import type { Profile } from "@/lib/db/profile";
import { mergeAcrossSources, type MergedJob } from "./dedupe";
import { isStatusVisible, matchesFilters, type JobFilters } from "./filters";
import { buildIdf, scoreJob, type RankingProfile, type ScoreResult } from "./score";

export interface RankedJob extends MergedJob {
  status: JobStatusValue;
  score: number;
  reasons: string[];
  matchedKeywords: string[];
  titleMatches: string[];
  recencyDays: number | null;
}

export interface SearchRequest {
  filters?: JobFilters;
  /** Hide jobs that have merely been seen. See filters.visibleStatuses. */
  strictMode?: boolean;
  limit?: number;
  /** Minimum score to include. */
  minScore?: number;
}

export interface SearchStats {
  candidates: number;
  hiddenByStatus: number;
  afterFilters: number;
  returned: number;
}

export interface SearchResponse {
  jobs: RankedJob[];
  stats: SearchStats;
}

export function profileToRanking(profile: Profile): RankingProfile {
  return {
    keywords: profile.keywords,
    titles: profile.titles,
    locations: profile.locations,
    location: profile.location,
    seniority: profile.seniority,
    yearsExperience: profile.yearsExperience,
  };
}

/**
 * Ranking is a pure function over what is already in SQLite — fetching is a
 * separate concern (lib/sources/collect.ts). That separation is what makes the
 * whole search testable without a network or a GPU.
 */
export function searchJobs(
  profile: Profile,
  request: SearchRequest = {},
  db: DatabaseSync = getDb(),
  now: number = Date.now(),
): SearchResponse {
  const { filters = {}, strictMode = false, limit = 100, minScore = 0 } = request;
  const ranking = profileToRanking(profile);

  const all = listJobsWithStatus(db);
  const visible = all.filter((job) => isStatusVisible(job.status, strictMode));
  const hiddenByStatus = all.length - visible.length;

  const merged = mergeAcrossSources(visible);
  const filtered = merged.filter((job) => matchesFilters(job, filters, now));

  const idf = buildIdf(filtered, ranking.keywords);

  const scored: RankedJob[] = filtered.map((job) => {
    const result: ScoreResult = scoreJob(job, ranking, {
      now,
      idf,
      titleMultiplier: env.scoring.titleMultiplier,
      recencyHalfLifeDays: env.scoring.recencyHalfLifeDays,
    });
    return {
      ...job,
      status: (visible.find((row) => row.id === job.id)?.status ?? "new") as JobStatusValue,
      score: result.score,
      reasons: result.reasons,
      matchedKeywords: result.matchedKeywords,
      titleMatches: result.titleMatches,
      recencyDays: result.recencyDays,
    };
  });

  const kept = scored
    .filter((job) => job.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.postedAt ?? 0) - (a.postedAt ?? 0))
    .slice(0, limit);

  return {
    jobs: kept,
    stats: {
      candidates: all.length,
      hiddenByStatus,
      afterFilters: filtered.length,
      returned: kept.length,
    },
  };
}
