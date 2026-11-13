import "./styles.css";
import { Api, ApiError, type HistoryRecord, type Me } from "./api/client";
import { newProfile, type Profile } from "./profiles/profile";
import { warmUpSafetyModel } from "./safety/imageFilter";
import { MemoryCache, type SearchCache } from "./search/cache";
import { planSearch, type SearchPlan } from "./search/plan";
import type { SessionSettings } from "./session/settings";
import type { ImageRef } from "./types";
import { renderAuth, type AuthMode } from "./ui/auth";
import { h } from "./ui/dom";
import { renderGallery } from "./ui/gallery";
import { renderHome } from "./ui/home";
import { renderWhoIsDrawing } from "./ui/profiles";
import { runSession, type SessionResult } from "./ui/session";
import { renderSummary } from "./ui/summary";

export interface App {
  api: Api;
  cache: SearchCache;
  /** False for a guest: drawing works, but nothing is kept after the tab closes. */
  signedIn: boolean;
  email: string;
  profiles: Profile[];
  /** The profile that's drawing. */
  profile: Profile;
  /** Shortcut for profile.settings. */
  settings: SessionSettings;
  /** Ids of the current profile's saved pictures. */
  favoriteIds: Set<string>;
  /** Thumbs-up counts seen so far (everyone's), and the pictures this family liked. */
  likes: Map<string, number>;
  likedIds: Set<string>;

  /** Applies settings now and saves them to the server shortly after. */
  updateSettings(settings: SessionSettings): void;
  /** Saves profile changes to the server and returns the stored profile. */
  saveProfile(id: string, changes: Parameters<Api["updateProfile"]>[1]): Promise<Profile>;
  addProfile(fields: Parameters<Api["createProfile"]>[0]): Promise<void>;
  /** True if the profile has a password and this login hasn't unlocked it. */
  isLocked(profile: Profile): boolean;
  /** Switches to a profile without a password (or one already unlocked). */
  switchProfile(id: string): Promise<void>;
  /** Checks the password with the server, then switches to that profile. */
  unlock(id: string, password: string): Promise<boolean>;
  /** Locks password-protected profiles and shows "Who's drawing?". */
  lock(): void;
  deleteProfile(id: string): Promise<void>;
  /** Saves or un-saves a picture. Returns whether it's now saved. */
  toggleFavorite(image: ImageRef): Promise<boolean>;
  /** Gives a picture this family's thumbs up, or takes it back. Returns whether it's now liked. */
  toggleLike(image: ImageRef): Promise<boolean>;
  /** Fetches thumbs-up counts for pictures not looked up yet, and returns counts for all of them. */
  likeCounts(ids: string[]): Promise<Map<string, number>>;

  // The family's drawing data: on the server when signed in, in this tab only for a guest.
  hiddenIds(): Promise<Set<string>>;
  hide(imageId: string): Promise<void>;
  history(limit: number): Promise<HistoryRecord[]>;
  addHistory(record: Omit<HistoryRecord, "id" | "profileId">): Promise<void>;

  /** Shows sign-in (or sign-up), with a way back to drawing as a guest. */
  showSignIn(opts?: { message?: string; mode?: AuthMode }): void;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<void>;

  goHome(message?: string): void;
  showGallery(): void;
  start(input: { prompt?: string; categoryId?: string }, replay?: ImageRef[]): void;
  startPlan(plan: SearchPlan, replay?: ImageRef[]): void;
  showSummary(result: SessionResult): void;
}

const SETTINGS_SAVE_DELAY_MS = 600;
const LIKE_LOOKUP_BATCH = 50;

/** A guest's profile lives in memory only: nothing goes to the server or browser storage. */
const guestProfile = () => newProfile({ id: "guest", name: "Guest" });

async function boot() {
  const root = document.getElementById("app")!;
  // Start downloading the safety model right away, so it's ready by the time you press Start.
  void warmUpSafetyModel().catch(() => {});

  const show = (el: HTMLElement) => {
    root.replaceChildren(el);
    window.scrollTo(0, 0);
  };

  const params = new URLSearchParams(location.search);
  const resetToken = params.get("reset");
  // Deep link: /?draw=horses starts drawing right after sign-in.
  let pendingDraw = params.get("draw");
  if (resetToken || pendingDraw) history.replaceState(null, "", location.pathname);

  const api = new Api();
  let unlocked = new Set<string>();
  let settingsTimer = 0;

  const useProfile = async (profile: Profile) => {
    app.profile = profile;
    app.settings = profile.settings;
    document.documentElement.dataset.accent = profile.color;
    const saved = await api.favorites(profile.id).catch(() => []);
    app.favoriteIds = new Set(saved.map((i) => i.id));
  };

  const replaceProfile = (profile: Profile) => {
    app.profiles = app.profiles.some((p) => p.id === profile.id) ? app.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...app.profiles, profile];
    if (profile.id === app.profile.id) {
      app.profile = profile;
      app.settings = profile.settings;
      document.documentElement.dataset.accent = profile.color;
    }
  };

  const go = () => {
    const draw = pendingDraw;
    pendingDraw = null;
    if (draw) app.start({ prompt: draw });
    else app.goHome();
  };

  let guest = guestProfile();
  let guestHidden = new Set<string>();
  let guestHistory: HistoryRecord[] = [];

  const enterGuest = () => {
    clearTimeout(settingsTimer);
    app.signedIn = false;
    app.email = "";
    app.profiles = [guest];
    app.profile = guest;
    app.settings = guest.settings;
    app.favoriteIds = new Set();
    app.likedIds = new Set();
    delete document.documentElement.dataset.accent;
  };

  /** A guest who signs up keeps what they did in this tab: settings, presets, history and hidden pictures. */
  const keepGuestWork = async (me: Me) => {
    const first = me.profiles[0];
    if (!first) return;
    const kept = await api.updateProfile(first.id, { settings: guest.settings, presets: guest.presets }).catch(() => first);
    me.profiles = me.profiles.map((p) => (p.id === kept.id ? kept : p));
    for (const r of guestHistory.slice().reverse()) await api.addHistory(first.id, r).catch(() => {});
    for (const id of guestHidden) await api.hide(first.id, id).catch(() => {});
    guest = guestProfile();
    guestHidden = new Set();
    guestHistory = [];
  };

  /** After sign-in: open the last profile, or ask who's drawing if it has a password. */
  const enter = async (me: Me, how?: AuthMode) => {
    if (how === "signup") await keepGuestWork(me);
    app.signedIn = true;
    // Look counts up again, so pictures this family liked show as liked.
    app.likes.clear();
    app.likedIds = new Set();
    app.email = me.email;
    app.profiles = me.profiles;
    unlocked = new Set(me.unlocked);
    const current = me.profiles.find((p) => p.id === me.lastProfileId) ?? me.profiles[0];
    if (app.isLocked(current)) {
      app.profile = current;
      app.settings = current.settings;
      document.documentElement.dataset.accent = current.color;
      show(renderWhoIsDrawing(app, go));
    } else {
      await useProfile(current);
      go();
    }
  };

  const showAuth = (opts: { message?: string; mode?: AuthMode; resetToken?: string } = {}) => {
    clearTimeout(settingsTimer);
    delete document.documentElement.dataset.accent;
    show(renderAuth(api, (me, how) => void enter(me, how), { ...opts, onSkip: go }));
  };
  api.onSignedOut = () => {
    // A guest has no login to lose.
    if (!app.signedIn) return;
    enterGuest();
    showAuth({ message: "You've been signed out. Sign in again to keep saving your progress." });
  };

  const app: App = {
    api,
    cache: new MemoryCache(),
    signedIn: false,
    email: "",
    profiles: [],
    profile: undefined as unknown as Profile,
    settings: undefined as unknown as SessionSettings,
    favoriteIds: new Set(),
    likes: new Map(),
    likedIds: new Set(),

    updateSettings(settings) {
      const id = app.profile.id;
      replaceProfile({ ...app.profile, settings });
      if (!app.signedIn) return void (guest = app.profile);
      clearTimeout(settingsTimer);
      settingsTimer = window.setTimeout(() => void api.updateProfile(id, { settings }).catch(() => {}), SETTINGS_SAVE_DELAY_MS);
    },
    async saveProfile(id, changes) {
      if (!app.signedIn) {
        const { password: _password, ...rest } = changes;
        guest = { ...guest, ...rest };
        replaceProfile(guest);
        return guest;
      }
      const profile = await api.updateProfile(id, changes);
      replaceProfile(profile);
      if (changes.password?.next) unlocked = new Set([id]);
      return profile;
    },
    async addProfile(fields) {
      const profile = await api.createProfile(fields);
      replaceProfile(profile);
      if (profile.hasLock) unlocked = new Set([profile.id]);
      await api.unlockProfile(profile.id, fields.password);
      await useProfile(profile);
    },
    isLocked(profile) {
      return !!profile.hasLock && !unlocked.has(profile.id);
    },
    async switchProfile(id) {
      const profile = app.profiles.find((p) => p.id === id);
      if (!profile || app.isLocked(profile)) return;
      // Tells the server who's drawing; switching away also locks a protected profile again.
      await api.unlockProfile(id).catch(() => {});
      unlocked = profile.hasLock ? new Set([id]) : new Set();
      await useProfile(profile);
    },
    async unlock(id, password) {
      const profile = app.profiles.find((p) => p.id === id);
      if (!profile) return false;
      try {
        await api.unlockProfile(id, password);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 429)) return false;
        throw e;
      }
      unlocked = new Set([id]);
      await useProfile(profile);
      return true;
    },
    lock() {
      unlocked = new Set();
      void api.lockAll().catch(() => {});
      show(renderWhoIsDrawing(app, () => app.goHome()));
    },
    async deleteProfile(id) {
      await api.deleteProfile(id);
      app.profiles = app.profiles.filter((p) => p.id !== id);
      if (app.profile.id !== id) return;
      const open = app.profiles.find((p) => !app.isLocked(p));
      if (open) return app.switchProfile(open.id);
      // Everyone left has a password: ask who's drawing.
      app.profile = app.profiles[0];
      app.settings = app.profile.settings;
      app.lock();
    },
    async toggleFavorite(image) {
      const id = app.profile.id;
      if (app.favoriteIds.has(image.id)) {
        app.favoriteIds.delete(image.id);
        await api.removeFavorite(id, image.id).catch(() => app.favoriteIds.add(image.id));
        return app.favoriteIds.has(image.id);
      }
      app.favoriteIds.add(image.id);
      await api.addFavorite(id, image).catch(() => app.favoriteIds.delete(image.id));
      return app.favoriteIds.has(image.id);
    },
    async toggleLike(image) {
      if (!app.signedIn) return false;
      const liked = !app.likedIds.has(image.id);
      if (liked) app.likedIds.add(image.id);
      else app.likedIds.delete(image.id);
      try {
        const { count } = await (liked ? api.like(image.id) : api.unlike(image.id));
        app.likes.set(image.id, count);
      } catch {
        if (liked) app.likedIds.delete(image.id);
        else app.likedIds.add(image.id);
      }
      return app.likedIds.has(image.id);
    },
    async likeCounts(ids) {
      const missing = [...new Set(ids)].filter((id) => !app.likes.has(id));
      for (let i = 0; i < missing.length; i += LIKE_LOOKUP_BATCH) {
        const batch = missing.slice(i, i + LIKE_LOOKUP_BATCH);
        const r = await api.likes(batch).catch(() => null);
        if (!r) break;
        for (const id of batch) app.likes.set(id, r.counts[id] ?? 0);
        for (const id of r.mine) app.likedIds.add(id);
      }
      return new Map(ids.map((id) => [id, app.likes.get(id) ?? 0]));
    },

    async hiddenIds() {
      if (!app.signedIn) return new Set(guestHidden);
      return api.hidden().then((h) => new Set(h.map((x) => x.imageId)), () => new Set<string>());
    },
    async hide(imageId) {
      if (!app.signedIn) return void guestHidden.add(imageId);
      await api.hide(app.profile.id, imageId).catch(() => {});
    },
    async history(limit) {
      if (!app.signedIn) return guestHistory.slice(0, limit);
      return api.history(app.profile.id, limit).catch(() => []);
    },
    async addHistory(record) {
      if (!app.signedIn) return void guestHistory.unshift({ ...record, id: crypto.randomUUID(), profileId: guest.id });
      await api.addHistory(app.profile.id, record).catch(() => {});
    },

    showSignIn(opts) {
      showAuth(opts);
    },
    async signOut() {
      await api.signOut().catch(() => {});
      enterGuest();
      app.goHome();
    },
    async deleteAccount(password) {
      await api.deleteAccount(password);
      enterGuest();
      app.likes.clear();
      showAuth({ message: "Your account and everything in it has been deleted." });
    },

    goHome(message) {
      show(renderHome(app, message));
    },
    showGallery() {
      show(renderGallery(app));
    },
    start(input, replay) {
      const result = planSearch(input);
      if (!result.ok) return app.goHome(result.message);
      app.startPlan(result.plan, replay);
    },
    startPlan(plan, replay) {
      void runSession(app, plan, replay).then(show);
    },
    showSummary(result) {
      show(renderSummary(app, result));
    },
  };

  enterGuest();
  if (resetToken) return showAuth({ resetToken });

  try {
    await enter(await api.me());
  } catch (e) {
    // Not signed in: draw as a guest. An account is only needed to keep things.
    if (e instanceof ApiError && e.status === 401) return go();
    show(
      h(
        "main",
        { class: "home who" },
        h("h1", {}, "Draw with Dad"),
        h("p", { class: "error" }, e instanceof Error ? e.message : "Something went wrong."),
        h("button", { type: "button", class: "primary", onclick: () => location.reload() }, "Try again"),
      ),
    );
  }
}

void boot();
