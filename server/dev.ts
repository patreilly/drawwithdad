import { appFromEnv } from "./config";

/** Loaded by the Vite dev server (see vite.config.ts), so `npm run dev` serves the app and the API together. */
process.env.DYNAMODB_ENDPOINT ||= "http://localhost:8000";
process.env.APP_URL ||= "http://localhost:5173";

const { app, repo } = appFromEnv();
export const ready = repo.ensureTable();
export default app;
