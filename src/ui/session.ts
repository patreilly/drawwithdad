import type { App } from "../main";
import { expandPrompt, ollamaStatus, pickModel } from "../ollama/client";
import { classifyImage, warmUpSafetyModel } from "../safety/imageFilter";
import { FRIENDLY_REFUSAL } from "../safety/textFilter";
import type { SearchPlan } from "../search/plan";
import { ReferenceQueue } from "../search/referenceQueue";
import { buildSteps, SessionClock, type ClockEvent } from "../session/clock";
import { capSegments } from "../session/settings";
import type { ImageRef } from "../types";
import { formatClock, h } from "./dom";
import { Sound } from "./sound";

export interface SessionResult {
  plan: SearchPlan;
  shown: ImageRef[];
  startedAt: number;
  endedAt: number;
  note?: string;
}

const TICK_MS = 100;
const IDLE_MS = 2500;
const POSTERIZE_LEVELS = [0, 2, 3, 4, 5];
const GRID_LEVELS = [0, 2, 3, 4];

export async function runSession(app: App, plan: SearchPlan, replay?: ImageRef[]): Promise<HTMLElement> {
  const s = app.settings;
  const startedAt = Date.now();

  const [hiddenIds, recent] = await Promise.all([
    // Anything hidden by anyone in the family stays hidden for everyone.
    app.hiddenIds(),
    s.avoidRepeats ? app.history(20) : Promise.resolve([]),
  ]);

  const fixed = replay ?? plan.images;
  const steps = buildSteps(fixed ? { ...s, segments: capSegments(s.segments, fixed.length) } : s);
  const clock = new SessionClock(steps, { getReadyMs: s.getReadySeconds * 1000, advance: s.advance, warnSeconds: s.warnSeconds });
  const total = clock.imageCount;

  let modelFailed = false;
  warmUpSafetyModel().catch(() => {
    modelFailed = true;
  });

  const queue = new ReferenceQueue({
    queries: replay ? [] : plan.queries,
    initial: replay,
    candidates: replay ? undefined : plan.images,
    orientation: s.orientation,
    strict: plan.strict,
    shuffle: s.shuffle,
    hiddenIds,
    recentIds: new Set(recent.flatMap((r) => r.imageIds)),
    store: app.cache,
    classify: classifyImage,
    popularity: (ids) => app.likeCounts(ids),
  });
  queue.ensure(total + 2);

  const sound = new Sound(s.sound, s.volume);
  sound.unlock();

  // ---- view state ----
  let shownIndex = -1;
  let loaded = false;
  let flipped = false;
  let gray = s.grayscale;
  let posterize = s.posterize;
  let grid = s.grid;
  let peek = false;
  let ended = false;
  let endNote: string | undefined;
  const shown: ImageRef[] = [];

  // ---- DOM ----
  const img = h("img", { class: "ref", alt: "", referrerpolicy: "no-referrer", draggable: "false" });
  const gridEl = h("div", { class: "grid-overlay", "aria-hidden": "true" });
  const frame = h("div", { class: "frame" }, img, gridEl);
  const stage = h("div", { class: "stage" }, frame);

  const overlayTitle = h("p", { class: "overlay-title" });
  const overlayBig = h("p", { class: "overlay-big" });
  const overlaySub = h("p", { class: "overlay-sub" });
  const overlayActions = h("div", { class: "overlay-actions" });
  const overlay = h("div", { class: "overlay", role: "status", "aria-live": "polite" }, overlayTitle, overlayBig, overlaySub, overlayActions);
  let overlayKey = "";

  const toast = h("div", { class: "toast", role: "status" });
  const counter = h("span", { class: "counter" });
  const timer = h("span", { class: `timer ${s.timerDisplay}` });
  const progress = h("div", { class: "progress-bar" });
  const hud = h("div", { class: "hud" }, counter, timer);
  const credit = h("div", { class: "credit" });

  const btn = (label: string, title: string, onclick: () => void, extra: Record<string, string> = {}) =>
    h("button", { type: "button", title, "aria-label": title, onclick: (e: Event) => ((e.currentTarget as HTMLElement).blur(), onclick()), ...extra }, label);

  const pauseBtn = btn("⏸", "Pause (Space)", () => togglePause());
  const flipBtn = btn("⇋", "Mirror (F)", () => toggle("flip"));
  const grayBtn = btn("◐", "Grayscale (G)", () => toggle("gray"));
  const valueBtn = btn("▦", "Value study (V)", () => toggle("values"));
  const gridBtn = btn("#", "Grid (R)", () => toggle("grid"));
  const saveBtn = btn("☆", "Save to My pictures (S)", () => void saveCurrent());
  const likeBtn = btn("👍", "Thumbs up: a good one to draw (L)", () => void likeCurrent(), { class: "like" });
  const controls = h(
    "div",
    { class: "controls" },
    btn("⏮", "Previous (←)", () => handle(clock.prev())),
    pauseBtn,
    btn("⏭", "Next (→)", () => handle(clock.next())),
    btn("+30s", "Add 30 seconds (A)", () => handle(clock.addTime(30_000))),
    h("span", { class: "sep" }),
    flipBtn,
    grayBtn,
    valueBtn,
    gridBtn,
    h("span", { class: "sep" }),
    saveBtn,
    likeBtn,
    btn("🚫", "Hide this image forever (X)", () => hideCurrent()),
    btn("⛶", "Fullscreen", () => toggleFullscreen()),
    btn("✕", "End session (Esc)", () => finish()),
  );

  const root = h("div", { class: "session", tabindex: "-1" }, stage, progress, hud, credit, overlay, toast, controls);

  // ---- behaviour ----
  function showImage(index: number) {
    const ref = queue.images[index];
    if (!ref) return;
    shownIndex = index;
    queue.markShown(index);
    loaded = false;
    peek = false;
    flipped = s.flip === "always" || (s.flip === "random" && Math.random() < 0.5);
    img.classList.remove("ready");
    let triedThumb = false;
    img.onload = () => {
      loaded = true;
      img.classList.add("ready");
      if (!shown.some((x) => x.id === ref.id)) shown.push(ref);
    };
    img.onerror = () => {
      if (!triedThumb) {
        triedThumb = true;
        img.src = ref.thumbUrl;
        return;
      }
      // Broken link: swap in the next image and restart this step.
      queue.drop(index);
      shownIndex = -1;
      handle(clock.restart());
    };
    img.src = ref.url;
    img.alt = ref.title;
    credit.replaceChildren(
      h("a", { href: ref.landingUrl, target: "_blank", rel: "noopener noreferrer" }, `“${ref.title}”`),
      ` by ${ref.creator} · `,
      ref.licenseUrl ? h("a", { href: ref.licenseUrl, target: "_blank", rel: "noopener noreferrer" }, ref.license) : ref.license,
    );
    // Usually known from the search page already; this covers replays and slow lookups.
    void app.likeCounts([ref.id]).then(render);
    // Warm the browser cache for the next two.
    for (const next of queue.images.slice(index + 1, index + 3)) new Image().src = next.url;
  }

  function handle(events: ClockEvent[]) {
    for (const e of events) {
      if (e.type === "warn") sound.warn();
      if (e.type === "phase" && e.phase === "drawing") sound.change();
      if (e.type === "phase" && e.phase === "done") void finish();
    }
    render();
  }

  function togglePause() {
    clock.togglePause();
    render();
  }

  function toggle(what: "flip" | "gray" | "values" | "grid") {
    if (what === "flip") flipped = !flipped;
    if (what === "gray") gray = !gray;
    if (what === "values") posterize = POSTERIZE_LEVELS[(POSTERIZE_LEVELS.indexOf(posterize) + 1) % POSTERIZE_LEVELS.length];
    if (what === "grid") grid = GRID_LEVELS[(GRID_LEVELS.indexOf(grid) + 1) % GRID_LEVELS.length];
    flash(
      what === "flip" ? (flipped ? "Mirrored" : "Not mirrored")
      : what === "gray" ? (gray ? "Grayscale on" : "Grayscale off")
      : what === "values" ? (posterize ? `${posterize} values` : "Values off")
      : grid ? `${grid} × ${grid} grid` : "Grid off",
    );
    render();
  }

  function currentRef(): ImageRef | null {
    return clock.step?.kind === "image" && shownIndex >= 0 ? (queue.images[shownIndex] ?? null) : null;
  }

  async function saveCurrent() {
    const ref = currentRef();
    if (!ref) return;
    if (!app.signedIn) return flash("Create a free account to save pictures");
    const saved = await app.toggleFavorite(ref);
    flash(saved ? "★ Saved to My pictures" : "Removed from My pictures");
    render();
  }

  async function likeCurrent() {
    const ref = currentRef();
    if (!ref) return;
    if (!app.signedIn) return flash("Create a free account to give pictures a thumbs up");
    const liked = await app.toggleLike(ref);
    flash(liked ? "👍 Thanks! That helps others find good ones." : "Thumbs up taken back");
    render();
  }

  async function hideCurrent() {
    const step = clock.step;
    if (step?.kind !== "image" || shownIndex < 0) return;
    const ref = queue.images[shownIndex];
    if (!ref) return;
    await app.hide(ref.id);
    if (app.favoriteIds.has(ref.id)) await app.toggleFavorite(ref);
    const i = shown.findIndex((x) => x.id === ref.id);
    if (i >= 0) shown.splice(i, 1);
    queue.drop(shownIndex);
    shownIndex = -1;
    flash("Hidden. You won't see that one again.");
    handle(clock.restart());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.().catch(() => {});
  }

  let toastTimer = 0;
  function flash(text: string) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1400);
  }

  function setOverlay(key: string, title: string, big: string, sub: string, actions: HTMLElement[] = []) {
    overlay.hidden = !key;
    if (key !== overlayKey) {
      overlayKey = key;
      overlayActions.replaceChildren(...actions);
    }
    overlayTitle.textContent = title;
    overlayBig.textContent = big;
    overlaySub.textContent = sub;
  }

  function render() {
    const step = clock.step;
    const imageStep = step?.kind === "image" ? step : null;
    const ready = !!imageStep && shownIndex === imageStep.imageIndex && loaded;
    const memoryHidden = clock.phase === "drawing" && s.memoryViewSeconds > 0 && clock.drawingElapsedMs >= s.memoryViewSeconds * 1000 && !peek;

    counter.textContent = imageStep ? `${imageStep.imageIndex + 1} / ${total}` : step?.kind === "break" ? "Break" : "";
    timer.textContent = clock.phase === "drawing" || clock.phase === "break" || clock.phase === "timeUp" ? formatClock(clock.remainingMs) : "";
    timer.classList.toggle("urgent", clock.phase === "drawing" && clock.remainingMs <= Math.max(s.warnSeconds, 3) * 1000);
    pauseBtn.textContent = clock.paused ? "▶" : "⏸";

    const stepMs = imageStep?.seconds ? imageStep.seconds * 1000 : step?.kind === "break" ? step.seconds * 1000 : 0;
    const frac = stepMs && (clock.phase === "drawing" || clock.phase === "break") ? 1 - clock.remainingMs / stepMs : clock.phase === "timeUp" ? 1 : 0;
    progress.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;

    // Study aids. Posterize uses an SVG filter so it works on any image, CORS or not.
    const filters = [posterize ? `url(#posterize-${posterize})` : gray ? "grayscale(1)" : ""].filter(Boolean);
    img.style.filter = filters.join(" ");
    img.style.transform = flipped ? "scaleX(-1)" : "";
    gridEl.style.setProperty("--n", String(grid));
    gridEl.hidden = !grid;
    flipBtn.classList.toggle("on", flipped);
    grayBtn.classList.toggle("on", gray);
    valueBtn.classList.toggle("on", !!posterize);
    gridBtn.classList.toggle("on", !!grid);
    const saved = !!imageStep && shownIndex === imageStep.imageIndex && app.favoriteIds.has(queue.images[shownIndex]?.id ?? "");
    saveBtn.textContent = saved ? "★" : "☆";
    saveBtn.classList.toggle("on", saved);
    const current = imageStep && shownIndex === imageStep.imageIndex ? queue.images[shownIndex] : undefined;
    const likes = current ? (app.likes.get(current.id) ?? 0) : 0;
    likeBtn.textContent = likes ? `👍 ${likes}` : "👍";
    likeBtn.classList.toggle("on", !!current && app.likedIds.has(current.id));
    likeBtn.title = likes ? `${likes} ${likes === 1 ? "family likes" : "families like"} this one. Thumbs up (L)` : "Thumbs up: a good one to draw (L)";

    frame.classList.toggle("blur", clock.phase === "getReady" || memoryHidden || clock.phase === "break");
    frame.classList.toggle("gone", memoryHidden || clock.phase === "break" || !ready);

    const back = () => btn("Back home", "Back home", () => finish(true), { class: "primary" });
    if (modelFailed) {
      setOverlay("model", "The safety check couldn't start", "🛡️", "No images are shown without it. Check your connection, then try again.", [
        btn("Try again", "Try again", () => void finish(true).then(() => app.startPlan(plan, replay)), { class: "primary" }),
        back(),
      ]);
    } else if (clock.paused) {
      setOverlay("paused", "Paused", "⏸", "Press Space to keep going", [btn("Resume", "Resume", togglePause, { class: "primary" })]);
    } else if (imageStep && !ready) {
      const err = queue.error && !queue.images.length ? queue.error : "";
      setOverlay(
        err ? "error" : "loading",
        err ? "Hmm, no pictures yet" : `Finding safe references for “${plan.prompt}”`,
        err ? "🔌" : "🔎",
        err || "Each image is checked on your device first.",
        err ? [back()] : [],
      );
    } else if (clock.phase === "getReady") {
      setOverlay("ready", "Get ready…", String(Math.max(1, Math.ceil(clock.remainingMs / 1000))), imageStep?.seconds ? `${formatClock(imageStep.seconds * 1000)} to draw` : "Untimed. Press → when done.");
    } else if (clock.phase === "break") {
      setOverlay("break", "Break time", formatClock(clock.remainingMs), "Stretch your hands, roll your shoulders, look out a window.", [
        btn("Skip break", "Skip break", () => handle(clock.next()), { class: "primary" }),
      ]);
    } else if (memoryHidden) {
      setOverlay("memory", "Now draw it from memory!", "🧠", "", [btn("Peek", "Peek", () => ((peek = true), render()))]);
    } else {
      setOverlay("", "", "", "");
    }
    toast.classList.toggle("sticky", clock.phase === "timeUp");
    if (clock.phase === "timeUp") toast.textContent = "Time's up! Press → for the next one, or A for more time.";
  }

  let last = performance.now();
  const interval = window.setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (ended) return;
    const step = clock.step;
    if (step?.kind === "image") {
      if (shownIndex !== step.imageIndex) {
        if (queue.images[step.imageIndex]) showImage(step.imageIndex);
        else if (!waiting) waitForImage(step.imageIndex);
      }
      // Don't run the clock until the image is actually on screen.
      if (shownIndex !== step.imageIndex || !loaded || modelFailed) return render();
    }
    handle(clock.tick(dt));
  }, TICK_MS);

  let waiting = false;
  function waitForImage(index: number) {
    waiting = true;
    void queue.waitFor(index).then((ref) => {
      waiting = false;
      if (!ref && !ended && !queue.error) {
        endNote = plan.images
          ? index === 0 ? "None of your saved pictures could be loaded right now." : "That's all of your saved pictures!"
          : index === 0 ? `We couldn't find safe pictures for “${plan.prompt}”. Try different words?` : `That's all the safe pictures we found for “${plan.prompt}”.`;
        void finish(index === 0);
      } else if (!ref && !ended && queue.images.length && index > 0) {
        endNote = queue.error ?? undefined;
        void finish();
      }
    });
  }

  let idleTimer = 0;
  const wake = () => {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => root.classList.add("idle"), IDLE_MS);
  };
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  wake();

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const map: Record<string, () => void> = {
      " ": togglePause,
      arrowright: () => handle(clock.next()),
      n: () => handle(clock.next()),
      arrowleft: () => handle(clock.prev()),
      a: () => handle(clock.addTime(30_000)),
      f: () => toggle("flip"),
      g: () => toggle("gray"),
      v: () => toggle("values"),
      r: () => toggle("grid"),
      x: () => void hideCurrent(),
      s: () => void saveCurrent(),
      l: () => void likeCurrent(),
      escape: () => void finish(),
    };
    if (map[k]) {
      e.preventDefault();
      wake();
      map[k]();
    }
  };
  document.addEventListener("keydown", onKey);

  // Optional smart search. It never blocks the first image.
  if (plan.expandable && s.ollama.enabled && !replay) {
    void (async () => {
      const status = await ollamaStatus(s.ollama.url);
      const model = status.ok ? pickModel(s.ollama.model, status.models) : null;
      if (!model || ended) return;
      try {
        const exp = await expandPrompt(s.ollama.url, model, plan.prompt);
        if (ended) return;
        if (!exp.safe) {
          endNote = FRIENDLY_REFUSAL;
          return void finish(true);
        }
        queue.addQueries(exp.queries.map((text) => ({ text, sources: ["commons", "openverse"] })));
        queue.ensure(total + 2);
      } catch {
        // Ollama is a nice-to-have; ignore failures.
      }
    })();
  }

  async function finish(toHome = false) {
    if (ended) return;
    ended = true;
    clearInterval(interval);
    clearTimeout(idleTimer);
    document.removeEventListener("keydown", onKey);
    queue.abort();
    sound.close();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    const endedAt = Date.now();
    if (shown.length) {
      await app.addHistory({ startedAt, endedAt, prompt: plan.prompt, categoryId: plan.category?.id, segments: s.segments, imageIds: shown.map((x) => x.id) });
    }
    if (toHome || !shown.length) app.goHome(endNote);
    else app.showSummary({ plan, shown, startedAt, endedAt, note: endNote });
  }

  handle(clock.start());
  queueMicrotask(() => root.focus());
  return root;
}
