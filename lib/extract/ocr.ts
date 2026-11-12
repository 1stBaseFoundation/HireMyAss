import { env } from "@/lib/env";
import { chat, LlmUnavailableError, visionUrl, type ContentPart } from "@/lib/llm/client";
import { toDataUrl } from "./raster";

/**
 * Vision OCR for scanned resumes.
 *
 * Deliberately terse prompt: formatting instructions make small VLMs
 * hallucinate structure. "Preserve line breaks, no commentary" produces the
 * cleanest raw text for the deterministic extractor downstream.
 */
const OCR_PROMPT = [
  "You are an OCR engine. Transcribe ALL text in this image exactly as written.",
  "Preserve the reading order and line breaks.",
  "Do not summarise, translate, correct spelling, or add commentary.",
  "Output the transcription only. If the image contains no text, output nothing.",
].join(" ");

export interface OcrResult {
  text: string;
  pages: number;
  ms: number;
  ok: boolean;
  error?: string;
}

/** Transcribes one or more page images, concatenating in page order. */
export async function ocrPages(pngs: Buffer[]): Promise<OcrResult> {
  const started = Date.now();
  const chunks: string[] = [];

  for (const [index, png] of pngs.entries()) {
    const content: ContentPart[] = [
      { type: "text", text: OCR_PROMPT },
      { type: "image_url", image_url: { url: toDataUrl(png) } },
    ];

    try {
      const result = await chat({
        baseUrl: visionUrl(),
        model: "vlm",
        messages: [{ role: "user", content }],
        temperature: 0,
        maxTokens: 4096,
        timeoutMs: env.timeouts.visionMs,
      });
      if (result.text) chunks.push(result.text);
    } catch (error) {
      const reason =
        error instanceof LlmUnavailableError
          ? "vision server not running (npm run servers)"
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        text: chunks.join("\n\n"),
        pages: index + 1,
        ms: Date.now() - started,
        ok: false,
        error: `page ${index + 1}: ${reason}`,
      };
    }
  }

  const text = chunks.join("\n\n").trim();
  return {
    text,
    pages: pngs.length,
    ms: Date.now() - started,
    ok: text.length > 0,
    ...(text.length === 0 ? { error: "vision model returned no text" } : {}),
  };
}
