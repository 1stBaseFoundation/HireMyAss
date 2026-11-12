import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSource } from "@/lib/sources/registry";

/**
 * Live network test — skipped unless LIVE_SOURCES=1.
 *   $env:LIVE_SOURCES=1; npx vitest run tests/live-sources.test.ts
 *
 * Fixtures protect the suite from schema drift only until the provider changes
 * the shape; this is what catches that day.
 */
const RUN = process.env.LIVE_SOURCES === "1";
const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "sources");

/** Replays each captured fixture back to whichever source asks for it. */
function replayer(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const map: Array<[RegExp, string]> = [
      [/arbeitnow/i, "arbeitnow.json"],
      [/remotive/i, "remotive.json"],
      [/jobicy/i, "jobicy.json"],
      [/remoteok/i, "remoteok.json"],
      [/himalayas/i, "himalayas.json"],
      [/greenhouse/i, "greenhouse.json"],
      [/lever/i, "lever.json"],
      [/ashby/i, "ashby.json"],
    ];
    const hit = map.find(([pattern]) => pattern.test(url));
    if (!hit) return new Response("no fixture", { status: 404 });
    return new Response(readFileSync(path.join(fixtureDir, hit[1]), "utf8"), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("fixture replay sanity", () => {
  it("replays the right fixture per adapter", async () => {
    const arbeitnow = getSource("arbeitnow")!;
    const jobs = await arbeitnow.fetchJobs({}, { fetchImpl: replayer() });
    expect(jobs.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUN)("live source reachability", () => {
  const ids = [
    "arbeitnow",
    "remotive",
    "jobicy",
    "remoteok",
    "himalayas",
    "greenhouse",
    "lever",
    "ashby",
  ];

  for (const id of ids) {
    it(`${id} returns normalized jobs`, async () => {
      const source = getSource(id);
      expect(source, `source ${id} is registered`).toBeDefined();

      const jobs = await source!.fetchJobs({});
      // eslint-disable-next-line no-console
      console.log(`${id}: ${jobs.length} jobs, e.g. "${jobs[0]?.title}" @ ${jobs[0]?.company}`);

      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs.slice(0, 5)) {
        expect(job.applyUrl).toMatch(/^https?:\/\//);
        expect(job.title.length).toBeGreaterThan(0);
      }
    }, 60_000);
  }
});
