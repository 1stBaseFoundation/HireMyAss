import { describe, expect, it } from "vitest";
import type { JobRow } from "@/lib/db/jobs";
import { migrate, openDatabase } from "@/lib/db";
import { getProfile, saveProfile, updateProfileKeywords } from "@/lib/db/profile";
import type { RankingProfile } from "@/lib/match/score";
import { scoreJob } from "@/lib/match/score";
import {
  normalizePriorities,
  priorityFor,
  priorityMultiplier,
  prunePriorities,
} from "@/lib/match/priority";

const NOW = Date.parse("2026-11-12T12:00:00Z");

function job(overrides: Partial<JobRow>): JobRow {
  return {
    id: 1,
    fingerprint: "fp",
    source: "himalayas",
    sourceId: null,
    title: "React Developer",
    company: "Acme",
    location: "Remote",
    remoteMode: "remote",
    employmentType: "full_time",
    description: "Frontend work.",
    applyUrl: "https://example.test/apply",
    postedAt: NOW,
    fetchedAt: NOW,
    updatedAt: NOW,
    sources: [],
    ...overrides,
  };
}

function profile(overrides: Partial<RankingProfile> = {}): RankingProfile {
  return {
    keywords: ["React", "Communication"],
    titles: [],
    locations: [],
    location: null,
    seniority: null,
    yearsExperience: null,
    ...overrides,
  };
}

const reactJob = job({ id: 2, title: "React Developer", description: "Frontend work." });
const commsJob = job({
  id: 1,
  title: "Communication Lead",
  description: "Internal communication.",
});

/** Fixed IDF so the comparison is about priority, not corpus statistics. */
const IDF = new Map([
  ["react", 1],
  ["communication", 1],
]);

describe("priority map", () => {
  it("keeps only non-default, valid entries", () => {
    expect(
      normalizePriorities({
        React: "pin",
        Communication: "soften",
        TypeScript: "normal",
        Docker: "sometimes",
        "  Node.js  ": "pin",
      }),
    ).toEqual({ React: "pin", Communication: "soften", "Node.js": "pin" });
  });

  it("matches priorities case-insensitively", () => {
    expect(priorityFor({ react: "pin" }, "React")).toBe("pin");
    expect(priorityMultiplier({ react: "pin" }, "REACT")).toBeGreaterThan(1);
    expect(priorityMultiplier(undefined, "React")).toBe(1);
  });

  it("drops priorities for terms that left the profile", () => {
    expect(prunePriorities({ React: "pin", Docker: "soften" }, ["React"])).toEqual({
      React: "pin",
    });
  });
});

describe("priority changes the ranking", () => {
  it("pins the term the user cares about above an exact-title generic match", () => {
    const base = profile({ keywords: ["Communication"] });
    const unpinnedComms = scoreJob(commsJob, base, { idf: IDF, titleMultiplier: 5, now: NOW });
    const unpinnedReact = scoreJob(reactJob, profile(), { idf: IDF, titleMultiplier: 5, now: NOW });

    // Sanity: both jobs carry one title-level keyword hit.
    expect(unpinnedComms.titleMatches).toEqual(["Communication"]);
    expect(unpinnedReact.titleMatches).toEqual(["React"]);

    const pinned = scoreJob(reactJob, profile({ keywordPriority: { React: "pin" } }), {
      idf: IDF,
      titleMultiplier: 5,
      now: NOW,
    });

    expect(pinned.score).toBeGreaterThan(unpinnedComms.score);
    expect(pinned.score).toBeGreaterThan(unpinnedReact.score);
    expect(pinned.pinnedMatches).toEqual(["React"]);
    expect(pinned.reasons.join(" ")).toContain("pinned");
  });

  it("softens a term without hiding it as evidence", () => {
    const softened = scoreJob(commsJob, profile({ keywordPriority: { React: "soften" } }), {
      idf: IDF,
      titleMultiplier: 5,
      now: NOW,
    });
    const reactSoftened = scoreJob(reactJob, profile({ keywordPriority: { React: "soften" } }), {
      idf: IDF,
      titleMultiplier: 5,
      now: NOW,
    });

    // The softened React job still matches React — it just stops dominating.
    expect(reactSoftened.matchedKeywords).toContain("React");
    expect(softened.score).toBeGreaterThan(reactSoftened.score);
  });

  it("leaves scoring untouched when no priorities are set", () => {
    const a = scoreJob(reactJob, profile(), { idf: IDF, now: NOW });
    const b = scoreJob(reactJob, profile({ keywordPriority: {} }), { idf: IDF, now: NOW });
    expect(a.score).toBe(b.score);
    expect(a.pinnedMatches).toEqual([]);
  });
});

describe("priority persistence", () => {
  const input = {
    fullName: "Jane Doe",
    headline: "Senior Developer",
    email: "jane@example.test",
    phone: null,
    location: "Berlin",
    yearsExperience: 8,
    seniority: "senior",
    rawText: "cv",
    keywords: ["React", "TypeScript", "Communication"],
    titles: ["Senior Developer"],
    locations: ["Berlin"],
    sourceFile: "cv.pdf",
    parseMethod: "pdf-text",
  };

  it("survives an edit that does not mention it, and prunes removed terms", () => {
    const db = openDatabase(":memory:");
    migrate(db);

    saveProfile(input, db, {
      keywordPriority: { React: "pin", TypeScript: "soften" },
    });
    expect(getProfile(db)!.keywordPriority).toEqual({ React: "pin", TypeScript: "soften" });

    // A plain save keeps the user's choices.
    saveProfile({ ...input, headline: "Staff Engineer" }, db);
    expect(getProfile(db)!.keywordPriority).toEqual({ React: "pin", TypeScript: "soften" });

    // Dropping a keyword drops its priority with it.
    updateProfileKeywords(["React", "Communication"], db);
    expect(getProfile(db)!.keywordPriority).toEqual({ React: "pin" });
  });

  it("tolerates a stored map with unknown values", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    saveProfile(input, db);
    db.prepare(`UPDATE profile SET keyword_priority_json = ? WHERE id = 1`).run(
      JSON.stringify({ React: "pin", Docker: "loud", TypeScript: "normal" }),
    );

    expect(getProfile(db)!.keywordPriority).toEqual({ React: "pin" });
  });
});
