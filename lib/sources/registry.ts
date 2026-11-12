import { ashbySource, DEFAULT_TARGETS, greenhouseSource, leverSource, type AtsTarget } from "./ats";
import { arbeitnow, himalayas, jobicy, remoteok, remotive } from "./boards";
import type { JobSource } from "./types";

/**
 * Every registered source. Aggregators are always on; ATS boards are opt-in by
 * company token, because which companies you care about is a user decision.
 */
export const SOURCES: JobSource[] = [
  arbeitnow,
  remotive,
  jobicy,
  remoteok,
  himalayas,
  greenhouseSource(DEFAULT_TARGETS.greenhouse),
  leverSource(DEFAULT_TARGETS.lever),
  ashbySource(DEFAULT_TARGETS.ashby),
];

export function getSource(id: string): JobSource | undefined {
  return SOURCES.find((source) => source.id === id);
}

/** Resolve an explicit allow-list of source ids, preserving registry order. */
export function getSources(ids?: string[]): JobSource[] {
  if (!ids || ids.length === 0) return SOURCES;
  const wanted = new Set(ids);
  return SOURCES.filter((source) => wanted.has(source.id));
}

export function describeSources(): Array<{
  id: string;
  label: string;
  homepage: string;
  attribution: string | null;
  capabilities: JobSource["capabilities"];
}> {
  return SOURCES.map(({ id, label, homepage, attribution, capabilities }) => ({
    id,
    label,
    homepage,
    attribution,
    capabilities,
  }));
}

export { DEFAULT_TARGETS };
export type { AtsTarget };
export type { JobSource };
