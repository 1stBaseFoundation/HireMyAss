import type { EmploymentType, JobStatusValue, RemoteMode } from "@/lib/db/jobs";
import type { EmploymentTypeFilter, RemoteModeFilter } from "@/lib/sources/types";

const DAY_MS = 86_400_000;

export interface JobFilters {
  employmentTypes?: EmploymentTypeFilter[];
  remoteModes?: RemoteModeFilter[];
  /** Free-text location: "berlin", "south africa", "remote". */
  location?: string;
  postedWithinDays?: 1 | 3 | 7;
}

export interface FilterableJob {
  employmentType: EmploymentType;
  remoteMode: RemoteMode;
  location: string | null;
  title: string;
  description: string | null;
  postedAt: number | null;
}

/**
 * What the list shows.
 *
 * `applied` and `dismissed` are hidden forever — that is the user's explicit
 * instruction ("omit anything seen from future lists"). `seen` is kept but
 * sunk, because a job merely rendered once is not a decision. Strict mode
 * collapses that to `new` only, for people who want the literal behaviour.
 */
export function visibleStatuses(strictMode: boolean): JobStatusValue[] {
  return strictMode ? ["new"] : ["new", "seen"];
}

export function isStatusVisible(status: JobStatusValue, strictMode: boolean): boolean {
  return visibleStatuses(strictMode).includes(status);
}

export function matchesFilters(
  job: FilterableJob,
  filters: JobFilters,
  now: number = Date.now(),
): boolean {
  if (filters.employmentTypes && filters.employmentTypes.length > 0) {
    // A board that cannot report employment type would otherwise be filtered
    // out entirely; keep `unknown` so those jobs remain discoverable.
    const type = job.employmentType;
    if (type !== "unknown" && !filters.employmentTypes.includes(type as EmploymentTypeFilter)) {
      return false;
    }
  }

  if (filters.remoteModes && filters.remoteModes.length > 0) {
    if (job.remoteMode !== "unknown" && !filters.remoteModes.includes(job.remoteMode)) {
      return false;
    }
  }

  if (filters.postedWithinDays) {
    if (job.postedAt === null) return false;
    const age = now - job.postedAt;
    if (age > filters.postedWithinDays * DAY_MS) return false;
  }

  if (filters.location) {
    const needle = filters.location.trim().toLowerCase();
    if (needle) {
      const haystack = [
        job.location ?? "",
        job.remoteMode,
        // A remote-only board still needs to match "remote" searches, and an
        // on-site role in the right city needs to match that city.
        job.title,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
  }

  return true;
}
