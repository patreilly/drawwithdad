import { handle } from "hono/aws-lambda";
import { appFromEnv } from "./config";

/** AWS: API Gateway (HTTP API) → this Lambda. CloudFront routes /api/* here. */
export const handler = handle(appFromEnv().app);
