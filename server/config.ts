import { createApp } from "./app";
import { ConsoleMailer, SesMailer } from "./mail";
import { Repo } from "./repo";

/**
 * Builds the API from environment variables:
 *   TABLE_NAME         DynamoDB table (default "draw-with-dad")
 *   DYNAMODB_ENDPOINT  DynamoDB Local URL for dev/Docker; unset on AWS
 *   APP_URL            public URL, for links in password-reset emails
 *   MAIL_FROM          a verified SES sender; unset = print emails to the log
 */
export function appFromEnv() {
  const repo = new Repo({ table: process.env.TABLE_NAME || "draw-with-dad", endpoint: process.env.DYNAMODB_ENDPOINT || undefined });
  const mailer = process.env.MAIL_FROM ? new SesMailer(process.env.MAIL_FROM) : new ConsoleMailer();
  return { repo, app: createApp({ repo, mailer, appUrl: process.env.APP_URL || undefined }) };
}
