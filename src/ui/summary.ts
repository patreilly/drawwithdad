import type { App } from "../main";
import { formatDuration } from "../session/settings";
import type { ImageRef } from "../types";
import { h } from "./dom";
import type { SessionResult } from "./session";

export function renderSummary(app: App, result: SessionResult): HTMLElement {
  const minutes = Math.max(1, Math.round((result.endedAt - result.startedAt) / 60_000));
  const again = { prompt: result.plan.category ? undefined : result.plan.prompt, categoryId: result.plan.category?.id };
  // Saved-picture sessions are re-run from the plan; searching for "My pictures" would make no sense.
  const startAgain = () => (result.plan.images ? app.startPlan(result.plan) : app.start(again));

  const view = h(
    "main",
    { class: "summary" },
    h("h1", {}, "Nice work! ✏️"),
    h("p", { class: "tagline" }, `${result.shown.length} reference${result.shown.length === 1 ? "" : "s"} · about ${formatDuration(minutes * 60)} of drawing`),
    result.note ? h("p", { class: "muted" }, result.note) : null,
    h(
      "div",
      { class: "row center" },
      h("button", { type: "button", class: "primary", onclick: startAgain }, result.plan.images ? "Again, shuffled" : "Again with new pictures"),
      h("button", { type: "button", onclick: () => app.start(again, result.shown) }, "Same pictures again"),
      h("button", { type: "button", onclick: () => app.goHome() }, "Home"),
    ),
    app.signedIn
      ? h("p", { class: "muted" }, "Tap ☆ to save a picture to My pictures, or 👍 to tell others it's a good one to draw.")
      : h(
          "p",
          { class: "muted" },
          h("button", { type: "button", class: "link", onclick: () => app.showSignIn({ mode: "signup" }) }, "Create a free account"),
          " to save pictures, give them a thumbs up and keep your history.",
        ),
    thumbGrid(app, result.shown),
  );
  queueMicrotask(() => view.querySelector<HTMLButtonElement>("button.primary")?.focus());
  return view;
}

/** Credited thumbnails with a save star and a thumbs up. Shared by the summary and the gallery. */
export function thumbGrid(app: App, images: ImageRef[], onUnsave?: (img: ImageRef, li: HTMLElement) => void): HTMLElement {
  const painters: (() => void)[] = [];
  const signUp = (message: string) => app.showSignIn({ mode: "signup", message });
  void app.likeCounts(images.map((i) => i.id)).then(() => painters.forEach((p) => p()));
  return h(
    "ul",
    { class: "thumbs" },
    ...images.map((img) => {
      const star = h("button", { type: "button", class: "star" });
      const like = h("button", { type: "button", class: "like" });
      const paint = () => {
        const likes = app.likes.get(img.id) ?? 0;
        const liked = app.likedIds.has(img.id);
        like.textContent = likes ? `👍 ${likes}` : "👍";
        like.classList.toggle("on", liked);
        like.setAttribute("aria-label", `${liked ? "Take back your thumbs up for" : "Thumbs up for"} “${img.title}”${likes ? ` (${likes} so far)` : ""}`);
        like.title = likes ? `${likes} ${likes === 1 ? "family likes" : "families like"} this one` : "A good one to draw? Give it a thumbs up";
        const saved = app.favoriteIds.has(img.id);
        star.textContent = saved ? "★" : "☆";
        star.classList.toggle("on", saved);
        star.setAttribute("aria-label", saved ? `Remove “${img.title}” from My pictures` : `Save “${img.title}” to My pictures`);
        star.title = saved ? "Remove from My pictures" : "Save to My pictures";
      };
      const li = h(
        "li",
        {},
        h("a", { href: img.landingUrl, target: "_blank", rel: "noopener noreferrer" }, h("img", { src: img.thumbUrl, alt: img.title, loading: "lazy", referrerpolicy: "no-referrer" })),
        star,
        like,
        h("small", {}, `${img.creator} · ${img.license}`),
      );
      star.addEventListener("click", async () => {
        if (!app.signedIn) return signUp("Create a free account to save pictures to My pictures.");
        const saved = await app.toggleFavorite(img);
        paint();
        if (!saved) onUnsave?.(img, li);
      });
      like.addEventListener("click", async () => {
        if (!app.signedIn) return signUp("Create a free account to give pictures a thumbs up.");
        await app.toggleLike(img);
        paint();
      });
      painters.push(paint);
      paint();
      return li;
    }),
  );
}
