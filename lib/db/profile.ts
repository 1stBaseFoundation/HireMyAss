import type { DatabaseSync } from "node:sqlite";
import { getDb, nowMs, parseJson } from "./index";

export interface Profile {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  yearsExperience: number | null;
  seniority: string | null;
  rawText: string;
  keywords: string[];
  titles: string[];
  locations: string[];
  sourceFile: string | null;
  parseMethod: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ProfileInput = Omit<Profile, "createdAt" | "updatedAt">;

interface RawProfileRow {
  full_name: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  years_experience: number | null;
  seniority: string | null;
  raw_text: string;
  keywords_json: string;
  titles_json: string;
  locations_json: string;
  source_file: string | null;
  parse_method: string | null;
  created_at: number;
  updated_at: number;
}

export function getProfile(db: DatabaseSync = getDb()): Profile | null {
  const row = db.prepare("SELECT * FROM profile WHERE id = 1").get() as RawProfileRow | undefined;
  if (!row) return null;
  return {
    fullName: row.full_name,
    headline: row.headline,
    email: row.email,
    phone: row.phone,
    location: row.location,
    yearsExperience: row.years_experience,
    seniority: row.seniority,
    rawText: row.raw_text,
    keywords: parseJson<string[]>(row.keywords_json, []),
    titles: parseJson<string[]>(row.titles_json, []),
    locations: parseJson<string[]>(row.locations_json, []),
    sourceFile: row.source_file,
    parseMethod: row.parse_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Replaces the single profile row. There is only ever one. */
export function saveProfile(input: ProfileInput, db: DatabaseSync = getDb()): Profile {
  const ts = nowMs();
  const existing = db.prepare("SELECT created_at FROM profile WHERE id = 1").get() as
    | { created_at: number }
    | undefined;

  db.prepare(
    `INSERT INTO profile (
       id, full_name, headline, email, phone, location, years_experience, seniority,
       raw_text, keywords_json, titles_json, locations_json, source_file, parse_method,
       created_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       full_name = excluded.full_name,
       headline = excluded.headline,
       email = excluded.email,
       phone = excluded.phone,
       location = excluded.location,
       years_experience = excluded.years_experience,
       seniority = excluded.seniority,
       raw_text = excluded.raw_text,
       keywords_json = excluded.keywords_json,
       titles_json = excluded.titles_json,
       locations_json = excluded.locations_json,
       source_file = excluded.source_file,
       parse_method = excluded.parse_method,
       updated_at = excluded.updated_at`,
  ).run(
    input.fullName,
    input.headline,
    input.email,
    input.phone,
    input.location,
    input.yearsExperience,
    input.seniority,
    input.rawText,
    JSON.stringify(input.keywords),
    JSON.stringify(input.titles),
    JSON.stringify(input.locations),
    input.sourceFile,
    input.parseMethod,
    existing?.created_at ?? ts,
    ts,
  );

  const saved = getProfile(db);
  if (!saved) throw new Error("profile vanished immediately after write");
  return saved;
}

/** Applies a keyword-level edit (used by the chat `refine_profile` tool). */
export function updateProfileKeywords(
  keywords: string[],
  db: DatabaseSync = getDb(),
): Profile | null {
  const current = getProfile(db);
  if (!current) return null;
  return saveProfile({ ...current, keywords }, db);
}
