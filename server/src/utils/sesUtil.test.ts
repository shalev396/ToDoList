/**
 * The Mailer seam: SES on a stage (SesMailer, which sends one SendEmailCommand from
 * noreply@{DOMAIN_NAME}), the mailer a test installs otherwise; sendEmail asks stageMailer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SESClient } from '@aws-sdk/client-ses';
import { RecordingMailer } from '../testing/recordingMailer.js';
import { SesMailer, sendEmail, setMailerForTests, stageMailer } from './sesUtil.js';

const EMAIL = { to: 'a@example.test', subject: 'Hi', htmlBody: '<b>Hi</b>', textBody: 'Hi' };

describe('the Mailer seam', () => {
  it('SesMailer sends one email from noreply@ the stage domain', async () => {
    process.env.DOMAIN_NAME = 'example.test';
    const sent: { name: string; input: unknown }[] = [];
    const client = {
      send: (command: { input: unknown }): Promise<unknown> => {
        sent.push({ name: command.constructor.name, input: command.input });
        return Promise.resolve({});
      },
    } as unknown as SESClient;
    await new SesMailer(client).send(EMAIL);
    assert.deepEqual(sent, [
      {
        name: 'SendEmailCommand',
        input: {
          Source: 'noreply@example.test',
          Destination: { ToAddresses: ['a@example.test'] },
          Message: {
            Subject: { Data: 'Hi', Charset: 'UTF-8' },
            Body: {
              Html: { Data: '<b>Hi</b>', Charset: 'UTF-8' },
              Text: { Data: 'Hi', Charset: 'UTF-8' },
            },
          },
        },
      },
    ]);
  });

  it('sendEmail goes to the mailer a test installs, and SES again once it is removed', async () => {
    const mailer = new RecordingMailer();
    setMailerForTests(mailer);
    try {
      assert.equal(stageMailer(), mailer);
      await sendEmail(EMAIL);
      assert.deepEqual(mailer.sent, [EMAIL]);
    } finally {
      setMailerForTests(null);
    }
    assert.ok(stageMailer() instanceof SesMailer);
  });
});
