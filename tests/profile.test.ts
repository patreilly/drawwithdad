import { describe, expect, it } from "vitest";
import { applyMyPreset, makePreset, newProfile, sanitizeProfile } from "../src/profiles/profile";
import { DEFAULT_SETTINGS } from "../src/session/settings";

describe("profiles", () => {
  it("cleans up bad stored data", () => {
    const p = sanitizeProfile({ id: "x", name: "   ", avatar: "💣", color: "neon" as never, settings: { grid: 99 } as never, presets: [null, { id: "my-1", label: "", settings: {} }] as never });
    expect(p.name).toBe("Artist");
    expect(p.avatar).toBe("✏️");
    expect(p.color).toBe("orange");
    expect(p.settings.grid).toBe(6);
    expect(p.presets).toHaveLength(1);
    expect(p.presets[0].label).toBe("My preset");
  });

  it("trims long names", () => {
    expect(newProfile({ name: "A".repeat(100) }).name).toHaveLength(24);
  });

  it("saves a preset without Ollama settings and applies it later", () => {
    const tuned = { ...structuredClone(DEFAULT_SETTINGS), segments: [{ count: 3, seconds: 45 }], grid: 3, flip: "random" as const };
    const preset = makePreset("Saturday class", tuned);
    expect(preset.settings).not.toHaveProperty("ollama");
    expect(preset.settings).not.toHaveProperty("presetId");

    const current = { ...structuredClone(DEFAULT_SETTINGS), ollama: { enabled: true, url: "http://box:11434", model: "m" } };
    const applied = applyMyPreset(current, preset);
    expect(applied.presetId).toBe(preset.id);
    expect(applied.segments).toEqual([{ count: 3, seconds: 45 }]);
    expect(applied.grid).toBe(3);
    expect(applied.ollama.url).toBe("http://box:11434");
  });
});
