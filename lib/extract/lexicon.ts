import skillsJson from "./skills.json";

export interface SkillEntry {
  canonical: string;
  category: string;
  aliases: string[];
}

interface RawLexicon {
  version: number;
  groups: Record<string, Record<string, string[]>>;
}

const lexicon = skillsJson as unknown as RawLexicon;

/** Flat list of every skill, with the canonical name always matchable. */
export const SKILLS: SkillEntry[] = Object.entries(lexicon.groups).flatMap(([category, entries]) =>
  Object.entries(entries).map(([canonical, aliases]) => ({
    canonical,
    category,
    aliases: Array.from(new Set([canonical.toLowerCase(), ...aliases.map((a) => a.toLowerCase())])),
  })),
);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary match that treats `_` as part of a word, so "node" does not
 * match "node_modules" and "go" cannot match "goto".
 */
function boundaryPattern(alias: string): RegExp {
  return new RegExp(`(?<![a-z0-9_])${escapeRegExp(alias)}(?![a-z0-9_])`, "gi");
}

const MATCHERS: Array<{ entry: SkillEntry; patterns: RegExp[] }> = SKILLS.map((entry) => ({
  entry,
  patterns: entry.aliases.map(boundaryPattern),
}));

export interface SkillHit {
  canonical: string;
  category: string;
  count: number;
  /** The alias that produced the first hit — useful for explaining a match. */
  matchedOn: string;
}

/** Finds every known skill mentioned in `text`, with occurrence counts. */
export function matchSkills(text: string): SkillHit[] {
  const haystack = text.toLowerCase();
  const hits: SkillHit[] = [];

  for (const { entry, patterns } of MATCHERS) {
    let count = 0;
    let matchedOn = "";
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const found = haystack.match(pattern);
      if (found && found.length > 0) {
        count += found.length;
        if (!matchedOn) matchedOn = found[0].toLowerCase();
      }
    }
    if (count > 0) {
      hits.push({ canonical: entry.canonical, category: entry.category, count, matchedOn });
    }
  }

  return hits.sort((a, b) => b.count - a.count || a.canonical.localeCompare(b.canonical));
}

/**
 * Canonicalises user-typed keywords (from the chat `refine_profile` tool or the
 * chip editor) so "ts", "TS" and "TypeScript" all collapse to one entry.
 */
export function canonicalSkill(input: string): string {
  const needle = input.trim().toLowerCase();
  if (!needle) return input;
  for (const entry of SKILLS) {
    if (entry.canonical.toLowerCase() === needle) return entry.canonical;
    if (entry.aliases.includes(needle)) return entry.canonical;
  }
  return input.trim();
}

export function skillCategory(canonical: string): string | null {
  return SKILLS.find((s) => s.canonical.toLowerCase() === canonical.toLowerCase())?.category ?? null;
}
