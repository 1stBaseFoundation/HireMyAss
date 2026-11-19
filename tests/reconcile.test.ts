import { describe, expect, it } from "vitest";
import type { Profile } from "@/lib/db/profile";
import { assessProfile } from "@/lib/extract/confidence";
import { extractProfile } from "@/lib/extract/deterministic";
import { reconcileWithConfirmed } from "@/lib/extract/reconcile";

const TEXT = [
  "Jane Q Doe",
  "jane.doe@example.test | London",
  "Skills:",
  "TypeScript, React, PostgreSQL",
  "Work Experience",
  "Senior Developer",
  "Acme Ltd 2019 - 2023",
].join("\n");

function parse(text = TEXT) {
  const base = extractProfile(text);
  return { base, confidence: assessProfile(base, text) };
}

function previous(overrides: Partial<Profile> = {}): Profile {
  return {
    fullName: "Jane Q Doe",
    headline: "Senior Developer",
    email: "jane.doe@example.test",
    phone: null,
    location: "London",
    yearsExperience: 8,
    seniority: "senior",
    rawText: "old cv",
    keywords: ["React", "Kubernetes"],
    titles: ["Senior Developer"],
    locations: ["London"],
    sourceFile: "old.txt",
    parseMethod: "plain",
    confirmedAt: 1_700_000_000_000,
    confidence: {},
    keywordPriority: { React: "pin" },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("re-upload reconciliation", () => {
  it("lets the fresh parse win when nothing was confirmed", () => {
    const { base, confidence } = parse();
    const result = reconcileWithConfirmed(previous({ confirmedAt: null, email: "old@x.test" }), base, confidence);

    expect(result.values.email).toBe("jane.doe@example.test");
    expect(result.keywords).toEqual(base.keywords);
    expect(result.carriedFields).toEqual([]);
  });

  it("keeps a confirmed value the new résumé no longer mentions", () => {
    const noContact = "Jane Q Doe\nSkills:\nTypeScript\nWork Experience\nDeveloper";
    const { base, confidence } = parse(noContact);
    const result = reconcileWithConfirmed(previous(), base, confidence);

    expect(result.values.email).toBe("jane.doe@example.test");
    expect(result.carriedFields).toContain("email");
    expect(result.notes.join(" ")).toContain("does not mention it");
    expect(result.confidence.fields.email).toMatchObject({
      provenance: "confirmed",
      confidence: "high",
      included: true,
    });
  });

  it("lets the user's confirmed value beat a contradicting parse", () => {
    const moved = "Jane Q Doe\njane.doe@example.test | Berlin\nSkills:\nTypeScript, React";
    const { base, confidence } = parse(moved);
    const result = reconcileWithConfirmed(previous(), base, confidence);

    expect(result.values.location).toBe("London");
    expect(result.notes.join(" ")).toContain("Berlin");
    expect(result.confidence.fields.location.note).toContain("confirmed");
  });

  it("unions keywords and grades carried-over ones as confirmed", () => {
    const { base, confidence } = parse();
    const result = reconcileWithConfirmed(previous(), base, confidence);

    expect(result.keywords.slice(0, 2)).toEqual(["React", "Kubernetes"]);
    expect(result.keywords).toEqual(expect.arrayContaining(["TypeScript", "PostgreSQL"]));

    const kubernetes = result.confidence.keywords.find((item) => item.keyword === "Kubernetes");
    expect(kubernetes).toMatchObject({ provenance: "confirmed", included: true });
  });

  it("does not duplicate keywords the new parse still contains", () => {
    const { base, confidence } = parse();
    const result = reconcileWithConfirmed(previous(), base, confidence);

    const react = result.keywords.filter((keyword) => keyword.toLowerCase() === "react");
    expect(react).toHaveLength(1);
    expect(result.confidence.keywords.filter((item) => item.keyword === "React")).toHaveLength(1);
  });
});
