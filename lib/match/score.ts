import type { JobRow } from "@/lib/db/jobs";

/**
 * Ranking.
 *
 * Deliberately model-free: a 4B LLM scoring 2,600 jobs would take hours and be
 * less consistent than arithmetic. What matters here is that the number is
 * explainable — every point of a score must be attributable to a term the user
 * confirmed on the review screen, so `reasons` and `score` always reconcile.
 */

export interface RankingProfile {
  keywords: string[];
  titles: string[];
  locations: string[];
  location: string | null;
  seniority: string | null;
  yearsExperience: number | null;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  matchedKeywords: string[];
  titleMatches: string[];
  recencyDays: number | null;
}

export interface ScoreOptions {
  now?: number;
  idf?: Map<string, number>;
  titleMultiplier?: number;
  recencyHalfLifeDays?: number;
}

const DAY_MS = 86_400_000;

/** Weights sum to 1. Tuned so role relevance beats incidental freshness. */
const WEIGHTS = {
  keyword: 0.62,
  recency: 0.14,
  location: 0.14,
  seniority: 0.1,
} as const;

/** Word-boundary containment that also works for "c++", ".net" and "ci/cd". */
function mentions(haystack: string, term: string): boolean {
  if (!term) return false;
  if (/^[a-z0-9 ]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "i").test(haystack);
  }
  return haystack.includes(term);
}

/**
 * Inverse document frequency across the candidate set, so "React" (in 400 jobs)
 * counts far less than "Solidity" (in 3). Without this, every score is
 * dominated by whichever term is most common on the boards.
 */
export function buildIdf(jobs: JobRow[], keywords: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const total = Math.max(jobs.length, 1);

  for (const keyword of keywords) {
    const term = keyword.toLowerCase();
    if (term.length < 2) continue;
    let df = 0;
    for (const job of jobs) {
      if (mentions(job.title, term) || mentions(job.description ?? "", term)) df += 1;
    }
    idf.set(term, Math.log(1 + total / (1 + df)));
  }
  return idf;
}

export function scoreJob(
  job: JobRow,
  profile: RankingProfile,
  options: ScoreOptions = {},
): ScoreResult {
  const {
    now = Date.now(),
    idf = new Map<string, number>(),
    titleMultiplier = 5,
    recencyHalfLifeDays = 7,
  } = options;

  const title = job.title.toLowerCase();
  const body = `${job.title} ${job.description ?? ""}`.toLowerCase();

  // ---- keyword overlap (the bulk of the score)
  let points = 0;
  const matchedKeywords: string[] = [];
  const titleMatches: string[] = [];

  for (const keyword of profile.keywords) {
    // A one-character "skill" is never evidence — it matches every stray letter
    // and silently dominates the score. The lexicon stops producing these, but
    // a profile saved before that fix can still contain them.
    if (keyword.trim().length < 2) continue;

    const term = keyword.toLowerCase();
    const weight = titleMultiplier > 0 ? idf.get(term) ?? 1 : 1;
    const inTitle = mentions(title, term);
    const inBody = inTitle || mentions(body, term);
    if (!inBody) continue;

    matchedKeywords.push(keyword);
    if (inTitle) {
      titleMatches.push(keyword);
      points += titleMultiplier * weight;
    } else {
      points += weight;
    }
  }

  // Saturating curve: 8 points ≈ 63%, 16 ≈ 86%, 24 ≈ 95%. Dividing by the
  // theoretical maximum (every keyword in every title) would leave realistic
  // jobs stuck near 8%, which reads as broken rather than strict.
  const keywordScore = 1 - Math.exp(-points / 8);

  // ---- recency
  const recencyDays =
    job.postedAt === null ? null : Math.max(0, (now - job.postedAt) / DAY_MS);
  const recencyScore =
    recencyDays === null ? 0.5 : Math.exp((-Math.LN2 * recencyDays) / recencyHalfLifeDays);

  // ---- location fit
  const jobLocation = (job.location ?? "").toLowerCase();
  const profilePlaces = [profile.location, ...profile.locations]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  let locationScore = 0.3;
  if (profilePlaces.some((place) => place && jobLocation.includes(place))) locationScore = 1;
  else if (job.remoteMode === "remote") locationScore = 0.6;

  // ---- seniority fit
  const seniorityScore =
    profile.seniority && mentions(body, profile.seniority.toLowerCase()) ? 1 : 0.5;

  const score = Math.round(
    100 *
      Math.min(
        1,
        // Relevance dominates. Recency was originally 0.2, which let a
        // "posted today" job with two generic keyword hits outrank an exact
        // role match posted two days ago — the wrong ordering for this tool,
        // especially since recency is already an explicit filter chip.
        WEIGHTS.keyword * keywordScore +
          WEIGHTS.recency * recencyScore +
          WEIGHTS.location * locationScore +
          WEIGHTS.seniority * seniorityScore,
      ),
  );

  const reasons: string[] = [];
  if (titleMatches.length > 0) {
    reasons.push(`${titleMatches.slice(0, 3).join(", ")} in title`);
  }
  const otherMatches = matchedKeywords.filter((keyword) => !titleMatches.includes(keyword));
  if (otherMatches.length > 0) {
    reasons.push(otherMatches.slice(0, 3).join(", "));
  }
  if (recencyDays !== null) {
    reasons.push(
      recencyDays < 1
        ? "posted today"
        : `posted ${Math.floor(recencyDays)}d ago`,
    );
  } else {
    reasons.push("posting date unknown");
  }
  if (locationScore === 1) {
    const hit = profilePlaces.find((place) => place && jobLocation.includes(place));
    reasons.push(`location: ${hit}`);
  } else {
    reasons.push(job.remoteMode);
  }
  if (seniorityScore === 1 && profile.seniority) reasons.push(`${profile.seniority} match`);

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons: reasons.slice(0, 5),
    matchedKeywords,
    titleMatches,
    recencyDays,
  };
}
