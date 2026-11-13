import { SEARCH_TTL_MS, type ImageRecord, type SearchCache } from "./cache";
import { SAFETY_VERSION } from "../safety/imageFilter";
import { findBlockedTerm } from "../safety/textFilter";
import { SOURCES } from "../sources";
import { SourceError, type ImageSource } from "../sources/types";
import { searchKey, takePrefetched } from "./prefetch";
import type { ImageRef, Orientation, SafetyVerdict, SourceId } from "../types";

export interface QueueQuery {
  text: string;
  sources: SourceId[];
}

export interface QueueOptions {
  queries: QueueQuery[];
  orientation: Orientation;
  strict: boolean;
  shuffle: boolean;
  /** Never shown (the user hid them). */
  hiddenIds: Set<string>;
  /** Shown only after everything else runs out (recently drawn). */
  recentIds: Set<string>;
  store: SearchCache;
  classify: (thumbUrl: string, strict: boolean) => Promise<SafetyVerdict>;
  sources?: Record<SourceId, ImageSource>;
  /** Already-approved images to start with (replaying a session). */
  initial?: ImageRef[];
  /** A fixed set of images to draw, such as saved pictures. They still go through the safety check. */
  candidates?: ImageRef[];
  /** How many images to safety-check at once. */
  concurrency?: number;
  /** Thumbs-up counts, so pictures other people liked come first. Never waited on for long. */
  popularity?: (ids: string[]) => Promise<Map<string, number>>;
}

/** How long a search page waits for thumbs-up counts before going ahead without them. */
const POPULARITY_WAIT_MS = 400;

interface Feed {
  query: string;
  /** null for the fixed candidates feed, which never fetches. */
  source: ImageSource | null;
  page: number;
  hasMore: boolean;
  backlog: ImageRef[];
  inflight: Promise<void> | null;
}

/**
 * Turns search queries into a stream of safety-checked images. It pulls a few
 * candidates from each query in turn, so a category session mixes subjects. It
 * checks them in parallel and publishes each safe image as soon as it's
 * verified, so the session can start on the first one.
 */
export class ReferenceQueue {
  readonly images: ImageRef[] = [];
  error: string | null = null;
  exhausted = false;
  onChange: (() => void) | null = null;

  private feeds: Feed[] = [];
  private feedCursor = 0;
  private seen = new Set<string>();
  private deferred: ImageRef[] = [];
  /** Thumbs-up counts from `popularity`, by image id. */
  private likes = new Map<string, number>();
  /** Images before this index have been on screen, so their order is settled. */
  private frontier = 0;
  private target = 0;
  private pumping: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  private readonly abortCtl = new AbortController();
  private readonly sources: Record<SourceId, ImageSource>;

  constructor(private readonly opts: QueueOptions) {
    this.sources = opts.sources ?? SOURCES;
    for (const img of opts.initial ?? []) {
      this.images.push(img);
      this.seen.add(img.id);
    }
    const candidates = (opts.candidates ?? []).filter((img) => !this.seen.has(img.id) && !opts.hiddenIds.has(img.id) && this.seen.add(img.id));
    if (candidates.length) {
      this.feeds.push({ query: "", source: null, page: 1, hasMore: false, backlog: opts.shuffle ? shuffled(candidates) : candidates, inflight: null });
    }
    this.addQueries(opts.queries);
  }

  addQueries(queries: QueueQuery[]): void {
    for (const q of queries) {
      for (const s of q.sources) {
        const key = `${s}|${q.text.toLowerCase()}`;
        if (this.feeds.some((f) => `${f.source?.id}|${f.query.toLowerCase()}` === key)) continue;
        this.feeds.push({ query: q.text, source: this.sources[s], page: 1, hasMore: true, backlog: [], inflight: null });
      }
    }
    if (this.feeds.some((f) => f.hasMore)) this.exhausted = false;
    if (this.images.length < this.target) this.kick();
  }

  /** Asks for at least `count` images. Returns right away; listen via onChange or waitFor. */
  ensure(count: number): void {
    this.target = Math.max(this.target, count);
    this.kick();
  }

  /** Resolves when image `index` is available or nothing more can be found. */
  waitFor(index: number): Promise<ImageRef | null> {
    this.ensure(index + 1);
    return new Promise((resolve) => {
      const check = () => {
        if (this.images[index]) return resolve(this.images[index]), true;
        if (this.exhausted && !this.pumping) return resolve(null), true;
        return false;
      };
      if (check()) return;
      const waiter = () => {
        if (!check()) this.waiters.push(waiter);
      };
      this.waiters.push(waiter);
    });
  }

  /** Tells the queue image `index` is on screen; liked pictures found later go right after it. */
  markShown(index: number): void {
    this.frontier = Math.max(this.frontier, index + 1);
  }

  /** Removes an image (hidden by the user, or it failed to load) and finds a replacement. */
  drop(index: number): void {
    if (index < 0 || index >= this.images.length) return;
    this.images.splice(index, 1);
    this.exhausted = false;
    this.kick();
    this.notify();
  }

  abort(): void {
    this.abortCtl.abort();
    this.exhausted = true;
    this.notify();
  }

  private kick(): void {
    if (this.pumping || this.abortCtl.signal.aborted) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      this.notify();
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    this.onChange?.();
  }

  private async pump(): Promise<void> {
    // Feeds are fetched in parallel, and a slow source never holds up a fast one.
    // We pull a few images at a time from each feed so subjects and sources interleave.
    const live = () => this.feeds.filter((f) => f.hasMore || f.backlog.length || f.inflight);
    while (this.images.length < this.target && !this.abortCtl.signal.aborted) {
      const feeds = live();
      if (!feeds.length) {
        // Out of fresh images: fall back to ones drawn recently rather than stopping early.
        if (!this.deferred.length) break;
        await this.check(this.deferred.splice(0, this.target - this.images.length + 2));
        continue;
      }
      for (const f of feeds) {
        if (!f.backlog.length && f.hasMore && !f.inflight) {
          f.inflight = this.fetchPage(f).finally(() => (f.inflight = null));
        }
      }
      const ready = feeds.filter((f) => f.backlog.length);
      if (!ready.length) {
        await Promise.race(feeds.map((f) => f.inflight).filter(Boolean));
        continue;
      }
      const perVisit = Math.max(3, Math.ceil((this.target - this.images.length) / feeds.length) + 1);
      // Liked pictures go before anything else that's ready, whichever feed they're in.
      const liked = (img: ImageRef) => (this.likes.get(img.id) ?? 0) > 0;
      const popular = ready.find((f) => liked(f.backlog[0]));
      if (popular) {
        const n = popular.backlog.findIndex((img) => !liked(img));
        await this.check(popular.backlog.splice(0, Math.min(perVisit, n < 0 ? popular.backlog.length : n)));
        continue;
      }
      const feed = ready[this.feedCursor++ % ready.length];
      await this.check(feed.backlog.splice(0, perVisit));
    }
    this.exhausted = !live().length && !this.deferred.length;
  }

  private async fetchPage(feed: Feed): Promise<void> {
    const { store, orientation, shuffle } = this.opts;
    const source = feed.source;
    if (!source) return;
    const key = searchKey(source.id, feed.query, orientation, feed.page);
    let images: ImageRef[] | null = null;
    let hasMore = false;

    try {
      const cached = await store.getSearch(key);
      if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL_MS) {
        const records = await store.getImages(cached.imageIds);
        if (records.size === cached.imageIds.length) {
          images = cached.imageIds.map((id) => records.get(id)!);
          hasMore = cached.hasMore;
        }
      }
    } catch {
      // Cache problems never block a session.
    }

    if (!images) {
      try {
        const page =
          (await takePrefetched(key)?.catch(() => null)) ??
          (await source.search({ query: feed.query, page: feed.page, orientation, signal: this.abortCtl.signal }));
        images = page.images;
        hasMore = page.hasMore;
        void this.cacheSearch(key, images, hasMore);
      } catch (e) {
        if (this.abortCtl.signal.aborted) return;
        feed.hasMore = false;
        if (e instanceof SourceError && (e.kind === "rate-limited" || !this.images.length)) this.error = e.message;
        if (!(e instanceof SourceError)) this.error = "Couldn't search for images. Check your internet connection.";
        return;
      }
    }

    feed.page++;
    feed.hasMore = hasMore && images.length > 0;
    const fresh = images.filter((img) => {
      if (this.seen.has(img.id) || this.opts.hiddenIds.has(img.id)) return false;
      this.seen.add(img.id);
      if (this.opts.recentIds.has(img.id)) {
        this.deferred.push(img);
        return false;
      }
      return true;
    });
    feed.backlog.push(...(await this.popularFirst(shuffle ? shuffled(fresh) : fresh)));
  }

  /** Moves pictures people gave a thumbs up to the front, most liked first; the rest keep their order. */
  private async popularFirst(images: ImageRef[]): Promise<ImageRef[]> {
    const lookup = this.opts.popularity;
    if (!lookup || !images.length) return images;
    const counts = await Promise.race([
      lookup(images.map((i) => i.id)).catch(() => null),
      new Promise<null>((res) => setTimeout(() => res(null), POPULARITY_WAIT_MS)),
    ]);
    if (!counts?.size) return images;
    for (const [id, n] of counts) this.likes.set(id, n);
    return images.slice().sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  }

  private async cacheSearch(key: string, images: ImageRef[], hasMore: boolean): Promise<void> {
    try {
      const existing = await this.opts.store.getImages(images.map((i) => i.id));
      const now = Date.now();
      // Keep any safety verdict we already have for an image.
      await this.opts.store.putImages(images.map((i) => ({ ...existing.get(i.id), ...i, firstSeenAt: existing.get(i.id)?.firstSeenAt ?? now })));
      await this.opts.store.putSearch({ key, imageIds: images.map((i) => i.id), hasMore, fetchedAt: now });
    } catch {
      // ignore
    }
  }

  /** Safety-checks candidates in parallel and publishes each safe one immediately. */
  private async check(candidates: ImageRef[]): Promise<void> {
    const known = await this.opts.store.getImages(candidates.map((c) => c.id)).catch(() => new Map<string, ImageRecord>());
    const verdicts: ImageRecord[] = [];
    let i = 0;
    const worker = async () => {
      while (i < candidates.length && !this.abortCtl.signal.aborted) {
        const img = candidates[i++];
        const record = known.get(img.id);
        let verdict = record?.safety?.version === SAFETY_VERSION ? record.safety : undefined;
        if (!verdict) {
          verdict = await this.judge(img);
          // Only remember real verdicts. Timeouts and classifier errors may be temporary.
          if (verdict.scores || verdict.reason?.startsWith("metadata")) {
            verdicts.push({ ...img, firstSeenAt: record?.firstSeenAt ?? Date.now(), safety: verdict });
          }
        }
        if (verdict.safe && this.images.length < this.target + 2 && !this.abortCtl.signal.aborted) {
          this.publish(img);
          this.notify();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 3, candidates.length) }, worker));
    if (verdicts.length) await this.opts.store.putImages(verdicts).catch(() => {});
  }

  /** Appends a safe image, except a liked one jumps ahead of everything not shown yet (after other liked ones). */
  private publish(img: ImageRef): void {
    const liked = (i: ImageRef) => (this.likes.get(i.id) ?? 0) > 0;
    if (!liked(img)) return void this.images.push(img);
    let at = Math.min(this.frontier, this.images.length);
    while (at < this.images.length && liked(this.images[at])) at++;
    this.images.splice(at, 0, img);
  }

  private async judge(img: ImageRef): Promise<SafetyVerdict> {
    const term = findBlockedTerm(`${img.title} ${img.tags.join(" ")}`, { metadata: true });
    if (term) return { safe: false, reason: `metadata:${term}`, version: SAFETY_VERSION, checkedAt: Date.now() };
    try {
      // Commons has no safe-search of its own, so its images always get the strict thresholds.
      return await this.opts.classify(img.thumbUrl, this.opts.strict || img.source === "commons");
    } catch {
      // If the classifier itself breaks, fail closed.
      return { safe: false, reason: "classifier-error", version: SAFETY_VERSION, checkedAt: Date.now() };
    }
  }
}

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
