import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractText, OCR_THRESHOLD, sniffType } from "@/lib/extract/text";

/**
 * The PDF/DOCX fixtures are the user's own resume, so they live in data/
 * (gitignored) rather than tests/fixtures. These tests skip when absent.
 */
const fixtureDir = path.join(process.cwd(), "data", "fixtures");
const pdfPath = path.join(fixtureDir, "resume.pdf");

describe("type sniffing", () => {
  it("detects pdf by magic bytes, not extension", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
    expect(sniffType(pdf)).toBe("pdf");
  });

  it("detects docx (zip container)", () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(sniffType(docx)).toBe("docx");
  });

  it("detects plain text", () => {
    expect(sniffType(new TextEncoder().encode("just some words\n"))).toBe("text");
  });

  it("rejects binary junk", () => {
    expect(sniffType(new Uint8Array([0, 1, 2, 3, 0, 0]))).toBe("unknown");
  });
});

describe("plain text extraction", () => {
  it("normalises whitespace and newlines", async () => {
    const buffer = new TextEncoder().encode("Line one   \r\n\r\n\r\n\r\nLine two\t\n");
    const result = await extractText(buffer, "cv.txt");
    expect(result.method).toBe("plain");
    expect(result.needsOcr).toBe(false);
    expect(result.text).toBe("Line one\n\nLine two");
  });
});

describe.skipIf(!existsSync(pdfPath))("pdf extraction (real resume fixture)", () => {
  it("pulls a usable text layer", async () => {
    const buffer = readFileSync(pdfPath);
    expect(sniffType(buffer)).toBe("pdf");

    const result = await extractText(buffer, "resume.pdf");
    expect(result.method).toBe("pdf-text");
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(OCR_THRESHOLD);
    expect(result.needsOcr).toBe(false);
    expect(result.text.toLowerCase()).toContain("matthew");
  });

  it("does not leave stray control characters", async () => {
    const result = await extractText(readFileSync(pdfPath), "resume.pdf");
    expect(result.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});
