import type { App } from "../main";
import { ollamaStatus, pickModel } from "../ollama/client";
import { makePreset, MAX_PRESETS } from "../profiles/profile";
import { DURATION_CHOICES, formatDuration, sanitize, type SessionSettings } from "../session/settings";
import { h } from "./dom";

type Option<T> = [T, string];

function select<T extends string | number>(value: T, options: Option<T>[], onChange: (v: T) => void): HTMLSelectElement {
  const el = h(
    "select",
    { onchange: () => onChange(options[el.selectedIndex][0]) },
    ...options.map(([v, label]) => h("option", { selected: v === value }, label)),
  );
  return el;
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox", checked, onchange: () => onChange(el.checked) });
  return el;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("small", {}, hint) : null);
}

const seconds = (list: number[], zero?: string): Option<number>[] =>
  list.map((s) => [s, s === 0 ? (zero ?? "Off") : formatDuration(s)]);

/** The full settings panel. Edits a draft and only saves on "Done". */
export function openCustomize(app: App, onSaved: () => void): void {
  const draft: SessionSettings = structuredClone(app.settings);
  const dialog = h("dialog", { class: "customize", "aria-label": "Customize session" });

  const segmentsBox = h("div", { class: "segments" });
  const renderSegments = () => {
    segmentsBox.replaceChildren(
      h("div", { class: "segments" }, ...draft.segments.map((seg, i) =>
        h(
          "div",
          { class: "segment" },
          select(seg.count, Array.from({ length: 50 }, (_, n): Option<number> => [n + 1, String(n + 1)]), (v) => {
            seg.count = v;
            draft.presetId = "custom";
          }),
          h("span", {}, "images ×"),
          select<number | string>(seg.seconds ?? "untimed", DURATION_CHOICES.map((d): Option<number | string> => [d ?? "untimed", formatDuration(d)]), (v) => {
            seg.seconds = v === "untimed" ? null : (v as number);
            draft.presetId = "custom";
          }),
          draft.segments.length > 1
            ? h("button", { type: "button", class: "icon", "aria-label": "Remove", onclick: () => (draft.segments.splice(i, 1), (draft.presetId = "custom"), renderSegments()) }, "✕")
            : null,
        ),
      )),
      draft.segments.length < 10
        ? h(
            "button",
            {
              type: "button",
              class: "link",
              onclick: () => {
                const last = draft.segments[draft.segments.length - 1];
                draft.segments.push({ count: Math.max(1, Math.ceil(last.count / 2)), seconds: last.seconds === null ? null : last.seconds * 2 });
                draft.presetId = "custom";
                renderSegments();
              },
            },
            "+ Add a longer round",
          )
        : "",
    );
  };
  renderSegments();

  // Saved presets belong to the profile and are saved right away, even if the dialog is cancelled.
  const presetsBox = h("div", {});
  const renderPresets = () => {
    const presets = app.profile.presets;
    const name = h("input", { type: "text", maxlength: 24, placeholder: "e.g. Saturday class", "aria-label": "Preset name" });
    const saveBtn = h("button", { type: "button" }, "Save as preset");
    saveBtn.addEventListener("click", async () => {
      const preset = makePreset(name.value || `Preset ${presets.length + 1}`, sanitize(draft));
      saveBtn.disabled = true;
      await app.saveProfile(app.profile.id, { presets: [...presets, preset] }).then(
        () => (draft.presetId = preset.id),
        () => {},
      );
      renderPresets();
    });
    presetsBox.replaceChildren(
      h("small", { class: "block" }, `Save everything above and below (timing, flow, study aids, sound) as ${app.profile.name}'s own preset. It shows up next to the others on the home screen.`),
      presets.length < MAX_PRESETS ? h("div", { class: "row" }, name, saveBtn) : h("small", { class: "block" }, "That's the most presets. Remove one to save another."),
      presets.length
        ? h(
            "ul",
            { class: "my-presets" },
            ...presets.map((p) =>
              h(
                "li",
                {},
                h("span", {}, `★ ${p.label}`),
                h(
                  "button",
                  {
                    type: "button",
                    class: "icon",
                    "aria-label": `Remove ${p.label}`,
                    onclick: async () => {
                      await app.saveProfile(app.profile.id, { presets: app.profile.presets.filter((x) => x.id !== p.id) }).catch(() => {});
                      if (draft.presetId === p.id) draft.presetId = "custom";
                      renderPresets();
                    },
                  },
                  "✕",
                ),
              ),
            ),
          )
        : "",
    );
  };
  renderPresets();

  const ollamaInfo = h("small", {});
  const checkOllama = async () => {
    ollamaInfo.textContent = "Checking…";
    const s = await ollamaStatus(draft.ollama.url);
    if (!s.ok) {
      ollamaInfo.textContent =
        `Not reachable at ${draft.ollama.url}. Install Ollama, run \`ollama pull llama3.2:3b\`, ` +
        (location.hostname === "localhost" || location.hostname === "127.0.0.1"
          ? "then start it."
          : `then start it with OLLAMA_ORIGINS=${location.origin}.`);
      return;
    }
    const model = pickModel(draft.ollama.model, s.models);
    ollamaInfo.textContent = model ? `Connected. Using ${model}.` : "Connected, but no models installed. Run `ollama pull llama3.2:3b`.";
  };

  const body = h(
    "form",
    { method: "dialog" },
    h("h2", {}, `Customize ${app.profile.avatar} ${app.profile.name}'s sessions`),

    h("fieldset", {}, h("legend", {}, "Timing"), segmentsBox),
    h("fieldset", {}, h("legend", {}, "My presets"), presetsBox),

    h(
      "fieldset",
      {},
      h("legend", {}, "Flow"),
      field("Get-ready countdown", select(draft.getReadySeconds, seconds([0, 3, 5, 10]), (v) => (draft.getReadySeconds = v)), "A moment to pick up your pencil before each image."),
      field("When time's up", select(draft.advance, [["auto", "Go to the next image"], ["manual", "Wait for me to press Next"]], (v) => (draft.advance = v))),
      field(
        "Breaks",
        select(draft.breakEvery, [[0, "No breaks"], [5, "Every 5 images"], [10, "Every 10 images"], [15, "Every 15 images"]], (v) => (draft.breakEvery = v)),
      ),
      field("Break length", select(draft.breakSeconds, seconds([30, 60, 120, 300]), (v) => (draft.breakSeconds = v))),
      field(
        "Memory drawing",
        select(draft.memoryViewSeconds, seconds([0, 10, 20, 30, 60], "Off"), (v) => (draft.memoryViewSeconds = v)),
        "Show the image briefly, then hide it and draw from memory.",
      ),
    ),

    h(
      "fieldset",
      {},
      h("legend", {}, "Images"),
      field("Orientation", select(draft.orientation, [["any", "Any"], ["landscape", "Landscape"], ["portrait", "Portrait"], ["square", "Square"]], (v) => (draft.orientation = v))),
      field("Shuffle results", checkbox(draft.shuffle, (v) => (draft.shuffle = v))),
      field("Avoid images I've drawn recently", checkbox(draft.avoidRepeats, (v) => (draft.avoidRepeats = v))),
    ),

    h(
      "fieldset",
      {},
      h("legend", {}, "Study aids"),
      h("small", { class: "block" }, "You can also toggle these while drawing: F flip · G gray · V values · R grid."),
      field("Mirror image", select(draft.flip, [["off", "Off"], ["always", "Always"], ["random", "Randomly"]], (v) => (draft.flip = v)), "Mirroring helps spot proportion mistakes."),
      field("Grayscale", checkbox(draft.grayscale, (v) => (draft.grayscale = v))),
      field("Value study (posterize)", select(draft.posterize, [[0, "Off"], [2, "2 values"], [3, "3 values"], [4, "4 values"], [5, "5 values"]], (v) => (draft.posterize = v))),
      field("Grid overlay", select(draft.grid, [[0, "Off"], [2, "2 × 2"], [3, "3 × 3"], [4, "4 × 4"]], (v) => (draft.grid = v))),
    ),

    h(
      "fieldset",
      {},
      h("legend", {}, "Display & sound"),
      field("Timer", select(draft.timerDisplay, [["large", "Large"], ["small", "Small"], ["hidden", "Hidden"]], (v) => (draft.timerDisplay = v))),
      field("Sounds", checkbox(draft.sound, (v) => (draft.sound = v))),
      field("Countdown beeps", select(draft.warnSeconds, [[0, "Off"], [3, "Last 3 seconds"], [5, "Last 5 seconds"], [10, "Last 10 seconds"]], (v) => (draft.warnSeconds = v))),
      field(
        "Volume",
        (() => {
          const el = h("input", { type: "range", min: 0, max: 1, step: 0.1, value: draft.volume, oninput: () => (draft.volume = Number(el.value)) });
          return el;
        })(),
      ),
    ),

    h(
      "fieldset",
      {},
      h("legend", {}, "Smart search (optional)"),
      field("Use a local Ollama to find better references", checkbox(draft.ollama.enabled, (v) => ((draft.ollama.enabled = v), v && void checkOllama()))),
      field(
        "Ollama URL",
        (() => {
          const el = h("input", { type: "url", value: draft.ollama.url, onchange: () => (draft.ollama.url = el.value.trim() || "http://localhost:11434") });
          return el;
        })(),
      ),
      field(
        "Model",
        (() => {
          const el = h("input", { type: "text", value: draft.ollama.model, placeholder: "auto (smallest installed)", onchange: () => (draft.ollama.model = el.value.trim()) });
          return el;
        })(),
      ),
      ollamaInfo,
    ),

    h(
      "fieldset",
      {},
      h("legend", {}, "Safety & privacy"),
      h(
        "p",
        { class: "block" },
        "Safety filtering is always on and can't be turned off. Every image is checked on this device before it's shown. An image anyone hides stays hidden for everyone in the family.",
      ),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: async (e: Event) => ((e.target as HTMLButtonElement).textContent = "Cleared ✓", await app.api.clearHidden(app.profile.id)) }, "Un-hide images I hid"),
        h("button", { type: "button", onclick: async (e: Event) => ((e.target as HTMLButtonElement).textContent = "Cleared ✓", await app.api.clearHistory(app.profile.id)) }, "Clear my drawing history"),
      ),
    ),

    h(
      "div",
      { class: "dialog-actions" },
      h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
      h(
        "button",
        {
          type: "button",
          class: "primary",
          onclick: () => {
            app.updateSettings(sanitize(draft));
            dialog.close();
          },
        },
        "Done",
      ),
    ),
  );

  dialog.append(body);
  dialog.addEventListener("close", () => {
    dialog.remove();
    onSaved();
  });
  document.body.append(dialog);
  dialog.showModal();
  if (draft.ollama.enabled) void checkOllama();
}
