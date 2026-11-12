import type { EmploymentType, RemoteMode } from "@/lib/db/jobs";

/**
 * Coercion helpers shared by every adapter.
 *
 * The whole point of this layer is that Phase 4's filters can be written once:
 * every source normalises into the same vocabulary, so "contract + Berlin +
 * last 3 days" behaves identically regardless of which board answered.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Boards return HTML in descriptions; we store readable text. */
export function stripHtml(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/[ \t]{2,}/g, " ")
    // Tags leave stray spaces either side of the newlines we inserted.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** A date string, ISO timestamp, ms epoch or seconds epoch -> ms epoch. */
export function toEpochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything below 1e12 is seconds, not milliseconds (1e12 ms = 2001).
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return toEpochMs(Number(trimmed));

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

const FULL_TIME = /\b(full[\s-]?time|permanent|regular full)\b/i;
const PART_TIME = /\b(part[\s-]?time)\b/i;
const CONTRACT = /\b(contract|contractor|freelance|fixed[\s-]?term|interim|consultancy)\b/i;
const TEMPORARY = /\b(temporary|temp|seasonal)\b/i;
const INTERNSHIP = /\b(intern|internship|graduate programme|graduate program|apprentice)\b/i;

/** First non-empty match wins; contract beats temporary because boards conflate them. */
export function inferEmploymentType(
  ...hints: Array<string | null | undefined>
): EmploymentType {
  const haystack = hints.filter(Boolean).join(" | ");
  if (!haystack) return "unknown";
  if (INTERNSHIP.test(haystack)) return "internship";
  if (PART_TIME.test(haystack)) return "part_time";
  if (CONTRACT.test(haystack)) return "contract";
  if (TEMPORARY.test(haystack)) return "contract";
  if (FULL_TIME.test(haystack)) return "full_time";
  return "unknown";
}

const REMOTE = /\b(remote|anywhere|work from home|wfh|distributed team)\b/i;
const HYBRID = /\b(hybrid|flexible working|partially remote)\b/i;
const ONSITE = /\b(on[\s-]?site|in[\s-]?office|in person)\b/i;

/**
 * `explicit` (a boolean or vendor enum) beats string sniffing. Boards that
 * report `remote: false` really do mean on-site, not unknown.
 */
export function inferRemoteMode(
  explicit: string | boolean | null | undefined,
  ...hints: Array<string | null | undefined>
): RemoteMode {
  if (typeof explicit === "boolean") return explicit ? "remote" : "onsite";

  const stated = (explicit ?? "").toString().trim().toLowerCase();
  if (stated) {
    if (stated.includes("hybrid")) return "hybrid";
    if (stated.includes("remote")) return "remote";
    if (stated.includes("onsite") || stated.includes("on-site") || stated.includes("office")) {
      return "onsite";
    }
  }

  const haystack = hints.filter(Boolean).join(" | ");
  if (HYBRID.test(haystack)) return "hybrid";
  if (REMOTE.test(haystack)) return "remote";
  if (ONSITE.test(haystack)) return "onsite";
  return "unknown";
}

/** Collapses whitespace and strips vendor noise like "(m/w/d)". */
export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function cleanTitle(value: string | null | undefined): string {
  return cleanText(value)
    .replace(/\s*\((?:m\/[fwd]+|[^)]{0,4})\)\s*$/i, "")
    .replace(/^[\s\-–—•]+/, "")
    .trim();
}
