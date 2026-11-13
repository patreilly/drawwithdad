import { serve } from "@hono/node-server";
import { appFromEnv } from "./config";

/** Local dev and Docker: a plain Node server talking to DynamoDB Local. */
const { app, repo } = appFromEnv();
const port = Number(process.env.PORT) || 8787;

async function start() {
  if (process.env.DYNAMODB_ENDPOINT) {
    // DynamoDB Local may still be starting up.
    for (let attempt = 1; ; attempt++) {
      try {
        await repo.ensureTable();
        break;
      } catch (e) {
        if (attempt >= 30) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`API listening on http://localhost:${port}/api`));
}

void start();
