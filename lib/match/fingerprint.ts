import { createHash } from "node:crypto";

/**
 * Cross-source identity for a posting.
 *
 * The naive key (company + title + location) is too brittle in practice: the
 * same role shows up as "Remote", "Remote, US", "" and "Anywhere" depending on
 * the board. So we keep two keys:
 *
 *   fingerprintJob  — strict. Used as the UNIQUE constraint in `jobs`.
 *   looseFingerprint — company + title only. Used to spot the *same* job posted
 *                      on several boards (Phase 4) without collapsing genuinely
 *                      distinct openings in different cities.
 */

/** Lowercase, strip accents, collapse punctuation to single spaces. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Removes hiring noise that boards append inconsistently:
 * "(m/w/d)", "[Remote]", "- Remote", "(Contract)", trailing city lists.
 */
export function normalizeTitle(title: string): string {
  return normalizeText(
    title
      .replace(/\((?:m\/[fwd]+(?:\/[fwd]+)*|[^)]{0,30})\)/gi, " ")
      .replace(/\[[^\]]{0,30}\]/g, " ")
      .replace(/\b(remote|hybrid|on-?site|fully remote|remote only)\b/gi, " ")
      .replace(/\s[-\u2013\u2014|]\s.*$/, " "),
  );
}

/** "Remote, United States" -> "remote united states", null -> "". */
export function normalizeLocation(location: string | null | undefined): string {
  return normalizeText(location);
}

function sha256(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function fingerprintJob(job: {
  company: string;
  title: string;
  location?: string | null;
}): string {
  return sha256([
    normalizeText(job.company),
    normalizeTitle(job.title),
    normalizeLocation(job.location),
  ]);
}

export function looseFingerprint(job: { company: string; title: string }): string {
  return sha256([normalizeText(job.company), normalizeTitle(job.title)]);
}
