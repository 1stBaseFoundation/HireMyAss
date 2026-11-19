import type { DeterministicProfile } from "./deterministic";

/**
 * Provenance and confidence for every parsed field.
 *
 * A resume parse produces *claims*, not facts. The review screen has to show
 * where each value came from and how much to trust it before anything is
 * confirmed, because a wrong keyword set silently poisons every ranking
 * downstream and the damage is invisible (see TODO.md "Review stage").
 *
 * The rules implemented here are the table in TODO.md, verbatim:
 *
 *   keyword in the skills section   → high, included
 *   keyword in prose                → medium, included
 *   keyword only the model proposed → low, excluded until confirmed
 *   years from "N years"            → high
 *   years derived from date ranges  → medium, flagged
 *   location from the gazetteer     → medium
 *   location/seniority model guess  → low
 *   email/phone regex hit           → high; absent → a gap, never invented
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export type Provenance =
  | "skills-section"
  | "prose"
  | "explicit"
  | "derived"
  | "gazetteer"
  | "title-cue"
  | "regex"
  | "model"
  | "confirmed"
  | "missing";

export const CONFIDENCE_FIELDS = [
  "fullName",
  "headline",
  "email",
  "phone",
  "location",
  "yearsExperience",
  "seniority",
] as const;

export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

export interface FieldAssessment {
  provenance: Provenance;
  confidence: ConfidenceLevel;
  /** Part of the confirmed snapshot unless the user changes it. */
  included: boolean;
  /** Human-readable "why", shown next to the field on the review screen. */
  note?: string;
}

export interface KeywordAssessment extends FieldAssessment {
  keyword: string;
}

export interface ProfileConfidence {
  version: 1;
  fields: Record<ConfidenceField, FieldAssessment>;
  keywords: KeywordAssessment[];
  /** Values the résumé does not state. Shown as gaps to fill, never invented. */
  gaps: ConfidenceField[];
}

/** What the optional model pass contributed, for provenance purposes. */
export interface EnrichmentProvenance {
  /** Field names the model filled that the deterministic pass left empty. */
  modelFields?: string[];
  /** Keywords the model proposed that the lexicon did not back. */
  modelKeywords?: string[];
  /** Model proposals that disagreed with evidence and were discarded. */
  contradictions?: Array<{ field: string; proposed: string; kept: string }>;
}

const EMPTY_FIELD: FieldAssessment = {
  provenance: "missing",
  confidence: "low",
  included: false,
};

/** Word-boundary containment that also works for "c++", ".net" and "ci/cd". */
function mentions(haystack: string, term: string): boolean {
  if (!term) return false;
  if (/^[a-z0-9 ]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "i").test(haystack);
  }
  return haystack.toLowerCase().includes(term.toLowerCase());
}

function field(
  provenance: Provenance,
  confidence: ConfidenceLevel,
  note?: string,
): FieldAssessment {
  return {
    provenance,
    confidence,
    // Low-confidence values start excluded from the confirmed snapshot.
    included: confidence !== "low",
    ...(note ? { note } : {}),
  };
}

function assessKeywords(
  base: DeterministicProfile,
  modelKeywords: string[],
  rawText: string,
): KeywordAssessment[] {
  const skillsSection = (base.sections.skills ?? "").toLowerCase();
  const hitByCanonical = new Map(
    base.skillHits.map((hit) => [hit.canonical.toLowerCase(), hit]),
  );

  const assessments: KeywordAssessment[] = base.keywords.map((keyword) => {
    const hit = hitByCanonical.get(keyword.toLowerCase());
    if (!hit) {
      // In the list but with no lexicon hit: only the pipeline's slicing can
      // produce this, and it is still a term we can point at.
      return {
        keyword,
        ...field("prose", "medium", "not traced back to a lexicon hit"),
      };
    }
    const listedInSkills = skillsSection.includes(hit.matchedOn.toLowerCase());
    return {
      keyword,
      ...(listedInSkills
        ? field("skills-section", "high", `listed under Skills (${hit.matchedOn})`)
        : field("prose", "medium", `mentioned in the text (${hit.matchedOn})`)),
    };
  });

  const seen = new Set(base.keywords.map((keyword) => keyword.toLowerCase()));

  for (const proposed of modelKeywords) {
    const keyword = proposed.trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);

    // The model proposed it and the lexicon does not know it. If the résumé
    // actually says the word, that is corroboration; if it does not, it is a
    // guess and must stay out of the ranking until the user ticks it.
    assessments.push({
      keyword,
      ...(mentions(rawText, keyword)
        ? field("model", "medium", "model proposed it and the text agrees")
        : field("model", "low", "model suggested it, no evidence in the résumé")),
    });
  }

  return assessments;
}

function assessFields(
  base: DeterministicProfile,
  enrichment: EnrichmentProvenance,
): Record<ConfidenceField, FieldAssessment> {
  const modelFields = new Set(enrichment.modelFields ?? []);
  const contradictions = new Map(
    (enrichment.contradictions ?? []).map((item) => [item.field, item]),
  );

  const fromModel = (note?: string): FieldAssessment =>
    field("model", "low", note ?? "model filled a gap — confirm it");

  const valueField = (
    name: ConfidenceField,
    value: string | number | null,
    evidence: FieldAssessment,
  ): FieldAssessment => {
    const clash = contradictions.get(name);
    if (clash) {
      return field(
        "model",
        "low",
        `model proposed "${clash.proposed}"; the résumé says "${clash.kept}"`,
      );
    }
    if (value === null || value === "") {
      return modelFields.has(name) ? fromModel() : EMPTY_FIELD;
    }
    // A deterministic value is evidence-backed by definition: the model only
    // ever fills fields this pass left empty.
    return evidence;
  };

  const fields: Record<ConfidenceField, FieldAssessment> = {
    fullName: valueField("fullName", base.fullName, field("regex", "high")),
    headline: valueField("headline", base.headline, field("title-cue", "high")),
    email: valueField("email", base.email, field("regex", "high")),
    phone: valueField("phone", base.phone, field("regex", "high")),
    location: valueField("location", base.location, field("gazetteer", "medium")),
    yearsExperience: valueField(
      "yearsExperience",
      base.yearsExperience,
      base.yearsSource === "explicit"
        ? field("explicit", "high")
        : field("derived", "medium", "derived from date ranges — check it"),
    ),
    seniority: valueField(
      "seniority",
      base.seniority,
      base.seniorityCue === "title"
        ? field("title-cue", "high")
        : field("title-cue", "medium", "inferred from the résumé text"),
    ),
  };

  return fields;
}

/**
 * Attaches provenance + confidence to a parsed profile.
 *
 * Deliberately pure: it never touches the DB or the model, so the review
 * screen and the tests can both call it with a parsed profile in hand.
 */
export function assessProfile(
  base: DeterministicProfile,
  rawText: string,
  enrichment: EnrichmentProvenance = {},
): ProfileConfidence {
  const fields = assessFields(base, enrichment);
  const keywords = assessKeywords(base, enrichment.modelKeywords ?? [], rawText);

  const gaps = CONFIDENCE_FIELDS.filter(
    (name) => fields[name].provenance === "missing",
  );

  return { version: 1, fields, keywords, gaps };
}

/** Narrows a stored JSON blob back to `ProfileConfidence`, or null if unusable. */
export function readConfidence(value: unknown): ProfileConfidence | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProfileConfidence>;
  if (candidate.version !== 1 || !candidate.fields || !Array.isArray(candidate.keywords)) {
    return null;
  }
  return candidate as ProfileConfidence;
}

/**
 * The keywords a confirmation should carry when the caller did not enumerate
 * them: everything that is not low-confidence by default.
 */
export function defaultConfirmedKeywords(
  keywords: string[],
  confidence: unknown,
): string[] {
  const parsed = readConfidence(confidence);
  if (!parsed) return keywords;

  const excluded = new Set(
    parsed.keywords.filter((item) => !item.included).map((item) => item.keyword.toLowerCase()),
  );
  return keywords.filter((keyword) => !excluded.has(keyword.toLowerCase()));
}

/** Default-included fields, for rendering the review screen and its tests. */
export function defaultConfirmedFields(
  confidence: ProfileConfidence,
): ConfidenceField[] {
  return CONFIDENCE_FIELDS.filter((name) => confidence.fields[name].included);
}
