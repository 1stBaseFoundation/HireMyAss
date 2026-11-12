import { matchSkills, type SkillHit } from "./lexicon";

export type Seniority = "junior" | "mid" | "senior" | "lead" | null;

export interface DeterministicProfile {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  yearsExperience: number | null;
  seniority: Seniority;
  keywords: string[];
  titles: string[];
  locations: string[];
  sections: Record<string, string>;
  skillHits: SkillHit[];
}

const TITLE_WORDS =
  /\b(engineer|developer|technician|manager|analyst|designer|architect|consultant|administrator|specialist|lead|director|coordinator|supervisor|officer|assistant|intern|programmer|scientist)\b/i;

const SECTION_PATTERNS: Array<[string, RegExp]> = [
  ["summary", /^(summary|profile|objective|about me|professional summary|personal summary)\s*:?\s*$/i],
  ["skills", /^(skills|technical skills|key skills|core competenc\w*|competencies|expertise|technical expertise)\b/i],
  ["experience", /^(work experience|experience|employment|careers? history|professional experience|work history)\b/i],
  ["education", /^(education|qualifications?|education and qualifications|academic)\b/i],
  ["certifications", /^(certifications?|licenses?|courses|training)\b/i],
  ["languages", /^(languages?)\b/i],
  ["projects", /^(projects?|portfolio)\b/i],
  ["achievements", /^(achievements?|accomplishments?)\b/i],
  ["references", /^(references?)\b/i],
  ["personal", /^(personal (information|details)|contact details|contact)\b/i],
];

const COUNTRIES = [
  "south africa", "germany", "united kingdom", "uk", "england", "scotland", "ireland",
  "united states", "usa", "canada", "netherlands", "belgium", "france", "spain",
  "portugal", "poland", "australia", "new zealand", "india", "brazil", "nigeria",
  "kenya", "egypt", "united arab emirates", "uae", "singapore", "japan", "switzerland",
];

const CITIES = [
  "berlin", "munich", "hamburg", "london", "manchester", "edinburgh", "dublin",
  "amsterdam", "rotterdam", "lisbon", "porto", "warsaw", "krakow", "cape town",
  "johannesburg", "pretoria", "durban", "nigel", "new york", "san francisco",
  "austin", "seattle", "toronto", "vancouver", "bangalore", "hyderabad", "pune",
  "sydney", "melbourne", "dubai", "nairobi", "lagos", "cairo", "madrid", "paris",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegex(word: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, "gi");
}

/** Splits on recognisable section headers; unheaded leading text becomes `header`. */
export function splitSections(text: string): Record<string, string> {
  const lines = text.split("\n");
  const sections: Record<string, string[]> = { header: [] };
  let current = "header";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 60) {
      const hit = SECTION_PATTERNS.find(([, pattern]) => pattern.test(trimmed));
      if (hit) {
        current = hit[0];
        sections[current] ??= [];
        continue;
      }
    }
    (sections[current] ??= []).push(line);
  }

  return Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, value.join("\n").trim()]),
  );
}

function extractEmail(text: string): string | null {
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() ?? null;
}

function extractPhone(text: string): string | null {
  const candidates = text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g) ?? [];
  const best = candidates
    .map((c) => c.trim())
    .filter((c) => {
      const digits = (c.match(/\d/g) ?? []).length;
      return digits >= 9 && digits <= 15;
    })
    .sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function extractName(text: string): string | null {
  const cvLine = text.match(/curriculum vitae of\s+([A-Z][^\n]{2,60})/i);
  if (cvLine?.[1]) return titleCase(cvLine[1].trim());

  const surname = text.match(/surname\s*:?\s*[.\s]*([A-Z][a-z'\u2019-]{1,30})/i)?.[1];
  const firstNames = text.match(/first names?\s*:?\s*[.\s]*([A-Z][^\n.]{1,60})/i)?.[1];
  if (surname && firstNames) return titleCase(`${firstNames.trim()} ${surname.trim()}`);

  for (const raw of text.split("\n").slice(0, 8)) {
    const line = raw.trim();
    if (!line || /\d|@|http/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z][a-z'\u2019-]*$/.test(w))) {
      return titleCase(line);
    }
  }
  return null;
}

function cleanTitleLine(line: string): string {
  return line
    .replace(/\s*[-\u2013\u2014]\s*(19|20)\d{2}.*$/i, "")
    .replace(/\s*\(.*?\)\s*$/g, "")
    .replace(/^[-\u2013\u2014\u25aa\u2022*\u00b7\s]+/, "")
    .replace(/[.:;,]+$/, "")
    .trim();
}

function extractTitles(sections: Record<string, string>): string[] {
  const scope = [sections.experience, sections.header, sections.summary]
    .filter(Boolean)
    .join("\n");
  const found: string[] = [];

  for (const raw of scope.split("\n")) {
    const line = raw.trim();
    if (!line || line.length > 60) continue;
    // Titles start with a capital and stay short; anything else is prose.
    if (!/^[A-Z0-9]/.test(line)) continue;
    if (line.includes("&")) continue;
    if (line.split(/\s+/).length > 5) continue;
    if (/(19|20)\d{2}/.test(line) && !/engineer|developer|technician/i.test(line)) continue;
    if (!TITLE_WORDS.test(line)) continue;
    const cleaned = cleanTitleLine(line);
    if (cleaned.length >= 3 && cleaned.length <= 60) found.push(cleaned);
  }

  return Array.from(new Set(found)).slice(0, 12);
}

/**
 * Only counts years that look like employment dates. A naive "find all 4-digit
 * numbers" scan is wrong: resumes are full of "Microsoft Office 2010, 2013,
 * 2016, 2019" and "Windows 7/8/10", which would invent a decade of experience.
 */
function extractYears(text: string, sections: Record<string, string>): number | null {
  const explicit = Array.from(text.matchAll(/(\d{1,2})\+?\s*(?:years|yrs)\b/gi))
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 45);
  const explicitBest = explicit.length > 0 ? Math.max(...explicit) : null;

  const inScope = (sections.experience ?? "").replace(/.*date of birth.*/gi, "");
  const years: number[] = [];

  const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  // "Feb 2020", "October 2018"
  for (const m of inScope.matchAll(new RegExp(`${MONTH}[,\\s]+((?:19|20)\\d{2})`, "gi"))) {
    years.push(Number(m[1]));
  }
  // "2017 - 2018", "2019 to 2021"
  for (const m of inScope.matchAll(/((?:19|20)\d{2})\s*(?:[-\u2013]|to)\s*((?:19|20)\d{2})/gi)) {
    years.push(Number(m[1]), Number(m[2]));
  }
  // "Feb 2020 to present" — an ongoing role runs to today.
  if (/\b(present|current|now|ongoing)\b/i.test(inScope)) {
    years.push(new Date().getFullYear());
  }

  let spanBest: number | null = null;
  if (years.length >= 2) {
    const span = Math.max(...years) - Math.min(...years);
    if (span > 0 && span < 45) spanBest = span;
  }

  const best = Math.max(explicitBest ?? 0, spanBest ?? 0);
  return best > 0 ? best : null;
}

function extractSeniority(text: string, titles: string[]): Seniority {
  const haystack = `${titles.join(" ")} ${text}`.toLowerCase();
  if (/\b(principal|staff|head of|chief|director|vice president)\b/.test(haystack)) return "lead";
  if (/\b(senior|team lead|tech lead|manager)\b/.test(haystack)) return "senior";
  if (/\b(junior|graduate|entry level|intern)\b/.test(haystack)) return "junior";
  if (/\b(mid level|intermediate)\b/.test(haystack)) return "mid";
  return null;
}

function extractLocations(text: string, sections: Record<string, string>): string[] {
  const found = new Set<string>();
  const nationalities = new Set([
    "south african", "british", "german", "irish", "american", "canadian", "indian",
  ]);

  for (const country of COUNTRIES) {
    if (wordRegex(country).test(text)) found.add(titleCase(country));
  }
  for (const city of CITIES) {
    if (wordRegex(city).test(text)) found.add(titleCase(city));
  }
  const personal = `${sections.personal ?? ""}\n${sections.header ?? ""}`;
  const nationality = personal.match(/nationality\s*:?\s*[.\s]*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i)?.[1];
  if (nationality && nationalities.has(nationality.toLowerCase())) found.add(titleCase(nationality));

  return Array.from(found).slice(0, 10);
}

function extractKeywords(text: string, sections: Record<string, string>): SkillHit[] {
  const hits = matchSkills(text);
  const skillsSection = (sections.skills ?? "").toLowerCase();

  return hits
    .map((hit) => ({
      ...hit,
      // A skill the candidate explicitly listed deserves more weight than one
      // that merely appears inside a sentence.
      count: hit.count + (skillsSection.includes(hit.matchedOn) ? 2 : 0),
    }))
    .sort((a, b) => b.count - a.count || a.canonical.localeCompare(b.canonical));
}

export function extractProfile(text: string): DeterministicProfile {
  const sections = splitSections(text);
  const titles = extractTitles(sections);
  const skillHits = extractKeywords(text, sections);
  const locations = extractLocations(text, sections);

  return {
    fullName: extractName(text),
    email: extractEmail(text),
    phone: extractPhone(text),
    location: locations[0] ?? null,
    headline: titles[0] ?? null,
    yearsExperience: extractYears(text, sections),
    seniority: extractSeniority(text, titles),
    keywords: skillHits.slice(0, 40).map((h) => h.canonical),
    titles,
    locations,
    sections,
    skillHits,
  };
}

