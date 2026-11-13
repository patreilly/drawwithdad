import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../server/passwords";
import { normalizeEmail, sanitizeImageId, sanitizeImageRef, sanitizeSegments } from "../server/validate";

describe("password hashing", () => {
  it("verifies the right password only, and salts each hash", async () => {
    const a = await hashPassword("pancakes", 10);
    const b = await hashPassword("pancakes", 10);
    expect(a).not.toContain("pancakes");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "pancakes")).toBe(true);
    expect(await verifyPassword(a, "Pancakes")).toBe(false);
    expect(await verifyPassword("garbage", "pancakes")).toBe(false);
  });

  it("uses OWASP-strength scrypt by default", async () => {
    expect((await hashPassword("pancakes")).startsWith("scrypt$17$8$1$")).toBe(true);
  });
});

describe("input validation", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail("  Dad@Example.COM ")).toBe("dad@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });

  it("accepts only https image references from known sources", () => {
    const ok = { source: "openverse", sourceId: "abc", url: "https://x/a.jpg", thumbUrl: "https://x/t.jpg", landingUrl: "https://x", title: "t", creator: "c", license: "CC0", tags: [] };
    expect(sanitizeImageRef(ok)?.id).toBe("openverse:abc");
    expect(sanitizeImageRef({ ...ok, url: "http://x/a.jpg" })).toBeNull();
    expect(sanitizeImageRef({ ...ok, thumbUrl: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeImageRef({ ...ok, source: "evil" })).toBeNull();
    expect(sanitizeImageRef({ ...ok, id: "nasa:spoofed" })?.id).toBe("openverse:abc");
  });

  it("checks image ids and clamps rounds", () => {
    expect(sanitizeImageId("commons:123")).toBe("commons:123");
    expect(sanitizeImageId("evil:1")).toBeNull();
    expect(sanitizeSegments([{ count: 999, seconds: 1 }, { count: 2, seconds: null }])).toEqual([{ count: 100, seconds: 5 }, { count: 2, seconds: null }]);
  });
});
