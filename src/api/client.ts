import type { Profile } from "../profiles/profile";
import type { Segment } from "../session/settings";
import type { ImageRef } from "../types";

/** What the server knows about the signed-in family. */
export interface Me {
  email: string;
  lastProfileId: string | null;
  /** Password-protected profiles unlocked in this login session. */
  unlocked: string[];
  profiles: Profile[];
}

export interface HistoryRecord {
  id: string;
  profileId: string;
  startedAt: number;
  endedAt?: number;
  prompt: string;
  categoryId?: string;
  segments: Segment[];
  imageIds: string[];
}

export interface PasswordChange {
  current?: string;
  next?: string;
  remove?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Talks to the Draw with Dad API (same origin, under /api). The login is an
 * httpOnly cookie the page can't read; nothing is kept in browser storage.
 */
export class Api {
  /** Called when the server says the login has expired. */
  onSignedOut: (() => void) | null = null;

  constructor(private readonly base = "/api") {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        credentials: "same-origin",
        headers: {
          // The server requires this on changes; other sites can't send it (no CORS), which blocks CSRF.
          "X-Requested-With": "draw-with-dad",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "Can't reach the Draw with Dad server. Check your connection.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/auth/")) this.onSignedOut?.();
      throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status}).`);
    }
    return data as T;
  }

  // Account
  me = () => this.call<Me>("GET", "/me");
  signUp = (email: string, password: string, name: string) => this.call<Me>("POST", "/auth/signup", { email, password, name });
  signIn = (email: string, password: string) => this.call<Me>("POST", "/auth/login", { email, password });
  signOut = () => this.call<void>("POST", "/auth/logout", {});
  forgotPassword = (email: string) => this.call<void>("POST", "/auth/forgot", { email });
  resetPassword = (token: string, password: string) => this.call<Me>("POST", "/auth/reset", { token, password });
  deleteAccount = (password: string) => this.call<void>("DELETE", "/me", { password });
  setLastProfile = (lastProfileId: string) => this.call<void>("PATCH", "/me", { lastProfileId });
  lockAll = () => this.call<void>("POST", "/lock", {});

  // Profiles
  createProfile = (p: { name: string; avatar: string; color: string; password?: string }) => this.call<Profile>("POST", "/profiles", p);
  updateProfile = (id: string, changes: Partial<Pick<Profile, "name" | "avatar" | "color" | "settings" | "presets">> & { password?: PasswordChange }) =>
    this.call<Profile>("PUT", `/profiles/${encodeURIComponent(id)}`, changes);
  deleteProfile = (id: string) => this.call<void>("DELETE", `/profiles/${encodeURIComponent(id)}`);
  unlockProfile = (id: string, password?: string) => this.call<void>("POST", `/profiles/${encodeURIComponent(id)}/unlock`, { password });

  // Saved pictures
  favorites = (profileId: string) => this.call<ImageRef[]>("GET", `/profiles/${encodeURIComponent(profileId)}/favorites`);
  addFavorite = (profileId: string, image: ImageRef) => this.call<void>("PUT", `/profiles/${encodeURIComponent(profileId)}/favorites`, { image });
  removeFavorite = (profileId: string, imageId: string) =>
    this.call<void>("DELETE", `/profiles/${encodeURIComponent(profileId)}/favorites?imageId=${encodeURIComponent(imageId)}`);

  // History
  history = (profileId: string, limit: number) => this.call<HistoryRecord[]>("GET", `/profiles/${encodeURIComponent(profileId)}/history?limit=${limit}`);
  addHistory = (profileId: string, record: Omit<HistoryRecord, "id" | "profileId">) =>
    this.call<void>("POST", `/profiles/${encodeURIComponent(profileId)}/history`, record);
  clearHistory = (profileId: string) => this.call<void>("DELETE", `/profiles/${encodeURIComponent(profileId)}/history`);

  // Hidden images (shared by the family)
  hidden = () => this.call<{ imageId: string; profileId: string }[]>("GET", "/hidden");
  hide = (profileId: string, imageId: string) => this.call<void>("PUT", "/hidden", { profileId, imageId });
  clearHidden = (profileId: string) => this.call<void>("DELETE", `/hidden?profileId=${encodeURIComponent(profileId)}`);

  // Thumbs-ups: counts are public, liking needs an account (one per family)
  likes = (ids: string[]) => this.call<{ counts: Record<string, number>; mine: string[] }>("POST", "/likes/lookup", { ids });
  like = (imageId: string) => this.call<{ count: number }>("PUT", "/likes", { imageId });
  unlike = (imageId: string) => this.call<{ count: number }>("DELETE", `/likes?imageId=${encodeURIComponent(imageId)}`);
}
