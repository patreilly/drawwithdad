# ✏️ Draw with Dad

Type what you want to draw, press Enter, and you're drawing from a timed reference photo within seconds.

- **Kid-safe by design.** Every image is safety-checked on your device before it's shown, and there's no way to turn that off.
- **One family account, no tracking, no API keys.** A grown-up signs up with email and password, and everything is saved on the server, so it follows you to any device. Images come from openly licensed libraries (Wikimedia Commons, Openverse, NASA) with credit shown for each one.
- **Built for practice.** Gesture timers, progressive "class" sessions, breaks, memory drawing, mirror, grayscale, value studies and a grid.
- **Profiles for the whole family.** Everyone gets their own settings, presets, saved pictures and history, with an emoji, a color and an optional profile password. Kids never need an email address.
- **Smart search (optional).** A local [Ollama](https://ollama.com) turns "dragon" into "bat wing", "lizard scales", "crocodile head"…

## Run it

Draw with Dad has three parts, and the same code runs in all three places:

- **The web app** (TypeScript, Vite) does the searching and safety checks in the browser.
- **A small API** (TypeScript, [Hono](https://hono.dev)) handles accounts and saved data.
- **[DynamoDB](https://aws.amazon.com/dynamodb/)** stores everything. Locally it's the official [DynamoDB Local](https://hub.docker.com/r/amazon/dynamodb-local), so dev, Docker and AWS behave the same.

| Where | You need | Commands | Opens at |
|---|---|---|---|
| **Your computer (dev)** | [Node.js](https://nodejs.org) 22+ and [Docker](https://docs.docker.com/get-docker/) | `npm install` then `npm run dev` | http://localhost:5173 |
| **Docker** | Docker only | `docker compose up --build` | http://localhost:8080 |
| **AWS** | Node.js 22+ and a configured [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | `npm install` then `npm run deploy:aws` | prints your `https://….cloudfront.net` URL |

```bash
git clone <this repo> draw-with-dad && cd draw-with-dad
docker compose up --build        # or: npm install && npm run dev
```

Open the URL, create a family account, and start drawing. Add `?draw=horses` to go straight to drawing after sign-in.

**Password-reset emails:** locally there's no email server, so reset links are printed to the log. With `npm run dev` they appear in the terminal; with Docker, run `docker compose logs api`. On AWS they're sent with Amazon SES (see below).

### Dev details

`npm run dev` starts DynamoDB Local in Docker (`docker compose up -d dynamodb`) and runs the API inside Vite's dev server under `/api`, with hot reload for both. Data is kept in a Docker volume between runs. To start over, run `docker compose down -v`.

### Docker details

- **Three containers:**
  - `web`: unprivileged nginx serving the app and proxying `/api`.
  - `api`: Node, running a single bundled file without `node_modules`, as a non-root user.
  - `dynamodb`: DynamoDB Local, with data in a named volume.
- **Build:** the image build runs the tests.
- **Commands:** `PORT=3000 docker compose up --build` changes the port. Add `-d` to run it in the background. `docker compose down` stops it, and `docker compose down -v` also deletes the data.
- **Running it on a server:** use the same compose file behind your usual HTTPS proxy. Set `APP_URL` on the `api` service to your public URL so reset links point to it.

  For real use, prefer the AWS setup, which uses the real DynamoDB. DynamoDB Local is a development tool, not a production database.

### AWS details

`npm run deploy:aws` does everything:

1. Checks that the AWS CLI works and has credentials.
2. Runs the tests and builds the app and the API.
3. Uploads the API code.
4. Creates the stack the first time, or updates it after that.
5. Uploads the app and clears the CDN cache.

The first run takes about 5 minutes, mostly CloudFront. Later runs take about a minute.

```
browser ──▶ CloudFront ──┬── /*      ──▶ S3 (private; the app)
                         └── /api/*  ──▶ API Gateway (HTTP API) ──▶ Lambda ──▶ DynamoDB
```

- **What it creates** (`deploy/cloudformation.yaml`):
  - **App:** a private, encrypted S3 bucket that only CloudFront can read.
  - **API:** a Lambda function (Node 22, arm64) behind an HTTP API. It's served under `/api` on the **same CloudFront domain**, so the login cookie is first-party and no CORS is needed.
  - **Data:** one on-demand DynamoDB table with encryption, point-in-time recovery (35 days of backups) and automatic expiry for old login sessions. The table is **kept** if the stack is deleted, so a mistake can't wipe every account.
- **Scaling and cost:** nothing runs when nobody is using it. Lambda, the HTTP API and on-demand DynamoDB scale automatically from zero to thousands of requests per second, with no servers to manage. A family uses a few thousand requests a month, which costs cents. Image searching and safety checks run in each user's browser, so they add no server load.
- **Password-reset emails:** verify a sender address in [Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), then deploy with `MAIL_FROM=you@example.com npm run deploy:aws`. New SES accounts are in a "sandbox" and can only email verified addresses until you [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html). Without `MAIL_FROM`, reset links only go to the API's CloudWatch logs.
- **Options:**
  - `AWS_PROFILE=… AWS_REGION=…` picks the account and region.
  - `STACK=my-copy` deploys a second copy.
  - `APP_URL=https://draw.example.com` sets the public URL used in emails, if you put a custom domain in front.
  - `PRICE_CLASS=PriceClass_All` serves from every CloudFront edge location.
- **Remove it:** `npm run destroy:aws` asks you to confirm, then deletes the app, the API and the CDN. It asks separately before deleting the user data.
- **Setting up the AWS CLI:** install it (`brew install awscli` on macOS), then run `aws configure` (or `aws sso login`).
- **Custom domain:** not automated yet. Add an ACM certificate and an alias to the distribution, then deploy with `APP_URL=…`.

| Key | Action |
|---|---|
| Space | Pause / resume |
| → / N | Next image |
| ← | Previous image |
| A | Add 30 seconds |
| F | Mirror |
| G | Grayscale |
| V | Value study (cycles 2–5 tones) |
| R | Grid (cycles 2×2 to 4×4) |
| S | Save to My pictures (★) |
| X | Hide this image forever (for the whole family) |
| Esc | End session |

## Session settings

Pick a preset or open **Customize…**:

| Setting | Options |
|---|---|
| Rounds | Any mix of *count × duration*: 15s, 30s, 45s, 1m, 90s, 2m, 3m, 5m, 10m, 15m, 20m, 30m, 45m, 60m, or untimed |
| Presets | Warm-up (10 × 30s) · Quick sketch (10 × 2m) · Gesture class (10×30s → 5×1m → 3×2m → 2×5m) · Kids' sketch (6 × 3m) · Study (4 × 5m) · Long study (1 × 20m) · Memory (look 20s, draw 2m) · Untimed |
| Get-ready countdown | Off, 3s, 5s, 10s |
| When time's up | Auto-advance, or wait for Next |
| Breaks | Every 5/10/15 images, for 30s to 5m |
| Memory drawing | Show for 10–60s, then hide (with a Peek button) |
| Orientation | Any, landscape, portrait, square |
| Shuffle · Avoid recent repeats | On/off |
| Mirror | Off, always, random per image |
| Grayscale · Value study · Grid | Defaults that you can also toggle mid-session |
| Timer | Large, small, hidden |
| Sounds | Chime on new image, beeps in the last 3/5/10s, volume |

## Accounts and profiles

A grown-up creates one **family account** (email and password). Everyone draws under their own **profile** inside it. Kids never need an email address. You stay signed in for 30 days per device, and the last profile used opens automatically unless it has a password.

Click the avatar at the top right to switch, add or edit profiles, sign out or delete the account. Each profile keeps:

- **Settings:** every timing and study-aid choice.
- **My presets:** in **Customize… → My presets**, save the current setup under a name. It appears next to the built-in presets.
- **My pictures:** press ☆ (or S) while drawing, or on the summary screen. Open **★ My pictures** to browse them or draw from them.
- **History:** the "Again:" prompts on the home screen.

**Passwords (optional).** Set one under *Edit* on a profile.

- **Getting in:** a profile with a password asks for it whenever someone switches to it, and after each new sign-in. **🔒 Lock** in the profile menu locks it right away. Switching to another profile also locks it.
- **Enforced by the server:** the API refuses to read or change a locked profile's data until it's unlocked in that login session.
- **Editing:** changing or removing a profile password needs the current one.
- **Forgotten profile password:** the account owner can't see it, but can delete the profile.

Hiding an image (X) hides it for everyone in the family. Each profile can un-hide only what it hid.

### How sign-in is secured

- **Password storage:** account and profile passwords are hashed on the server with scrypt (N=2¹⁷, r=8, p=1, OWASP's recommended settings), each with a random salt. Passwords are never stored or logged.
- **The login cookie:** it's a random token in an `HttpOnly; Secure; SameSite=Lax` cookie that page scripts can't read. Only a hash of the token is stored, and it expires after 30 days.
- **Cross-site attacks (CSRF):** every change must carry a custom request header, which other sites can't send.
- **Guessing:** sign-in, profile unlock and password reset are rate-limited, and failed sign-ins take the same time whether or not the email exists.
- **Password reset:** reset links work once and expire after 60 minutes. Using one signs out every other device.
- **Deleting the account** removes every profile, saved picture and history entry.
- **Browser storage:** nothing is stored in the browser except the login cookie. Searches are cached in memory only for the open tab.

## How it works

```
prompt ─▶ word filter ─▶ search Commons + Openverse (+ NASA) in parallel, from the browser
       ─▶ per image: metadata word filter ─▶ NSFW image classifier (in-browser, strict)
       ─▶ first safe image starts the session; the rest load while you draw
```

- **Speed.** The search starts while you're still typing (or hovering a category tile). The safety model downloads in the background as the page loads. Sources are queried in parallel, so a slow one never holds up a fast one. Repeat subjects in the same tab come from an in-memory cache.
- **Why search runs in the browser and not on the server:** each user's searches count against the image libraries' rate limits separately (Openverse allows 200 a day per user), and the safety model runs on the user's device at no cost to us. The server only stores what people choose to keep.
- **Safety layers:**
  1. A prompt word filter. Figure-drawing terms are redirected to clothed poses.
  2. Each source's safe-search option.
  3. Commons only: photos only (no paintings or sculpture), plus category and description filtering.
  4. A metadata word filter.
  5. The [NSFWJS](https://github.com/infinitered/nsfwjs) image classifier on every thumbnail, with low thresholds. People prompts get stricter thresholds and skip Commons.
  6. A family-wide "hide forever" list.

  If the classifier can't load or can't read an image, the image isn't shown.
- **Data.** One DynamoDB table (`server/repo.ts` documents its layout). Each family's records share one partition key, so loading a family is one query and deleting an account removes everything. Saved pictures are *references* to online images (URL, attribution), never the image files. They're safety-checked again in the browser every time they're shown.

No filter is perfect. If you see something that shouldn't be there, press **X** to hide it, and please [open an issue](../../issues) describing the search (don't attach the image).

## Smart search with Ollama (optional)

```bash
ollama pull llama3.2:3b
ollama serve                                          # for the dev server on localhost
OLLAMA_ORIGINS=http://localhost:8080 ollama serve     # for the Docker copy
OLLAMA_ORIGINS=https://your-site ollama serve         # for a deployed copy
```

Your browser talks to Ollama directly, so it works the same whether the app is served by Vite, Docker or AWS. Ollama doesn't need to be in the container. Then turn it on under **Customize… → Smart search**. Ollama never delays the first image: its extra searches join the session when they're ready. If Ollama decides a prompt isn't kid-appropriate, the session ends.

## Development

```bash
npm test           # unit tests (no database needed)
npm run test:api   # API tests against DynamoDB Local (starts it in Docker)
npm run typecheck
npm run build      # dist/ (the app) and dist-server/ (the API, bundled for Node and Lambda)
```

| Folder | What |
|---|---|
| `src/` | The web app. Vanilla TypeScript + Vite, with no UI framework. `src/api/client.ts` talks to the API. |
| `server/` | The API. `app.ts` has the routes, `repo.ts` the DynamoDB access, `passwords.ts` the hashing. It runs from `node.ts` (Docker), `lambda.ts` (AWS) or `dev.ts` (inside Vite). |
| `deploy/` | CloudFormation template and nginx config |
| `scripts/` | `deploy.sh` and `destroy.sh` for AWS |

Shared rules, such as profile and settings validation, live in `src/` and are imported by the server, so the browser and the API validate the same way. To add an image source, implement `ImageSource` in `src/sources/` (see `types.ts` for the rules: strict safe-search, a CORS-readable thumbnail, attribution) and register it in `src/sources/index.ts`.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full requirements and roadmap.

## License

MIT. Images belong to their creators under the licenses shown with each one.
# drawwithdad
