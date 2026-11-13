import { describe, expect, it } from "vitest";
import { applyPreset, capSegments, DEFAULT_SETTINGS, describeSegments, PRESETS, sanitize, totalSeconds } from "../src/session/settings";

describe("settings", () => {
  it("sanitizes junk and clamps values", () => {
    const s = sanitize({ segments: [{ count: 0, seconds: 1 }, "x"], getReadySeconds: 999, flip: "sideways", ollama: { enabled: true } });
    expect(s.segments).toEqual([{ count: 1, seconds: 5 }]);
    expect(s.getReadySeconds).toBe(30);
    expect(s.flip).toBe("off");
    expect(s.ollama.url).toBe(DEFAULT_SETTINGS.ollama.url);
  });

  it("presets reset flow overrides from the previous preset", () => {
    const memory = applyPreset(DEFAULT_SETTINGS, PRESETS.find((p) => p.id === "memory")!);
    expect(memory.memoryViewSeconds).toBe(20);
    const quick = applyPreset(memory, PRESETS.find((p) => p.id === "quick")!);
    expect(quick.memoryViewSeconds).toBe(0);
  });

  it("describes and totals the gesture class", () => {
    const cls = PRESETS.find((p) => p.id === "class")!;
    expect(describeSegments(cls.segments)).toBe("10 × 30s, 5 × 1 min, 3 × 2 min, 2 × 5 min");
    expect(totalSeconds(cls.segments)).toBe(300 + 300 + 360 + 600);
    expect(totalSeconds([{ count: 1, seconds: null }])).toBeNull();
  });
});

describe("capSegments", () => {
  it("trims rounds to the number of pictures available", () => {
    const segs = [{ count: 10, seconds: 30 }, { count: 5, seconds: 60 }, { count: 2, seconds: 300 }];
    expect(capSegments(segs, 12)).toEqual([{ count: 10, seconds: 30 }, { count: 2, seconds: 60 }]);
    expect(capSegments(segs, 1)).toEqual([{ count: 1, seconds: 30 }]);
    expect(capSegments(segs, 50)).toEqual(segs);
  });
});
