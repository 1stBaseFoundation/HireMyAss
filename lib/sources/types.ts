import type { EmploymentType, NormalizedJob, RemoteMode } from "@/lib/db/jobs";

export type EmploymentTypeFilter = "full_time" | "part_time" | "contract";
export type RemoteModeFilter = "remote" | "hybrid" | "onsite";

export interface SearchQuery {
  /** Free-text terms (job title fragments, technologies). */
  terms?: string[];
  employmentTypes?: EmploymentTypeFilter[];
  remoteModes?: RemoteModeFilter[];
  /** Free-text location: city, country, "remote". */
  location?: string;
  postedWithinDays?: 1 | 3 | 7;
  limit?: number;
}

export interface SourceCapabilities {
  /** Can the source tell us full-time vs contract vs part-time? */
  employmentType: boolean;
  /** Does it report where the role is? */
  region: boolean;
  /** Does it report a publication date? */
  postedDate: boolean;
  /** Can it be queried by keyword server-side? */
  keywords: boolean;
  requiresKey: boolean;
}

export interface FetchContext {
  /** Injectable for fixture-based tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface JobSource {
  id: string;
  label: string;
  homepage: string;
  /** Some sources demand credit and a followable link (Remotive, RemoteOK). */
  attribution: string | null;
  capabilities: SourceCapabilities;
  /** Minimum time between live fetches. Remotive is capped at ~4/day. */
  ttlMs: number;
  fetchJobs(query: SearchQuery, ctx?: FetchContext): Promise<NormalizedJob[]>;
}

export type { EmploymentType, NormalizedJob, RemoteMode };

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown when a source returns something structurally unexpected. */
export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = "SourceError";
  }
}

export async function getJson<T>(url: string, ctx: FetchContext = {}): Promise<T> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "HireMyAss/0.1 (self-hosted job aggregator)",
    },
    signal: ctx.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new SourceError(url, `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}
