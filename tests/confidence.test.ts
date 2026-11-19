import { describe, expect, it } from "vitest";
import { extractProfile } from "@/lib/extract/deterministic";
import {
  assessProfile,
  defaultConfirmedKeywords,
  readConfidence,
} from "@/lib/extract/confidence";

const RESUME = [
  "Jane Q Doe",
  "jane.doe@example.com | London",
  "Summary",
  "I have shipped several React dashboards.",
  "Skills:",
  "TypeScript, PostgreSQL, Docker",
  "Work Experience",
  "Senior Developer",
  "Acme Ltd 2019 - 2023",
].join("\n");

function findKeyword(confidence: ReturnType<typeof assessProfile>, keyword: string) {
  const hit = confidence.keywords.find(
    (item) => item.keyword.toLowerCase() === keyword.toLowerCase(),
  );
  if (!hit) throw new Error(`no assessment for "${keyword}"`);
  return hit;
}

describe("keyword provenance", () => {
  it("marks a skills-list term high and a prose mention medium", () => {
    const base = extractProfile(RESUME);
    const confidence = assessProfile(base, RESUME);

    expect(findKeyword(confidence, "TypeScript")).toMatchObject({
      provenance: "skills-section",
      confidence: "high",
      included: true,
    });
    expect(findKeyword(confidence, "React")).toMatchObject({
      provenance: "prose",
      confidence: "medium",
      included: true,
    });
  });

  it("keeps an unevidenced model keyword out of the confirmed set", () => {
    const base = extractProfile(RESUME);
    const confidence = assessProfile(base, RESUME, {
      modelKeywords: ["Kubernetes"],
    });

    const kubernetes = findKeyword(confidence, "Kubernetes");
    expect(kubernetes).toMatchObject({
      provenance: "model",
      confidence: "low",
      included: false,
    });
    expect(defaultConfirmedKeywords(base.keywords.concat("Kubernetes"), confidence)).not.toContain(
      "Kubernetes",
    );
  });

  it("upgrades a model keyword the résumé actually supports", () => {
    const text = `${RESUME}\nAlso comfortable with Kubernetes in production.`;
    const base = extractProfile(text);
    const confidence = assessProfile(base, text, { modelKeywords: ["Kubernetes"] });

    expect(findKeyword(confidence, "Kubernetes")).toMatchObject({
      confidence: "medium",
      included: true,
    });
  });
});

describe("field provenance", () => {
  it("distinguishes stated experience from a derived date span", () => {
    const derived = assessProfile(extractProfile(RESUME), RESUME);
    expect(derived.fields.yearsExperience).toMatchObject({
      provenance: "derived",
      confidence: "medium",
      included: true,
    });

    const stated = "Jane Doe\n9 years of experience building things.";
    const explicit = assessProfile(extractProfile(stated), stated);
    expect(explicit.fields.yearsExperience).toMatchObject({
      provenance: "explicit",
      confidence: "high",
    });
  });

  it("reports absent contact details as gaps instead of inventing them", () => {
    const noContact = "Jane Q Doe\nSkills:\nTypeScript, React\nWork Experience\nDeveloper";
    const confidence = assessProfile(extractProfile(noContact), noContact);

    expect(confidence.fields.email).toMatchObject({
      provenance: "missing",
      included: false,
    });
    expect(confidence.gaps).toEqual(expect.arrayContaining(["email", "phone"]));
  });

  it("downgrades a model-filled field and surfaces the contradiction", () => {
    const base = extractProfile(RESUME);
    const confidence = assessProfile(base, RESUME, {
      modelFields: ["location"],
      contradictions: [{ field: "location", proposed: "Berlin", kept: "London" }],
    });

    expect(confidence.fields.location).toMatchObject({
      confidence: "low",
      included: false,
    });
    expect(confidence.fields.location.note).toContain("Berlin");
  });

  it("round-trips through the stored JSON shape", () => {
    const confidence = assessProfile(extractProfile(RESUME), RESUME);
    const stored = JSON.parse(JSON.stringify(confidence)) as unknown;

    expect(readConfidence(stored)).toEqual(confidence);
    expect(readConfidence({ nonsense: true })).toBeNull();
    expect(readConfidence(undefined)).toBeNull();
  });
});
