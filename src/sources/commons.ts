import { findBlockedTerm } from "../safety/textFilter";
import type { ImageRef, Orientation } from "../types";
import { fetchJson, SourceError, type ImageSource, type SearchPage, type SearchParams } from "./types";

/**
 * Wikimedia Commons. No key, and fast (about 1s, against Openverse's 3–10s), so
 * it usually provides the first image of a session.
 *
 * Commons has no safe-search, so this adapter adds its own guards on top of
 * the image classifier, which always runs in strict mode for this source:
 *  - photos only: anything categorized as painting, sculpture, artwork etc. is
 *    dropped (that's where art nudes live),
 *  - title, description and categories go through the word filter.
 * https://www.mediawiki.org/wiki/API:Search
 */

const API = "https://commons.wikimedia.org/w/api.php";
const PAGE_SIZE = 20;
const DISPLAY_WIDTH = 1280;
const THUMB_WIDTH = 500;
const ART = /\b(paintings?|drawings?|sculptures?|statues?|artworks?|illustrations?|engravings?|lithographs?|etchings?|frescoe?s?|mosaics?|nudes?|nudity|erotica?)\b/i;
const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

interface CommonsPage {
  pageid: number;
  index: number;
  title: string;
  imageinfo?: {
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    descriptionurl: string;
    mime: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }[];
}

interface CommonsResponse {
  continue?: unknown;
  query?: { pages?: Record<string, CommonsPage> };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesOrientation(w: number, h: number, o: Orientation): boolean {
  if (o === "any" || !w || !h) return true;
  const r = w / h;
  return o === "landscape" ? r > 1.1 : o === "portrait" ? r < 0.9 : r >= 0.9 && r <= 1.1;
}

export function mapCommons(page: CommonsPage): ImageRef | null {
  const info = page.imageinfo?.[0];
  if (!info?.thumburl || !IMAGE_MIME.test(info.mime)) return null;
  const meta = (k: string) => stripHtml(info.extmetadata?.[k]?.value ?? "");
  const categories = meta("Categories");
  const description = meta("ImageDescription");
  const title = meta("ObjectName") || page.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, "");
  if (ART.test(categories) || ART.test(title)) return null;
  if (findBlockedTerm(`${title} ${description} ${categories.replace(/\|/g, " ")}`, { metadata: true })) return null;

  const url = info.thumburl.split("?")[0];
  return {
    id: `commons:${page.pageid}`,
    source: "commons",
    sourceId: String(page.pageid),
    url,
    thumbUrl: url.replace(`/${DISPLAY_WIDTH}px-`, `/${THUMB_WIDTH}px-`),
    landingUrl: info.descriptionurl,
    title: title.slice(0, 140),
    creator: meta("Artist").slice(0, 80) || "Wikimedia Commons contributor",
    license: meta("LicenseShortName") || "See source",
    licenseUrl: meta("LicenseUrl") || undefined,
    width: info.thumbwidth,
    height: info.thumbheight,
    tags: categories.split("|").filter(Boolean).slice(0, 20),
  };
}

export const commons: ImageSource = {
  id: "commons",
  label: "Wikimedia Commons",
  async search({ query, page, orientation, signal }: SearchParams): Promise<SearchPage> {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      generator: "search",
      gsrnamespace: "6",
      gsrsearch: `${query} filetype:bitmap`,
      gsrlimit: String(PAGE_SIZE),
      gsroffset: String((page - 1) * PAGE_SIZE),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: String(DISPLAY_WIDTH),
      iiextmetadatafilter: "ObjectName|ImageDescription|Artist|LicenseShortName|LicenseUrl|Categories",
    });
    const data = (await fetchJson(`${API}?${params}`, signal)) as CommonsResponse;
    if (!data || typeof data !== "object") throw new SourceError("Unexpected response from Wikimedia Commons", "bad-response");
    const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => a.index - b.index);
    return {
      images: pages
        .map(mapCommons)
        .filter((x): x is ImageRef => x !== null && matchesOrientation(x.width ?? 0, x.height ?? 0, orientation)),
      hasMore: !!data.continue,
    };
  },
};
