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
  /** NULL until the user confirms the parse on the review screen. */
  confirmedAt: number | null;
  /** Per-field provenance/confidence, produced by the review stage. */
  confidence: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type ProfileInput = Omit<
  Profile,
  "createdAt" | "updatedAt" | "confirmedAt" | "confidence"
>;

export interface SaveProfileOptions {
  /**
   * Keep an existing confirmation. Any fresh parse or edit resets it by default,
   * because changing the profile changes what the search will be run with.
   */
  keepConfirmation?: boolean;
  confidence?: Record<string, unknown>;
}

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
  confirmed_at: number | null;
  confidence_json: string;
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
    confirmedAt: row.confirmed_at,
    confidence: parseJson<Record<string, unknown>>(row.confidence_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Replaces the single profile row. There is only ever one. */
export function saveProfile(
  input: ProfileInput,
  db: DatabaseSync = getDb(),
  options: SaveProfileOptions = {},
): Profile {
  const ts = nowMs();
  const existing = db
    .prepare("SELECT created_at, confirmed_at, confidence_json FROM profile WHERE id = 1")
    .get() as
    | { created_at: number; confirmed_at: number | null; confidence_json: string }
    | undefined;

  db.prepare(
    `INSERT INTO profile (
       id, full_name, headline, email, phone, location, years_experience, seniority,
       raw_text, keywords_json, titles_json, locations_json, source_file, parse_method,
       confirmed_at, confidence_json, created_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       confirmed_at = excluded.confirmed_at,
       confidence_json = excluded.confidence_json,
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
    options.keepConfirmation ? (existing?.confirmed_at ?? null) : null,
    JSON.stringify(options.confidence ?? existing?.confidence_json ?? {}),
    existing?.created_at ?? ts,
    ts,
  );

  const saved = getProfile(db);
  if (!saved) throw new Error("profile vanished immediately after write");
  return saved;
}

/**
 * Marks the profile as reviewed. This is the gate that unlocks searching: until
 * it happens the parse is a draft and no vacancy query may run against it.
 */
export function confirmProfile(db: DatabaseSync = getDb()): Profile | null {
  const ts = nowMs();
  db.prepare("UPDATE profile SET confirmed_at = ?, updated_at = ? WHERE id = 1").run(ts, ts);
  return getProfile(db);
}

/** Withdraws confirmation (used when the resume is re-parsed). */
export function unconfirmProfile(db: DatabaseSync = getDb()): Profile | null {
  const ts = nowMs();
  db.prepare("UPDATE profile SET confirmed_at = NULL, updated_at = ? WHERE id = 1").run(ts);
  return getProfile(db);
}

export function isProfileConfirmed(profile: Profile | null): boolean {
  return Boolean(profile && profile.confirmedAt);
}

/** Thrown when a search is attempted before the user has reviewed the parse. */
export class ProfileNotConfirmedError extends Error {
  readonly code = "PROFILE_NOT_CONFIRMED";
  constructor() {
    super(
      "profile has not been reviewed yet — open /profile, check the extracted terms, then confirm before searching",
    );
    this.name = "ProfileNotConfirmedError";
  }
}

/** The profile ranking is allowed to use. */
export function getConfirmedProfile(db: DatabaseSync = getDb()): Profile {
  const profile = getProfile(db);
  if (!profile) throw new ProfileNotConfirmedError();
  if (!profile.confirmedAt) throw new ProfileNotConfirmedError();
  return profile;
}

/** Applies a keyword-level edit (used by the chat `refine_profile` tool). */
export function updateProfileKeywords(
  keywords: string[],
  db: DatabaseSync = getDb(),
): Profile | null {
  const current = getProfile(db);
  if (!current) return null;
  // An edit changes the search terms, so confirmation must be re-given.
  return saveProfile(toProfileInput(current, keywords), db);
}

/** Narrow a full Profile row back to a writable input, overriding keywords. */
export function toProfileInput(profile: Profile, keywords?: string[]): ProfileInput {
  return {
    fullName: profile.fullName,
    headline: profile.headline,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    yearsExperience: profile.yearsExperience,
    seniority: profile.seniority,
    rawText: profile.rawText,
    keywords: keywords ?? profile.keywords,
    titles: profile.titles,
    locations: profile.locations,
    sourceFile: profile.sourceFile,
    parseMethod: profile.parseMethod,
  };
}
