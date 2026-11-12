import { NextResponse } from "next/server";
import { ingestResume } from "@/lib/extract/pipeline";
import { getProfile } from "@/lib/db/profile";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = /\.(pdf|docx|txt|md)$/i;

/** Current parsed profile, or null when nothing has been uploaded yet. */
export async function GET() {
  try {
    const profile = getProfile(getDb());
    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to read profile" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data with a `file` field" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing `file` field" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 25 MB)` },
      { status: 413 },
    );
  }
  if (!ALLOWED.test(file.name)) {
    return NextResponse.json(
      { error: `unsupported file type "${file.name}" — use PDF, DOCX or TXT` },
      { status: 415 },
    );
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = await ingestResume(buffer, file.name);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "resume ingest failed",
      },
      { status: 422 },
    );
  }
}

/** Clears the stored profile — the resume is the user's to delete. */
export async function DELETE() {
  try {
    getDb().prepare("DELETE FROM profile WHERE id = 1").run();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to clear profile" },
      { status: 500 },
    );
  }
}
