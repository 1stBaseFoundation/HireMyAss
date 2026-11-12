import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  confirmProfile,
  getProfile,
  saveProfile,
  toProfileInput,
} from "@/lib/db/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accepts the user-reviewed snapshot and marks the profile confirmed.
 *
 * This is the gate described in TODO.md "Review stage": nothing may search
 * against a draft parse. The body carries the *edited* values, so whatever the
 * user corrected on screen is exactly what ranking will use.
 */
const ConfirmSchema = z.object({
  fullName: z.string().max(120).nullable().optional(),
  headline: z.string().max(200).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  location: z.string().max(120).nullable().optional(),
  yearsExperience: z.number().min(0).max(60).nullable().optional(),
  seniority: z.string().max(40).nullable().optional(),
  keywords: z.array(z.string().min(1).max(60)).max(80).optional(),
  titles: z.array(z.string().min(1).max(120)).max(30).optional(),
  locations: z.array(z.string().min(1).max(80)).max(30).optional(),
});

export async function POST(request: Request) {
  const db = getDb();
  const existing = getProfile(db);
  if (!existing) {
    return NextResponse.json(
      { error: "no profile to confirm — upload a resume first" },
      { status: 404 },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is valid: "confirm exactly what was parsed".
  }

  const parsed = ConfirmSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid profile payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const edits = parsed.data;
  const base = toProfileInput(existing);

  const merged = {
    ...base,
    ...Object.fromEntries(
      Object.entries(edits).filter(([, value]) => value !== undefined),
    ),
  } as typeof base;

  // Dedupe keywords case-insensitively while preserving the user's ordering.
  const seen = new Set<string>();
  merged.keywords = merged.keywords.filter((keyword) => {
    const key = keyword.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  saveProfile(merged, db);
  const confirmed = confirmProfile(db);

  return NextResponse.json({ profile: confirmed });
}

/** Withdraws confirmation, e.g. after uploading a different resume. */
export async function DELETE() {
  const db = getDb();
  db.prepare("UPDATE profile SET confirmed_at = NULL WHERE id = 1").run();
  return NextResponse.json({ profile: getProfile(db) });
}
