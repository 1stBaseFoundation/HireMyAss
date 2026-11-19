import { extractProfile } from "./deterministic";
import { assessProfile, type ProfileConfidence } from "./confidence";
import { enrichProfile } from "./llm-extract";
import { ocrPages } from "./ocr";
import { rasterizePdf } from "./raster";
import { extractText, type TextExtraction } from "./text";
import { saveProfile, type Profile } from "@/lib/db/profile";

export interface IngestResult {
  profile: Profile;
  /** Provenance/confidence per field, for the review screen. */
  confidence: ProfileConfidence;
  parseMethod: "pdf-text" | "pdf-ocr" | "docx" | "plain";
  pages: number;
  ocrUsed: boolean;
  llmUsed: boolean;
  notes: string[];
  warnings: string[];
  textChars: number;
}

/**
 * Resume → stored profile.
 *
 * Order matters: cheap deterministic extraction first, OCR only when the text
 * layer is missing, and the model only for fields the parser could not
 * establish. Every stage degrades instead of failing — a downed model still
 * yields a usable profile.
 *
 * Privacy note: the uploaded bytes are NOT persisted. Only the extracted text
 * and the structured facts are stored in the local SQLite file.
 */
export interface IngestOptions {
  /** Set false to keep the pipeline fully offline (tests). Default true. */
  allowLlm?: boolean;
  /** Set false to skip OCR fallback entirely. Default true. */
  allowOcr?: boolean;
}

export async function ingestResume(
  buffer: Uint8Array,
  filename: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { allowLlm = true, allowOcr = true } = options;
  const notes: string[] = [];

  let extracted: TextExtraction = await extractText(buffer, filename);
  let text = extracted.text;
  let ocrUsed = false;
  let pages = extracted.pageCount;

  if (extracted.needsOcr) {
    notes.push("no usable text layer — falling back to vision OCR");
    if (!allowOcr) {
      notes.push("OCR disabled for this run");
    } else {
      const images = await rasterizePdf(buffer, { scale: 1.5, maxPages: 4 });
      pages = images.length || pages;
      const ocr = await ocrPages(images.map((image) => image.png));

      if (ocr.ok) {
        text = ocr.text;
        ocrUsed = true;
        notes.push(`ocr: ${ocr.pages} page(s) in ${ocr.ms} ms`);
      } else {
        notes.push(`ocr failed: ${ocr.error ?? "unknown error"}`);
        // Keep whatever fragments OCR did return, if anything.
        if (ocr.text.length > text.length) {
          text = ocr.text;
          ocrUsed = true;
        }
      }
    }
  }

  if (text.trim().length === 0) {
    throw new Error(
      `could not read any text from "${filename}". If it is a scan, make sure the vision server is running (npm run servers).`,
    );
  }

  const deterministic = extractProfile(text);
  notes.push(
    `deterministic: ${deterministic.keywords.length} keywords, ${deterministic.titles.length} titles`,
  );

  const enriched = allowLlm
    ? await enrichProfile(deterministic, text)
    : { profile: deterministic, usedLlm: false, filled: [], note: "model skipped", modelFields: [], modelKeywords: [], contradictions: [] };
  if (enriched.note) notes.push(`model: ${enriched.note}`);

  // The deterministic parse is the evidence base; the enrichment pass only
  // tells us what it *guessed*, so confidence is assessed against both.
  const confidence = assessProfile(deterministic, text, {
    modelFields: enriched.modelFields,
    modelKeywords: enriched.modelKeywords,
    contradictions: enriched.contradictions,
  });
  const excluded = confidence.keywords.filter((keyword) => !keyword.included).length;
  if (excluded > 0) notes.push(`${excluded} low-confidence keyword(s) start excluded`);
  if (confidence.gaps.length > 0) {
    notes.push(`missing: ${confidence.gaps.join(", ")}`);
  }

  const method: IngestResult["parseMethod"] = ocrUsed
    ? "pdf-ocr"
    : extracted.method === "pdf-text"
      ? "pdf-text"
      : extracted.method === "docx"
        ? "docx"
        : "plain";

  const profile = saveProfile(
    {
      fullName: enriched.profile.fullName,
      headline: enriched.profile.headline,
      email: enriched.profile.email,
      phone: enriched.profile.phone,
      location: enriched.profile.location,
      yearsExperience: enriched.profile.yearsExperience,
      seniority: enriched.profile.seniority,
      rawText: text,
      keywords: enriched.profile.keywords,
      titles: enriched.profile.titles,
      locations: enriched.profile.locations,
      sourceFile: filename,
      parseMethod: method,
    },
    undefined,
    { confidence: confidence as unknown as Record<string, unknown> },
  );

  return {
    profile,
    confidence,
    parseMethod: method,
    pages,
    ocrUsed,
    llmUsed: enriched.usedLlm,
    notes,
    warnings: extracted.warnings,
    textChars: text.length,
  };
}
