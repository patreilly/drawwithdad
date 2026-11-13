import type { Segment } from "../src/session/settings";
import type { ImageRef, SourceId } from "../src/types";

const SOURCES: SourceId[] = ["openverse", "commons", "nasa"];

export function normalizeEmail(input: unknown): string | null {
  const email = String(input ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);

function httpsUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/**
 * Saved pictures arrive from the browser, so they're untrusted: only https URLs
 * from known sources, sizes capped. They're shown only to the same family, and
 * the browser safety-checks them again before display.
 */
export function sanitizeImageRef(input: unknown): ImageRef | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Partial<ImageRef>;
  if (!SOURCES.includes(i.source as SourceId)) return null;
  const url = httpsUrl(i.url);
  const thumbUrl = httpsUrl(i.thumbUrl);
  const landingUrl = httpsUrl(i.landingUrl);
  const sourceId = str(i.sourceId, 200);
  if (!url || !thumbUrl || !landingUrl || !sourceId) return null;
  const licenseUrl = i.licenseUrl ? httpsUrl(i.licenseUrl) : null;
  const creatorUrl = i.creatorUrl ? httpsUrl(i.creatorUrl) : null;
  return {
    id: `${i.source}:${sourceId}`,
    source: i.source as SourceId,
    sourceId,
    url,
    thumbUrl,
    landingUrl,
    title: str(i.title, 300),
    creator: str(i.creator, 200),
    license: str(i.license, 100),
    ...(licenseUrl ? { licenseUrl } : {}),
    ...(creatorUrl ? { creatorUrl } : {}),
    ...(Number.isFinite(i.width) ? { width: Number(i.width) } : {}),
    ...(Number.isFinite(i.height) ? { height: Number(i.height) } : {}),
    tags: Array.isArray(i.tags) ? i.tags.slice(0, 30).map((t) => str(t, 60)) : [],
  };
}

export function sanitizeImageId(input: unknown): string | null {
  const id = str(input, 220);
  const [source, ...rest] = id.split(":");
  return SOURCES.includes(source as SourceId) && rest.join(":") ? id : null;
}

export function sanitizeSegments(input: unknown): Segment[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map((s) => ({
    count: Math.min(100, Math.max(1, Math.round(Number(s?.count)) || 1)),
    seconds: s?.seconds === null ? null : Math.min(14400, Math.max(5, Math.round(Number(s?.seconds)) || 60)),
  }));
}
