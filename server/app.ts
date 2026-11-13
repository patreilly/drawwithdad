import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  MAX_PASSWORD,
  MAX_PROFILES,
  MIN_ACCOUNT_PASSWORD,
  MIN_PROFILE_PASSWORD,
  newProfile,
  sanitizeProfile,
  type Profile,
} from "../src/profiles/profile";
import type { Mailer } from "./mail";
import { burnTime, hashPassword, verifyPassword } from "./passwords";
import { EmailTakenError, type AccountItem, type AuthItem, type ProfileItem, type Repo } from "./repo";
import { normalizeEmail, sanitizeImageId, sanitizeImageRef, sanitizeSegments } from "./validate";

export interface AppOptions {
  repo: Repo;
  mailer: Mailer;
  /** Public URL of the app, for links in emails. Without it, password-reset emails can't be sent. */
  appUrl?: string;
  /** scrypt cost (log2 N). Lower only in tests. */
  passwordCost?: number;
}

interface Auth {
  tokenHash: string;
  account: AccountItem;
  session: AuthItem;
}

type Env = { Variables: { auth: Auth } };

const COOKIE = "dwd_session";
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const MAX_FAVORITES = 500;
/** Pictures per thumbs-up lookup: one search page with room to spare. */
const MAX_LIKE_LOOKUP = 60;
/** Browsers can't add this header to a cross-site request without CORS, which we never allow: that blocks CSRF. */
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "draw-with-dad";

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 423 | 429,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

/** The profile as the browser sees it: never the password hash. */
function publicProfile(p: ProfileItem): Profile {
  const { lockHash, ...rest } = p;
  return { ...rest, ...(lockHash ? { hasLock: true } : {}) };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function password(input: unknown, min: number): string {
  const pw = typeof input === "string" ? input : "";
  if (pw.length < min) throw new ApiError(400, `Use at least ${min} characters for the password.`);
  if (pw.length > MAX_PASSWORD) throw new ApiError(400, "That password is too long.");
  return pw;
}

export function createApp(o: AppOptions) {
  const { repo, mailer } = o;
  const cost = o.passwordCost;
  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "That request is too large." }, 413) }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
      return c.json({ error: "Missing request header." }, 403);
    }
    await next();
  });

  const limit = async (key: string, max: number, windowSeconds: number) => {
    if ((await repo.hit(key, windowSeconds)) > max) throw new ApiError(429, "Too many tries. Please wait a few minutes and try again.");
  };

  const startSession = async (c: Context, accountId: string, unlocked: string[] = []) => {
    const token = newToken();
    await repo.createAuth(sha256(token), { accountId, createdAt: Date.now(), unlocked }, SESSION_DAYS * 86400);
    const https = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    setCookie(c, COOKIE, token, { httpOnly: true, secure: https, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  };

  const me = async (accountId: string, unlocked: string[]) => {
    const [account, profiles] = await Promise.all([repo.getAccount(accountId), repo.listProfiles(accountId)]);
    return { email: account!.email, lastProfileId: account!.lastProfileId ?? null, unlocked, profiles: profiles.map(publicProfile) };
  };

  /** The signed-in family, if the login cookie is valid. */
  const readAuth = async (c: Context): Promise<Auth | undefined> => {
    const token = getCookie(c, COOKIE);
    const tokenHash = token ? sha256(token) : "";
    const session = tokenHash ? await repo.getAuth(tokenHash) : undefined;
    const account = session ? await repo.getAccount(session.accountId) : undefined;
    if (!session || !account || session.createdAt < (account.sessionsValidAfter ?? 0)) return undefined;
    return { tokenHash, account, session };
  };

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const found = await readAuth(c);
    if (!found) {
      deleteCookie(c, COOKIE, { path: "/" });
      throw new ApiError(401, "Please sign in.");
    }
    c.set("auth", found);
    await next();
  };

  /** Loads a profile of this family, refusing password-protected ones that this login hasn't unlocked. */
  const profileFor = async (c: Context<Env>, profileId: string): Promise<ProfileItem> => {
    const { account, session } = c.get("auth");
    const profile = await repo.getProfile(account.accountId, profileId);
    if (!profile) throw new ApiError(404, "That profile doesn't exist.");
    if (profile.lockHash && !session.unlocked.includes(profileId)) throw new ApiError(423, `${profile.name}'s profile is locked.`);
    return profile;
  };

  // ---------- public ----------

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/auth/signup", async (c) => {
    const b = await body(c);
    const email = normalizeEmail(b.email);
    if (!email) throw new ApiError(400, "Please enter a valid email address.");
    const pw = password(b.password, MIN_ACCOUNT_PASSWORD);
    await limit(`signup#${email}`, 5, 3600);
    const profile = newProfile({ name: String(b.name ?? "") || "Me" });
    let account: AccountItem;
    try {
      account = await repo.createAccount(email, await hashPassword(pw, cost), profile);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new ApiError(409, "There's already an account with that email. Try signing in.");
      throw e;
    }
    await startSession(c, account.accountId);
    return c.json(await me(account.accountId, []), 201);
  });

  app.post("/auth/login", async (c) => {
    const b = await body(c);
    const email = normalizeEmail(b.email);
    const pw = typeof b.password === "string" ? b.password.slice(0, MAX_PASSWORD) : "";
    if (!email || !pw) throw new ApiError(400, "Please enter your email and password.");
    await limit(`login#${email}`, 10, 900);
    const login = await repo.getLogin(email);
    const ok = login ? await verifyPassword(login.passwordHash, pw) : (await burnTime(cost), false);
    if (!login || !ok) throw new ApiError(401, "That email and password don't match.");
    await startSession(c, login.accountId);
    return c.json(await me(login.accountId, []));
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await repo.deleteAuth(sha256(token));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/auth/forgot", async (c) => {
    const email = normalizeEmail((await body(c)).email);
    if (!email) throw new ApiError(400, "Please enter a valid email address.");
    await limit(`forgot#${email}`, 3, 3600);
    const login = await repo.getLogin(email);
    // Same answer either way, so this can't be used to find out who has an account.
    if (login) {
      const token = newToken();
      await repo.createReset(sha256(token), login.accountId, email, RESET_MINUTES * 60);
      if (!o.appUrl) {
        console.warn("APP_URL isn't set, so the password-reset email can't include a link.");
      } else {
        const link = `${o.appUrl.replace(/\/$/, "")}/?reset=${token}`;
        await mailer.send(
          email,
          "Reset your Draw with Dad password",
          `Someone asked to reset the password for your Draw with Dad account.\n\nTo choose a new password, open this link within ${RESET_MINUTES} minutes:\n${link}\n\nIf it wasn't you, ignore this email. Your password won't change.`,
        );
      }
    }
    return c.json({ ok: true });
  });

  app.post("/auth/reset", async (c) => {
    const b = await body(c);
    const pw = password(b.password, MIN_ACCOUNT_PASSWORD);
    const reset = typeof b.token === "string" ? await repo.consumeReset(sha256(b.token)) : undefined;
    if (!reset) throw new ApiError(400, "That reset link has expired or was already used. Ask for a new one.");
    await repo.setPassword(reset.email, await hashPassword(pw, cost), reset.accountId);
    await startSession(c, reset.accountId);
    return c.json(await me(reset.accountId, []));
  });

  // ---------- account ----------

  app.get("/me", auth, async (c) => {
    const { account, session } = c.get("auth");
    return c.json(await me(account.accountId, session.unlocked));
  });

  app.patch("/me", auth, async (c) => {
    const { account } = c.get("auth");
    const id = String((await body(c)).lastProfileId ?? "");
    if (!(await repo.getProfile(account.accountId, id))) throw new ApiError(404, "That profile doesn't exist.");
    await repo.setLastProfile(account.accountId, id);
    return c.json({ ok: true });
  });

  app.delete("/me", auth, async (c) => {
    const { account, tokenHash } = c.get("auth");
    const pw = String((await body(c)).password ?? "");
    await limit(`delete#${account.accountId}`, 5, 900);
    const login = await repo.getLogin(account.email);
    if (!login || !(await verifyPassword(login.passwordHash, pw))) throw new ApiError(403, "That password isn't right.");
    await repo.deleteAccount(account);
    await repo.deleteAuth(tokenHash);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  /** Locks every password-protected profile again in this login session. */
  app.post("/lock", auth, async (c) => {
    await repo.setUnlocked(c.get("auth").tokenHash, []);
    return c.json({ ok: true });
  });

  // ---------- profiles ----------

  app.post("/profiles", auth, async (c) => {
    const { account, tokenHash } = c.get("auth");
    const b = await body(c);
    if ((await repo.listProfiles(account.accountId)).length >= MAX_PROFILES) throw new ApiError(400, `That's the most profiles (${MAX_PROFILES}).`);
    const profile: ProfileItem = sanitizeProfile({ name: String(b.name ?? ""), avatar: b.avatar as string, color: b.color as Profile["color"], createdAt: Date.now() });
    delete (profile as Profile).hasLock;
    if (b.password) profile.lockHash = await hashPassword(password(b.password, MIN_PROFILE_PASSWORD), cost);
    await repo.putProfile(account.accountId, profile);
    // You just chose its password, so it starts unlocked for you.
    if (profile.lockHash) await repo.setUnlocked(tokenHash, [profile.id]);
    return c.json(publicProfile(profile), 201);
  });

  app.put("/profiles/:pid", auth, async (c) => {
    const { account, tokenHash, session } = c.get("auth");
    const existing = await profileFor(c, c.req.param("pid"));
    const b = await body(c);
    const merged = sanitizeProfile({
      ...existing,
      ...("name" in b ? { name: b.name as string } : {}),
      ...("avatar" in b ? { avatar: b.avatar as string } : {}),
      ...("color" in b ? { color: b.color as Profile["color"] } : {}),
      ...("settings" in b ? { settings: b.settings as Profile["settings"] } : {}),
      ...("presets" in b ? { presets: b.presets as Profile["presets"] } : {}),
      id: existing.id,
      createdAt: existing.createdAt,
    });
    delete (merged as Profile).hasLock;
    const updated: ProfileItem = { ...merged, ...(existing.lockHash ? { lockHash: existing.lockHash } : {}) };

    const pw = b.password as { current?: unknown; next?: unknown; remove?: unknown } | undefined;
    if (pw && typeof pw === "object" && (pw.next || pw.remove)) {
      // Changing or removing a profile password needs the current one, even when unlocked.
      if (existing.lockHash) {
        await limit(`unlock#${account.accountId}#${existing.id}`, 10, 900);
        if (!(await verifyPassword(existing.lockHash, String(pw.current ?? "")))) throw new ApiError(403, "The current password isn't right.");
      }
      if (pw.remove) delete updated.lockHash;
      else {
        updated.lockHash = await hashPassword(password(pw.next, MIN_PROFILE_PASSWORD), cost);
        if (!session.unlocked.includes(existing.id)) await repo.setUnlocked(tokenHash, [existing.id]);
      }
    }
    await repo.putProfile(account.accountId, updated);
    return c.json(publicProfile(updated));
  });

  app.delete("/profiles/:pid", auth, async (c) => {
    const { account } = c.get("auth");
    const profile = await profileFor(c, c.req.param("pid"));
    if ((await repo.listProfiles(account.accountId)).length <= 1) throw new ApiError(400, "You need at least one profile.");
    await repo.deleteProfile(account.accountId, profile.id);
    return c.json({ ok: true });
  });

  app.post("/profiles/:pid/unlock", auth, async (c) => {
    const { account, tokenHash } = c.get("auth");
    const profile = await repo.getProfile(account.accountId, c.req.param("pid"));
    if (!profile) throw new ApiError(404, "That profile doesn't exist.");
    if (profile.lockHash) {
      await limit(`unlock#${account.accountId}#${profile.id}`, 10, 900);
      if (!(await verifyPassword(profile.lockHash, String((await body(c)).password ?? "")))) {
        throw new ApiError(403, "That's not the right password.");
      }
    }
    // One unlocked profile at a time: switching to another locks the previous one.
    await repo.setUnlocked(tokenHash, profile.lockHash ? [profile.id] : []);
    await repo.setLastProfile(account.accountId, profile.id);
    return c.json({ ok: true });
  });

  // ---------- saved pictures ----------

  app.get("/profiles/:pid/favorites", auth, async (c) => {
    const profile = await profileFor(c, c.req.param("pid"));
    const items = await repo.favorites(c.get("auth").account.accountId, profile.id);
    return c.json(items.map((f) => f.image));
  });

  app.put("/profiles/:pid/favorites", auth, async (c) => {
    const { account } = c.get("auth");
    const profile = await profileFor(c, c.req.param("pid"));
    const image = sanitizeImageRef((await body(c)).image);
    if (!image) throw new ApiError(400, "That picture can't be saved.");
    if ((await repo.favorites(account.accountId, profile.id)).length >= MAX_FAVORITES) {
      throw new ApiError(400, `That's the most saved pictures (${MAX_FAVORITES}). Remove some first.`);
    }
    await repo.addFavorite(account.accountId, { profileId: profile.id, image, savedAt: Date.now() });
    return c.json({ ok: true });
  });

  app.delete("/profiles/:pid/favorites", auth, async (c) => {
    const profile = await profileFor(c, c.req.param("pid"));
    const imageId = sanitizeImageId(c.req.query("imageId"));
    if (!imageId) throw new ApiError(400, "Missing picture.");
    await repo.removeFavorite(c.get("auth").account.accountId, profile.id, imageId);
    return c.json({ ok: true });
  });

  // ---------- drawing history ----------

  app.get("/profiles/:pid/history", auth, async (c) => {
    const profile = await profileFor(c, c.req.param("pid"));
    const n = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
    return c.json(await repo.history(c.get("auth").account.accountId, profile.id, n));
  });

  app.post("/profiles/:pid/history", auth, async (c) => {
    const profile = await profileFor(c, c.req.param("pid"));
    const b = await body(c);
    const startedAt = Number(b.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) throw new ApiError(400, "Missing start time.");
    await repo.addHistory(c.get("auth").account.accountId, {
      id: crypto.randomUUID(),
      profileId: profile.id,
      startedAt,
      endedAt: Number(b.endedAt) || undefined,
      prompt: String(b.prompt ?? "").slice(0, 100),
      categoryId: b.categoryId ? String(b.categoryId).slice(0, 40) : undefined,
      segments: sanitizeSegments(b.segments),
      imageIds: (Array.isArray(b.imageIds) ? b.imageIds : []).map(sanitizeImageId).filter((x): x is string => !!x).slice(0, 200),
    });
    return c.json({ ok: true }, 201);
  });

  app.delete("/profiles/:pid/history", auth, async (c) => {
    const profile = await profileFor(c, c.req.param("pid"));
    await repo.clearHistory(c.get("auth").account.accountId, profile.id);
    return c.json({ ok: true });
  });

  // ---------- hidden images (shared by the whole family) ----------

  app.get("/hidden", auth, async (c) => {
    return c.json((await repo.hidden(c.get("auth").account.accountId)).map((h) => ({ imageId: h.imageId, profileId: h.profileId })));
  });

  app.put("/hidden", auth, async (c) => {
    const b = await body(c);
    const profile = await profileFor(c, String(b.profileId ?? ""));
    const imageId = sanitizeImageId(b.imageId);
    if (!imageId) throw new ApiError(400, "Missing picture.");
    await repo.hide(c.get("auth").account.accountId, { imageId, profileId: profile.id, hiddenAt: Date.now() });
    return c.json({ ok: true });
  });

  /** Un-hides only the images this profile hid. */
  app.delete("/hidden", auth, async (c) => {
    const profile = await profileFor(c, String(c.req.query("profileId") ?? ""));
    await repo.clearHidden(c.get("auth").account.accountId, profile.id);
    return c.json({ ok: true });
  });

  // ---------- thumbs-ups (counts are public; one per family) ----------

  /** Counts for a list of pictures, plus which of them this family liked when signed in. */
  // A POST so a page of long ids fits in the body; it only reads.
  app.post("/likes/lookup", async (c) => {
    const b = await body(c);
    const ids = (Array.isArray(b.ids) ? b.ids : [])
      .map(sanitizeImageId)
      .filter((x): x is string => !!x)
      .slice(0, MAX_LIKE_LOOKUP);
    const found = ids.length ? await readAuth(c) : undefined;
    const [counts, liked] = await Promise.all([repo.likeCounts(ids), found ? repo.likedIds(found.account.accountId) : []]);
    const wanted = new Set(ids);
    return c.json({ counts: Object.fromEntries(counts), mine: liked.filter((id) => wanted.has(id)) });
  });

  app.put("/likes", auth, async (c) => {
    const { account } = c.get("auth");
    const imageId = sanitizeImageId((await body(c)).imageId);
    if (!imageId) throw new ApiError(400, "Missing picture.");
    await limit(`like#${account.accountId}`, 300, 3600);
    await repo.like(account.accountId, imageId);
    return c.json({ count: (await repo.likeCounts([imageId])).get(imageId) ?? 0 });
  });

  app.delete("/likes", auth, async (c) => {
    const { account } = c.get("auth");
    const imageId = sanitizeImageId(c.req.query("imageId"));
    if (!imageId) throw new ApiError(400, "Missing picture.");
    await limit(`like#${account.accountId}`, 300, 3600);
    await repo.unlike(account.accountId, imageId);
    return c.json({ count: (await repo.likeCounts([imageId])).get(imageId) ?? 0 });
  });

  return app;
}
