import type { Orientation } from "../types";

/** `seconds: null` means untimed: the image stays until you press Next. */
export interface Segment {
  count: number;
  seconds: number | null;
}

export type FlipMode = "off" | "always" | "random";

export interface SessionSettings {
  presetId: string;
  segments: Segment[];

  // Flow
  getReadySeconds: number;
  advance: "auto" | "manual";
  breakEvery: number; // images between breaks, 0 = no breaks
  breakSeconds: number;
  /** Memory drawing: show the image this long, then hide it. 0 = off. */
  memoryViewSeconds: number;

  // Images
  orientation: Orientation;
  shuffle: boolean;
  avoidRepeats: boolean;

  // Study aids (also toggleable during a session)
  flip: FlipMode;
  grayscale: boolean;
  posterize: number; // 0 = off, else number of tones (2–5)
  grid: number; // 0 = off, else N×N

  // Display & sound
  timerDisplay: "large" | "small" | "hidden";
  sound: boolean;
  warnSeconds: number; // beep during the last N seconds, 0 = off
  volume: number; // 0–1

  // Smart search via a local Ollama
  ollama: { enabled: boolean; url: string; model: string };
}

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  segments: Segment[];
  overrides?: Partial<SessionSettings>;
}

export const PRESETS: Preset[] = [
  { id: "warmup", label: "Warm-up", blurb: "Loose, fast gestures", segments: [{ count: 10, seconds: 30 }] },
  { id: "quick", label: "Quick sketch", blurb: "A good default", segments: [{ count: 10, seconds: 120 }] },
  {
    id: "class",
    label: "Gesture class",
    blurb: "Starts fast, gets longer",
    segments: [
      { count: 10, seconds: 30 },
      { count: 5, seconds: 60 },
      { count: 3, seconds: 120 },
      { count: 2, seconds: 300 },
    ],
  },
  { id: "kids", label: "Kids' sketch", blurb: "Relaxed pace for little artists", segments: [{ count: 6, seconds: 180 }], overrides: { getReadySeconds: 5 } },
  { id: "study", label: "Study", blurb: "Time for shapes and values", segments: [{ count: 4, seconds: 300 }] },
  { id: "long", label: "Long study", blurb: "One careful drawing", segments: [{ count: 1, seconds: 1200 }] },
  {
    id: "memory",
    label: "Memory",
    blurb: "Look for 20s, then draw from memory",
    segments: [{ count: 6, seconds: 120 }],
    overrides: { memoryViewSeconds: 20 },
  },
  { id: "untimed", label: "Untimed", blurb: "Press Next when you're done", segments: [{ count: 10, seconds: null }], overrides: { advance: "manual" } },
];

/** Durations offered in the custom editor. */
export const DURATION_CHOICES: (number | null)[] = [
  15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, null,
];

const FLOW_DEFAULTS = {
  getReadySeconds: 3,
  advance: "auto" as const,
  memoryViewSeconds: 0,
};

export const DEFAULT_SETTINGS: SessionSettings = {
  presetId: "quick",
  segments: [{ count: 10, seconds: 120 }],
  ...FLOW_DEFAULTS,
  breakEvery: 0,
  breakSeconds: 60,
  orientation: "any",
  shuffle: true,
  avoidRepeats: true,
  flip: "off",
  grayscale: false,
  posterize: 0,
  grid: 0,
  timerDisplay: "large",
  sound: true,
  warnSeconds: 3,
  volume: 0.5,
  ollama: { enabled: false, url: "http://localhost:11434", model: "" },
};

/** Switching presets resets the flow fields a preset may override, then applies its overrides. */
export function applyPreset(settings: SessionSettings, preset: Preset): SessionSettings {
  return {
    ...settings,
    ...FLOW_DEFAULTS,
    ...preset.overrides,
    presetId: preset.id,
    segments: preset.segments.map((s) => ({ ...s })),
  };
}

export function imageCount(segments: Segment[]): number {
  return segments.reduce((n, s) => n + s.count, 0);
}

/** Trims rounds so there are at most `max` images, for sessions drawn from a fixed set of pictures. */
export function capSegments(segments: Segment[], max: number): Segment[] {
  const out: Segment[] = [];
  let left = Math.max(1, max);
  for (const seg of segments) {
    if (left <= 0) break;
    out.push({ ...seg, count: Math.min(seg.count, left) });
    left -= seg.count;
  }
  return out;
}

/** Total drawing time in seconds, or null if any part is untimed. */
export function totalSeconds(segments: Segment[]): number | null {
  let total = 0;
  for (const s of segments) {
    if (s.seconds === null) return null;
    total += s.count * s.seconds;
  }
  return total;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "untimed";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h} hr`;
}

export function describeSegments(segments: Segment[]): string {
  return segments.map((s) => `${s.count} × ${formatDuration(s.seconds)}`).join(", ");
}

/** Merges stored settings over defaults and clamps values, so old or hand-edited data can't break a session. */
export function sanitize(input: unknown): SessionSettings {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== "object") return d;
  const s = { ...d, ...(input as Partial<SessionSettings>) };
  s.ollama = { ...d.ollama, ...(s.ollama ?? {}) };

  const segments = Array.isArray(s.segments)
    ? s.segments
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          count: clampInt(x.count, 1, 100, 1),
          seconds: x.seconds === null ? null : clampInt(x.seconds, 5, 4 * 3600, 60),
        }))
    : [];
  s.segments = segments.length ? segments.slice(0, 10) : d.segments;

  s.getReadySeconds = clampInt(s.getReadySeconds, 0, 30, d.getReadySeconds);
  s.breakEvery = clampInt(s.breakEvery, 0, 100, 0);
  s.breakSeconds = clampInt(s.breakSeconds, 5, 1800, d.breakSeconds);
  s.memoryViewSeconds = clampInt(s.memoryViewSeconds, 0, 600, 0);
  s.posterize = s.posterize ? clampInt(s.posterize, 2, 5, 3) : 0;
  s.grid = s.grid ? clampInt(s.grid, 2, 6, 3) : 0;
  s.warnSeconds = clampInt(s.warnSeconds, 0, 30, d.warnSeconds);
  s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));
  if (!["auto", "manual"].includes(s.advance)) s.advance = d.advance;
  if (!["off", "always", "random"].includes(s.flip)) s.flip = d.flip;
  if (!["any", "landscape", "portrait", "square"].includes(s.orientation)) s.orientation = d.orientation;
  if (!["large", "small", "hidden"].includes(s.timerDisplay)) s.timerDisplay = d.timerDisplay;
  return s;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
