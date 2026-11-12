import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "@/lib/db";
import { countJobs, findJobByFingerprint, getJob, upsertJob } from "@/lib/db/jobs";
import type { NormalizedJob } from "@/lib/db/jobs";
import { getProfile, saveProfile, updateProfileKeywords } from "@/lib/db/profile";
import { getSourceRun, isFresh, recordSourceFailure, recordSourceSuccess } from "@/lib/db/sources";
import { fingerprintJob, looseFingerprint, normalizeTitle } from "@/lib/match/fingerprint";

function fresh(): DatabaseSync {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: "himalayas",
    sourceId: "abc-1",
    title: "Senior React Developer",
    company: "Acme Corp",
    location: "Remote, Europe",
    remoteMode: "remote",
    employmentType: "full_time",
    description: "Build things.",
    applyUrl: "https://example.test/apply/1",
    postedAt: Date.now(),
    ...overrides,
  };
}

describe("schema", () => {
  it("applies idempotently", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => String((r as { name: string }).name));
    expect(tables).toEqual(
      expect.arrayContaining(["applications", "job_status", "jobs", "profile", "source_runs"]),
    );
    db.close();
  });

  it("records the schema version", () => {
    const db = fresh();
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(row.user_version)).toBeGreaterThan(0);
    db.close();
  });
});

describe("jobs", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = fresh();
  });

  it("inserts then merges on repeat", () => {
    const first = upsertJob(job(), db);
    const second = upsertJob(job(), db);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(countJobs(db)).toBe(1);
  });

  it("enforces fingerprint uniqueness at the storage layer", () => {
    upsertJob(job(), db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (fingerprint, source, title, company, apply_url, fetched_at, updated_at)
           VALUES (?, 'x', 'T', 'C', 'u', 1, 1)`,
        )
        .run(fingerprintJob(job())),
    ).toThrow();
  });

  it("merges the same posting from different sources", () => {
    upsertJob(job({ source: "himalayas", sourceId: "abc-1" }), db);
    upsertJob(job({ source: "jobicy", sourceId: "99", applyUrl: "https://jobicy.test/99" }), db);
    const row = findJobByFingerprint(fingerprintJob(job()), db);
    expect(row).not.toBeNull();
    expect(row!.sources).toHaveLength(2);
    expect(row!.sources.map((s) => s.source).sort()).toEqual(["himalayas", "jobicy"]);
    expect(countJobs(db)).toBe(1);
  });

  it("does not overwrite known fields with unknown ones", () => {
    upsertJob(job(), db);
    upsertJob(
      job({
        source: "remoteok",
        sourceId: "r1",
        remoteMode: "unknown",
        employmentType: "unknown",
        location: null,
        description: null,
      }),
      db,
    );
    const row = findJobByFingerprint(fingerprintJob(job()), db)!;
    expect(row.remoteMode).toBe("remote");
    expect(row.employmentType).toBe("full_time");
    expect(row.location).toBe("Remote, Europe");
  });

  it("round-trips a job by id", () => {
    const { id } = upsertJob(job(), db);
    const row = getJob(id, db)!;
    expect(row.title).toBe("Senior React Developer");
    expect(row.company).toBe("Acme Corp");
    expect(row.applyUrl).toBe("https://example.test/apply/1");
  });

describe("fingerprints", () => {
  it("ignores hiring noise in titles", () => {
    expect(normalizeTitle("Senior Developer (m/f/d)")).toBe("senior developer");
    expect(normalizeTitle("Senior Developer - Remote")).toBe("senior developer");
    expect(normalizeTitle("Senior Developer [Hybrid]")).toBe("senior developer");
  });

  it("distinguishes locations but matches across sources with the same location", () => {
    const a = job({ location: "Berlin, Germany" });
    const b = job({ location: "Berlin, Germany", source: "jobicy" });
    const c = job({ location: "Lisbon, Portugal" });
    expect(fingerprintJob(a)).toBe(fingerprintJob(b));
    expect(fingerprintJob(a)).not.toBe(fingerprintJob(c));
  });

  it("loose fingerprint collapses location differences", () => {
    expect(looseFingerprint(job({ location: "Berlin" }))).toBe(
      looseFingerprint(job({ location: "Remote, EU" })),
    );
  });
});

describe("profile", () => {
  it("round-trips and edits keywords", () => {
    const db = fresh();
    expect(getProfile(db)).toBeNull();

    saveProfile(
      {
        fullName: "Matthew Tong",
        headline: "Senior Developer",
        email: "m@example.test",
        phone: null,
        location: "Berlin",
        yearsExperience: 8,
        seniority: "senior",
        rawText: "resume text",
        keywords: ["TypeScript", "React"],
        titles: ["Senior Developer"],
        locations: ["Berlin"],
        sourceFile: "cv.pdf",
        parseMethod: "pdf-text",
      },
      db,
    );

    const loaded = getProfile(db)!;
    expect(loaded.fullName).toBe("Matthew Tong");
    expect(loaded.yearsExperience).toBe(8);
    expect(loaded.keywords).toEqual(["TypeScript", "React"]);

    updateProfileKeywords(["TypeScript"], db);
    expect(getProfile(db)!.keywords).toEqual(["TypeScript"]);
    db.close();
  });
});

describe("source bookkeeping", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = fresh();
  });

  it("tracks success and computes freshness", () => {
    expect(isFresh("remotive", 1000, db)).toBe(false);
    recordSourceSuccess("remotive", { jobCount: 12 }, db);
    expect(isFresh("remotive", 60_000, db)).toBe(true);
    expect(getSourceRun("remotive", db)!.jobCount).toBe(12);
  });

  it("records failure without marking the source fresh", () => {
    recordSourceFailure("remotive", new Error("429 too many requests"), db);
    const run = getSourceRun("remotive", db)!;
    expect(run.lastError).toContain("429");
    expect(run.lastOkAt).toBeNull();
    expect(isFresh("remotive", 60_000, db)).toBe(false);
  });

  it("expires freshness after the TTL", () => {
    const at = Date.now();
    recordSourceSuccess("jobicy", { jobCount: 3 }, db);
    expect(isFresh("jobicy", 1000, db, at + 500)).toBe(true);
    expect(isFresh("jobicy", 1000, db, at + 5000)).toBe(false);
  });
});

});
