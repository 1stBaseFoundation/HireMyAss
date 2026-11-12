import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "@/lib/db";
import { listJobsWithStatus, upsertJob, type NormalizedJob } from "@/lib/db/jobs";
import {
  confirmProfile,
  getConfirmedProfile,
  getProfile,
  isProfileConfirmed,
  ProfileNotConfirmedError,
  saveProfile,
  updateProfileKeywords,
} from "@/lib/db/profile";
import { mergeAcrossSources } from "@/lib/match/dedupe";
import { isStatusVisible, matchesFilters, visibleStatuses } from "@/lib/match/filters";
import { buildIdf } from "@/lib/match/score";
import { searchJobs } from "@/lib/match/search";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const DAY = 86_400_000;

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: "himalayas",
    sourceId: `id-${Math.random().toString(36).slice(2)}`,
    title: "Senior React Developer",
    company: "Acme Corp",
    location: "Remote, Europe",
    remoteMode: "remote",
    employmentType: "full_time",
    description: "Build React and TypeScript apps with Node.js.",
    applyUrl: "https://example.test/apply",
    postedAt: NOW - DAY,
    ...overrides,
  };
}

function seedProfile(db: DatabaseSync, keywords: string[]) {
  saveProfile(
    {
      fullName: "Jane Doe",
      headline: "Senior Developer",
      email: "jane@example.test",
      phone: null,
      location: "Berlin",
      yearsExperience: 8,
      seniority: "senior",
      rawText: "cv",
      keywords,
      titles: ["Senior Developer"],
      locations: ["Berlin", "Germany"],
      sourceFile: "cv.pdf",
      parseMethod: "pdf-text",
    },
    db,
  );
  return confirmProfile(db)!;
}

describe("scoring", () => {
  it("ranks a matching job above an unrelated one", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const profile = seedProfile(db, ["React", "TypeScript", "Node.js"]);

    const matching = upsertJob(job({ company: "Acme", title: "React Developer" }), db);
    const unrelated = upsertJob(
      job({
        company: "Other",
        title: "Registered Nurse",
        description: "Patient care and triage.",
      }),
      db,
    );

    const { jobs } = searchJobs(profile, {}, db, NOW);
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));

    expect(byId[matching.id]!.score).toBeGreaterThan(byId[unrelated.id]!.score);
    // Floor is deliberately modest: IDF over a 2-job corpus is tiny, so an
    // exact-role match lands mid-range rather than near 100. Against real
    // boards the same job scores in the 80s.
    expect(byId[matching.id]!.score).toBeGreaterThan(40);
    expect(byId[matching.id]!.reasons.join(" ")).toContain("title");
  });

  it("keeps scores inside 0..100 and explains them", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const profile = seedProfile(db, ["React"]);
    upsertJob(job(), db);

    const { jobs } = searchJobs(profile, {}, db, NOW);
    const result = jobs[0]!;
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.length).toBeLessThanOrEqual(5);
  });

  it("weights rare terms above ubiquitous ones", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    for (let i = 0; i < 9; i += 1) {
      upsertJob(job({ company: `C${i}`, title: `React Dev ${i}`, description: "React" }), db);
    }
    upsertJob(job({ company: "Z", title: "Solidity Engineer", description: "Solidity" }), db);

    const idf = buildIdf(listJobsWithStatus(db), ["React", "Solidity"]);
    expect(idf.get("solidity")!).toBeGreaterThan(idf.get("react")!);
  });
});

describe("dedupe across sources", () => {
  it("collapses the same posting listed by two boards", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    upsertJob(job({ source: "himalayas", title: "React Developer", company: "Acme" }), db);
    upsertJob(
      job({
        source: "jobicy",
        title: "React Developer (m/f/d)",
        company: "Acme",
        location: "Anywhere",
      }),
      db,
    );

    const merged = mergeAcrossSources(listJobsWithStatus(db));

    expect(merged).toHaveLength(1);
    expect(merged[0]!.sourceIds.sort()).toEqual(["himalayas", "jobicy"]);
    expect(merged[0]!.sources).toHaveLength(2);
  });
});

describe("filters", () => {
  const base = job();

  it("filters by employment type and remote mode", () => {
    expect(matchesFilters(base, { employmentTypes: ["contract"] })).toBe(false);
    expect(matchesFilters(base, { employmentTypes: ["full_time"] })).toBe(true);
    expect(matchesFilters(base, { remoteModes: ["onsite"] })).toBe(false);
    expect(matchesFilters(base, { remoteModes: ["remote"] })).toBe(true);
  });

  it("keeps jobs whose type is unknown when a type filter is set", () => {
    const unknown = job({ employmentType: "unknown" });
    expect(matchesFilters(unknown, { employmentTypes: ["contract"] })).toBe(true);
  });

  it("applies the 24h / 3d / 7d windows", () => {
    const fresh = job({ postedAt: NOW - 2 * 3600 * 1000 });
    const old = job({ postedAt: NOW - 5 * DAY });
    const undated = job({ postedAt: null });

    expect(matchesFilters(fresh, { postedWithinDays: 1 }, NOW)).toBe(true);
    expect(matchesFilters(old, { postedWithinDays: 1 }, NOW)).toBe(false);
    expect(matchesFilters(old, { postedWithinDays: 7 }, NOW)).toBe(true);
    expect(matchesFilters(undated, { postedWithinDays: 7 }, NOW)).toBe(false);
  });

  it("matches location text against location, mode and title", () => {
    expect(matchesFilters(base, { location: "remote" })).toBe(true);
    expect(matchesFilters(base, { location: "europe" })).toBe(true);
    expect(matchesFilters(base, { location: "berlin" })).toBe(false);
  });
});

describe("applied / seen semantics", () => {
  it("hides applied and dismissed jobs forever", () => {
    expect(isStatusVisible("applied", false)).toBe(false);
    expect(isStatusVisible("dismissed", false)).toBe(false);
    expect(isStatusVisible("seen", false)).toBe(true);
    expect(visibleStatuses(false)).toEqual(["new", "seen"]);
  });

  it("strict mode hides seen jobs as well", () => {
    expect(isStatusVisible("seen", true)).toBe(false);
    expect(visibleStatuses(true)).toEqual(["new"]);
  });

  it("omits an applied job from the result set", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const profile = seedProfile(db, ["React"]);
    const kept = upsertJob(job({ company: "Keep" }), db);
    const applied = upsertJob(job({ company: "Applied" }), db);

    db.prepare(
      "INSERT INTO job_status (job_id, status, applied_at, updated_at) VALUES (?, 'applied', ?, ?)",
    ).run(applied.id, NOW, NOW);

    const { jobs, stats } = searchJobs(profile, {}, db, NOW);
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(applied.id);
    expect(stats.hiddenByStatus).toBe(1);
  });
});

describe("review gate", () => {
  it("refuses to hand out a profile before confirmation", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(getProfile(db)).toBeNull();
    expect(() => getConfirmedProfile(db)).toThrow(ProfileNotConfirmedError);
  });

  it("confirming unlocks the profile, editing re-locks it", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    seedProfile(db, ["React"]);
    expect(isProfileConfirmed(getProfile(db))).toBe(true);

    updateProfileKeywords(["React", "TypeScript"], db);
    // An edit changes the search terms, so confirmation must be given again.
    expect(isProfileConfirmed(getProfile(db))).toBe(false);
    expect(() => getConfirmedProfile(db)).toThrow(ProfileNotConfirmedError);
  });

  it("migrates a v1 database that lacks the v2 columns", () => {
    const db = openDatabase(":memory:");
    // Simulate a v1 profile table: no confirmed_at / confidence_json.
    db.exec(`CREATE TABLE profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      full_name TEXT, headline TEXT, email TEXT, phone TEXT, location TEXT,
      years_experience REAL, seniority TEXT, raw_text TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]', titles_json TEXT NOT NULL DEFAULT '[]',
      locations_json TEXT NOT NULL DEFAULT '[]', source_file TEXT, parse_method TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);

    expect(() => migrate(db)).not.toThrow();
    const columns = (
      db.prepare("PRAGMA table_info(profile)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("confirmed_at");
    expect(columns).toContain("confidence_json");
  });
});

