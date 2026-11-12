import { beforeAll, describe, expect, it } from "vitest";

/** Point the coordinator at a closed port before anything imports lib/env. */
process.env.COORDINATOR_URL = "http://127.0.0.1:59999";

type Extract = typeof import("@/lib/extract/llm-extract");
type Client = typeof import("@/lib/llm/client");
type Deterministic = typeof import("@/lib/extract/deterministic");

let enrichProfile: Extract["enrichProfile"];
let missingFields: Extract["missingFields"];
let extractJson: Client["extractJson"];
let extractProfile: Deterministic["extractProfile"];

beforeAll(async () => {
  ({ enrichProfile, missingFields } = await import("@/lib/extract/llm-extract"));
  ({ extractJson } = await import("@/lib/llm/client"));
  ({ extractProfile } = await import("@/lib/extract/deterministic"));
});

const RESUME = [
  "Jane Q Doe",
  "jane.doe@example.com | +44 7700 900123 | London",
  "Skills:",
  "TypeScript, React, Node.js, PostgreSQL, Docker",
  "Work Experience",
  "Senior Developer",
  "Acme Ltd 2019 - present",
].join("\n");

/** Same person, but with no contact block and no seniority cue — forces a model call. */
const THIN_RESUME = [
  "Jane Q Doe",
  "Skills:",
  "TypeScript, React, Node.js, PostgreSQL, Docker",
  "Work Experience",
  "Developer",
  "Acme Ltd 2019 - present",
].join("\n");

describe("deterministic result survives a dead model", () => {
  it("falls back without throwing when the coordinator is unreachable", async () => {
    const base = extractProfile(THIN_RESUME);
    const before = JSON.stringify(base.keywords);
    expect(missingFields(base).length).toBeGreaterThan(0);

    const result = await enrichProfile(base, THIN_RESUME, { timeoutMs: 2000 });

    expect(result.usedLlm).toBe(false);
    expect(result.note).toMatch(/model unavailable|skipped|unusable/i);
    expect(JSON.stringify(result.profile.keywords)).toBe(before);
    expect(result.profile.fullName?.toLowerCase()).toContain("jane");
  });

  it("skips the model entirely when nothing is missing", async () => {
    const base = extractProfile(RESUME);
    const complete = { ...base, seniority: "senior" as const, location: "London" };
    expect(missingFields(complete)).toEqual([]);

    const result = await enrichProfile(complete, RESUME);
    expect(result.usedLlm).toBe(false);
    expect(result.note).toContain("deterministic pass complete");
  });
});

describe("extractJson", () => {
  it("handles bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("handles fenced JSON with prose around it", () => {
    expect(extractJson('Sure!\n```json\n{"a":[1,2]}\n```\nHope that helps')).toEqual({ a: [1, 2] });
  });

  it("handles braces inside strings", () => {
    expect(extractJson('{"note":"a } b { c"}')).toEqual({ note: "a } b { c" });
  });

  it("returns null for unparseable output", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"broken":')).toBeNull();
  });
});
