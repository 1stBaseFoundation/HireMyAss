import { createCanvas } from "@napi-rs/canvas";

export interface PageImage {
  page: number;
  width: number;
  height: number;
  png: Buffer;
}

export interface RasterOptions {
  /** 1.5 ≈ 108 DPI at A4 — enough for OCR without exploding token counts. */
  scale?: number;
  maxPages?: number;
  /** Hard ceiling on long edge; keeps the vision encoder inside its budget. */
  maxEdge?: number;
}

/**
 * Renders PDF pages to PNG so the vision model can read scans.
 *
 * Used only when the text layer is missing — a real scanned PDF. The canvas is
 * @napi-rs/canvas (prebuilt native, no toolchain needed on Windows).
 */
export async function rasterizePdf(
  buffer: Uint8Array,
  options: RasterOptions = {},
): Promise<PageImage[]> {
  const { scale = 1.5, maxPages = 4, maxEdge = 2200 } = options;

  // The legacy build is the one that works outside a browser (no Worker).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const pages: PageImage[] = [];
  const limit = Math.min(doc.numPages, maxPages);

  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height);
    const effectiveScale = longest > maxEdge ? (maxEdge / longest) * scale : scale;
    const viewport = page.getViewport({ scale: effectiveScale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    // pdf.js v6 wants both `canvasContext` and `canvas`; the type surface is
    // looser than the runtime, so the cast is deliberate and narrow.
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown,
    } as never).promise;

    const png = canvas.toBuffer("image/png");
    pages.push({
      page: pageNumber,
      width: canvas.width,
      height: canvas.height,
      png: Buffer.from(png),
    });
  }

  // pdf.js v6 exposes teardown on the loading task, not the document proxy.
  await loadingTask.destroy();
  return pages;
}

/** PNG magic bytes — cheap sanity check before shipping a buffer to the model. */
export function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

export function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}
