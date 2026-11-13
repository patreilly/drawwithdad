/**
 * API tests against a real DynamoDB Local (the same engine as production).
 * Run with `npm run test:api`; skipped by plain `npm test` when no DynamoDB is available.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import type { Mailer } from "../server/mail";
import { Repo } from "../server/repo";

const endpoint = process.env.DYNAMODB_ENDPOINT;

class Inbox implements Mailer {
  last = "";
  async send(_to: string, _subject: string, text: string) {
    this.last = text;
  }
}

async function setup() {
  const repo = new Repo({ table: `test-${crypto.randomUUID()}`, endpoint });
  await repo.ensureTable();
  const inbox = new Inbox();
  const app = createApp({ repo, mailer: inbox, appUrl: "http://localhost:5173", passwordCost: 10 });
  return { app, repo, inbox };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

/** A browser: keeps its cookie and sends the CSRF header. */
function client(app: App) {
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "X-Requested-With": "draw-with-dad" }) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
  return { call, get cookie() { return cookie; } };
}

const image = (id: string) => ({ source: "openverse", sourceId: id, url: `https://x/${id}.jpg`, thumbUrl: `https://x/${id}_t.jpg`, landingUrl: "https://x", title: id, creator: "c", license: "CC0", tags: [] });

describe.skipIf(!endpoint)("API (DynamoDB Local)", () => {
  it("signs up, signs in and keeps the login in an httpOnly cookie", async () => {
    const { app } = await setup();
    const dad = client(app);
    const r = await dad.call("POST", "/auth/signup", { email: "Dad@Example.com", password: "pancakes1", name: "Dad" });
    expect(r.status).toBe(201);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=Lax/i);
    expect(r.body.email).toBe("dad@example.com");
    expect(r.body.profiles.map((p: { name: string }) => p.name)).toEqual(["Dad"]);

    expect((await client(app).call("POST", "/auth/signup", { email: "dad@example.com", password: "pancakes1" })).status).toBe(409);
    expect((await client(app).call("GET", "/me")).status).toBe(401);
    expect((await client(app).call("POST", "/auth/login", { email: "dad@example.com", password: "wrong-one" })).status).toBe(401);
    const again = client(app);
    expect((await again.call("POST", "/auth/login", { email: "dad@example.com", password: "pancakes1" })).status).toBe(200);
    expect((await again.call("GET", "/me")).status).toBe(200);

    await again.call("POST", "/auth/logout", {});
    expect((await again.call("GET", "/me")).status).toBe(401);
  });

  it("rejects changes without the CSRF header", async () => {
    const { app } = await setup();
    const r = await client(app).call("POST", "/auth/signup", { email: "a@b.co", password: "pancakes1" }, {});
    expect(r.status).toBe(403);
  });

  it("enforces profile passwords on the server and never reveals the hash", async () => {
    const { app } = await setup();
    const fam = client(app);
    await fam.call("POST", "/auth/signup", { email: "fam@x.co", password: "pancakes1", name: "Kid" });
    const dad = (await fam.call("POST", "/profiles", { name: "Dad", avatar: "🐻", color: "blue", password: "waffles" })).body;
    expect(dad.hasLock).toBe(true);
    expect(JSON.stringify((await fam.call("GET", "/me")).body)).not.toMatch(/lockHash|scrypt/);

    // Unlocked for whoever just set it; locking again blocks Dad's data.
    expect((await fam.call("GET", `/profiles/${dad.id}/favorites`)).status).toBe(200);
    await fam.call("POST", "/lock", {});
    expect((await fam.call("GET", `/profiles/${dad.id}/favorites`)).status).toBe(423);
    expect((await fam.call("PUT", `/profiles/${dad.id}`, { name: "Hacked" })).status).toBe(423);
    expect((await fam.call("POST", `/profiles/${dad.id}/unlock`, { password: "nope" })).status).toBe(403);
    expect((await fam.call("POST", `/profiles/${dad.id}/unlock`, { password: "waffles" })).status).toBe(200);
    expect((await fam.call("GET", `/profiles/${dad.id}/favorites`)).status).toBe(200);

    // Changing it needs the current password, even while unlocked.
    expect((await fam.call("PUT", `/profiles/${dad.id}`, { password: { current: "nope", remove: true } })).status).toBe(403);
    const removed = await fam.call("PUT", `/profiles/${dad.id}`, { password: { current: "waffles", remove: true } });
    expect(removed.status).toBe(200);
    expect(removed.body.hasLock).toBeUndefined();
  });

  it("keeps families apart", async () => {
    const { app } = await setup();
    const a = client(app);
    const b = client(app);
    const meA = (await a.call("POST", "/auth/signup", { email: "a@x.co", password: "pancakes1" })).body;
    await b.call("POST", "/auth/signup", { email: "b@x.co", password: "pancakes1" });
    const profileA = meA.profiles[0].id;
    expect((await b.call("GET", `/profiles/${profileA}/favorites`)).status).toBe(404);
    expect((await b.call("PUT", `/profiles/${profileA}`, { name: "x" })).status).toBe(404);
  });

  it("saves pictures, history and settings", async () => {
    const { app } = await setup();
    const fam = client(app);
    const pid = (await fam.call("POST", "/auth/signup", { email: "p@x.co", password: "pancakes1" })).body.profiles[0].id;

    expect((await fam.call("PUT", `/profiles/${pid}/favorites`, { image: image("one") })).status).toBe(200);
    expect((await fam.call("PUT", `/profiles/${pid}/favorites`, { image: { ...image("bad"), url: "http://insecure/x.jpg" } })).status).toBe(400);
    expect((await fam.call("GET", `/profiles/${pid}/favorites`)).body.map((i: { id: string }) => i.id)).toEqual(["openverse:one"]);
    await fam.call("DELETE", `/profiles/${pid}/favorites?imageId=openverse:one`);
    expect((await fam.call("GET", `/profiles/${pid}/favorites`)).body).toEqual([]);

    for (const [t, prompt] of [[100, "cats"], [300, "owls"], [200, "dogs"]] as const) {
      await fam.call("POST", `/profiles/${pid}/history`, { startedAt: t, prompt, segments: [{ count: 2, seconds: 30 }], imageIds: ["openverse:a"] });
    }
    expect((await fam.call("GET", `/profiles/${pid}/history?limit=2`)).body.map((h: { prompt: string }) => h.prompt)).toEqual(["owls", "dogs"]);

    const saved = await fam.call("PUT", `/profiles/${pid}`, { settings: { grid: 3, segments: [{ count: 4, seconds: 45 }] } });
    expect(saved.body.settings.grid).toBe(3);
    expect((await fam.call("GET", "/me")).body.profiles[0].settings.segments).toEqual([{ count: 4, seconds: 45 }]);
  });

  it("hides images for the whole family; each profile un-hides only its own", async () => {
    const { app } = await setup();
    const fam = client(app);
    const kid = (await fam.call("POST", "/auth/signup", { email: "h@x.co", password: "pancakes1" })).body.profiles[0].id;
    const dad = (await fam.call("POST", "/profiles", { name: "Dad" })).body.id;
    await fam.call("PUT", "/hidden", { profileId: dad, imageId: "openverse:bad" });
    await fam.call("PUT", "/hidden", { profileId: kid, imageId: "openverse:meh" });
    expect((await fam.call("GET", "/hidden")).body).toHaveLength(2);
    await fam.call("DELETE", `/hidden?profileId=${kid}`);
    expect((await fam.call("GET", "/hidden")).body.map((h: { imageId: string }) => h.imageId)).toEqual(["openverse:bad"]);
  });

  it("resets a forgotten password with a one-time link and signs out other devices", async () => {
    const { app, inbox } = await setup();
    const laptop = client(app);
    await laptop.call("POST", "/auth/signup", { email: "r@x.co", password: "pancakes1" });
    expect((await client(app).call("POST", "/auth/forgot", { email: "nobody@x.co" })).status).toBe(200);
    expect(inbox.last).toBe("");
    await client(app).call("POST", "/auth/forgot", { email: "r@x.co" });
    const token = inbox.last.match(/\?reset=([\w-]+)/)?.[1];
    expect(token).toBeTruthy();

    // Make sure the reset happens in a later millisecond than the laptop's login.
    await new Promise((r) => setTimeout(r, 5));
    const phone = client(app);
    expect((await phone.call("POST", "/auth/reset", { token, password: "new-password" })).status).toBe(200);
    expect((await phone.call("GET", "/me")).status).toBe(200);
    expect((await laptop.call("GET", "/me")).status).toBe(401);
    expect((await client(app).call("POST", "/auth/reset", { token, password: "another-one" })).status).toBe(400);
    expect((await client(app).call("POST", "/auth/login", { email: "r@x.co", password: "new-password" })).status).toBe(200);
  });

  it("rate-limits password guessing", async () => {
    const { app } = await setup();
    await client(app).call("POST", "/auth/signup", { email: "g@x.co", password: "pancakes1" });
    const guesser = client(app);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await guesser.call("POST", "/auth/login", { email: "g@x.co", password: `guess${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("deletes the account and everything in it", async () => {
    const { app, repo } = await setup();
    const fam = client(app);
    const me = (await fam.call("POST", "/auth/signup", { email: "d@x.co", password: "pancakes1" })).body;
    const pid = me.profiles[0].id;
    await fam.call("PUT", `/profiles/${pid}/favorites`, { image: image("x") });
    expect((await fam.call("DELETE", "/me", { password: "wrong" })).status).toBe(403);
    expect((await fam.call("DELETE", "/me", { password: "pancakes1" })).status).toBe(200);
    expect((await fam.call("GET", "/me")).status).toBe(401);
    expect(await repo.getLogin("d@x.co")).toBeUndefined();
    const accountId = (await repo.doc.send(new (await import("@aws-sdk/lib-dynamodb")).ScanCommand({ TableName: (repo as unknown as { config: { table: string } }).config.table }))).Items ?? [];
    expect(accountId.filter((i) => String(i.PK).startsWith("ACCT#"))).toEqual([]);
  });

  it("counts one thumbs up per family, shows counts to everyone, and takes them back with the account", async () => {
    const { app } = await setup();
    const a = client(app);
    const b = client(app);
    await a.call("POST", "/auth/signup", { email: "a@x.co", password: "pancakes1" });
    await b.call("POST", "/auth/signup", { email: "b@x.co", password: "pancakes1" });
    const pic = "commons:File:Horse, running.jpg";

    expect((await client(app).call("PUT", "/likes", { imageId: pic })).status).toBe(401);
    expect((await a.call("PUT", "/likes", { imageId: "evil:1" })).status).toBe(400);
    expect((await a.call("PUT", "/likes", { imageId: pic })).body).toEqual({ count: 1 });
    expect((await a.call("PUT", "/likes", { imageId: pic })).body).toEqual({ count: 1 });
    expect((await b.call("PUT", "/likes", { imageId: pic })).body).toEqual({ count: 2 });

    const guest = await client(app).call("POST", "/likes/lookup", { ids: [pic, "openverse:nobody"] });
    expect(guest.body).toEqual({ counts: { [pic]: 2 }, mine: [] });
    expect((await a.call("POST", "/likes/lookup", { ids: [pic] })).body.mine).toEqual([pic]);

    expect((await a.call("DELETE", `/likes?imageId=${encodeURIComponent(pic)}`)).body).toEqual({ count: 1 });
    expect((await a.call("DELETE", `/likes?imageId=${encodeURIComponent(pic)}`)).body).toEqual({ count: 1 });
    expect((await b.call("DELETE", "/me", { password: "pancakes1" })).status).toBe(200);
    expect((await client(app).call("POST", "/likes/lookup", { ids: [pic] })).body.counts).toEqual({});
  });
});
