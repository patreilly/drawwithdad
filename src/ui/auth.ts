import { ApiError, type Api, type Me } from "../api/client";
import { MIN_ACCOUNT_PASSWORD, passwordProblem } from "../profiles/profile";
import { h } from "./dom";

export type AuthMode = "signin" | "signup" | "forgot" | "reset";
type Mode = AuthMode;

/**
 * Sign in, create a family account, or reset a forgotten password. An account is
 * optional: `onSkip` goes back to drawing as a guest.
 */
export function renderAuth(
  api: Api,
  onSignedIn: (me: Me, how: AuthMode) => void,
  opts: { message?: string; resetToken?: string; mode?: AuthMode; onSkip?: () => void } = {},
): HTMLElement {
  const view = h("main", { class: "home who auth" });
  let resetToken = opts.resetToken;

  const field = (label: string, input: HTMLInputElement) => h("label", { class: "auth-field" }, h("span", {}, label), input);
  const input = (attrs: Record<string, string | number | boolean>) => h("input", { required: true, ...attrs });

  const render = (mode: Mode, notice = "") => {
    const email = input({ type: "email", autocomplete: "email", maxlength: 254 });
    const password = input({ type: "password", autocomplete: mode === "signin" ? "current-password" : "new-password", maxlength: 128 });
    const again = input({ type: "password", autocomplete: "new-password", maxlength: 128 });
    const name = input({ type: "text", autocomplete: "given-name", maxlength: 24, placeholder: "e.g. Dad" });
    const error = h("p", { class: "error", role: "alert" });
    const submit = h(
      "button",
      { type: "submit", class: "primary" },
      { signin: "Sign in", signup: "Create account", forgot: "Email me a reset link", reset: "Save new password" }[mode],
    );

    const run = async () => {
      error.textContent = "";
      if ((mode === "signup" || mode === "reset") && passwordProblem(password.value, again.value, MIN_ACCOUNT_PASSWORD)) {
        error.textContent = passwordProblem(password.value, again.value, MIN_ACCOUNT_PASSWORD)!;
        return;
      }
      submit.disabled = true;
      try {
        if (mode === "signin") onSignedIn(await api.signIn(email.value, password.value), mode);
        else if (mode === "signup") onSignedIn(await api.signUp(email.value, password.value, name.value), mode);
        else if (mode === "reset") {
          const me = await api.resetPassword(resetToken ?? "", password.value);
          resetToken = undefined;
          onSignedIn(me, mode);
        } else {
          await api.forgotPassword(email.value);
          render("signin", "If there's an account for that email, a reset link is on its way. It works for 60 minutes.");
        }
      } catch (e) {
        error.textContent = e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
        submit.disabled = false;
      }
    };

    const link = (label: string, to: Mode) => h("button", { type: "button", class: "link", onclick: () => render(to) }, label);

    view.replaceChildren(
      h(
        "header",
        {},
        h("h1", {}, "Draw with Dad"),
        h(
          "p",
          { class: "tagline" },
          {
            signin: "Sign in to pick up where you left off.",
            signup: "A free family account keeps saved pictures, history and settings on any device. Everyone gets their own profile inside it.",
            forgot: "Forgot your password?",
            reset: "Choose a new password.",
          }[mode],
        ),
      ),
      notice || opts.message ? h("p", { class: "notice", role: "status" }, notice || opts.message!) : "",
      h(
        "form",
        { class: "auth-form", onsubmit: (e: Event) => (e.preventDefault(), void run()) },
        mode === "signup" ? field("Your name", name) : null,
        mode !== "reset" ? field("Email", email) : null,
        mode !== "forgot" ? field(mode === "signin" ? "Password" : `Password (${MIN_ACCOUNT_PASSWORD}+ characters)`, password) : null,
        mode === "signup" || mode === "reset" ? field("Type it again", again) : null,
        error,
        submit,
      ),
      h(
        "p",
        { class: "auth-links" },
        mode === "signin" ? [link("Create an account", "signup"), " · ", link("Forgot password?", "forgot")] : link("Back to sign in", "signin"),
      ),
      mode === "signup"
        ? h("p", { class: "block small" }, "A grown-up should create the account. Kids get their own profiles inside it; they never need an email address.")
        : "",
      opts.onSkip ? h("p", { class: "auth-links" }, h("button", { type: "button", class: "link", onclick: opts.onSkip }, "Keep drawing without an account →")) : "",
    );
    opts.message = undefined;
    queueMicrotask(() => view.querySelector<HTMLInputElement>("input")?.focus());
  };

  render(resetToken ? "reset" : (opts.mode ?? "signin"));
  return view;
}
