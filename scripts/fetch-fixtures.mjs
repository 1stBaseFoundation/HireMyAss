#!/usr/bin/env node
/**
 * Captures one live response per job source into tests/fixtures/sources/.
 * Adapter tests run against these fixtures, so the suite never touches the
 * network (and never trips Remotive's 4-requests-per-day cap).
 *
 *   node scripts/fetch-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "tests", "fixtures", "sources");
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  {
    id: "arbeitnow",
    url: "https://www.arbeitnow.com/api/job-board-api",
    trim: (json) => ({ ...json, data: json.data?.slice(0, 3) }),
  },
  {
    id: "remotive",
    url: "https://remotive.com/api/remote-jobs?limit=3",
    trim: (json) => ({ ...json, jobs: json.jobs?.slice(0, 3) }),
  },
  {
    id: "jobicy",
    url: "https://jobicy.com/api/v2/remote-jobs?count=3",
    trim: (json) => ({ ...json, jobs: json.jobs?.slice(0, 3) }),
  },
  {
    id: "remoteok",
    url: "https://remoteok.com/api",
    // element 0 is a legal notice; keep it so the adapter's handling is tested
    trim: (json) => (Array.isArray(json) ? [json[0], ...json.slice(1, 3)] : json),
  },
  {
    id: "himalayas",
    url: "https://himalayas.app/jobs/api?limit=3",
    trim: (json) => ({ ...json, jobs: json.jobs?.slice(0, 3) }),
  },
  {
    id: "greenhouse",
    url: "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=false",
    trim: (json) => ({ ...json, jobs: json.jobs?.slice(0, 3) }),
  },
  {
    id: "lever",
    url: "https://api.lever.co/v0/postings/leverdemo?mode=json",
    trim: (json) => (Array.isArray(json) ? json.slice(0, 3) : json),
  },
  {
    id: "ashby",
    url: "https://api.ashbyhq.com/posting-api/job-board/ramp",
    trim: (json) => ({ ...json, jobs: json.jobs?.slice(0, 3) }),
  },
];

const results = [];

for (const target of TARGETS) {
  process.stdout.write(`  ... ${target.id}\r`);
  try {
    const res = await fetch(target.url, {
      headers: { "User-Agent": "HireMyAss/0.1 (local job aggregator)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      results.push([target.id, `HTTP ${res.status}`, null]);
      continue;
    }
    const raw = await res.json();
    const trimmed = target.trim(raw);
    const file = path.join(OUT, `${target.id}.json`);
    writeFileSync(file, JSON.stringify(trimmed, null, 2), "utf8");
    const bytes = Buffer.byteLength(JSON.stringify(trimmed));
    results.push([target.id, `${res.status} ok`, `${(bytes / 1024).toFixed(1)} KB`]);
  } catch (error) {
    results.push([target.id, "failed", error instanceof Error ? error.message : String(error)]);
  }
}

console.log("\n  fixture capture\n");
for (const [id, status, detail] of results) {
  console.log(`  ${status.startsWith("2") || status.includes("ok") ? "✓" : "✗"} ${id.padEnd(14)} ${status} ${detail ?? ""}`);
}
console.log(`\n  written to ${OUT}\n`);
