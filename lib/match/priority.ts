/**
 * Keyword priority.
 *
 * Phase 4 left keyword weighting uniform, ordered only by how often a term
 * appears in the résumé. That is why a QA role could outrank an exact React
 * match: "Communication" and "Collaboration" are noise that matches every
 * posting. The fix is not another magic constant in the scorer — it is letting
 * the user say, on the review screen, which words actually describe the job
 * they want.
 *
 *   pin     the term defines the role; matching it should dominate
 *   normal  default weighting
 *   soften  a real skill, but not what the next job is about
 */

export type KeywordPriority = "pin" | "normal" | "soften";

export const KEYWORD_PRIORITIES: readonly KeywordPriority[] = ["pin", "normal", "soften"];

/**
 * Score multipliers. Chosen so one pinned title match outweighs a pile of
 * generic body hits, while a softened term still contributes a little: it is
 * evidence the candidate can do the job, just not the reason to rank it.
 */
export const PRIORITY_MULTIPLIER: Record<KeywordPriority, number> = {
  pin: 2.5,
  normal: 1,
  soften: 0.25,
};

export type KeywordPriorityMap = Record<string, KeywordPriority>;

function isPriority(value: unknown): value is KeywordPriority {
  return value === "pin" || value === "normal" || value === "soften";
}

/** Accepts arbitrary stored JSON and keeps only the entries it understands. */
export function normalizePriorities(value: unknown): KeywordPriorityMap {
  if (!value || typeof value !== "object") return {};
  const result: KeywordPriorityMap = {};
  for (const [keyword, priority] of Object.entries(value as Record<string, unknown>)) {
    const clean = keyword.trim();
    if (clean && isPriority(priority) && priority !== "normal") {
      // Store only deviations from the default; a map full of "normal" is
      // noise that has to be filtered on every read.
      result[clean] = priority;
    }
  }
  return result;
}

/** Priority is matched case-insensitively, like every other keyword lookup. */
export function priorityFor(
  priorities: KeywordPriorityMap | undefined,
  keyword: string,
): KeywordPriority {
  if (!priorities) return "normal";
  const direct = priorities[keyword];
  if (direct) return direct;

  const wanted = keyword.toLowerCase();
  for (const [key, value] of Object.entries(priorities)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "normal";
}

export function priorityMultiplier(
  priorities: KeywordPriorityMap | undefined,
  keyword: string,
): number {
  return PRIORITY_MULTIPLIER[priorityFor(priorities, keyword)];
}

/** Drops priorities for terms the profile no longer contains. */
export function prunePriorities(
  priorities: KeywordPriorityMap,
  keywords: string[],
): KeywordPriorityMap {
  const kept = new Set(keywords.map((keyword) => keyword.toLowerCase()));
  return Object.fromEntries(
    Object.entries(priorities).filter(([keyword]) => kept.has(keyword.toLowerCase())),
  );
}
