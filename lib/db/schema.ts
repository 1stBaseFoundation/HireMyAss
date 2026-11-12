/**
 * Schema is embedded as a string rather than a .sql file so it always ships
 * with the build (no fs reads at runtime, no bundler asset-tracing surprises).
 *
 * v2 adds the review gate: a profile is not usable for ranking until the user
 * has explicitly confirmed it (see TODO.md "Review stage").
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Single-row profile: the parsed resume. Everything here is user-editable.
CREATE TABLE IF NOT EXISTS profile (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  full_name       TEXT,
  headline        TEXT,
  email           TEXT,
  phone           TEXT,
  location        TEXT,
  years_experience REAL,
  seniority       TEXT,
  raw_text        TEXT NOT NULL,
  keywords_json   TEXT NOT NULL DEFAULT '[]',
  titles_json     TEXT NOT NULL DEFAULT '[]',
  locations_json  TEXT NOT NULL DEFAULT '[]',
  source_file     TEXT,
  parse_method    TEXT,
  -- v2: review gate. NULL confirmed_at means the parse is still a draft.
  confirmed_at    INTEGER,
  confidence_json TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Canonical job rows. One row per real-world posting, deduped across sources.
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,
  source_id       TEXT,
  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  location        TEXT,
  remote_mode     TEXT NOT NULL DEFAULT 'unknown',
  employment_type TEXT NOT NULL DEFAULT 'unknown',
  description     TEXT,
  apply_url       TEXT NOT NULL,
  posted_at       INTEGER,
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- [{ source, sourceId, url, applyUrl }] for every source that listed this job
  sources_json    TEXT NOT NULL DEFAULT '[]',
  raw_json        TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs (source, source_id);

-- Applied/seen state. Absence of a row means 'new'.
CREATE TABLE IF NOT EXISTS job_status (
  job_id        INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'new',
  first_seen_at INTEGER,
  applied_at    INTEGER,
  note          TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status ON job_status (status);

-- Immutable log of applications actually submitted.
CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  company        TEXT NOT NULL,
  title          TEXT NOT NULL,
  apply_url      TEXT,
  applied_at     INTEGER NOT NULL,
  resume_variant TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_applied ON applications (applied_at DESC);

-- Per-source fetch bookkeeping: TTL cache + rate-limit guard (Remotive: 4/day).
CREATE TABLE IF NOT EXISTS source_runs (
  source      TEXT PRIMARY KEY,
  last_ok_at  INTEGER,
  last_error  TEXT,
  cursor      TEXT,
  job_count   INTEGER NOT NULL DEFAULT 0
);
`;
