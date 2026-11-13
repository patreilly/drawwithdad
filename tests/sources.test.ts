import { describe, expect, it } from "vitest";
import { parseExpansion, pickModel } from "../src/ollama/client";
import { planSearch } from "../src/search/plan";
import { mapNasa } from "../src/sources/nasa";
import { licenseLabel, mapOpenverse } from "../src/sources/openverse";

describe("openverse mapping", () => {
  const base = { id: "1", url: "u", thumbnail: "t", foreign_landing_url: "l", license: "by", license_version: "2.0" };
  it("maps attribution and drops sensitive results", () => {
    expect(mapOpenverse(base)?.license).toBe("CC BY 2.0");
    expect(mapOpenverse({ ...base, mature: true })).toBeNull();
    expect(mapOpenverse({ ...base, unstable__sensitivity: ["sensitive_text"] })).toBeNull();
    expect(licenseLabel("cc0")).toBe("CC0");
  });
});

describe("nasa mapping", () => {
  it("picks thumb and large renditions", () => {
    const ref = mapNasa({
      data: [{ nasa_id: "A1", title: "Rocket", media_type: "image" }],
      links: [
        { href: "https://x/A1~thumb.jpg", rel: "preview" },
        { href: "https://x/A1~large.jpg", rel: "alternate", width: 1920, height: 1080 },
      ],
    });
    expect(ref).toMatchObject({ id: "nasa:A1", thumbUrl: "https://x/A1~thumb.jpg", url: "https://x/A1~large.jpg" });
  });
});

describe("planSearch", () => {
  it("refuses blocked prompts", () => {
    expect(planSearch({ prompt: "naked people" }).ok).toBe(false);
  });
  it("mixes several subjects for a category", () => {
    const r = planSearch({ categoryId: "animals" });
    expect(r.ok && r.plan.queries.length).toBe(4);
  });
  it("routes figure drawing to the strict people category", () => {
    const r = planSearch({ prompt: "life drawing" });
    expect(r.ok && r.plan.category?.id).toBe("people");
    expect(r.ok && r.plan.strict).toBe(true);
  });
  it("adds NASA for space prompts", () => {
    const r = planSearch({ prompt: "rocket launch" });
    expect(r.ok && r.plan.queries[0].sources).toContain("nasa");
  });
});

describe("ollama", () => {
  it("validates and filters model output", () => {
    const out = parseExpansion(JSON.stringify({ safe: true, queries: ["bat wing", "nude model", 5, "a very long query with far too many words in it", "dragon"] }), "dragon");
    expect(out).toEqual({ safe: true, queries: ["bat wing"] });
    expect(parseExpansion("not json", "x")).toEqual({ safe: true, queries: [] });
  });
  it("picks the smallest text model", () => {
    expect(pickModel("", ["llama3.1:8b", "llama3.2:3b", "nomic-embed-text"])).toBe("llama3.2:3b");
    expect(pickModel("mine", [])).toBe("mine");
  });
});

import { mapCommons } from "../src/sources/commons";

describe("commons mapping", () => {
  const page = (categories: string, title = "File:Pelican.jpg") => ({
    pageid: 7, index: 1, title,
    imageinfo: [{
      thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/1280px-P.jpg?utm=x",
      thumbwidth: 1280, thumbheight: 853, descriptionurl: "https://commons.wikimedia.org/wiki/File:P.jpg", mime: "image/jpeg",
      extmetadata: { Artist: { value: '<a href="//x">Jane &amp; Co</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" }, Categories: { value: categories } },
    }],
  });
  it("maps photos with a CORS-readable thumb and plain-text credit", () => {
    expect(mapCommons(page("Birds in water|Pelecanus"))).toMatchObject({
      id: "commons:7", creator: "Jane & Co", license: "CC BY-SA 4.0",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/1280px-P.jpg",
      thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/500px-P.jpg",
    });
  });
  it("drops artworks and unsafe categories", () => {
    expect(mapCommons(page("Oil paintings by someone"))).toBeNull();
    expect(mapCommons(page("Nude women"))).toBeNull();
    expect(mapCommons(page("Dead birds"))).toBeNull();
  });
});

describe("free prompt sources", () => {
  it("skips Commons for prompts about people", () => {
    const r = planSearch({ prompt: "girl running" });
    expect(r.ok && r.plan.queries[0].sources).toEqual(["openverse"]);
    const r2 = planSearch({ prompt: "pelican" });
    expect(r2.ok && r2.plan.queries[0].sources).toEqual(["commons", "openverse"]);
  });
});
