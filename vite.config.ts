import { getRequestListener } from "@hono/node-server";
import { defineConfig, type Plugin } from "vite";

/** Serves the API from the dev server under /api, reloading it when server code changes. */
function devApi(): Plugin {
  return {
    name: "draw-with-dad-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/") && req.url !== "/api") return next();
        try {
          const mod = await server.ssrLoadModule("/server/dev.ts");
          await mod.ready;
          await getRequestListener(mod.default.fetch)(req, res);
        } catch (e) {
          server.config.logger.error(`API error: ${(e as Error).message}\nIs DynamoDB Local running? (docker compose up -d dynamodb)`);
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "The local API isn't ready. Is DynamoDB Local running? (docker compose up -d dynamodb)" }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  build: {
    target: "es2022",
    // The safety model ships as a few large lazy chunks; that's expected.
    chunkSizeWarningLimit: 7000,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
