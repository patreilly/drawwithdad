# Draw with Dad. Two images from one build:
#   web: the static app on an unprivileged nginx, which also proxies /api to the API
#   api: the Node API (bundled, no node_modules)
# Run everything with:  docker compose up --build   → http://localhost:8080

# glibc base (not alpine): Vite's and TypeScript's native binaries ship glibc builds.
FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

# The bundle is plain JavaScript, so the small alpine image is enough at runtime.
FROM node:24.11.0-alpine AS api
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/node.mjs"]

FROM nginxinc/nginx-unprivileged:1.28.0-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
