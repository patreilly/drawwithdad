import type { ImageRef, Orientation, SourceId } from "../types";

export interface SearchParams {
  query: string;
  page: number;
  orientation: Orientation;
  signal?: AbortSignal;
}

export interface SearchPage {
  images: ImageRef[];
  hasMore: boolean;
}

/**
 * An image source. To add a new source, implement this in one file and register
 * it in sources/index.ts. Sources must:
 *  - use the strictest safe-search option their API offers,
 *  - return a CORS-enabled `thumbUrl` (the safety check needs to read its pixels),
 *  - return attribution (creator, license, landing page).
 */
export interface ImageSource {
  id: SourceId;
  label: string;
  search(params: SearchParams): Promise<SearchPage>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: "rate-limited" | "network" | "bad-response",
  ) {
    super(message);
  }
}

export async function fetchJson(url: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { signal: combined, headers: { Accept: "application/json" } });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new SourceError(`Couldn't reach ${new URL(url).host}`, "network");
  }
  if (res.status === 429) throw new SourceError("Too many searches, so the image library asked us to slow down. Try again in a minute.", "rate-limited");
  if (!res.ok) throw new SourceError(`${new URL(url).host} returned ${res.status}`, "bad-response");
  return res.json();
}
