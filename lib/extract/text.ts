import mammoth from "mammoth";
import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";

export type TextMethod = "pdf-text" | "docx" | "plain";

export interface TextExtraction {
  text: string;
  pageCount: number;
  method: TextMethod;
  /** True when the PDF had little/no text layer — it needs OCR. */
  needsOcr: boolean;
  warnings: string[];
}

/** Below this many characters a PDF is assumed to be a scan of images. */
export const OCR_THRESHOLD = 200;

/** Magic bytes beat file extensions — a .pdf that is really a .docx happens. */
export function sniffType(buffer: Uint8Array): "pdf" | "docx" | "text" | "unknown" {
  const head = buffer.subarray(0, 5);
  // %PDF-
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
  // PK\x03\x04 (zip container — .docx)
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "docx";
  // No NUL bytes in the first block is a decent text heuristic.
  const sample = buffer.subarray(0, 512);
  if (!sample.includes(0x00)) return "text";
  return "unknown";
}

function cleanText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

export async function extractText(
  buffer: Uint8Array,
  filename: string,
): Promise<TextExtraction> {
  const kind = sniffType(buffer);
  const warnings: string[] = [];

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    const text = cleanText(value);
    if (text.length === 0) warnings.push("docx produced no text");
    return { text, pageCount: 0, method: "docx", needsOcr: false, warnings };
  }

  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const pageCount = pdf.numPages;
    const { text } = await unpdfExtract(pdf, { mergePages: true });
    const merged = cleanText(text);
    const needsOcr = merged.length < OCR_THRESHOLD;
    if (needsOcr) {
      warnings.push(
        `pdf text layer empty or tiny (${merged.length} chars over ${pageCount} pages) — OCR required`,
      );
    }
    return { text: merged, pageCount, method: "pdf-text", needsOcr, warnings };
  }

  if (kind === "text") {
    const text = cleanText(new TextDecoder().decode(buffer));
    return { text, pageCount: 0, method: "plain", needsOcr: false, warnings };
  }

  throw new Error(
    `unsupported file type for "${filename}" — expected PDF, DOCX or plain text`,
  );
}
