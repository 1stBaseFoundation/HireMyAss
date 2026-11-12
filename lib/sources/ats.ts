import {
  cleanText,
  cleanTitle,
  inferEmploymentType,
  inferRemoteMode,
  stripHtml,
  toEpochMs,
} from "./normalize";
import { getJson, type FetchContext, type JobSource, type SearchQuery } from "./types";

/**
 * Applicant Tracking System boards.
 *
 * These are the highest-value sources: the JSON is public, it is meant to be
 * read, and — unlike the aggregators — the apply URL points at the actual
 * application form rather than another listing page.
 *
 * Each adapter fans out over a list of company board tokens. One broken board
 * must not take the whole source down, so failures are isolated per board.
 */

export interface AtsTarget {
  board: string;
  company?: string;
}

export const DEFAULT_TARGETS: Record<"greenhouse" | "lever" | "ashby", AtsTarget[]> = {
  greenhouse: [{ board: "gitlab" }, { board: "stripe" }, { board: "figma" }],
  lever: [{ board: "leverdemo", company: "Lever Demo" }],
  ashby: [
    { board: "ramp", company: "Ramp" },
    { board: "openai", company: "OpenAI" },
  ],
};

/** Runs `fn` per board, collecting jobs and per-board errors. */
async function fanOut<T>(
  targets: AtsTarget[],
  fn: (target: AtsTarget) => Promise<T[]>,
): Promise<{ jobs: T[]; errors: string[] }> {
  const jobs: T[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    try {
      jobs.push(...(await fn(target)));
    } catch (error) {
      errors.push(`${target.board}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { jobs, errors };
}

function prettify(board: string): string {
  return board
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ---------------------------------------------------------------- Greenhouse
interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  company_name?: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  content?: string;
}

export function greenhouseSource(targets: AtsTarget[] = DEFAULT_TARGETS.greenhouse): JobSource {
  return {
    id: "greenhouse",
    label: "Greenhouse",
    homepage: "https://boards.greenhouse.io",
    attribution: null,
    ttlMs: 2 * 60 * 60 * 1000,
    capabilities: {
      employmentType: false,
      region: true,
      postedDate: true,
      keywords: false,
      requiresKey: false,
    },
    async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
      const { jobs, errors } = await fanOut(targets, async (target) => {
        const json = await getJson<{ jobs?: GreenhouseJob[] }>(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.board)}/jobs`,
          ctx,
        );
        return (json.jobs ?? []).map((job) => {
          const location = cleanText(job.location?.name) || null;
          return {
            source: "greenhouse",
            sourceId: String(job.id),
            title: cleanTitle(job.title),
            company: cleanText(job.company_name) || target.company || prettify(target.board),
            location,
            remoteMode: inferRemoteMode(null, location, job.title),
            // The list endpoint omits employment type; the title is the only hint.
            employmentType: inferEmploymentType(job.title),
            description: stripHtml(job.content),
            applyUrl: job.absolute_url,
            postedAt: toEpochMs(job.first_published ?? job.updated_at),
            raw: job,
          };
        });
      });
      if (jobs.length === 0 && errors.length > 0) {
        throw new Error(`all greenhouse boards failed (${errors.join("; ")})`);
      }
      return jobs;
    },
  };
}

// ---------------------------------------------------------------- Lever
interface LeverJob {
  id: string;
  text: string;
  createdAt?: number;
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  categories?: {
    commitment?: string;
    team?: string;
    department?: string;
    location?: string;
    allLocations?: string[];
  };
}

export function leverSource(targets: AtsTarget[] = DEFAULT_TARGETS.lever): JobSource {
  return {
    id: "lever",
    label: "Lever",
    homepage: "https://lever.co",
    attribution: null,
    ttlMs: 2 * 60 * 60 * 1000,
    capabilities: {
      employmentType: true,
      region: true,
      postedDate: true,
      keywords: false,
      requiresKey: false,
    },
    async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
      const { jobs, errors } = await fanOut(targets, async (target) => {
        const json = await getJson<LeverJob[]>(
          `https://api.lever.co/v0/postings/${encodeURIComponent(target.board)}?mode=json`,
          ctx,
        );
        if (!Array.isArray(json)) throw new Error("expected an array");
        return json.map((job) => {
          const locations = job.categories?.allLocations?.filter(Boolean) ?? [];
          const location =
            cleanText(job.categories?.location) ||
            (locations.length > 0 ? locations.join(", ") : "") ||
            null;
          return {
            source: "lever",
            sourceId: job.id,
            title: cleanTitle(job.text),
            company: target.company ?? prettify(target.board),
            location,
            remoteMode: inferRemoteMode(null, location, job.text),
            employmentType: inferEmploymentType(job.categories?.commitment, job.text),
            description: stripHtml(job.descriptionPlain ?? job.description),
            applyUrl:
              job.applyUrl ?? job.hostedUrl ?? `https://jobs.lever.co/${target.board}/${job.id}`,
            postedAt: toEpochMs(job.createdAt),
            raw: job,
          };
        });
      });
      if (jobs.length === 0 && errors.length > 0) {
        throw new Error(`all lever boards failed (${errors.join("; ")})`);
      }
      return jobs;
    },
  };
}

// ---------------------------------------------------------------- Ashby
interface AshbyJob {
  id: string;
  title: string;
  employmentType?: string;
  location?: string;
  publishedAt?: string;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
}

export function ashbySource(targets: AtsTarget[] = DEFAULT_TARGETS.ashby): JobSource {
  return {
    id: "ashby",
    label: "Ashby",
    homepage: "https://www.ashbyhq.com",
    attribution: null,
    ttlMs: 2 * 60 * 60 * 1000,
    capabilities: {
      employmentType: true,
      region: true,
      postedDate: true,
      keywords: false,
      requiresKey: false,
    },
    async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
      const { jobs, errors } = await fanOut(targets, async (target) => {
        const json = await getJson<{ jobs?: AshbyJob[] }>(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.board)}`,
          ctx,
        );
        return (json.jobs ?? [])
          .filter((job) => job.title)
          .map((job) => {
            const location = cleanText(job.location) || null;
            return {
              source: "ashby",
              sourceId: job.id,
              title: cleanTitle(job.title),
              company: target.company ?? prettify(target.board),
              location,
              // Ashby states workplaceType explicitly (Remote / Hybrid / Onsite).
              remoteMode: inferRemoteMode(job.workplaceType ?? job.isRemote, location),
              employmentType: inferEmploymentType(job.employmentType, job.title),
              description: stripHtml(job.descriptionPlain),
              applyUrl:
                job.applyUrl ?? job.jobUrl ?? `https://jobs.ashbyhq.com/${target.board}/${job.id}`,
              postedAt: toEpochMs(job.publishedAt),
              raw: job,
            };
          });
      });
      if (jobs.length === 0 && errors.length > 0) {
        throw new Error(`all ashby boards failed (${errors.join("; ")})`);
      }
      return jobs;
    },
  };
}

