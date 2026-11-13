import { SOURCES } from "../sources";
import type { SearchPage } from "../sources/types";
import type { Orientation, SourceId } from "../types";
import type { SearchPlan } from "./plan";

/**
 * Image APIs can take several seconds to answer. To get you drawing sooner,
 * the home screen starts the first search while you're still typing (or
 * hovering a category), and the session picks up the in-flight result.
 */

const MAX_AGE_MS = 60_000;
const inflight = new Map<string, { at: number; promise: Promise<SearchPage> }>();

export function searchKey(source: SourceId, query: string, orientation: Orientation, page: number): string {
  return `${source}|${query.toLowerCase()}|${orientation}|${page}`;
}

export function takePrefetched(key: string): Promise<SearchPage> | undefined {
  const hit = inflight.get(key);
  if (!hit) return undefined;
  inflight.delete(key);
  return Date.now() - hit.at < MAX_AGE_MS ? hit.promise : undefined;
}

/** Prefetches page 1 of the first `maxQueries` queries of a plan. Errors are ignored here and retried by the session. */
export function prefetchPlan(plan: SearchPlan, orientation: Orientation, maxQueries = 1): void {
  for (const q of plan.queries.slice(0, maxQueries)) {
    for (const source of q.sources) {
      const key = searchKey(source, q.text, orientation, 1);
      const existing = inflight.get(key);
      if (existing && Date.now() - existing.at < MAX_AGE_MS) continue;
      const promise = SOURCES[source].search({ query: q.text, page: 1, orientation });
      promise.catch(() => inflight.delete(key));
      inflight.set(key, { at: Date.now(), promise });
    }
  }
}
