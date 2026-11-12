import {
  cleanText,
  cleanTitle,
  inferEmploymentType,
  inferRemoteMode,
  stripHtml,
  toEpochMs,
} from "./normalize";
import { getJson, type FetchContext, type JobSource, type SearchQuery, SourceError } from "./types";

/**
 * Public, keyless job-board APIs. All four shapes were captured live into
 * tests/fixtures/sources/ before these adapters were written.
 */

// ---------------------------------------------------------------- Arbeitnow
interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
}

export const arbeitnow: JobSource = {
  id: "arbeitnow",
  label: "Arbeitnow",
  homepage: "https://www.arbeitnow.com",
  attribution: null,
  ttlMs: 60 * 60 * 1000,
  capabilities: {
    employmentType: true,
    region: true,
    postedDate: true,
    keywords: false,
    requiresKey: false,
  },
  async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
    const json = await getJson<{ data?: ArbeitnowJob[] }>(
      "https://www.arbeitnow.com/api/job-board-api?page=1",
      ctx,
    );
    if (!json.data) throw new SourceError("arbeitnow", "missing `data` array");

    return json.data.map((job) => ({
      source: "arbeitnow",
      sourceId: job.slug,
      title: cleanTitle(job.title),
      company: cleanText(job.company_name),
      location: cleanText(job.location) || null,
      // Arbeitnow reports remote as a real boolean, so `false` means on-site.
      remoteMode: inferRemoteMode(job.remote, job.location, job.description),
      employmentType: inferEmploymentType(job.job_types?.join(" "), job.title, job.description),
      description: stripHtml(job.description),
      applyUrl: job.url,
      postedAt: toEpochMs(job.created_at),
      raw: job,
    }));
  },
};

// ---------------------------------------------------------------- Remotive
interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  description?: string;
}

export const remotive: JobSource = {
  id: "remotive",
  label: "Remotive",
  homepage: "https://remotive.com",
  // Required by their API terms: credit + a followable link.
  attribution: "Jobs by Remotive — https://remotive.com",
  // Their docs ask for a maximum of ~4 requests per day and delay data by 24 h.
  ttlMs: 6 * 60 * 60 * 1000,
  capabilities: {
    employmentType: true,
    region: true,
    postedDate: true,
    keywords: true,
    requiresKey: false,
  },
  async fetchJobs(query: SearchQuery, ctx: FetchContext = {}) {
    const params = new URLSearchParams({ limit: "100" });
    const search = query.terms?.slice(0, 3).join(" ");
    if (search) params.set("search", search);

    const json = await getJson<{ jobs?: RemotiveJob[] }>(
      `https://remotive.com/api/remote-jobs?${params.toString()}`,
      ctx,
    );
    if (!json.jobs) throw new SourceError("remotive", "missing `jobs` array");

    return json.jobs.map((job) => ({
      source: "remotive",
      sourceId: String(job.id),
      title: cleanTitle(job.title),
      company: cleanText(job.company_name),
      location: cleanText(job.candidate_required_location) || null,
      // Remotive only lists remote roles.
      remoteMode: "remote" as const,
      employmentType: inferEmploymentType(job.job_type, job.title, job.description),
      description: stripHtml(job.description),
      applyUrl: job.url,
      postedAt: toEpochMs(job.publication_date),
      raw: job,
    }));
  },
};

// ---------------------------------------------------------------- Jobicy
interface JobicyJob {
  id: number;
  url: string;
  jobTitle: string;
  companyName: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

export const jobicy: JobSource = {
  id: "jobicy",
  label: "Jobicy",
  homepage: "https://jobicy.com",
  attribution: "Jobs by Jobicy — https://jobicy.com",
  ttlMs: 3 * 60 * 60 * 1000,
  capabilities: {
    employmentType: true,
    region: true,
    postedDate: true,
    keywords: true,
    requiresKey: false,
  },
  async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
    const json = await getJson<{ jobs?: JobicyJob[] }>(
      "https://jobicy.com/api/v2/remote-jobs?count=50",
      ctx,
    );
    if (!json.jobs) throw new SourceError("jobicy", "missing `jobs` array");

    return json.jobs.map((job) => ({
      source: "jobicy",
      sourceId: String(job.id),
      title: cleanTitle(job.jobTitle),
      company: cleanText(job.companyName),
      location: cleanText(job.jobGeo) || null,
      remoteMode: "remote" as const,
      employmentType: inferEmploymentType(job.jobType?.join(" "), job.jobTitle),
      description: stripHtml(job.jobDescription ?? job.jobExcerpt),
      applyUrl: job.url,
      postedAt: toEpochMs(job.pubDate),
      raw: job,
    }));
  },
};


// ---------------------------------------------------------------- RemoteOK
interface RemoteOkJob {
  id?: string;
  slug?: string;
  legal?: string;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  apply_url?: string;
  url?: string;
}

export const remoteok: JobSource = {
  id: "remoteok",
  label: "Remote OK",
  homepage: "https://remoteok.com",
  attribution: "Jobs by Remote OK — https://remoteok.com",
  ttlMs: 3 * 60 * 60 * 1000,
  capabilities: {
    employmentType: false,
    region: true,
    postedDate: true,
    keywords: false,
    requiresKey: false,
  },
  async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
    const json = await getJson<RemoteOkJob[]>("https://remoteok.com/api", ctx);
    if (!Array.isArray(json)) throw new SourceError("remoteok", "expected an array");

    // Element 0 is a legal notice object, not a job — it has no id/position.
    return json
      .filter((job) => job && (job.id || job.slug) && (job.position || job.slug))
      .map((job) => ({
        source: "remoteok",
        sourceId: job.id ?? job.slug ?? null,
        title: cleanTitle(job.position ?? job.slug),
        company: cleanText(job.company) || "Unknown",
        location: cleanText(job.location) || null,
        remoteMode: "remote" as const,
        employmentType: inferEmploymentType(job.tags?.join(" "), job.position, job.description),
        description: stripHtml(job.description),
        applyUrl: job.apply_url ?? job.url ?? `https://remoteok.com/remote-jobs/${job.slug}`,
        postedAt: toEpochMs(job.date),
        raw: job,
      }));
  },
};

// ---------------------------------------------------------------- Himalayas
interface HimalayasJob {
  title: string;
  companyName: string;
  employmentType?: string;
  seniority?: string[];
  locationRestrictions?: string[];
  categories?: string[];
  description?: string;
  pubDate?: number;
  applicationLink?: string;
  guid?: string;
}

export const himalayas: JobSource = {
  id: "himalayas",
  label: "Himalayas",
  homepage: "https://himalayas.app",
  attribution: null,
  ttlMs: 3 * 60 * 60 * 1000,
  capabilities: {
    employmentType: true,
    region: true,
    postedDate: true,
    keywords: false,
    requiresKey: false,
  },
  async fetchJobs(_query: SearchQuery, ctx: FetchContext = {}) {
    const json = await getJson<{ jobs?: HimalayasJob[] }>(
      "https://himalayas.app/jobs/api?limit=100",
      ctx,
    );
    if (!json.jobs) throw new SourceError("himalayas", "missing jobs array");

    return json.jobs.map((job) => {
      const locations = (job.locationRestrictions ?? []).filter(Boolean);
      const applyUrl = job.applicationLink ?? job.guid ?? "https://himalayas.app";

      return {
        source: "himalayas",
        // guid is stable and unique per posting; title alone is not.
        sourceId: job.guid ?? applyUrl,
        title: cleanTitle(job.title),
        company: cleanText(job.companyName),
        location: locations.length > 0 ? locations.join(", ") : null,
        // Himalayas is a remote-only board.
        remoteMode: "remote" as const,
        employmentType: inferEmploymentType(job.employmentType, job.title),
        description: stripHtml(job.description),
        applyUrl,
        postedAt: toEpochMs(job.pubDate),
        raw: job,
      };
    });
  },
};
