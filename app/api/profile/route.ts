import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProfile } from "@/lib/db/profile";
import { readConfidence } from "@/lib/extract/confidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The review screen's data source.
 *
 * Returns the draft parse *and* its provenance. `confidence` is null only for
 * profiles stored before Phase 3.5 — the screen treats that as "nothing is
 * graded yet" rather than inventing confidence it does not have.
 */
export async function GET() {
  try {
    const profile = getProfile(getDb());
    if (!profile) {
      return NextResponse.json({ profile: null, confidence: null });
    }
    return NextResponse.json({
      profile,
      confidence: readConfidence(profile.confidence),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to read profile" },
      { status: 500 },
    );
  }
}
