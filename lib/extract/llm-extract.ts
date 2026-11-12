import { z } from "zod";
import { chat, extractJson } from "@/lib/llm/client";
import { canonicalSkill } from "./lexicon";
import type { DeterministicProfile, Seniority } from "./deterministic";

/**
 * Optional enrichment pass.
 *
 * The deterministic extractor is the source of truth: it only reports what it
 * can point at in the text. The model is asked to fill ONLY the fields the
 * deterministic pass left empty, and never to overwrite evidence-backed values.
 * If the model is down, returns garbage, or times out, the caller keeps the
 * deterministic result untouched.
 */

/** Flat schema: all strings, "" meaning unknown. Union types confuse 4B models. */
const GAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fullName", "headline", "email", "phone", "location", "seniority", "keywords", "titles"],
  properties: {
    fullName: { type: "string" },
    headline: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    location: { type: "string" },
    seniority: { type: "string", enum: ["junior", "mid", "senior", "lead", ""] },
    keywords: { type: "array", items: { type: "string" }, maxItems: 40 },
    titles: { type: "array", items: { type: "string" }, maxItems: 10 },
  },
} as const;

const GapSchema = z.object({
  fullName: z.string().default(""),
  headline: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  seniority: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  titles: z.array(z.string()).default([]),
});

export interface EnrichmentResult {
  profile: DeterministicProfile;
  usedLlm: boolean;
  filled: string[];
  note: string;
}

const MAX_RESUME_CHARS = 6000;

function systemPrompt(missing: string[]): string {
  return [
    "You extract structured facts from a resume.",
    "Only use information that appears in the resume text.",
    "If a field is not stated, output an empty string.",
    "Never invent employers, dates, or skills.",
    `Fields needing attention: ${missing.join(", ") || "none"}.`,
    "Reply with JSON only.",
  ].join(" ");
}

/** Fields the deterministic pass could not establish. */
export function missingFields(profile: DeterministicProfile): string[] {
  const missing: string[] = [];
  if (!profile.fullName) missing.push("fullName");
  if (!profile.headline) missing.push("headline");
  if (!profile.email) missing.push("email");
  if (!profile.phone) missing.push("phone");
  if (!profile.location) missing.push("location");
  if (!profile.seniority) missing.push("seniority");
  if (profile.keywords.length < 5) missing.push("keywords");
  return missing;
}

export async function enrichProfile(
  base: DeterministicProfile,
  rawText: string,
  options: { timeoutMs?: number } = {},
): Promise<EnrichmentResult> {
  const missing = missingFields(base);
  if (missing.length === 0) {
    return { profile: base, usedLlm: false, filled: [], note: "deterministic pass complete" };
  }

  const source = rawText.slice(0, MAX_RESUME_CHARS);

  try {
    const result = await chat({
      messages: [
        { role: "system", content: systemPrompt(missing) },
        { role: "user", content: `RESUME:\n${source}` },
      ],
      temperature: 0,
      maxTokens: 1024,
      timeoutMs: options.timeoutMs,
      jsonSchema: { name: "resume_gaps", schema: GAP_SCHEMA as unknown as Record<string, unknown> },
    });

    // Salvage JSON the model reasoned its way to even if it never emitted
    // `content` (reasoning models do this when the token budget is tight).
    const parsed = GapSchema.safeParse(
      extractJson(result.text) ?? extractJson(result.reasoning),
    );
    if (!parsed.success) {
      return {
        profile: base,
        usedLlm: false,
        filled: [],
        note: `model returned unusable JSON (${parsed.error.issues[0]?.message ?? "parse error"}; ${
          result.text.length
        } chars content)`,
      };
    }

    const gaps = parsed.data;
    const filled: string[] = [];
    const merged: DeterministicProfile = { ...base };

    const takeString = (
      key: "fullName" | "headline" | "email" | "phone" | "location",
      value: string,
    ) => {
      const clean = value.trim();
      if (!merged[key] && clean) {
        merged[key] = clean;
        filled.push(key);
      }
    };

    takeString("fullName", gaps.fullName);
    takeString("headline", gaps.headline);
    takeString("email", gaps.email);
    takeString("phone", gaps.phone);
    takeString("location", gaps.location);

    if (!merged.seniority && gaps.seniority) {
      const candidate = gaps.seniority.trim() as Seniority;
      if (["junior", "mid", "senior", "lead"].includes(candidate ?? "")) {
        merged.seniority = candidate;
        filled.push("seniority");
      }
    }

    // Union, never replace: deterministic hits are evidence-backed.
    const keywords = new Set(merged.keywords);
    const before = keywords.size;
    for (const keyword of gaps.keywords) {
      const canonical = canonicalSkill(keyword);
      if (canonical.length >= 2 && canonical.length <= 40) keywords.add(canonical);
    }
    merged.keywords = Array.from(keywords).slice(0, 40);
    if (keywords.size > before) filled.push(`keywords(+${keywords.size - before})`);

    const titles = new Set(merged.titles);
    for (const title of gaps.titles) {
      if (title.trim().length >= 3) titles.add(title.trim());
    }
    merged.titles = Array.from(titles).slice(0, 12);

    return {
      profile: merged,
      usedLlm: true,
      filled,
      note: filled.length > 0 ? `filled: ${filled.join(", ")}` : "model had nothing to add",
    };
  } catch (error) {
    return {
      profile: base,
      usedLlm: false,
      filled: [],
      note: `model unavailable, kept deterministic result (${
        error instanceof Error ? error.message.slice(0, 120) : String(error)
      })`,
    };
  }
}
