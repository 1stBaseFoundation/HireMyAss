import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPng, rasterizePdf } from "@/lib/extract/raster";

const pdfPath = path.join(process.cwd(), "data", "fixtures", "resume.pdf");

describe("png helper", () => {
  it("recognises png magic bytes", () => {
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(isPng(Buffer.from("not a png"))).toBe(false);
  });
});

describe.skipIf(!existsSync(pdfPath))("pdf rasterisation", () => {
  it("renders pages to real PNGs within the edge budget", async () => {
    const pages = await rasterizePdf(readFileSync(pdfPath), { scale: 1, maxPages: 1 });

    expect(pages).toHaveLength(1);
    expect(isPng(pages[0]!.png)).toBe(true);
    expect(pages[0]!.width).toBeGreaterThan(100);
    expect(pages[0]!.height).toBeGreaterThan(100);
    expect(Math.max(pages[0]!.width, pages[0]!.height)).toBeLessThanOrEqual(2200);

    // Keep one page around so the OCR path can be exercised by the smoke script.
    const outDir = path.join(process.cwd(), "data", "tmp");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "page1.png"), pages[0]!.png);
  }, 30_000);
});
