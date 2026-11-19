import type { Profile } from "@/lib/db/profile";
import { CONFIDENCE_FIELDS, type ConfidenceField, type ProfileConfidence } from "./confidence";
import type { DeterministicProfile } from "./deterministic";

/**
 * Re-uploading a résumé must not throw away work the user already did.
 *
 * The rule (TODO.md, "Review stage"): a fresh parse replaces the draft, but
 * values the user confirmed survive — unless the new document contradicts them,
 * in which case the user's value wins and the contradiction is shown as a note.
 * Confirmation itself is always withdrawn, so the review screen reopens.
 */

export interface ReconciledValues {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  yearsExperience: number | null;
  seniority: string | null;
}

export interface Reconciliation {
  values: ReconciledValues;
  keywords: string[];
  confidence: ProfileConfidence;
  /** Fields kept from the confirmed snapshot even though the new parse differed. */
  carriedFields: ConfidenceField[];
  /** Human-readable contradictions, surfaced with the ingest notes. */
  notes: string[];
}

function normalise(value: string | number | null): string {
  return typeof value === "number" ? String(value) : (value ?? "").trim().toLowerCase();
}

export function reconcileWithConfirmed(
  previous: Profile | null,
  next: DeterministicProfile,
  confidence: ProfileConfidence,
): Reconciliation {
  const values: ReconciledValues = {
    fullName: next.fullName,
    headline: next.headline,
    email: next.email,
    phone: next.phone,
    location: next.location,
    yearsExperience: next.yearsExperience,
    seniority: next.seniority,
  };

  // Nothing was confirmed, so there is no user intent to protect.
  if (!previous || !previous.confirmedAt) {
    return { values, keywords: next.keywords, confidence, carriedFields: [], notes: [] };
  }

  const carriedFields: ConfidenceField[] = [];
  const notes: string[] = [];
  const grade = structuredClone(confidence);

  for (const field of CONFIDENCE_FIELDS) {
    const before = previous[field];
    if (before === null || before === "") continue;

    const after = values[field];
    const same = after !== null && normalise(after) === normalise(before);

    if (same) continue;

    // The user's confirmed value survives a contradicting parse; only an
    // absent value in the new document is also worth keeping silently.
    carriedFields.push(field);
    (values as Record<ConfidenceField, string | number | null>)[field] = before;
    grade.fields[field] = {
      provenance: "confirmed",
      confidence: "high",
      included: true,
      note: "kept from your confirmed profile",
    };
    notes.push(
      after === null || after === ""
        ? `${field}: the new résumé does not mention it — kept your confirmed value`
        : `${field}: new résumé suggests "${String(after)}" — kept your confirmed "${String(before)}"`,
    );
  }

  // Keywords are unioned: a term the user confirmed is not contradicted just
  // because the new document phrases its skills section differently.
  const keywords = [...previous.keywords];
  const seen = new Set(keywords.map((keyword) => keyword.toLowerCase()));

  for (const keyword of next.keywords) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }

  const graded = new Set(grade.keywords.map((item) => item.keyword.toLowerCase()));
  for (const keyword of keywords) {
    const key = keyword.toLowerCase();
    if (graded.has(key)) continue;
    grade.keywords.push({
      keyword,
      provenance: "confirmed",
      confidence: "medium",
      included: true,
      note: "kept from your confirmed profile",
    });
  }

  grade.gaps = CONFIDENCE_FIELDS.filter((name) => grade.fields[name].provenance === "missing");

  return { values, keywords, confidence: grade, carriedFields, notes };
}
