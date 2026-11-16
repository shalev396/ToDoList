import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { environment } from '../config/environment.js';
import { assertUnderTest } from '../config/testSwitches.js';

const SES_FROM_USERNAME = 'noreply';

export interface SendEmailParams {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

/**
 * Where the app's email goes (dependency inversion, like KeyProvider and Transport): AWS SES on a
 * stage (SesMailer), a stand-in a test installs (setMailerForTests; testing/recordingMailer.ts
 * records every email and sends none). Callers send through `sendEmail`, which asks stageMailer.
 */
export interface Mailer {
  send(params: SendEmailParams): Promise<void>;
}

/**
 * The stage's mailer: AWS SES, from noreply@{DOMAIN_NAME} (read on each email). The domain must
 * be verified in the SES console. Making one never touches AWS; the first email does.
 */
export class SesMailer implements Mailer {
  readonly #client: SESClient;

  constructor(client: SESClient) {
    this.#client = client;
  }

  get #from(): string {
    return `${SES_FROM_USERNAME}@${environment.domainName}`;
  }

  async send(params: SendEmailParams): Promise<void> {
    await this.#client.send(
      new SendEmailCommand({
        Source: this.#from,
        Destination: {
          ToAddresses: [params.to],
        },
        Message: {
          Subject: { Data: params.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: params.htmlBody, Charset: 'UTF-8' },
            Text: { Data: params.textBody, Charset: 'UTF-8' },
          },
        },
      }),
    );
  }
}

const sesMailer = new SesMailer(new SESClient({ region: environment.awsRegion }));

let mailerForTests: Mailer | null = null;

/**
 * Tests only (node:test): every email goes to `mailer` instead of SES; null restores SES. It
 * throws in a server.
 */
export function setMailerForTests(mailer: Mailer | null): void {
  assertUnderTest('setMailerForTests');
  mailerForTests = mailer;
}

/** The mailer this stage sends through: the one a test installed, else SES. */
export function stageMailer(): Mailer {
  return mailerForTests ?? sesMailer;
}

/**
 * Sends an email through the stage's mailer (stageMailer: SES, from noreply@{DOMAIN_NAME}).
 *
 * @example
 * await sendEmail({
 *   to: 'user@example.com',
 *   subject: 'Hello',
 *   htmlBody: '<h1>Hi</h1>',
 *   textBody: 'Hi',
 * });
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  await stageMailer().send(params);
}

/** Escapes HTML special characters for safe embedding in email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
