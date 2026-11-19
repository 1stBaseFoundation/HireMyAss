import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * DATA_DIR is redirected before any route module (and therefore lib/env) loads,
 * so these tests never touch the real database.
 */
process.env.DATA_DIR = path.join(process.cwd(), "data", "test-review-db");

const RESUME = [
  "Jane Q Doe",
  "jane.doe@example.test | London",
  "Skills:",
  "TypeScript, React, PostgreSQL",
  "Work Experience",
  "Senior Developer",
  "Acme Ltd 2019 - 2023",
].join("\n");

type Routes = {
  profile: typeof import("@/app/api/profile/route");
  confirm: typeof import("@/app/api/profile/confirm/route");
  search: typeof import("@/app/api/jobs/search/route");
};

let routes: Routes;
let extractProfile: typeof import("@/lib/extract/deterministic")["extractProfile"];
let assessProfile: typeof import("@/lib/extract/confidence")["assessProfile"];
let saveProfile: typeof import("@/lib/db/profile")["saveProfile"];
let getProfile: typeof import("@/lib/db/profile")["getProfile"];
let getDb: typeof import("@/lib/db")["getDb"];
let db: ReturnType<typeof getDb>;

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  routes = {
    profile: await import("@/app/api/profile/route"),
    confirm: await import("@/app/api/profile/confirm/route"),
    search: await import("@/app/api/jobs/search/route"),
  };
  ({ extractProfile } = await import("@/lib/extract/deterministic"));
  ({ assessProfile } = await import("@/lib/extract/confidence"));
  ({ saveProfile, getProfile } = await import("@/lib/db/profile"));
  ({ getDb } = await import("@/lib/db"));
  db = getDb();
});

beforeEach(() => {
  db.exec("DELETE FROM profile");
});

/** A draft parse whose model added an unevidenced keyword. */
function seedDraft() {
  const base = extractProfile(RESUME);
  const confidence = assessProfile(base, RESUME, {
    modelKeywords: ["Kubernetes"],
    modelFields: [],
  });
  saveProfile(
    {
      fullName: base.fullName,
      headline: base.headline,
      email: base.email,
      phone: base.phone,
      location: base.location,
      yearsExperience: base.yearsExperience,
      seniority: base.seniority,
      rawText: RESUME,
      keywords: [...base.keywords, "Kubernetes"],
      titles: base.titles,
      locations: base.locations,
      sourceFile: "cv.txt",
      parseMethod: "plain",
    },
    db,
    { confidence: confidence as unknown as Record<string, unknown> },
  );
}

describe("review API", () => {
  it("reports no profile before an upload", async () => {
    const response = await routes.profile.GET();
    const body = (await response.json()) as { profile: unknown; confidence: unknown };
    expect(body.profile).toBeNull();
    expect(body.confidence).toBeNull();
  });

  it("serves the draft with its confidence, and refuses to search it", async () => {
    seedDraft();

    const response = await routes.profile.GET();
    const body = (await response.json()) as {
      profile: { confirmedAt: number | null; keywords: string[] };
      confidence: { keywords: Array<{ keyword: string; included: boolean }> };
    };

    expect(body.profile.confirmedAt).toBeNull();
    expect(body.confidence.keywords.find((item) => item.keyword === "Kubernetes")).toMatchObject({
      confidence: "low",
      included: false,
    });

    const search = await routes.search.POST(post("http://test/api/jobs/search", {}));
    expect(search.status).toBe(428);
    const refusal = (await search.json()) as { code?: string };
    expect(refusal.code).toBe("PROFILE_NOT_CONFIRMED");
  });

  it("confirming with an empty body leaves low-confidence terms out", async () => {
    seedDraft();

    const response = await routes.confirm.POST(post("http://test/api/profile/confirm", {}));
    expect(response.status).toBe(200);

    const stored = getProfile(db)!;
    expect(stored.confirmedAt).not.toBeNull();
    expect(stored.keywords).toContain("React");
    expect(stored.keywords).not.toContain("Kubernetes");
  });

  it("persists the edited snapshot and the priority map", async () => {
    seedDraft();

    const response = await routes.confirm.POST(
      post("http://test/api/profile/confirm", {
        email: "jane@example.test",
        yearsExperience: 9,
        keywords: ["React", "TypeScript", "Kubernetes"],
        keywordPriority: { React: "pin", Kubernetes: "normal" },
      }),
    );
    expect(response.status).toBe(200);

    const stored = getProfile(db)!;
    expect(stored.email).toBe("jane@example.test");
    expect(stored.yearsExperience).toBe(9);
    // An explicit include overrides the low-confidence default.
    expect(stored.keywords).toContain("Kubernetes");
    // "normal" is the default and is not stored.
    expect(stored.keywordPriority).toEqual({ React: "pin" });
  });

  it("withdrawing confirmation re-locks search", async () => {
    seedDraft();
    await routes.confirm.POST(post("http://test/api/profile/confirm", {}));

    const withdrawn = await routes.confirm.DELETE();
    expect(withdrawn.status).toBe(200);
    expect(getProfile(db)!.confirmedAt).toBeNull();

    const search = await routes.search.POST(post("http://test/api/jobs/search", {}));
    expect(search.status).toBe(428);
  });

  it("rejects an invalid priority value", async () => {
    seedDraft();
    const response = await routes.confirm.POST(
      post("http://test/api/profile/confirm", {
        keywordPriority: { React: "loud" },
      }),
    );
    expect(response.status).toBe(400);
  });
});
