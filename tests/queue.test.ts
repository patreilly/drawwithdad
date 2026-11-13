import { describe, expect, it } from "vitest";
import { MemoryCache } from "../src/search/cache";
import { ReferenceQueue } from "../src/search/referenceQueue";
import type { ImageSource } from "../src/sources/types";
import type { ImageRef, SafetyVerdict } from "../src/types";

function fakeSource(prefix: string, pages = 2): ImageSource & { calls: number } {
  const src = {
    id: "openverse" as const,
    label: "fake",
    calls: 0,
    async search({ query, page }: { query: string; page: number }) {
      src.calls++;
      const images: ImageRef[] = Array.from({ length: 5 }, (_, i) => ({
        id: `openverse:${prefix}-${query}-${page}-${i}`, source: "openverse" as const, sourceId: `${i}`,
        url: "u", thumbUrl: i === 0 ? "unsafe" : "t", landingUrl: "l",
        title: i === 1 ? "nude study" : `${query} ${i}`, creator: "c", license: "CC0", tags: [],
      }));
      return { images, hasMore: page < pages };
    },
  };
  return src;
}

const classify = async (thumb: string): Promise<SafetyVerdict> => ({ safe: thumb !== "unsafe", scores: {}, version: 1, checkedAt: 0 });

function makeQueue(queries: string[], extra: Partial<ConstructorParameters<typeof ReferenceQueue>[0]> = {}) {
  const source = fakeSource("x");
  const store = new MemoryCache();
  const queue = new ReferenceQueue({
    queries: queries.map((text) => ({ text, sources: ["openverse"] })),
    orientation: "any", strict: false, shuffle: false, hiddenIds: new Set(), recentIds: new Set(),
    store, classify, sources: { openverse: source, commons: source, nasa: source }, ...extra,
  });
  return { queue, source, store };
}

describe("ReferenceQueue", () => {
  it("puts pictures with thumbs-ups first, and doesn't wait long for the counts", async () => {
    const liked = new Map([["openverse:x-cat-1-4", 3], ["openverse:x-cat-1-3", 1]]);
    const { queue } = makeQueue(["cat"], { popularity: async () => liked });
    await queue.waitFor(1);
    expect(queue.images.slice(0, 2).map((i) => i.id)).toEqual(["openverse:x-cat-1-4", "openverse:x-cat-1-3"]);

    // A liked picture from another subject jumps ahead of the round-robin too.
    const mixed = makeQueue(["cat", "dog"], { popularity: async () => new Map([["openverse:x-dog-1-4", 2]]) });
    await mixed.queue.waitFor(1);
    expect(mixed.queue.images.slice(0, 2).map((i) => i.id)).toContain("openverse:x-dog-1-4");

    // One found after the session started goes right after the picture on screen.
    let late = new Map<string, number>();
    const growing = makeQueue(["cat"], { popularity: async () => late });
    await growing.queue.waitFor(2);
    growing.queue.markShown(0);
    late = new Map([["openverse:x-cat-2-3", 1]]);
    await growing.queue.waitFor(growing.queue.images.length + 2);
    expect(growing.queue.images[1].id).toBe("openverse:x-cat-2-3");

    const slow = makeQueue(["cat"], { popularity: () => new Promise(() => {}) });
    const started = Date.now();
    await slow.queue.waitFor(0);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(slow.queue.images[0].id).toBe("openverse:x-cat-1-2");
  });

  it("drops images that fail the classifier or the metadata filter", async () => {
    const { queue } = makeQueue(["cat"]);
    await queue.waitFor(2);
    expect(queue.images.every((i) => !i.id.endsWith("-0") && !i.id.endsWith("-1"))).toBe(true);
  });

  it("interleaves subjects from several queries", async () => {
    const { queue } = makeQueue(["cat", "dog", "owl"]);
    await queue.waitFor(5);
    const subjects = new Set(queue.images.slice(0, 6).map((i) => i.id.split("-")[1]));
    expect(subjects.size).toBe(3);
  });

  it("safety-checks a fixed set of saved pictures without searching", async () => {
    const ref = (id: string, thumbUrl = "t"): ImageRef => ({
      id, source: "openverse", sourceId: id, url: "u", thumbUrl, landingUrl: "l", title: id, creator: "c", license: "CC0", tags: [],
    });
    const { queue, source } = makeQueue([], {
      candidates: [ref("openverse:a"), ref("openverse:bad", "unsafe"), ref("openverse:hidden"), ref("openverse:b")],
      hiddenIds: new Set(["openverse:hidden"]),
    });
    expect(await queue.waitFor(5)).toBeNull();
    expect(queue.images.map((i) => i.id)).toEqual(["openverse:a", "openverse:b"]);
    expect(source.calls).toBe(0);
  });

  it("reports exhaustion with null when there aren't enough safe images", async () => {
    const { queue } = makeQueue(["cat"]);
    expect(await queue.waitFor(50)).toBeNull();
    expect(queue.images.length).toBe(6); // 2 pages × 3 safe
  });

  it("skips hidden images and serves recent ones only as a fallback", async () => {
    const { queue } = makeQueue(["cat"], {
      hiddenIds: new Set(["openverse:x-cat-1-2"]),
      recentIds: new Set(["openverse:x-cat-1-3"]),
    });
    await queue.waitFor(10);
    const ids = queue.images.map((i) => i.id);
    expect(ids).not.toContain("openverse:x-cat-1-2");
    expect(ids[ids.length - 1]).toBe("openverse:x-cat-1-3");
  });

  it("reuses cached searches and verdicts on the next session", async () => {
    const first = makeQueue(["cat"]);
    await first.queue.waitFor(1);
    let classified = 0;
    const second = new ReferenceQueue({
      queries: [{ text: "cat", sources: ["openverse"] }],
      orientation: "any", strict: false, shuffle: false, hiddenIds: new Set(), recentIds: new Set(),
      store: first.store, classify: async (t) => (classified++, classify(t)),
      sources: { openverse: first.source, commons: first.source, nasa: first.source },
    });
    const calls = first.source.calls;
    await second.waitFor(1);
    expect(first.source.calls).toBe(calls); // page 1 came from the cache
    expect(classified).toBe(0);
  });
});

describe("ReferenceQueue with sources of different speeds", () => {
  it("serves the fast source first instead of waiting on the slow one", async () => {
    const fast = fakeSource("fast");
    const slow = fakeSource("slow");
    const slowSearch = slow.search.bind(slow);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    slow.search = async (p) => (await slowGate, slowSearch(p));
    const queue = new ReferenceQueue({
      queries: [{ text: "cat", sources: ["openverse", "commons"] }],
      orientation: "any", strict: false, shuffle: false, hiddenIds: new Set(), recentIds: new Set(),
      store: new MemoryCache(), classify, sources: { openverse: slow, commons: fast, nasa: fast },
    });
    const first = await queue.waitFor(0);
    expect(first?.id).toContain("fast");
    releaseSlow();
    await queue.waitFor(8);
    expect(queue.images.some((i) => i.id.includes("slow"))).toBe(true);
  });
});
