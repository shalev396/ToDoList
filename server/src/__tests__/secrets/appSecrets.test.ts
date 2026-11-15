/**
 * App secrets never leak (services/appSecrets.ts, part of the secret-leak suite in `npm run test:unit`).
 *
 * Every way a read can go (Secrets Manager stubbed on the SDK client: no AWS call), with FAKE
 * values that each failure tries to smuggle out: an SDK error quoting the value in its message,
 * cause and response; a parse error quoting the payload; a value of the wrong shape; a value
 * passed where a name belongs; a value in the stage's environment (never read). Nothing written
 * to stdout or stderr, and no error (message, stack, cause, properties, util.inspect, JSON), may
 * hold a value. Reports name a scenario, never a value.
 */
import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import {
  getAppSecret,
  resetAppSecretsForTests,
  type AppSecretName,
} from '../../services/appSecrets.js';
import { GOOGLE_CALENDAR_OAUTH } from '../../classes/integration/definitions/googleCalendar.js';
import { logger } from '../../services/logger.js';
import { findSecrets } from '../../services/secretPatterns.js';

/** Google Calendar's OAuth app credentials, as its strategy reads them. */
const googleOAuthCredentials = (): ReturnType<typeof GOOGLE_CALENDAR_OAUTH.credentials> =>
  GOOGLE_CALENDAR_OAUTH.credentials();

// ─── capture of stdout and stderr (the logger, console, the SDK) ─────────────────────────────────

let captured = '';
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);

function tee(original: typeof process.stdout.write): typeof process.stdout.write {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') captured += chunk;
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
}

// ─── FAKE values, unique per run, built at run time ──────────────────────────────────────────────

/** A canary and 32 random hex characters: any 6 of them in a row are this value's and no other text's. */
const fake = (): string => `FAKE${randomBytes(16).toString('hex')}`;

const VALUES = {
  clientId: fake(),
  clientSecret: fake(),
  apiKey: fake(),
  envSecret: fake(),
  sdkEcho: fake(),
} as const;

/**
 * A value counts as leaked when any 6 characters of it in a row show up, not only the whole of it:
 * a JSON parse error quotes about ten characters around where it failed (`"FAKE3f9a1c"...`).
 */
const FRAGMENT = 6;

function leakedKinds(text: string): string[] {
  return Object.entries(VALUES)
    .filter(([, value]) => {
      for (let start = 0; start + FRAGMENT <= value.length; start += 1) {
        if (text.includes(value.slice(start, start + FRAGMENT))) return true;
      }
      return false;
    })
    .map(([kind]) => kind);
}

/** Every way an error could be shown: by a log line, a response, a crash report, a debugger. */
function renderings(error: unknown): string[] {
  const own = error instanceof Error ? Object.getOwnPropertyNames(error) : [];
  return [
    String(error),
    error instanceof Error ? (error.stack ?? '') : '',
    inspect(error, { depth: 8, showHidden: true }),
    JSON.stringify(error),
    JSON.stringify(own.map((key) => [key, String((error as Record<string, unknown>)[key])])),
  ];
}

let assertions = 0;

function assertLeakFree(scenario: string, error: unknown): void {
  assert.ok(error instanceof Error, `${scenario}: no error was thrown`);
  assert.equal(error.cause, undefined, `${scenario}: the error carries a cause`);
  const kinds = leakedKinds(renderings(error).join('\n'));
  assertions += Object.keys(VALUES).length;
  assert.deepEqual(kinds, [], `${scenario}: the error holds part of a value (${kinds.join(', ')})`);
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

type Answer = () => Promise<{ SecretString?: string }>;

function stubSecretsManager(answer: Answer): void {
  mock.method(SecretsManagerClient.prototype, 'send', answer);
}

/** What an SDK error can look like when it echoes what it handled: message, cause, response. */
function echoingSdkError(name: string): Error {
  const error = new Error(`${name}: request for ${VALUES.sdkEcho} failed near ${VALUES.apiKey}`, {
    cause: new Error(VALUES.clientSecret),
  });
  error.name = name;
  Object.assign(error, {
    $response: { body: VALUES.apiKey, headers: { 'x-echo': VALUES.sdkEcho } },
    $metadata: { httpStatusCode: 400 },
    SecretString: VALUES.clientSecret,
  });
  return error;
}

const savedEnv: Record<string, string | undefined> = { ...process.env };

function setStage(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('APP_SECRET') ||
      key.startsWith('GOOGLE_OAUTH_') ||
      key === 'OPENROUTER_API_KEY'
    ) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, env);
}

const DEV = { ENV: 'dev' };

before(() => {
  process.stdout.write = tee(originalStdout);
  process.stderr.write = tee(originalStderr);
});

afterEach(() => {
  mock.restoreAll();
  resetAppSecretsForTests();
});

after(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, savedEnv);
  originalStdout(`app-secret leak suite: ${String(assertions)} value checks\n`);
});

// ─── the tests ───────────────────────────────────────────────────────────────────────────────────

describe('app secrets: no value in an error', () => {
  it('Secrets Manager fails with an SDK error that quotes the value', async () => {
    setStage(DEV);
    for (const name of [
      'AccessDeniedException',
      'ResourceNotFoundException',
      'DecryptionFailure',
      'ThrottlingException',
    ]) {
      mock.restoreAll();
      stubSecretsManager(() => Promise.reject(echoingSdkError(name)));
      assertLeakFree(`SDK ${name}`, await thrown(getAppSecret('openrouter')));
    }
    // An error whose whole message is the value.
    mock.restoreAll();
    stubSecretsManager(() => Promise.reject(new Error(VALUES.apiKey)));
    assertLeakFree('SDK message is the value', await thrown(getAppSecret('openrouter')));
  });

  it('the payload is not JSON, and the parse error would quote it', async () => {
    setStage(DEV);
    for (const [scenario, text] of [
      ['an unquoted value', `{"JIRA_CLIENT_ID": ${VALUES.clientId}, "JIRA_CLIENT_SECRET": "x"}`],
      ['a bare value', VALUES.clientSecret],
      [
        'a cut-off object',
        `{"JIRA_CLIENT_ID":"${VALUES.clientId}","JIRA_CLIENT_SECRET":"${VALUES.clientSecret}`,
      ],
      ['a trailing comma', `{"JIRA_CLIENT_ID":"${VALUES.clientId}",}`],
    ] as const) {
      mock.restoreAll();
      stubSecretsManager(() => Promise.resolve({ SecretString: text }));
      assertLeakFree(`payload: ${scenario}`, await thrown(getAppSecret('oauth-jira')));
    }
  });

  it('the payload is JSON of the wrong shape around a real-looking value', async () => {
    setStage(DEV);
    for (const [scenario, value] of [
      ['secret missing', { CLICKUP_CLIENT_ID: VALUES.clientId }],
      [
        'secret not a string',
        { CLICKUP_CLIENT_ID: VALUES.clientId, CLICKUP_CLIENT_SECRET: [VALUES.clientSecret] },
      ],
      ['secret empty', { CLICKUP_CLIENT_ID: VALUES.clientId, CLICKUP_CLIENT_SECRET: '' }],
      [
        'id not a string',
        { CLICKUP_CLIENT_ID: { v: VALUES.clientId }, CLICKUP_CLIENT_SECRET: 'x' },
      ],
      ['an array of values', [VALUES.clientId, VALUES.clientSecret]],
      ['a JSON string', VALUES.clientSecret],
    ] as const) {
      mock.restoreAll();
      stubSecretsManager(() => Promise.resolve({ SecretString: JSON.stringify(value) }));
      assertLeakFree(`shape: ${scenario}`, await thrown(getAppSecret('oauth-clickup')));
    }
  });

  it('a value passed where a name belongs is not echoed', async () => {
    setStage(DEV);
    stubSecretsManager(() => Promise.reject(new Error('never asked')));
    assertLeakFree('value as a name', await thrown(getAppSecret(VALUES.apiKey as AppSecretName)));
  });

  it('a value in the stage environment is never read: Secrets Manager is all the read sees', async () => {
    for (const stage of ['dev', 'qa', 'prod']) {
      setStage({
        ENV: stage,
        APP_SECRET_OPENROUTER: JSON.stringify({ apiKey: VALUES.envSecret }),
        GOOGLE_OAUTH_CLIENT_ID: VALUES.clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: VALUES.envSecret,
        OPENROUTER_API_KEY: VALUES.envSecret,
      });
      mock.restoreAll();
      stubSecretsManager(() => Promise.reject(echoingSdkError('AccessDeniedException')));
      assertLeakFree(
        `${stage}: read with a value in the env`,
        await thrown(getAppSecret('openrouter')),
      );
    }
  });

  it('the call site: googleOAuthCredentials fails generically', async () => {
    setStage(DEV);
    stubSecretsManager(() => Promise.reject(echoingSdkError('AccessDeniedException')));
    assertLeakFree('googleOAuthCredentials: unreadable', await thrown(googleOAuthCredentials()));
    mock.restoreAll();
    stubSecretsManager(() =>
      Promise.resolve({
        SecretString: `{"GOOGLE_CALENDAR_CLIENT_ID":"${VALUES.clientId}","GOOGLE_CALENDAR_CLIENT_SECRET":`,
      }),
    );
    assertLeakFree('googleOAuthCredentials: malformed', await thrown(googleOAuthCredentials()));
  });
});

describe('app secrets: no value in a log line', () => {
  it('a successful read logs nothing of the value, and an error logged by the app neither', async () => {
    setStage(DEV);
    stubSecretsManager(() =>
      Promise.resolve({
        SecretString: JSON.stringify({
          GOOGLE_CALENDAR_CLIENT_ID: VALUES.clientId,
          GOOGLE_CALENDAR_CLIENT_SECRET: VALUES.clientSecret,
          OPENROUTER_API_KEY: VALUES.apiKey,
        }),
      }),
    );
    const secret = await getAppSecret<{ clientSecret: string }>('google-calendar-oauth');
    assert.equal(secret.clientSecret, VALUES.clientSecret);
    // What the error handler does with an unexpected error: it logs it (redacted).
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(() => Promise.reject(echoingSdkError('AccessDeniedException')));
    logger.error('GET /api/private/x failed', await thrown(getAppSecret('google-calendar-oauth')));
  });

  it('nothing written to stdout or stderr holds a value or a secret shape', async () => {
    // Let anything still pending write what it is going to write.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      captured.includes('App secret'),
      'the failures above logged nothing: is the capture broken?',
    );
    const kinds = leakedKinds(captured);
    assertions += Object.keys(VALUES).length;
    assert.deepEqual(kinds, [], `the logs hold part of a value (${kinds.join(', ')})`);
    const hits = findSecrets(captured).map((hit) => hit.kind);
    assert.deepEqual(hits, [], `the logs hold secret shapes: ${[...new Set(hits)].join(', ')}`);
  });
});
