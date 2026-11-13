import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Local dev and Docker: emails (like password-reset links) are printed to the server log. */
export class ConsoleMailer implements Mailer {
  async send(to: string, subject: string, text: string): Promise<void> {
    console.log(`\n📧 Email to ${to}: ${subject}\n${text}\n`);
  }
}

/** AWS: sends through Amazon SES. `from` must be a verified SES identity. */
export class SesMailer implements Mailer {
  private readonly ses = new SESv2Client({});
  constructor(private readonly from: string) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
  }
}
