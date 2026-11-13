import type { ImageRef } from "../types";
import { fetchJson, SourceError, type ImageSource, type SearchPage, type SearchParams } from "./types";

/**
 * NASA Image and Video Library. No API key. Most media is public domain.
 * https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
 */

const API = "https://images-api.nasa.gov/search";
const PAGE_SIZE = 20;

interface NasaLink {
  href: string;
  rel: string;
  width?: number;
  height?: number;
}

interface NasaItem {
  data: {
    nasa_id: string;
    title?: string;
    keywords?: string[];
    photographer?: string;
    secondary_creator?: string;
    center?: string;
    media_type: string;
  }[];
  links?: NasaLink[];
}

interface NasaResponse {
  collection: { items: NasaItem[]; links?: { rel: string }[] };
}

export function mapNasa(item: NasaItem): ImageRef | null {
  const d = item.data?.[0];
  if (!d || d.media_type !== "image" || !item.links?.length) return null;
  const thumb = item.links.find((l) => l.href.includes("~thumb")) ?? item.links.find((l) => l.rel === "preview");
  const full =
    item.links.find((l) => l.href.includes("~large")) ??
    item.links.find((l) => l.href.includes("~medium")) ??
    thumb;
  if (!thumb || !full) return null;
  return {
    id: `nasa:${d.nasa_id}`,
    source: "nasa",
    sourceId: d.nasa_id,
    url: full.href,
    thumbUrl: thumb.href,
    landingUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
    title: d.title?.trim() || "Untitled",
    creator: d.photographer || d.secondary_creator || (d.center ? `NASA ${d.center}` : "NASA"),
    license: "NASA media (generally public domain)",
    licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    width: full.width,
    height: full.height,
    tags: (d.keywords ?? []).slice(0, 20),
  };
}

export const nasa: ImageSource = {
  id: "nasa",
  label: "NASA",
  async search({ query, page, orientation, signal }: SearchParams): Promise<SearchPage> {
    const params = new URLSearchParams({ q: query, media_type: "image", page: String(page), page_size: String(PAGE_SIZE) });
    const data = (await fetchJson(`${API}?${params}`, signal)) as NasaResponse;
    if (!data?.collection?.items) throw new SourceError("Unexpected response from NASA", "bad-response");
    let images = data.collection.items.map(mapNasa).filter((x): x is ImageRef => x !== null);
    if (orientation !== "any") {
      images = images.filter((i) => {
        if (!i.width || !i.height) return true;
        const r = i.width / i.height;
        return orientation === "landscape" ? r > 1.1 : orientation === "portrait" ? r < 0.9 : r >= 0.9 && r <= 1.1;
      });
    }
    return { images, hasMore: (data.collection.links ?? []).some((l) => l.rel === "next") };
  },
};
