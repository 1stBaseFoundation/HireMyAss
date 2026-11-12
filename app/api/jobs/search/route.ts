import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { countJobs } from "@/lib/db/jobs";
import { getConfirmedProfile, ProfileNotConfirmedError } from "@/lib/db/profile";
import { searchJobs } from "@/lib/match/search";
import { collectJobs } from "@/lib/sources/collect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const FiltersSchema = z.object({
  employmentTypes: z
    .array(z.enum(["full_time", "part_time", "contract"]))
    .max(3)
    .optional(),
  remoteModes: z.array(z.enum(["remote", "hybrid", "onsite"])).max(3).optional(),
  location: z.string().trim().max(120).optional(),
  postedWithinDays: z.union([z.literal(1), z.literal(3), z.literal(7)]).optional(),
});

const SearchBody = z.object({
  filters: FiltersSchema.optional(),
  strictMode: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  minScore: z.number().min(0).max(100).optional(),
  /** Force a refetch, ignoring the per-source TTL cache. */
  refresh: z.boolean().optional(),
  /** Restrict to specific source ids. */
  sources: z.array(z.string().max(40)).max(12).optional(),
});

export async function POST(request: Request) {
  const db = getDb();

  // ---- the gate. Ranking never runs against an unreviewed parse.
  let profile;
  try {
    profile = getConfirmedProfile(db);
  } catch (error) {
    if (error instanceof ProfileNotConfirmedError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 428 },
      );
    }
    throw error;
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* empty body = default filters */
  }

  const parsed = SearchBody.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid search payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const options = parsed.data;

  const startedAt = Date.now();

  // ---- fetch (TTL-cached per source; only stale sources hit the network)
  let collect = null;
  const shouldFetch = options.refresh === true || countJobs(db) === 0;
  if (shouldFetch) {
    collect = await collectJobs(
      { location: options.filters?.location, employmentTypes: options.filters?.employmentTypes },
      { sourceIds: options.sources, force: options.refresh === true },
    );
  } else {
    collect = await collectJobs({}, { sourceIds: options.sources });
  }

  const result = searchJobs(
    profile,
    {
      filters: options.filters,
      strictMode: options.strictMode,
      limit: options.limit,
      minScore: options.minScore,
    },
    db,
  );

  return NextResponse.json({
    ...result,
    profileConfirmedAt: profile.confirmedAt,
    sources: collect.outcomes,
    allCached: collect.allCached,
    tookMs: Date.now() - startedAt,
  });
}

/** Lightweight source health, used by the settings screen. */
export async function GET() {
  const db = getDb();
  const runs = db.prepare("SELECT * FROM source_runs ORDER BY source").all();
  return NextResponse.json({ runs });
}
