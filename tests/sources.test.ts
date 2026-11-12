import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ashbySource, greenhouseSource, leverSource } from "@/lib/sources/ats";
import { arbeitnow, himalayas, jobicy, remoteok, remotive } from "@/lib/sources/boards";
import {
  inferEmploymentType,
  inferRemoteMode,
  stripHtml,
  toEpochMs,
} from "@/lib/sources/normalize";
import type { JobSource } from "@/lib/sources/types";

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "sources");

/** Serves a captured response instead of hitting the network. */
function stubFetch(file: string, status = 200): typeof fetch {
  const body = readFileSync(path.join(fixtureDir, file), "utf8");
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const ENUMS = {
  remoteMode: ["remote", "hybrid", "onsite", "unknown"],
  employmentType: ["full_time", "part_time", "contract", "internship", "temporary", "unknown"],
};

async function assertWellFormed(source: JobSource, file: string): Promise<number> {
  const jobs = await source.fetchJobs({}, { fetchImpl: stubFetch(file) });
  expect(jobs.length).toBeGreaterThan(0);

  for (const job of jobs) {
    expect(job.source).toBe(source.id);
    expect(job.title.length).toBeGreaterThan(0);
    expect(job.company.length).toBeGreaterThan(0);
    expect(job.applyUrl).toMatch(/^https?:\/\//);
    expect(ENUMS.remoteMode).toContain(job.remoteMode);
    expect(ENUMS.employmentType).toContain(job.employmentType);
    expect(job.postedAt === null || typeof job.postedAt === "number").toBe(true);
    // Descriptions must never carry raw HTML into the UI.
    if (job.description) expect(job.description).not.toMatch(/<[a-z][^>]*>/i);
  }
  return jobs.length;
}

describe("normalize helpers", () => {
  it("converts seconds, milliseconds and ISO dates to ms epoch", () => {
    expect(toEpochMs(1794466521)).toBe(1794466521000);
    expect(toEpochMs(1794466521000)).toBe(1794466521000);
    expect(toEpochMs("2026-11-10T14:25:05")).toBe(Date.parse("2026-11-10T14:25:05"));
    expect(toEpochMs(0)).toBeNull();
    expect(toEpochMs("")).toBeNull();
    expect(toEpochMs("not a date")).toBeNull();
  });

  it("maps employment-type phrasing", () => {
    expect(inferEmploymentType("Full-Time")).toBe("full_time");
    expect(inferEmploymentType("part time")).toBe("part_time");
    expect(inferEmploymentType("Contract")).toBe("contract");
    expect(inferEmploymentType("Regular Full Time (Salary)")).toBe("full_time");
    expect(inferEmploymentType("Fixed Term")).toBe("contract");
    expect(inferEmploymentType("")).toBe("unknown");
  });

  it("treats an explicit boolean as authoritative", () => {
    // Arbeitnow returns remote:false for genuinely on-site roles.
    expect(inferRemoteMode(false, "Berlin")).toBe("onsite");
    expect(inferRemoteMode(true, "Berlin")).toBe("remote");
    expect(inferRemoteMode("Hybrid", "New York")).toBe("hybrid");
    expect(inferRemoteMode(null, "Remote, Europe")).toBe("remote");
    expect(inferRemoteMode(null, "Berlin, Germany")).toBe("unknown");
  });

  it("strips html and decodes entities", () => {
    expect(stripHtml("<p>Hello <b>World</b></p><li>a &amp; b</li>")).toBe("Hello World\na & b");
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml("   ")).toBeNull();
  });
});

describe("source adapters against captured fixtures", () => {
  it("arbeitnow", async () => {
    expect(await assertWellFormed(arbeitnow, "arbeitnow.json")).toBeGreaterThan(0);
  });

  it("remotive", async () => {
    expect(await assertWellFormed(remotive, "remotive.json")).toBeGreaterThan(0);
  });

  it("jobicy", async () => {
    expect(await assertWellFormed(jobicy, "jobicy.json")).toBeGreaterThan(0);
  });

  it("remoteok skips the legal-notice element", async () => {
    const count = await assertWellFormed(remoteok, "remoteok.json");
    const jobs = await remoteok.fetchJobs({}, { fetchImpl: stubFetch("remoteok.json") });
    expect(count).toBeGreaterThan(0);
    // The fixture keeps element 0 (the legal notice); it must not become a job.
    expect(jobs.every((job) => job.title.toLowerCase() !== "legal")).toBe(true);
    expect(jobs.some((job) => job.company === "Unknown")).toBe(false);
  });

  it("himalayas", async () => {
    expect(await assertWellFormed(himalayas, "himalayas.json")).toBeGreaterThan(0);
  });

  it("greenhouse exposes a direct application URL", async () => {
    const source = greenhouseSource([{ board: "gitlab" }]);
    const jobs = await source.fetchJobs({}, { fetchImpl: stubFetch("greenhouse.json") });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]!.applyUrl).toMatch(/job-boards\.greenhouse\.io|boards\.greenhouse\.io/);
  });

  it("lever", async () => {
    expect(await assertWellFormed(leverSource([{ board: "leverdemo" }]), "lever.json")).toBeGreaterThan(0);
  });

  it("ashby uses the workplace type and a real apply URL", async () => {
    const source = ashbySource([{ board: "ramp" }]);
    const jobs = await source.fetchJobs({}, { fetchImpl: stubFetch("ashby.json") });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((job) => job.applyUrl.includes("/application"))).toBe(true);
    expect(jobs.some((job) => job.remoteMode === "hybrid" || job.remoteMode === "remote")).toBe(true);
  });

  it("isolates a broken ATS board instead of failing the source", async () => {
    let call = 0;
    const flaky = (async () => {
      call += 1;
      if (call === 1) return new Response("nope", { status: 500 });
      return new Response(readFileSync(path.join(fixtureDir, "greenhouse.json"), "utf8"), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const source = greenhouseSource([{ board: "broken" }, { board: "gitlab" }]);
    const jobs = await source.fetchJobs({}, { fetchImpl: flaky });
    expect(jobs.length).toBeGreaterThan(0);
  });
});
