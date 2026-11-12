import type { DatabaseSync } from "node:sqlite";
import { getDb, nowMs, parseJson } from "./index";
import { fingerprintJob } from "@/lib/match/fingerprint";

export type RemoteMode = "remote" | "hybrid" | "onsite" | "unknown";
export type EmploymentType =
  | "full_time"
  | "part_time"
  | "contract"
  | "internship"
  | "temporary"
  | "unknown";
export type JobStatusValue = "new" | "seen" | "applied" | "dismissed" | "rejected";

export interface JobSourceRef {
  source: string;
  sourceId: string | null;
  url: string;
  applyUrl: string;
}

/** Shape every source adapter must produce. */
export interface NormalizedJob {
  source: string;
  sourceId: string | null;
  title: string;
  company: string;
  location: string | null;
  remoteMode: RemoteMode;
  employmentType: EmploymentType;
  description: string | null;
  applyUrl: string;
  postedAt: number | null;
  raw?: unknown;
}

export interface JobRow {
  id: number;
  fingerprint: string;
  source: string;
  sourceId: string | null;
  title: string;
  company: string;
  location: string | null;
  remoteMode: RemoteMode;
  employmentType: EmploymentType;
  description: string | null;
  applyUrl: string;
  postedAt: number | null;
  fetchedAt: number;
  updatedAt: number;
  sources: JobSourceRef[];
}

interface RawJobRow {
  id: number;
  fingerprint: string;
  source: string;
  source_id: string | null;
  title: string;
  company: string;
  location: string | null;
  remote_mode: string;
  employment_type: string;
  description: string | null;
  apply_url: string;
  posted_at: number | null;
  fetched_at: number;
  updated_at: number;
  sources_json: string;
}

function toJob(row: RawJobRow): JobRow {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    company: row.company,
    location: row.location,
    remoteMode: row.remote_mode as RemoteMode,
    employmentType: row.employment_type as EmploymentType,
    description: row.description,
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
    sources: parseJson<JobSourceRef[]>(row.sources_json, []),
  };
}

export interface UpsertResult {
  id: number;
  inserted: boolean;
}

/**
 * Inserts a job, or merges into the existing row when the fingerprint matches.
 * Merging keeps every source that listed the posting so the UI can still credit
 * all of them, while `apply_url` prefers the first source that supplied a
 * direct application link.
 */
export function upsertJob(job: NormalizedJob, db: DatabaseSync = getDb()): UpsertResult {
  const fingerprint = fingerprintJob(job);
  const ts = nowMs();
  const ref: JobSourceRef = {
    source: job.source,
    sourceId: job.sourceId,
    url: job.applyUrl,
    applyUrl: job.applyUrl,
  };

  const existing = db
    .prepare("SELECT id, sources_json FROM jobs WHERE fingerprint = ?")
    .get(fingerprint) as { id: number; sources_json: string } | undefined;

  if (existing) {
    const sources = parseJson<JobSourceRef[]>(existing.sources_json, []);
    const alreadyListed = sources.some(
      (s) => s.source === ref.source && s.sourceId === ref.sourceId,
    );
    if (!alreadyListed) sources.push(ref);

    db.prepare(
      `UPDATE jobs SET
         location = COALESCE(?, location),
         remote_mode = CASE WHEN ? <> 'unknown' THEN ? ELSE remote_mode END,
         employment_type = CASE WHEN ? <> 'unknown' THEN ? ELSE employment_type END,
         description = COALESCE(?, description),
         posted_at = COALESCE(posted_at, ?),
         updated_at = ?,
         sources_json = ?
       WHERE id = ?`,
    ).run(
      job.location,
      job.remoteMode,
      job.remoteMode,
      job.employmentType,
      job.employmentType,
      job.description,
      job.postedAt,
      ts,
      JSON.stringify(sources),
      existing.id,
    );

    return { id: existing.id, inserted: false };
  }

  const info = db
    .prepare(
      `INSERT INTO jobs (
         fingerprint, source, source_id, title, company, location, remote_mode,
         employment_type, description, apply_url, posted_at, fetched_at, updated_at,
         sources_json, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fingerprint,
      job.source,
      job.sourceId,
      job.title,
      job.company,
      job.location,
      job.remoteMode,
      job.employmentType,
      job.description,
      job.applyUrl,
      job.postedAt,
      ts,
      ts,
      JSON.stringify([ref]),
      job.raw === undefined ? null : JSON.stringify(job.raw),
    );

  return { id: Number(info.lastInsertRowid), inserted: true };
}

export function getJob(id: number, db: DatabaseSync = getDb()): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJobRow | undefined;
  return row ? toJob(row) : null;
}

export function findJobByFingerprint(
  fingerprint: string,
  db: DatabaseSync = getDb(),
): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE fingerprint = ?").get(fingerprint) as
    | RawJobRow
    | undefined;
  return row ? toJob(row) : null;
}

export interface JobWithStatus extends JobRow {
  status: JobStatusValue;
}

/**
 * Every stored job with its applied/seen state joined in. `new` is the absence
 * of a row in job_status, so the COALESCE is what makes the default explicit.
 */
export function listJobsWithStatus(
  db: DatabaseSync = getDb(),
  limit = 5000,
): JobWithStatus[] {
  const rows = db
    .prepare(
      `SELECT j.*, COALESCE(s.status, 'new') AS status
         FROM jobs j
         LEFT JOIN job_status s ON s.job_id = j.id
        ORDER BY COALESCE(j.posted_at, j.fetched_at) DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as Array<RawJobRow & { status: string }>;

  return rows.map((row) => ({ ...toJob(row), status: row.status as JobStatusValue }));
}

export function countJobs(db: DatabaseSync = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
  return Number(row.n);
}
