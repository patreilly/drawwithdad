import { DEFAULT_SETTINGS, sanitize, type SessionSettings } from "../session/settings";

/**
 * A profile is one person drawing under a family account: their settings,
 * their own presets, saved pictures and history. It's stored on the server;
 * this module is shared by the browser and the API, so both validate the same way.
 */
export interface Profile {
  id: string;
  name: string;
  avatar: string;
  color: AccentColor;
  createdAt: number;
  settings: SessionSettings;
  presets: MyPreset[];
  /** The profile has its own password (checked by the server; the hash never leaves it). */
  hasLock?: boolean;
}

/** A saved customization. It stores everything that shapes a session except Ollama. */
export interface MyPreset {
  id: string;
  label: string;
  settings: PresetSettings;
}

export type PresetSettings = Omit<SessionSettings, "presetId" | "ollama">;

export const AVATARS = ["✏️", "🦊", "🐻", "🐱", "🐶", "🦉", "🐢", "🦄", "🐉", "🦖", "🐙", "🚀", "🌻", "🎨", "🌈", "⭐"];
export const ACCENT_COLORS = ["orange", "blue", "green", "purple", "pink", "teal"] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];

export const MAX_PROFILES = 12;
export const MAX_PRESETS = 12;
export const MAX_NAME = 24;

export function newProfile(fields: { id?: string; name: string; avatar?: string; color?: AccentColor; settings?: SessionSettings }): Profile {
  return sanitizeProfile({
    id: fields.id ?? crypto.randomUUID(),
    name: fields.name,
    avatar: fields.avatar,
    color: fields.color,
    createdAt: Date.now(),
    settings: fields.settings ?? structuredClone(DEFAULT_SETTINGS),
    presets: [],
  });
}

/** Cleans a profile so old, hand-edited or hostile data can't break the app. */
export function sanitizeProfile(input: Partial<Profile>): Profile {
  const name = String(input.name ?? "").trim().slice(0, MAX_NAME) || "Artist";
  const presets = Array.isArray(input.presets) ? input.presets : [];
  return {
    id: String(input.id || crypto.randomUUID()).slice(0, 64),
    name,
    avatar: AVATARS.includes(input.avatar as string) ? input.avatar! : AVATARS[0],
    color: ACCENT_COLORS.includes(input.color as AccentColor) ? input.color! : "orange",
    createdAt: Number(input.createdAt) || Date.now(),
    settings: sanitize(input.settings),
    presets: presets
      .filter((p) => p && typeof p === "object" && typeof p.id === "string")
      .slice(0, MAX_PRESETS)
      .map((p) => ({ id: p.id.slice(0, 64), label: String(p.label ?? "").trim().slice(0, MAX_NAME) || "My preset", settings: presetSettings(sanitize(p.settings)) })),
    ...(input.hasLock ? { hasLock: true } : {}),
  };
}

export function presetSettings(settings: SessionSettings): PresetSettings {
  const { presetId: _p, ollama: _o, ...rest } = settings;
  return structuredClone(rest);
}

export function makePreset(label: string, settings: SessionSettings): MyPreset {
  return { id: `my-${crypto.randomUUID()}`, label: label.trim().slice(0, MAX_NAME) || "My preset", settings: presetSettings(settings) };
}

/** Applies a saved preset, keeping the profile's Ollama setup. */
export function applyMyPreset(settings: SessionSettings, preset: MyPreset): SessionSettings {
  return sanitize({ ...structuredClone(preset.settings), presetId: preset.id, ollama: settings.ollama });
}

export const MIN_ACCOUNT_PASSWORD = 8;
export const MIN_PROFILE_PASSWORD = 4;
export const MAX_PASSWORD = 128;

/** Shared password rules, so the form and the API say the same thing. */
export function passwordProblem(password: string, confirm: string, min: number): string | null {
  if (password.length < min) return `Use at least ${min} characters.`;
  if (password.length > MAX_PASSWORD) return "That password is too long.";
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}
