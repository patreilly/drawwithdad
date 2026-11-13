import type { ImageRef, Orientation } from "../types";
import { fetchJson, SourceError, type ImageSource, type SearchPage, type SearchParams } from "./types";

/**
 * Openverse: openly licensed images (Creative Commons and public domain).
 * No API key. Anonymous limits are 20 requests/min and 200/day per IP, and up to 20 results per page.
 * https://api.openverse.org/v1/
 */

const API = "https://api.openverse.org/v1/images/";
const PAGE_SIZE = 20;
const ASPECT: Record<Orientation, string | null> = { any: null, landscape: "wide", portrait: "tall", square: "square" };

interface OpenverseResult {
  id: string;
  title?: string | null;
  url: string;
  thumbnail: string;
  foreign_landing_url: string;
  creator?: string | null;
  creator_url?: string | null;
  license: string;
  license_version?: string | null;
  license_url?: string | null;
  width?: number | null;
  height?: number | null;
  mature?: boolean;
  tags?: { name: string }[] | null;
  unstable__sensitivity?: string[];
}

interface OpenverseResponse {
  page_count: number;
  results: OpenverseResult[];
}

export function licenseLabel(license: string, version?: string | null): string {
  const l = license.toLowerCase();
  if (l === "cc0") return "CC0";
  if (l === "pdm") return "Public Domain";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`;
}

export function mapOpenverse(r: OpenverseResult): ImageRef | null {
  // Openverse flags sensitive results; we drop them outright.
  if (r.mature || (r.unstable__sensitivity?.length ?? 0) > 0) return null;
  if (!r.url || !r.thumbnail) return null;
  return {
    id: `openverse:${r.id}`,
    source: "openverse",
    sourceId: r.id,
    url: r.url,
    thumbUrl: r.thumbnail,
    landingUrl: r.foreign_landing_url,
    title: r.title?.trim() || "Untitled",
    creator: r.creator?.trim() || "Unknown",
    creatorUrl: r.creator_url ?? undefined,
    license: licenseLabel(r.license, r.license_version),
    licenseUrl: r.license_url ?? undefined,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    tags: (r.tags ?? []).map((t) => t.name).slice(0, 20),
  };
}

export const openverse: ImageSource = {
  id: "openverse",
  label: "Openverse",
  async search({ query, page, orientation, signal }: SearchParams): Promise<SearchPage> {
    const params = new URLSearchParams({
      q: query,
      page: String(page),
      page_size: String(PAGE_SIZE),
      mature: "false",
      category: "photograph",
    });
    const aspect = ASPECT[orientation];
    if (aspect) params.set("aspect_ratio", aspect);

    const data = (await fetchJson(`${API}?${params}`, signal)) as OpenverseResponse;
    if (!data || !Array.isArray(data.results)) throw new SourceError("Unexpected response from Openverse", "bad-response");
    return {
      images: data.results.map(mapOpenverse).filter((x): x is ImageRef => x !== null),
      hasMore: page < (data.page_count ?? 0),
    };
  },
};
