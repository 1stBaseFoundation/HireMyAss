import type { JobRow, JobSourceRef } from "@/lib/db/jobs";
import { looseFingerprint } from "./fingerprint";

/**
 * Cross-source dedupe.
 *
 * The strict fingerprint (company+title+location) is the storage uniqueness key
 * and stops exact re-ingest. It cannot catch the same opening listed on several
 * boards, because boards disagree on the location string ("Remote", "Remote,
 * US", "", "Anywhere"). The loose fingerprint (company+title) groups those, and
 * the group is collapsed here into one presentable row.
 */

export interface MergedJob extends JobRow {
  /** Every source that listed this posting, in registry order of discovery. */
  sourceIds: string[];
}

/** Prefers the earliest posting; ties broken by the row that knows more sources. */
function pickRepresentative(group: JobRow[]): JobRow {
  return [...group].sort((a, b) => {
    if (a.postedAt !== null && b.postedAt !== null && a.postedAt !== b.postedAt) {
      return a.postedAt - b.postedAt;
    }
    if (a.postedAt === null && b.postedAt !== null) return 1;
    if (a.postedAt !== null && b.postedAt === null) return -1;
    return b.sources.length - a.sources.length;
  })[0]!;
}

export function mergeAcrossSources(jobs: JobRow[]): MergedJob[] {
  const groups = new Map<string, JobRow[]>();

  for (const job of jobs) {
    const key = looseFingerprint(job);
    const bucket = groups.get(key);
    if (bucket) bucket.push(job);
    else groups.set(key, [job]);
  }

  return Array.from(groups.values()).map((group) => {
    const representative = pickRepresentative(group);

    // Union every source reference so the UI can credit all of them, and so a
    // user can still reach the other listings if one is taken down.
    const refs = new Map<string, JobSourceRef>();
    for (const job of group) {
      for (const ref of job.sources) {
        const key = `${ref.source}:${ref.sourceId ?? ref.applyUrl}`;
        if (!refs.has(key)) refs.set(key, ref);
      }
    }

    return {
      ...representative,
      sources: Array.from(refs.values()),
      sourceIds: Array.from(new Set(group.map((job) => job.source))),
    };
  });
}
