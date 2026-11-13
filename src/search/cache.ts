import type { ImageRef, SafetyVerdict } from "../types";

/**
 * Short-lived, in-memory cache of search results and safety verdicts for this
 * page load. Nothing is written to the browser's storage; everything a user
 * wants to keep (profiles, saved pictures, history) lives on the server.
 */

export interface ImageRecord extends ImageRef {
  firstSeenAt: number;
  safety?: SafetyVerdict;
}

export interface SearchRecord {
  /** `${source}|${query}|${orientation}|${page}` */
  key: string;
  imageIds: string[];
  hasMore: boolean;
  fetchedAt: number;
}

export interface SearchCache {
  getImages(ids: string[]): Promise<Map<string, ImageRecord>>;
  putImages(images: ImageRecord[]): Promise<void>;
  getSearch(key: string): Promise<SearchRecord | undefined>;
  putSearch(record: SearchRecord): Promise<void>;
}

/** Cached searches expire, so a long-open tab still sees new uploads. */
export const SEARCH_TTL_MS = 60 * 60 * 1000;
/** Keeps memory bounded on a tab that's open all day. */
const MAX_IMAGES = 5000;

export class MemoryCache implements SearchCache {
  private images = new Map<string, ImageRecord>();
  private searches = new Map<string, SearchRecord>();

  async getImages(ids: string[]) {
    const out = new Map<string, ImageRecord>();
    for (const id of ids) {
      const r = this.images.get(id);
      if (r) out.set(id, structuredClone(r));
    }
    return out;
  }
  async putImages(images: ImageRecord[]) {
    for (const i of images) this.images.set(i.id, structuredClone(i));
    if (this.images.size > MAX_IMAGES) {
      this.images.clear();
      this.searches.clear();
    }
  }
  async getSearch(key: string) {
    return this.searches.get(key);
  }
  async putSearch(record: SearchRecord) {
    this.searches.set(record.key, record);
  }
}
