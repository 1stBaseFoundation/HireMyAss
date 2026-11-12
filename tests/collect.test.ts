import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "@/lib/db";
import { countJobs } from "@/lib/db/jobs";
import { collectJobs } from "@/lib/sources/collect";

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "sources");
const read = (file: string) => readFileSync(path.join(fixtureDir, file), "utf8");

describe("collectJobs", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  it("fetches, persists, then serves the second call from cache", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(read("arbeitnow.json"), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await collectJobs({}, { sourceIds: ["arbeitnow"], db, fetchImpl });
    expect(first.outcomes[0]!.ok).toBe(true);
    expect(first.outcomes[0]!.cached).toBe(false);
    expect(first.outcomes[0]!.fetched).toBeGreaterThan(0);
    expect(calls).toBe(1);
    expect(countJobs(db)).toBeGreaterThan(0);

    const second = await collectJobs({}, { sourceIds: ["arbeitnow"], db, fetchImpl });
    expect(second.allCached).toBe(true);
    expect(calls).toBe(1); // no second network call inside the TTL
  });

  it("refetches when forced", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(read("arbeitnow.json"), { status: 200 });
    }) as unknown as typeof fetch;

    await collectJobs({}, { sourceIds: ["arbeitnow"], db, fetchImpl });
    await collectJobs({}, { sourceIds: ["arbeitnow"], db, fetchImpl, force: true });
    expect(calls).toBe(2);
  });

  it("isolates one failing source from the rest", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("jobicy")) {
        return new Response("boom", { status: 503 });
      }
      return new Response(read("arbeitnow.json"), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await collectJobs({}, { sourceIds: ["arbeitnow", "jobicy"], db, fetchImpl });
    const byId = Object.fromEntries(result.outcomes.map((o) => [o.source, o]));

    expect(byId.arbeitnow!.ok).toBe(true);
    expect(byId.jobicy!.ok).toBe(false);
    expect(byId.jobicy!.error).toContain("503");
    expect(result.jobs.length).toBeGreaterThan(0);
  });

  it("does not duplicate jobs on repeated collection", async () => {
    const fetchImpl = (async () =>
      new Response(read("himalayas.json"), { status: 200 })) as unknown as typeof fetch;

    await collectJobs({}, { sourceIds: ["himalayas"], db, fetchImpl });
    const afterFirst = countJobs(db);
    await collectJobs({}, { sourceIds: ["himalayas"], db, fetchImpl, force: true });
    expect(countJobs(db)).toBe(afterFirst);
  });
});
