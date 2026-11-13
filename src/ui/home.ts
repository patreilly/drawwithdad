import { CATEGORIES } from "../config/categories";
import { ollamaStatus } from "../ollama/client";
import { applyMyPreset } from "../profiles/profile";
import { planSearch, type SearchPlan } from "../search/plan";
import { prefetchPlan } from "../search/prefetch";
import { applyPreset, describeSegments, formatDuration, PRESETS, totalSeconds } from "../session/settings";
import type { App } from "../main";
import { openCustomize } from "./customize";
import { h } from "./dom";
import { openProfiles } from "./profiles";

export function renderHome(app: App, message?: string): HTMLElement {
  const input = h("input", {
    id: "prompt",
    type: "search",
    placeholder: "What do you want to draw? e.g. horses, hands, castles",
    autocomplete: "off",
    enterkeyhint: "go",
    maxlength: 100,
    "aria-label": "What do you want to draw?",
  });
  const error = h("p", { class: "error", role: "alert" }, message ?? "");

  // Start searching while the user is still typing; Openverse can take a few seconds.
  let typingTimer = 0;
  input.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => {
      if (input.value.trim().length < 3) return;
      const r = planSearch({ prompt: input.value });
      if (r.ok && !r.plan.category) prefetchPlan(r.plan, app.settings.orientation);
    }, 600);
  });

  // Category subjects are picked at random, so plan on hover and reuse that plan on click.
  const categoryPlans = new Map<string, SearchPlan>();
  const planCategory = (id: string) => {
    let plan = categoryPlans.get(id);
    if (!plan) {
      const r = planSearch({ categoryId: id });
      if (!r.ok) return null;
      plan = r.plan;
      categoryPlans.set(id, plan);
      prefetchPlan(plan, app.settings.orientation, 2);
    }
    return plan;
  };

  const form = h(
    "form",
    {
      class: "search",
      onsubmit: (e: Event) => {
        e.preventDefault();
        app.start({ prompt: input.value });
      },
    },
    input,
    h("button", { type: "submit", class: "primary" }, "Start drawing ▶"),
  );

  const presetRow = h("div", { class: "presets", role: "radiogroup", "aria-label": "Session length" });
  const summary = h("p", { class: "session-summary" });
  const renderPresets = () => {
    presetRow.replaceChildren(
      ...PRESETS.map((p) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            class: "chip",
            "aria-checked": app.settings.presetId === p.id ? "true" : "false",
            title: p.blurb,
            onclick: () => {
              app.updateSettings(applyPreset(app.settings, p));
              renderPresets();
            },
          },
          h("strong", {}, p.label),
          h("span", {}, describeSegments(p.segments)),
        ),
      ),
      ...app.profile.presets.map((p) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            class: "chip mine",
            "aria-checked": app.settings.presetId === p.id ? "true" : "false",
            title: `${app.profile.name}'s preset`,
            onclick: () => {
              app.updateSettings(applyMyPreset(app.settings, p));
              renderPresets();
            },
          },
          h("strong", {}, `★ ${p.label}`),
          h("span", {}, describeSegments(p.settings.segments)),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "chip ghost",
          "aria-checked": app.settings.presetId === "custom" ? "true" : "false",
          role: "radio",
          onclick: () => openCustomize(app, renderPresets),
        },
        h("strong", {}, "Customize…"),
        h("span", {}, app.settings.presetId === "custom" ? describeSegments(app.settings.segments) : "timing, breaks, study aids"),
      ),
    );
    const total = totalSeconds(app.settings.segments);
    const extras = [
      app.settings.getReadySeconds ? `${app.settings.getReadySeconds}s get-ready` : "",
      app.settings.breakEvery ? `break every ${app.settings.breakEvery}` : "",
      app.settings.memoryViewSeconds ? `memory mode (${app.settings.memoryViewSeconds}s look)` : "",
      app.settings.flip !== "off" ? `flip: ${app.settings.flip}` : "",
      app.settings.grayscale ? "grayscale" : "",
      app.settings.posterize ? `${app.settings.posterize} values` : "",
      app.settings.grid ? `${app.settings.grid}×${app.settings.grid} grid` : "",
    ].filter(Boolean);
    summary.textContent = `${describeSegments(app.settings.segments)}${total !== null ? ` · ${formatDuration(total)} total` : ""}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
  };
  renderPresets();

  const tiles = h(
    "div",
    { class: "tiles" },
    ...CATEGORIES.map((c) =>
      h(
        "button",
        {
          type: "button",
          class: "tile",
          onpointerenter: () => void planCategory(c.id),
          onfocus: () => void planCategory(c.id),
          onclick: () => {
            const plan = planCategory(c.id);
            if (plan) app.startPlan(plan);
          },
        },
        h("span", { class: "tile-icon", "aria-hidden": "true" }, c.icon),
        h("span", {}, c.label),
      ),
    ),
  );

  const recent = h("div", { class: "recent" });
  const savedChip = () =>
    app.favoriteIds.size ? h("button", { type: "button", class: "chip small saved", onclick: () => app.showGallery() }, `★ My pictures (${app.favoriteIds.size})`) : null;
  recent.replaceChildren(savedChip() ?? "");
  void app.history(12).then((sessions) => {
    const seen = new Set<string>();
    const items = sessions
      .filter((s) => !s.categoryId && s.prompt && s.prompt !== "My pictures" && !seen.has(s.prompt.toLowerCase()) && seen.add(s.prompt.toLowerCase()))
      .slice(0, 6);
    if (!items.length) return;
    recent.replaceChildren(
      savedChip() ?? "",
      h("span", { class: "muted" }, "Again:"),
      ...items.map((s) => h("button", { type: "button", class: "chip small", onclick: () => app.start({ prompt: s.prompt }) }, s.prompt)),
    );
  });

  const savedLink = app.signedIn
    ? h("button", { type: "button", class: "link", onclick: () => app.showGallery() }, "★ My pictures")
    : h("button", { type: "button", class: "link", onclick: () => app.showSignIn({ mode: "signup", message: "Create a free account to save pictures to My pictures." }) }, "★ My pictures");
  const profileBtn = h(
    "button",
    { type: "button", class: "profile-chip", title: "Switch or add profiles", onclick: () => openProfiles(app, () => app.goHome()) },
    h("span", { class: "avatar", "aria-hidden": "true" }, app.profile.avatar),
    h("span", {}, app.profile.name),
    h("span", { "aria-hidden": "true" }, " ▾"),
  );
  profileBtn.setAttribute("aria-label", `Drawing as ${app.profile.name}. Switch or add profiles.`);
  const accountBtn = app.signedIn ? profileBtn : h("button", { type: "button", class: "profile-chip", onclick: () => app.showSignIn() }, "Sign in");

  const ollamaPill = h("span", { class: "pill muted" });
  if (app.settings.ollama.enabled) {
    ollamaPill.textContent = "Smart search: checking…";
    void ollamaStatus(app.settings.ollama.url).then((s) => {
      ollamaPill.textContent = s.ok ? `Smart search: on (Ollama)` : "Smart search: Ollama not reachable";
      ollamaPill.classList.toggle("ok", s.ok);
    });
  }

  const view = h(
    "main",
    { class: "home" },
    h("div", { class: "topbar" }, savedLink, accountBtn),
    h("header", {}, h("h1", {}, "Draw with Dad"), h("p", { class: "tagline" }, "Type a subject, press Enter, start drawing.")),
    form,
    error,
    h("section", { "aria-label": "Session length" }, presetRow, summary),
    recent,
    h("h2", {}, "Or pick something to draw"),
    tiles,
    app.signedIn
      ? null
      : h(
          "p",
          { class: "muted guest-note" },
          "Drawing as a guest. Nothing is kept after you close this tab. ",
          h("button", { type: "button", class: "link", onclick: () => app.showSignIn({ mode: "signup" }) }, "Create a free account"),
          " to keep your settings, history and saved pictures.",
        ),
    h(
      "footer",
      {},
      h("span", {}, "🛡️ Every image is safety-checked on your device before it's shown. No ads, no tracking."),
      ollamaPill,
    ),
  );

  queueMicrotask(() => input.focus());
  return view;
}
