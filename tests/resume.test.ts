import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractProfile, splitSections } from "@/lib/extract/deterministic";
import { canonicalSkill, matchSkills } from "@/lib/extract/lexicon";
import { extractText } from "@/lib/extract/text";

const pdfPath = path.join(process.cwd(), "data", "fixtures", "resume.pdf");

describe("lexicon", () => {
  it("finds skills and counts them", () => {
    const hits = matchSkills("I write TypeScript and React. TypeScript all day.");
    const byName = Object.fromEntries(hits.map((h) => [h.canonical, h.count]));
    expect(byName.TypeScript).toBe(2);
    expect(byName.React).toBe(1);
  });

  it("respects word boundaries so identifiers do not false-positive", () => {
    const names = matchSkills("see node_modules and goto and my_r_lang").map((h) => h.canonical);
    expect(names).not.toContain("Node.js");
    expect(names).not.toContain("Go");
  });

  it("canonicalises aliases both ways", () => {
    expect(canonicalSkill("ts")).toBe("TypeScript");
    expect(canonicalSkill("k8s")).toBe("Kubernetes");
    expect(canonicalSkill("TypeScript")).toBe("TypeScript");
    expect(canonicalSkill("Welding")).toBe("Welding");
  });

  it("matches symbols like c++ and c#", () => {
    const names = matchSkills("I know C++ and C# and .NET").map((h) => h.canonical);
    expect(names).toEqual(expect.arrayContaining(["C++", "C#", ".NET"]));
  });
});

describe("sectioning", () => {
  it("splits on recognisable headers", () => {
    const sections = splitSections(
      ["Jane Doe", "Skills:", "React, TypeScript", "Work Experience", "Dev at Acme"].join("\n"),
    );
    expect(sections.header).toContain("Jane Doe");
    expect(sections.skills).toContain("React");
    expect(sections.experience).toContain("Dev at Acme");
  });
});

describe.skipIf(!existsSync(pdfPath))("profile extraction (real CV fixture)", () => {
  it("produces a coherent profile", async () => {
    const { text } = await extractText(readFileSync(pdfPath), "resume.pdf");
    const profile = extractProfile(text);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          fullName: profile.fullName,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          headline: profile.headline,
          years: profile.yearsExperience,
          seniority: profile.seniority,
          titles: profile.titles,
          locations: profile.locations,
          keywords: profile.keywords,
        },
        null,
        2,
      ),
    );

    expect(profile.fullName?.toLowerCase()).toContain("matthew");
    expect(profile.phone).not.toBeNull();
    expect(profile.yearsExperience).toBeGreaterThan(0);
    expect(profile.titles.length).toBeGreaterThan(0);
    expect(profile.keywords.length).toBeGreaterThan(4);
    expect(profile.sections.experience).toBeTruthy();
  });
});
