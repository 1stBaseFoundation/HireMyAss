import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * DATA_DIR is redirected before the pipeline (and therefore lib/env) is
 * imported, so the test never touches the real local database.
 */
process.env.DATA_DIR = path.join(process.cwd(), "data", "test-db");

const pdfPath = path.join(process.cwd(), "data", "fixtures", "resume.pdf");

type Pipeline = typeof import("@/lib/extract/pipeline");
let ingestResume: Pipeline["ingestResume"];

beforeAll(async () => {
  ({ ingestResume } = await import("@/lib/extract/pipeline"));
});

describe("pipeline robustness", () => {
  it("rejects unsupported binary junk with a readable message", async () => {
    const junk = new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0]);
    await expect(ingestResume(junk, "thing.exe")).rejects.toThrow(/could not read any text|unsupported/i);
  });

  it("rejects an empty text file", async () => {
    await expect(ingestResume(new TextEncoder().encode("   "), "empty.txt")).rejects.toThrow(
      /could not read any text/i,
    );
  });

  it("parses a plain-text resume without any model", async () => {
    const text = [
      "Jane Q Doe",
      "jane.doe@example.com | +44 7700 900123 | London",
      "Skills:",
      "TypeScript, React, Node.js, PostgreSQL",
      "Work Experience",
      "Senior Developer",
      "Acme Ltd 2019 - present",
    ].join("\n");

    const result = await ingestResume(new TextEncoder().encode(text), "jane.txt", {
      allowLlm: false,
      allowOcr: false,
    });

    expect(result.parseMethod).toBe("plain");
    expect(result.llmUsed).toBe(false);
    expect(result.profile.fullName?.toLowerCase()).toContain("jane");
    expect(result.profile.email).toBe("jane.doe@example.com");
    expect(result.profile.keywords).toEqual(expect.arrayContaining(["TypeScript", "React"]));
  });
});

describe.skipIf(!existsSync(pdfPath))("pipeline on the real CV", () => {
  it("stores a complete profile offline", async () => {
    const result = await ingestResume(readFileSync(pdfPath), "resume.pdf", {
      allowLlm: false,
      allowOcr: false,
    });

    expect(result.parseMethod).toBe("pdf-text");
    expect(result.ocrUsed).toBe(false);
    expect(result.llmUsed).toBe(false);
    expect(result.textChars).toBeGreaterThan(200);
    expect(result.profile.fullName?.toLowerCase()).toContain("matthew");
    expect(result.profile.keywords.length).toBeGreaterThan(4);
    expect(result.profile.sourceFile).toBe("resume.pdf");
    expect(result.notes.join(" ")).toContain("deterministic");

    // persisted and readable back
    const { getProfile } = await import("@/lib/db/profile");
    const { getDb } = await import("@/lib/db");
    const stored = getProfile(getDb());
    expect(stored?.fullName).toBe(result.profile.fullName);
    expect(stored?.keywords).toEqual(result.profile.keywords);
  });
});
