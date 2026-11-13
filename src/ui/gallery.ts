import type { App } from "../main";
import { classifyImage } from "../safety/imageFilter";
import { savedPicturesPlan } from "../search/plan";
import { ReferenceQueue } from "../search/referenceQueue";
import { describeSegments } from "../session/settings";
import type { ImageRef } from "../types";
import { h } from "./dom";
import { thumbGrid } from "./summary";

/** "My pictures": the current profile's saved references. */
export function renderGallery(app: App): HTMLElement {
  const status = h("p", { class: "muted" }, "Loading…");
  const grid = h("div", {});
  const drawBtn = h("button", { type: "button", class: "primary", disabled: true }, "Draw these ▶");
  let shown: ImageRef[] = [];

  drawBtn.addEventListener("click", () => app.startPlan(savedPicturesPlan(shown)));

  const view = h(
    "main",
    { class: "summary gallery" },
    h("h1", {}, `${app.profile.avatar} My pictures`),
    h("p", { class: "tagline" }, `Saved by ${app.profile.name}`),
    h("div", { class: "row center" }, drawBtn, h("button", { type: "button", onclick: () => app.goHome() }, "Home")),
    h("p", { class: "muted session-summary" }, `Draws with your current timing: ${describeSegments(app.settings.segments)}`),
    status,
    grid,
  );

  const paint = () => {
    drawBtn.disabled = !shown.length;
    status.textContent = shown.length
      ? `${shown.length} saved picture${shown.length === 1 ? "" : "s"}`
      : "Nothing saved yet. Press ☆ (or S) while drawing to save a picture here.";
    grid.replaceChildren(
      thumbGrid(app, shown, (img, li) => {
        shown = shown.filter((x) => x.id !== img.id);
        li.remove();
        paint();
      }),
    );
  };

  void (async () => {
    const [saved, hiddenIds] = await Promise.all([
      app.api.favorites(app.profile.id).catch(() => [] as ImageRef[]),
      app.hiddenIds(),
    ]);
    if (!saved.length) return paint();
    // Saved pictures pass through the same safety check as search results, every time they're shown.
    // So a stricter future check still applies to pictures saved earlier, and nothing from the server is trusted blindly.
    const queue = new ReferenceQueue({
      queries: [],
      candidates: saved,
      orientation: "any",
      strict: true,
      shuffle: false,
      hiddenIds,
      recentIds: new Set(),
      store: app.cache,
      classify: classifyImage,
    });
    queue.onChange = () => {
      // Keep the saved order, newest first.
      const ok = new Set(queue.images.map((i) => i.id));
      const next = saved.filter((i) => ok.has(i.id) && app.favoriteIds.has(i.id));
      if (next.length !== shown.length) {
        shown = next;
        paint();
      }
    };
    queue.ensure(saved.length);
    await queue.waitFor(saved.length - 1);
    if (!shown.length) paint();
  })();

  return view;
}
