import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ocrPages } from "@/lib/extract/ocr";
import { rasterizePdf } from "@/lib/extract/raster";

/**
 * Live GPU test — skipped unless LIVE_VISION=1.
 *   $env:LIVE_VISION=1; npx vitest run tests/live-vision.test.ts
 *
 * Proves the scanned-PDF path end to end: render page -> vision model -> text.
 */
const RUN = process.env.LIVE_VISION === "1";
const pdfPath = path.join(process.cwd(), "data", "fixtures", "resume.pdf");

describe.skipIf(!RUN || !existsSync(pdfPath))("live vision OCR (scanned-PDF path)", () => {
  it("rasterises a real page and transcribes it", async () => {
    const pages = await rasterizePdf(readFileSync(pdfPath), { scale: 1.2, maxPages: 1 });
    expect(pages).toHaveLength(1);

    const result = await ocrPages(pages.map((page) => page.png));

    // eslint-disable-next-line no-console
    console.log(`OCR ${result.ok ? "ok" : "FAILED"} in ${result.ms} ms`);
    // eslint-disable-next-line no-console
    console.log(result.text.slice(0, 500));

    expect(result.ok).toBe(true);
    expect(result.text.length).toBeGreaterThan(100);
    expect(result.text.toLowerCase()).toContain("matthew");
  }, 300_000);
});
