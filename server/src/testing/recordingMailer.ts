/**
 * Test-only: the Mailer a test process installs instead of SES (utils/sesUtil.ts,
 * setMailerForTests). Every email is recorded in order; none is ever sent.
 */
import type { Mailer, SendEmailParams } from '../utils/sesUtil.js';

export class RecordingMailer implements Mailer {
  /** Every email sent, in order. */
  readonly sent: SendEmailParams[] = [];

  send(params: SendEmailParams): Promise<void> {
    this.sent.push(params);
    return Promise.resolve();
  }
}
