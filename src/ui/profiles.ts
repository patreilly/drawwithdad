import { ApiError } from "../api/client";
import type { App } from "../main";
import { ACCENT_COLORS, AVATARS, MAX_PROFILES, MIN_PROFILE_PASSWORD, passwordProblem, type AccentColor, type Profile } from "../profiles/profile";
import { h } from "./dom";

const PASSWORD_NOTE =
  "A profile password keeps the rest of the family out of this profile (and its settings and saved pictures). It's checked by the server, and only a secure hash is stored.";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

/** A row of profile buttons. Locked profiles ask for their password in place. */
function profileList(app: App, onPicked: () => void, extra?: (p: Profile) => HTMLElement | null): HTMLElement {
  return h(
    "ul",
    { class: "profile-list" },
    ...app.profiles.map((p) => {
      const li = h("li", {});
      const button = h(
        "button",
        {
          type: "button",
          class: "profile-pick",
          "data-accent": p.color,
          "aria-current": p.id === app.profile.id && !app.isLocked(p) ? "true" : "false",
          onclick: async () => {
            if (!app.isLocked(p)) {
              await app.switchProfile(p.id);
              return onPicked();
            }
            li.replaceChildren(passwordForm(p, `Unlock ${p.name}`, async (pw) => (await app.unlock(p.id, pw)) && (onPicked(), true), () => li.replaceChildren(...row)));
          },
        },
        h("span", { class: "avatar", "aria-hidden": "true" }, p.avatar),
        h("span", { class: "profile-name" }, p.name),
        p.hasLock ? h("span", { class: "muted", title: "Has a password" }, app.isLocked(p) ? "🔒" : "🔓") : null,
        p.id === app.profile.id && !app.isLocked(p) ? h("span", { class: "muted" }, "drawing now") : null,
      );
      const row = [button, extra?.(p) ?? ""];
      li.replaceChildren(...row);
      return li;
    }),
  );
}

/** Password prompt. `attempt` returns whether the password was right. */
function passwordForm(profile: Profile, submitLabel: string, attempt: (password: string) => Promise<boolean>, cancel?: () => void): HTMLElement {
  const input = h("input", { type: "password", autocomplete: "current-password", "aria-label": `${profile.name}'s password`, placeholder: `${profile.name}'s password` });
  const error = h("p", { class: "error", role: "alert" });
  const submit = h("button", { type: "submit", class: "primary" }, submitLabel);
  const form = h(
    "form",
    {
      class: "password-form",
      "data-accent": profile.color,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = "";
        try {
          if (await attempt(input.value)) return;
          error.textContent = "That's not the right password.";
        } catch (err) {
          error.textContent = errorText(err);
        }
        submit.disabled = false;
        input.select();
      },
    },
    h("span", { class: "avatar", "aria-hidden": "true" }, profile.avatar),
    input,
    submit,
    cancel ? h("button", { type: "button", onclick: cancel }, "Cancel") : null,
    error,
  );
  queueMicrotask(() => input.focus());
  return form;
}

/** Full-page picker, shown after sign-in when the last profile has a password, and after "Lock". */
export function renderWhoIsDrawing(app: App, onPicked: () => void): HTMLElement {
  return h(
    "main",
    { class: "home who" },
    h("header", {}, h("h1", {}, "Who's drawing?"), h("p", { class: "tagline" }, "Draw with Dad")),
    profileList(app, onPicked),
    h("p", { class: "auth-links" }, h("button", { type: "button", class: "link", onclick: () => void app.signOut() }, `Sign out of ${app.email}`)),
  );
}

/** "Who's drawing?" dialog: switch, add, edit and delete profiles; account actions. */
export function openProfiles(app: App, onChanged: () => void): void {
  const dialog = h("dialog", { class: "customize profiles", "aria-label": "Profiles" });
  const body = h("div", { class: "dialog-body" });
  dialog.append(body);

  const close = () => dialog.close();

  const showList = () => {
    body.replaceChildren(
      h("h2", {}, "Who's drawing?"),
      profileList(
        app,
        () => (onChanged(), close()),
        (p) =>
          h(
            "button",
            {
              type: "button",
              class: "link",
              "aria-label": `Edit ${p.name}`,
              // A protected profile has to be unlocked (and becomes the one drawing) before it can be edited.
              onclick: () => (app.isLocked(p) ? showUnlockToEdit(p) : showEditor(p)),
            },
            "Edit",
          ),
      ),
      app.profiles.length < MAX_PROFILES
        ? h("button", { type: "button", onclick: () => showEditor(null) }, "+ Add someone")
        : h("p", { class: "muted" }, `That's the most profiles (${MAX_PROFILES}) for one account.`),
      h("p", { class: "block" }, "Each profile keeps its own settings, presets, saved pictures and history. Add a password to keep a profile to yourself."),
      h(
        "fieldset",
        {},
        h("legend", {}, "Family account"),
        h("p", { class: "block" }, `Signed in as ${app.email}.`),
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", onclick: () => (close(), void app.signOut()) }, "Sign out"),
          h("button", { type: "button", class: "danger", onclick: showDeleteAccount }, "Delete account…"),
        ),
      ),
      h(
        "div",
        { class: "dialog-actions" },
        app.profile.hasLock && !app.isLocked(app.profile) ? h("button", { type: "button", onclick: () => (close(), app.lock()) }, `🔒 Lock ${app.profile.name}`) : null,
        h("button", { type: "button", onclick: close }, "Close"),
      ),
    );
  };

  const showUnlockToEdit = (p: Profile) => {
    body.replaceChildren(
      h("h2", {}, `Edit ${p.name}`),
      passwordForm(p, "Continue", async (pw) => (await app.unlock(p.id, pw)) && (onChanged(), showEditor(app.profiles.find((x) => x.id === p.id)!), true), showList),
    );
  };

  const showDeleteAccount = () => {
    const pw = h("input", { type: "password", autocomplete: "current-password", "aria-label": "Account password", required: true });
    const error = h("p", { class: "error", role: "alert" });
    body.replaceChildren(
      h("h2", {}, "Delete the family account?"),
      h(
        "p",
        { class: "block" },
        `This permanently deletes ${app.email}, every profile in it, and all saved pictures, presets and history. It can't be undone.`,
      ),
      h(
        "form",
        {
          onsubmit: async (e: Event) => {
            e.preventDefault();
            try {
              await app.deleteAccount(pw.value);
              close();
            } catch (err) {
              error.textContent = errorText(err);
            }
          },
        },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Account password"), pw),
        error,
        h("div", { class: "dialog-actions" }, h("button", { type: "button", onclick: showList }, "Back"), h("button", { type: "submit", class: "danger" }, "Delete everything")),
      ),
    );
    queueMicrotask(() => pw.focus());
  };

  const showEditor = (existing: Profile | null) => {
    let avatar = existing?.avatar ?? AVATARS[(app.profiles.length + 1) % AVATARS.length];
    let color: AccentColor = existing?.color ?? ACCENT_COLORS[app.profiles.length % ACCENT_COLORS.length];
    const name = h("input", { type: "text", value: existing?.name ?? "", maxlength: 24, placeholder: "Name", "aria-label": "Name", autocomplete: "off" });

    const avatars = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Picture" });
    const paintAvatars = () =>
      avatars.replaceChildren(
        ...AVATARS.map((a) =>
          h("button", { type: "button", role: "radio", class: "swatch", "aria-checked": a === avatar ? "true" : "false", "aria-label": a, onclick: () => ((avatar = a), paintAvatars()) }, a),
        ),
      );
    paintAvatars();

    const colors = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Color" });
    const paintColors = () =>
      colors.replaceChildren(
        ...ACCENT_COLORS.map((c) =>
          h("button", { type: "button", role: "radio", class: "swatch color", "data-accent": c, "aria-checked": c === color ? "true" : "false", "aria-label": c, onclick: () => ((color = c), paintColors()) }),
        ),
      );
    paintColors();

    // Password: set one, change it, or remove it. Changing an existing one needs the current one.
    const locked = !!existing?.hasLock;
    const current = h("input", { type: "password", autocomplete: "current-password", "aria-label": "Current password" });
    const next = h("input", { type: "password", autocomplete: "new-password", "aria-label": "New password", placeholder: `${MIN_PROFILE_PASSWORD}+ characters` });
    const again = h("input", { type: "password", autocomplete: "new-password", "aria-label": "Type it again" });
    const removeBox = h("input", { type: "checkbox", onchange: () => (next.disabled = again.disabled = removeBox.checked) });
    const passwordFields = h(
      "fieldset",
      {},
      h("legend", {}, locked ? "Password 🔒" : "Password (optional)"),
      h("small", { class: "block" }, PASSWORD_NOTE),
      locked ? h("label", { class: "field" }, h("span", { class: "field-label" }, "Current password"), current) : null,
      h("label", { class: "field" }, h("span", { class: "field-label" }, locked ? "New password" : "Password"), next),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Type it again"), again),
      locked ? h("label", { class: "field" }, h("span", { class: "field-label" }, "Remove the password"), removeBox) : null,
    );
    const error = h("p", { class: "error", role: "alert" });
    const submitLabel = existing ? "Save" : "Add and start drawing";
    const submit = h("button", { type: "submit", class: "primary" }, submitLabel);

    const save = async () => {
      error.textContent = "";
      const remove = removeBox.checked;
      const changing = remove || !!next.value || !!again.value;
      if (changing && !remove) {
        const problem = passwordProblem(next.value, again.value, MIN_PROFILE_PASSWORD);
        if (problem) return void (error.textContent = problem);
      }
      submit.disabled = true;
      submit.textContent = "Saving…";
      try {
        if (existing) {
          await app.saveProfile(existing.id, {
            name: name.value,
            avatar,
            color,
            ...(changing ? { password: remove ? { current: current.value, remove: true } : { current: current.value, next: next.value } } : {}),
          });
        } else {
          // New profiles start from the defaults, not from whoever is drawing now.
          await app.addProfile({ name: name.value, avatar, color, ...(next.value ? { password: next.value } : {}) });
        }
        onChanged();
        close();
      } catch (e) {
        error.textContent = errorText(e);
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    };

    const canDelete = existing && app.profiles.length > 1;
    body.replaceChildren(
      h("h2", {}, existing ? `Edit ${existing.name}` : "Add someone"),
      h(
        "form",
        { onsubmit: (e: Event) => (e.preventDefault(), void save()) },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), name),
        h("fieldset", {}, h("legend", {}, "Picture"), avatars),
        h("fieldset", {}, h("legend", {}, "Color"), colors),
        passwordFields,
        error,
        canDelete
          ? h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: async () => {
                  if (!confirm(`Delete ${existing.name}? Their settings, presets, saved pictures and history will be deleted.`)) return;
                  try {
                    await app.deleteProfile(existing.id);
                  } catch (e) {
                    return void (error.textContent = errorText(e));
                  }
                  // If everyone left has a password, the app is now on the lock screen.
                  if (app.isLocked(app.profile)) return close();
                  onChanged();
                  showList();
                },
              },
              `Delete ${existing.name}`,
            )
          : null,
        h("div", { class: "dialog-actions" }, h("button", { type: "button", onclick: showList }, "Back"), submit),
      ),
    );
    queueMicrotask(() => name.focus());
  };

  showList();
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
