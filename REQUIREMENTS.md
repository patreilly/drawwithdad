# Draw with Dad: Requirements

> A lightweight, open-source, kid-safe web app for timed drawing practice. Type what you
> want to draw, or tap a category, and start drawing from a safety-checked reference photo
> within seconds. AI-generated references are optional and kept separate (planned).

Status: **v0.2 implemented** (see §9). The keywords **MUST**, **SHOULD** and **MAY** follow RFC 2119.

---

## 0. North star: drawing within 30 seconds

Every decision works backwards from this:

> A returning family opens the site, types "horses" (or taps **Animals**), and is drawing
> from a timed reference **within 30 seconds**. A first-time visitor gets there with no
> sign-up, no API keys and no setup; an account is only needed to keep things.

| Step | Budget | How |
|---|---|---|
| Page shell interactive | < 1 s | ~25 KB gzipped app, no framework, static hosting on a CDN |
| Signed in | 0 s | Guests draw right away; returning families have a 30-day login cookie |
| Safety model ready | in the background | ~4 MB model starts downloading on page load, while you type |
| First search results | ~1 s | Search starts **while typing** (600 ms debounce) or on **tile hover**. Wikimedia Commons (~1 s) and Openverse (3–10 s) are queried **in parallel**. |
| First image approved | ~1 s | Thumbnails are classified 3 at a time; the session starts on the **first** safe image |
| Get-ready countdown | 3 s (configurable) | |

**Measured (v0.1, M-series Mac, home broadband):**
- Enter → drawing: **4.6–5.7 s**, including the 3 s countdown.
- Cold first visit, clicking a category tile: **~10 s** from navigation in dev mode.
- Production build via a `?draw=castle` deep link: **6.4 s** from navigation.
- v0.2 Docker stack, new visitor via `?draw=sailboat`: **2.3 s** from submitting the sign-up form to drawing.

Repeat subjects in the same tab are faster because they're served from the in-memory cache.

---

## 1. Goals and non-goals

### Goals
1. **Start drawing fast** (§0).
2. **Be kid-friendly with no exceptions.** No nudity, including art nudes, and no gore or disturbing content. The safety filter has **no off switch**.
3. **Need zero setup.** No API keys and no servers to manage. A fresh `git clone` runs with one or two commands: `npm install && npm run dev` locally, `docker compose up --build` in Docker, or `npm run deploy:aws` to AWS (serverless, scales from zero).
3a. **Keep what people save, everywhere.** One family account. Saved data lives on the server, never only in the browser, so clearing browser data or switching devices loses nothing.
4. **Stay lightweight.** Vanilla TypeScript + Vite, no UI framework, and a small dependency list.
5. **Respect creators.** Every image shows its title, creator, license and a link to the source.
6. **Use local AI only, and only optionally.** Ollama improves search but is never required, and it never sits on the critical path.
7. **Be easy to extend.** A new image source is one file implementing `ImageSource`.

### Non-goals
- It is not a painting program.
- It is not a social network. No uploads or sharing feeds.
- It does not scrape Google or Bing images.
- It does not offer an "adult" or "unfiltered" mode, now or later.
- It does not collect telemetry or analytics.

---

## 2. Users

| Persona | Needs |
|---|---|
| **Kid and parent drawing together** | One tap to start, big friendly UI, nothing inappropriate |
| **Practicing artist** | Gesture timers, progressive sessions, value and mirror tools |
| **Teacher** | Works on any classroom machine through a URL; safe by default |
| **Open-source contributor** | Small, framework-free codebase; clear source and storage interfaces |

---

## 3. Reference categories

Tapping a category starts a session that mixes 4 random subjects from its pool. Free-text prompts work too.

| Category | Example subjects | Sources | Notes |
|---|---|---|---|
| 🧍 People & Poses | walking, dancer, skateboarder, martial arts | Openverse | **Strict** thresholds; Commons excluded |
| 🙂 Faces & Expressions | smiling portrait, profile, laughing | Openverse | **Strict**; Commons excluded |
| ✋ Hands & Feet | hand holding cup, pointing, sneakers | Commons, Openverse | **Strict** |
| 🐴 Animals | cat, horse, owl, fox, giraffe | Commons, Openverse | |
| 🦴 Animal Structure | skeletons, shells, specimens | Commons, Openverse | |
| 🌻 Plants & Flowers | sunflower, oak tree, mushroom | Commons, Openverse | |
| 🏔️ Landscapes & Nature | mountains, waterfall, clouds | Commons, Openverse | |
| 🏰 Architecture & Places | castle, lighthouse, windmill | Commons, Openverse | |
| 🚂 Vehicles & Machines | steam locomotive, tractor, sailboat | Commons, Openverse, NASA | |
| 🚀 Space & Flight | astronaut, rocket launch, rover | NASA, Commons | |
| 🍎 Objects & Still Life | teapot, fruit bowl, teddy bear | Commons, Openverse | |
| 🧣 Clothing & Fabric | fabric folds, drapery, armor | Commons, Openverse | |
| 🪵 Textures & Materials | bark, rusty metal, scales | Commons, Openverse | |
| 💡 Light & Shadow | window light, silhouettes | Commons, Openverse | |
| 🐉 Creature Inspiration | chameleon, beetle macro, octopus | Commons, Openverse | |

Art Studies (public-domain paintings) is deferred. Museum collections are where art nudes live, and v0.1 drops artworks on purpose.

**Blocked content (all categories, not configurable):**
- nudity, partial nudity or art nudes
- sexual or suggestive content and swimwear or underwear focus
- gore, injury and dead animals
- graphic violence and modern firearms
- drugs, alcohol and tobacco
- horror
- hate symbols

---

## 4. Functional requirements

### 4.1 Start a session
- **FR-1** A focused prompt box with Enter-to-start MUST be the first thing on the page.
- **FR-2** Category tiles MUST start a session in one click.
- **FR-3** The last-used session settings MUST be remembered, so a returning user just types and presses Enter.
- **FR-4** Recent prompts SHOULD be shown as one-click "Again" chips.
- **FR-5** A deep link `/?draw=<subject>` MUST start a session immediately.

### 4.2 Timed session settings (artist-configurable)

| ID | Setting | Values (default **bold**) |
|---|---|---|
| T-1 | **Rounds** | Up to 10 rounds of *count × duration*. Durations: 15s, 30s, 45s, 1m, 90s, **2m**, 3m, 5m, 10m, 15m, 20m, 30m, 45m, 60m, untimed. Count 1–50 (**10**). |
| T-2 | **Presets** | Warm-up 10×30s · **Quick sketch 10×2m** · Gesture class 10×30s → 5×1m → 3×2m → 2×5m · Kids' sketch 6×3m (5s get-ready) · Study 4×5m · Long study 1×20m · Memory 6×2m (20s look) · Untimed 10× |
| T-3 | Get-ready countdown | 0, **3**, 5, 10 s |
| T-4 | When time's up | **Auto-advance** / wait for Next |
| T-5 | Breaks | **Off** / every 5, 10 or 15 images; length 30s, **1m**, 2m, 5m; skippable |
| T-6 | Memory drawing | **Off** / show for 10, 20, 30 or 60 s, then hide (with Peek) |
| T-7 | Orientation | **Any**, landscape, portrait, square |
| T-8 | Shuffle | **On** |
| T-9 | Avoid recently drawn images | **On** (recent images used only as a last resort) |
| T-10 | Mirror | **Off**, always, random per image |
| T-11 | Grayscale | **Off** |
| T-12 | Value study (posterize) | **Off**, 2–5 tones |
| T-13 | Grid overlay | **Off**, 2×2, 3×3, 4×4 |
| T-14 | Timer display | **Large**, small, hidden |
| T-15 | Sounds | **On**: chime on new image, beeps for the last 0/**3**/5/10 s, volume |

### 4.3 During a session
- **FR-6** Keyboard and on-screen controls: pause, next, previous, +30s, mirror, grayscale, value study, grid, hide image, fullscreen, end.
- **FR-7** Controls and cursor auto-hide after 2.5 s idle.
- **FR-8** The clock MUST NOT run until the current image is actually on screen.
- **FR-9** Broken image links MUST be replaced automatically.
- **FR-10** Attribution MUST be visible for the current image.
- **FR-11** **Hide forever (X)** adds the image to the family's hidden list and swaps in a new one.
- **FR-12** The end-of-session summary shows the images drawn, with credits, plus "Again with new pictures" and "Same pictures again".
- **FR-12a** **Save (S / ☆)** adds the current image to the profile's *My pictures*. Thumbnails in the summary can be saved too.
- **FR-12b** **Thumbs up (L / 👍)** marks a picture as a good reference. One per family (signed in only); the count is public and shown on the button. Search pages look up counts (waiting at most 400 ms), and a liked picture that passes the safety check is placed right after the picture on screen, most liked first. Counts never bypass the safety check.

### 4.3a Accounts
- **AC-1** Accounts are optional. A guest can do everything except save pictures and give thumbs-ups; settings, presets, history and hidden pictures live in the tab's memory only, and move into the account if the guest signs up. A grown-up creates one **family account** with email + password (≥ 8 characters). Kids are profiles inside it and never need an email address.
- **AC-2** Account passwords are hashed on the server with scrypt (N=2¹⁷, r=8, p=1, 16-byte salt). Built into Node, no native add-ons, so it runs in Docker and Lambda alike.
- **AC-3** The login is a random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, valid for 30 days. Only its SHA-256 is stored, and it expires automatically via DynamoDB TTL.
- **AC-4** CSRF: every non-GET request MUST carry `X-Requested-With: draw-with-dad`. The API never enables CORS, so other sites can't send it.
- **AC-5** Rate limits: sign-in 10 per email per 15 min, profile unlock 10 per profile per 15 min, reset emails 3 per email per hour, sign-up 5 per email per hour. Unknown emails take the same time to reject as wrong passwords.
- **AC-6** Password reset: a one-time token emailed as `APP_URL/?reset=…`, valid 60 min. Using it signs out every other device. The "forgot" endpoint answers the same whether or not the email exists. Email goes via Amazon SES on AWS, and to the server log locally.
- **AC-7** Deleting the account (password required) deletes every record for the family.
- **AC-8** Nothing is stored in browser storage (no localStorage, sessionStorage or IndexedDB). The only client-side state is the httpOnly cookie and an in-memory search cache.

### 4.3b Profiles
- **PR-1** A profile has a name, an emoji avatar and an accent color. It owns its settings, its saved presets ("My presets"), saved pictures ("My pictures") and drawing history.
- **PR-2** The last-used profile (stored on the account) opens automatically after sign-in, unless it has a password that this login session hasn't unlocked. In that case "Who's drawing?" is shown first, and a `?draw=` deep link continues afterwards. Switching is one click from the home screen.
- **PR-3** New profiles start from default settings. Up to 12 profiles per account, 12 presets per profile, 500 saved pictures per profile.
- **PR-4** Optional profile passwords (≥ 4 characters), scrypt-hashed and **enforced by the API**: a locked profile's data and settings return `423 Locked` until it's unlocked in the current login session. One profile is unlocked at a time; switching or Lock re-locks it. Changing or removing a profile password needs the current one. The hash never leaves the server.
- **PR-5** Saved pictures arrive from the browser, so the server validates them (https URLs, known sources, size caps), and the browser safety-checks them again every time they're displayed. A stricter future check therefore applies to old saves too.
- **PR-6** Hiding an image (X) hides it for **the whole family**. A profile can un-hide only what it hid. Deleting a profile removes its saves and history but keeps its hidden images hidden.
- **PR-7** Sessions drawn from a fixed set (My pictures, "Same pictures again") are trimmed to the number of pictures available.

### 4.4 Smart search with Ollama (optional)
- **FR-13** Off by default. When on, a local model rewrites free-text prompts into 3–5 related searches. These join the session **after** it has started.
- **FR-14** Model output is untrusted. It MUST be schema-validated, length-capped and run through the word filter.
- **FR-15** If the model flags a prompt as not kid-appropriate, the session ends with a friendly message.
- **FR-16** The settings panel MUST show Ollama's status and setup hints, including `OLLAMA_ORIGINS` for deployed copies.

### 4.5 AI-generated references (planned, v0.3)
- These MUST live in a separate tab, be off by default, and carry an **"AI-generated"** badge.
- Pluggable backends: Ollama image models (where supported), ComfyUI, AUTOMATIC1111/Forge, stable-diffusion.cpp. All are local and reached over HTTP from the browser.
- They go through the same prompt filter and the same image classifier, with a fixed safe negative prompt.

---

## 5. Safety requirements

Safety is layered and **fails closed**. It runs entirely in the browser.

| Layer | What | Status |
|---|---|---|
| L1 Prompt filter | Whole-word matching after normalization (leetspeak, spaced-out letters, stretched letters). Figure-drawing terms are **redirected** to clothed People & Poses. | ✅ |
| L2 Source safe-search | Openverse `mature=false` plus dropping its `sensitivity`-flagged results; Commons `filetype:bitmap` | ✅ |
| L3 Commons guards | Drops anything categorized as painting, sculpture, artwork or nude. Word-filters title, description and categories. Strict thresholds. Excluded from people prompts and categories. | ✅ |
| L4 Metadata filter | Title and tags go through the prompt list plus metadata-only words (dead, hunting, swimwear, injury…) | ✅ |
| L5 Image classifier | NSFWJS MobileNetV2-mid runs in-browser on **every** thumbnail. Reject at Porn/Hentai ≥ 0.10 or Sexy ≥ 0.20, or ≥ 0.05 / 0.10 when strict. | ✅ |
| L6 Ollama intent check | Optional | ✅ |
| L7 Family hide list | Stored on the server, shared by all profiles in the account. Each profile can clear only what it hid. | ✅ |

- **SR-1** No image may be displayed unless its thumbnail was classified as safe. If the model fails to load, the session shows an error instead of images.
- **SR-2** Unreadable images (no CORS, timeout) MUST be treated as unsafe. Every source MUST provide a CORS-enabled thumbnail.
- **SR-3** Verdicts are cached with a `SAFETY_VERSION`. Changing thresholds or the model MUST bump it so images are re-checked. Transient failures are never cached.
- **SR-4** The hide list is **per family**. There is no shared or community blocklist.
- **SR-5** Docs MUST say that filtering is very good but not perfect, and explain how to report a miss without attaching the image.
- **SR-6** Known gap: the classifier targets sexual content; it doesn't detect gore. Gore is handled by L1–L4 and source selection. A gore/violence image model is a v0.2 candidate.

---

## 6. Image sources

| Source | Key | Speed | Default | Notes |
|---|---|---|---|---|
| **Wikimedia Commons** | none | ~1 s | on (not for people) | Usually serves the first image. Its safe-search is our own L3 layer. |
| **Openverse** | none | 3–10 s | on | Anonymous limits: 20 req/min, 200/day per user IP (fine, because requests come from each user's browser) |
| **NASA Image Library** | none | ~0.5 s | space/vehicle prompts | Public domain |
| Pexels / Pixabay / Unsplash | free key | fast | v0.2, bring your own key | Keys stay in the user's browser storage, never in the deployed bundle |
| iNaturalist | none | ~0.2 s | v0.2 candidate | Wildlife and plants; would need dead-animal annotation filtering |

- **SRC-1** Sources are queried in parallel. A slow or failing source MUST NOT block others.
- **SRC-2** Search pages and safety verdicts are cached in memory in the tab (1 h), never in browser storage or on the server.
- **SRC-3** On a 429 (rate-limited), the session continues with other sources and says so if it runs out.

---

## 7. Data storage

**One DynamoDB table** (on-demand), accessed only by the API (`server/repo.ts`). Locally it's DynamoDB Local in Docker, so the same code and queries run everywhere.

| PK | SK | Contents |
|---|---|---|
| `EMAIL#<email>` | `EMAIL` | Login: account id, password hash |
| `ACCT#<id>` | `ACCOUNT` | Email, created, last profile, `sessionsValidAfter` |
| `ACCT#<id>` | `PROFILE#<pid>` | Name, avatar, color, settings, presets, optional `lockHash` |
| `ACCT#<id>` | `FAV#<pid>#<imageId>` | A saved picture: the image **reference** (URLs, title, creator, license), never bytes |
| `ACCT#<id>` | `HIST#<pid>#<startedAt>#<id>` | A finished session: prompt, rounds, image ids |
| `ACCT#<id>` | `HIDDEN#<imageId>` | Hidden for the family, plus which profile hid it |
| `ACCT#<id>` | `LIKE#<imageId>` | This family's thumbs-up (one per family) |
| `LIKES#<imageId>` | `LIKES` | Public thumbs-up count, kept in step with `LIKE#` items in one transaction |
| `AUTH#<sha256>` | `AUTH` | Login session: account, unlocked profiles (TTL 30 days) |
| `RESET#<sha256>` | `RESET` | Password-reset token (TTL 60 min, deleted on use) |
| `RATE#<key>` | `RATE` | Rate-limit counter (TTL = window) |

- **DB-1** A family's records share one partition key, so loading a family is one Query and account deletion is exact. Partitions are small (≤ 12 profiles × 500 pictures), well under DynamoDB limits.
- **DB-2** On AWS: encryption at rest, point-in-time recovery, TTL for sessions, tokens and counters, and `DeletionPolicy: Retain` so deleting the stack can't wipe accounts.
- **DB-3** Search results and safety verdicts are **not** stored on the server. They're cached in memory in the tab (1 h TTL). That keeps the server's work to what users choose to save.

---

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 Footprint | App shell ≤ 50 KB gzipped (now ~22 KB). Safety model + TF.js ~4.3 MB, lazy-loaded and cached by the browser. |
| NFR-2 Speed | See §0. Enter → drawing ≤ 10 s on broadband, including the countdown. |
| NFR-3 Hosting | Three targets, same code: **dev** (Vite serves the app and runs the API in-process, with DynamoDB Local); **Docker Compose** (nginx `web` + Node `api` + DynamoDB Local, with tests run during the image build, non-root and read-only containers); **AWS** (S3 + CloudFront for the app; `/api/*` → API Gateway HTTP API → Lambda (Node 22, arm64) → DynamoDB, on one domain). `deploy:aws` is idempotent: it creates or updates the stack. `destroy:aws` removes it and asks separately before deleting data. |
| NFR-3a Scale | Serverless and pay-per-request on AWS: no idle cost, scales automatically. Search and the safety model run on each user's device, so the server only handles account and saved-data requests. |
| NFR-4 Platforms | Current Chrome, Edge, Firefox and Safari on desktop and tablet. WebGL is preferred; TF.js falls back to CPU. |
| NFR-5 Privacy | No analytics, ads or tracking cookies. The only cookie is the login. The server stores the email, hashed passwords, profiles, saved image references, drawing history and thumbs-ups (public as counts only), and nothing else. Guests store nothing on the server. Accounts can be deleted completely. Search queries go from the browser straight to the image APIs, never through our server. |
| NFR-6 Accessibility | Keyboard-first, visible focus, ARIA live status, light and dark themes, reduced-motion support |
| NFR-7 Supply chain | Exact-pinned dependencies, at least two weeks old when adopted. Browser: nsfwjs, TF.js, `buffer`. Server: Hono (+ Node adapter), AWS SDK v3 (DynamoDB, SES). Container base images pinned to exact versions. |

---

## 9. Milestones

| Version | Scope | Status |
|---|---|---|
| **v0.1** | Prompt + 15 categories · Commons, Openverse, NASA · L1–L7 safety · timed sessions with all §4.2 settings · study aids · IndexedDB references · prefetch · Ollama query expansion · AWS deploy | ✅ done |
| **v0.1.1** | Profiles · My pictures · My presets (§4.3a) | ✅ done |
| v0.2.x | Bring-your-own-key Pexels/Pixabay · iNaturalist · gore classifier | |
| v0.3 | AI-generated references tab (§4.5) | |
| **v0.1.2** | Docker image · one-command AWS deploy/destroy | ✅ done |
| **v0.2** | Family accounts (§4.3a) · server-side storage in DynamoDB · server-enforced profile passwords · password reset · account deletion · Lambda + HTTP API · three-container Docker stack | ✅ done |
| v0.4 | Parent role (only the account owner can un-hide or delete profiles) · custom domain automation · optional TOTP for the account | |
| v1.0 | i18n · accessibility audit · docs site | |

---

## 10. Project and community

- **License:** MIT.
- **Repo:** README quick start, CONTRIBUTING (how to add a source), CODE_OF_CONDUCT, SECURITY (including safety-filter misses), issue templates.
- **CI:** typecheck, unit tests (no live network), API tests against DynamoDB Local, build, `docker compose build`.
- **Source PR checklist:** safe-search parameters, CORS-readable thumbnail, attribution fields, rate limits, and whether it's safe for people categories.

---

## 11. Open questions

1. **Wikimedia Commons on by default.** It's what makes the 30-second target reliable, because Openverse alone takes 3–10 s per search. It has no safe-search of its own, so it relies on our guards (L3–L5) and stays off for people prompts. Keep it on by default, or make it opt-in?
2. **Weapons.** The current filter allows historical armor and swords, and blocks modern firearms. Is that the right line?
3. **Openverse registration.** Registering an app raises rate limits, but the key would ship in a public bundle. Stay anonymous (current) or proxy searches through the API? A proxy would put every user behind one rate limit and add server cost.
4. **Guest mode.** Drawing currently requires an account (decided for v0.2). If first-visit friction becomes a problem, a "try it without saving" mode could come back.
5. **Child privacy (COPPA/GDPR-K).** Accounts are created by adults and kids have no email or personal data beyond a first name. Before a public launch, get a privacy policy reviewed.
