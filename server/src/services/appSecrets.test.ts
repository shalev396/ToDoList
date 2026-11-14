/**
 * App secrets (services/appSecrets.ts): the allow-list; the Secrets Manager read, by name under the
 * stage's prefix, kept for an hour and read again after; that the environment is never read; and
 * the test seam (setAppSecretsForTests). Secrets Manager is a stub on the SDK client, so no AWS
 * call is made. Every value is FAKE.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { appSecretsPrefix, STAGES } from '../../infra/lib/constants.js';
import {
  APP_SECRET_TTL_MS,
  APP_SECRETS,
  AppSecretError,
  getAppSecret,
  isAppSecretName,
  resetAppSecretsForTests,
  setAppSecretsForTests,
  type AppSecretFailure,
  type AppSecretName,
} from './appSecrets.js';
import { googleOAuthCredentials } from './googleOAuthClient.js';

const NAMES: AppSecretName[] = [
  'google-calendar-oauth',
  'oauth-clickup',
  'oauth-github',
  'oauth-jira',
  'oauth-linear',
  'openrouter',
];
const FAKE_KEY = 'FAKE-openrouter-key-0123456789';
const FAKE_GOOGLE = { clientId: 'FAKE-id.apps.example', clientSecret: 'FAKE-google-secret-0123' };
const START = 1_700_000_000_000;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  resetAppSecretsForTests();
});

afterEach(() => {
  setAppSecretsForTests(null);
  mock.restoreAll();
  mock.timers.reset();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, savedEnv);
});

function onStage(stage: (typeof STAGES)[number]): void {
  Object.assign(process.env, { ENV: stage });
}

type Answer = (secretId: string) => Promise<{ SecretString?: string }>;

/** Stubs GetSecretValue on the SDK client; returns the SecretIds asked for, in order. */
function stubSecretsManager(answer: Answer): string[] {
  const asked: string[] = [];
  mock.method(SecretsManagerClient.prototype, 'send', (command: unknown) => {
    assert.ok(command instanceof GetSecretValueCommand, 'only GetSecretValue is sent');
    const secretId = command.input.SecretId ?? '';
    asked.push(secretId);
    return answer(secretId);
  });
  return asked;
}

const answers =
  (...texts: (string | undefined)[]): Answer =>
  () => {
    const text = texts.length > 1 ? texts.shift() : texts[0];
    return Promise.resolve(text === undefined ? {} : { SecretString: text });
  };

function sdkError(name: string): Error {
  const error = new Error(`Secrets Manager says ${name}`);
  error.name = name;
  return error;
}

async function failure(promise: Promise<unknown>): Promise<AppSecretError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppSecretError, `not an AppSecretError: ${String(error)}`);
    return error;
  }
  assert.fail('expected an AppSecretError');
}

async function reasonOf(promise: Promise<unknown>): Promise<AppSecretFailure> {
  return (await failure(promise)).reason;
}

const openrouterJson = (apiKey: string): string => JSON.stringify({ apiKey });

describe('the allow-list', () => {
  it('holds exactly the six app secrets, each a plain Secrets Manager name', () => {
    assert.deepEqual(Object.keys(APP_SECRETS).sort(), NAMES);
    for (const name of NAMES) {
      assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(APP_SECRETS[name].length > 0, `${name} names no field`);
      for (const stage of STAGES) {
        assert.equal(`${appSecretsPrefix(stage)}${name}`, `todolist/${stage}/${name}`);
      }
    }
    assert.deepEqual(APP_SECRETS['google-calendar-oauth'], ['clientId', 'clientSecret']);
    assert.deepEqual(APP_SECRETS.openrouter, ['apiKey']);
  });

  it('knows its own names and nothing inherited', () => {
    for (const name of NAMES) assert.ok(isAppSecretName(name));
    for (const other of ['', 'nope', 'OPENROUTER', 'oauth/github', '__proto__', 'toString', 7]) {
      assert.ok(!isAppSecretName(other), String(other));
    }
  });

  it('refuses any other name on every stage, without a read and without echoing it', async () => {
    const asked = stubSecretsManager(answers(openrouterJson(FAKE_KEY)));
    const unlisted = 'todolist-unlisted-name';
    for (const stage of STAGES) {
      onStage(stage);
      const error = await failure(getAppSecret(unlisted as AppSecretName));
      assert.equal(error.reason, 'unknown');
      assert.ok(!error.message.includes(unlisted), error.message);
    }
    assert.deepEqual(asked, []);
  });
});

describe('Secrets Manager (deployed stages)', () => {
  for (const stage of STAGES) {
    it(`ENV=${stage} reads todolist/${stage}/<name> by name, with GetSecretValue`, async () => {
      onStage(stage);
      const asked = stubSecretsManager(answers(openrouterJson(FAKE_KEY)));
      const secret = await getAppSecret<{ apiKey: string }>('openrouter');
      assert.equal(secret.apiKey, FAKE_KEY);
      assert.ok(Object.isFrozen(secret));
      assert.deepEqual(asked, [`todolist/${stage}/openrouter`]);
    });
  }

  it('reads each secret once for the hour, however many calls, concurrent ones included', async () => {
    mock.timers.enable({ apis: ['Date'], now: START });
    onStage('dev');
    const asked = stubSecretsManager(answers(openrouterJson(FAKE_KEY)));
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => getAppSecret<{ apiKey: string }>('openrouter')),
    );
    assert.ok(concurrent.every((secret) => secret.apiKey === FAKE_KEY));
    mock.timers.tick(APP_SECRET_TTL_MS / 2);
    await getAppSecret('openrouter');
    assert.deepEqual(asked, ['todolist/dev/openrouter']);
  });

  it('reads it again once the hour is up, and serves the new value (rotation)', async () => {
    assert.equal(APP_SECRET_TTL_MS, 60 * 60 * 1000);
    mock.timers.enable({ apis: ['Date'], now: START });
    onStage('qa');
    const asked = stubSecretsManager(
      answers(openrouterJson('FAKE-old'), openrouterJson('FAKE-new')),
    );
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-old');
    mock.timers.tick(APP_SECRET_TTL_MS - 1);
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-old');
    assert.equal(asked.length, 1);
    mock.timers.tick(1);
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-new');
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-new');
    assert.deepEqual(asked, ['todolist/qa/openrouter', 'todolist/qa/openrouter']);
  });

  it('keeps each secret, and each stage prefix, on its own', async () => {
    onStage('dev');
    const asked = stubSecretsManager((secretId) =>
      Promise.resolve({
        SecretString: secretId.endsWith('openrouter')
          ? openrouterJson(FAKE_KEY)
          : JSON.stringify({ clientId: 'FAKE-jira-id', clientSecret: 'FAKE-jira-secret' }),
      }),
    );
    await getAppSecret('openrouter');
    await getAppSecret('oauth-jira');
    await getAppSecret('openrouter');
    await getAppSecret('oauth-jira');
    onStage('prod');
    await getAppSecret('openrouter');
    assert.deepEqual(asked, [
      'todolist/dev/openrouter',
      'todolist/dev/oauth-jira',
      'todolist/prod/openrouter',
    ]);
  });

  it('never keeps a failed read: the next call reads again', async () => {
    onStage('dev');
    let calls = 0;
    const asked = stubSecretsManager(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(sdkError('ThrottlingException'))
        : Promise.resolve({ SecretString: openrouterJson(FAKE_KEY) });
    });
    assert.equal(await reasonOf(getAppSecret('openrouter')), 'unavailable');
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, FAKE_KEY);
    assert.equal(asked.length, 2);
  });

  it('names each failure: missing, unavailable, invalid', async () => {
    onStage('prod');
    for (const [name, reason] of [
      ['ResourceNotFoundException', 'missing'],
      ['AccessDeniedException', 'unavailable'],
      ['DecryptionFailure', 'unavailable'],
      ['InternalServiceError', 'unavailable'],
    ] as const) {
      mock.restoreAll();
      stubSecretsManager(() => Promise.reject(sdkError(name)));
      const error = await failure(getAppSecret('oauth-linear'));
      assert.equal(error.reason, reason, name);
      assert.ok(!error.message.includes('Secrets Manager says'), error.message);
      assert.equal(error.cause, undefined);
    }
  });

  it('refuses a value that is not a JSON object with the registry fields, and passes others through', async () => {
    onStage('dev');
    const bad: (string | undefined)[] = [
      undefined, // a binary secret: no SecretString
      '',
      'FAKE-not-json',
      '[]',
      '"FAKE-a-string"',
      'null',
      '{}',
      '{"clientId":"FAKE-id"}',
      '{"clientId":"FAKE-id","clientSecret":""}',
      '{"clientId":"FAKE-id","clientSecret":7}',
      '{"clientId":["FAKE-id"],"clientSecret":"FAKE-secret"}',
    ];
    for (const text of bad) {
      mock.restoreAll();
      resetAppSecretsForTests();
      stubSecretsManager(answers(text));
      assert.equal(await reasonOf(getAppSecret('oauth-github')), 'invalid', String(text));
    }
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(
      answers('{"clientId":"FAKE-id","clientSecret":"FAKE-secret","appId":"12345","n":{"a":1}}'),
    );
    const secret = await getAppSecret<{ clientId: string; appId: string }>('oauth-github');
    assert.equal(secret.clientId, 'FAKE-id');
    assert.equal(secret.appId, '12345');
  });

  it('is not configured for a stage it does not know: no read at all', async () => {
    const asked = stubSecretsManager(answers(openrouterJson(FAKE_KEY)));
    for (const stage of ['', 'staging', 'DEV', 'dev/']) {
      Object.assign(process.env, { ENV: stage });
      assert.equal(await reasonOf(getAppSecret('openrouter')), 'missing', stage);
    }
    assert.deepEqual(asked, []);
  });
});

describe('the environment is never read', () => {
  for (const stage of STAGES) {
    it(`ENV=${stage}: an APP_SECRET_* or the older Google pair stands in for nothing`, async () => {
      onStage(stage);
      Object.assign(process.env, {
        APP_SECRET_OPENROUTER: openrouterJson('FAKE-from-env'),
        APP_SECRET_GOOGLE_CALENDAR_OAUTH: JSON.stringify(FAKE_GOOGLE),
        GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE.clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: FAKE_GOOGLE.clientSecret,
      });
      const asked = stubSecretsManager((secretId) =>
        secretId.endsWith('openrouter')
          ? Promise.resolve({ SecretString: openrouterJson('FAKE-from-aws') })
          : Promise.reject(sdkError('ResourceNotFoundException')),
      );
      assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-from-aws');
      assert.equal(await reasonOf(getAppSecret('google-calendar-oauth')), 'missing');
      assert.equal(await googleOAuthCredentials(), null);
      assert.ok(asked.every((secretId) => secretId.startsWith(`todolist/${stage}/`)));
    });
  }
});

describe('setAppSecretsForTests', () => {
  it("answers a test's values, checked like a read, and never Secrets Manager", async () => {
    onStage('dev');
    const asked = stubSecretsManager(answers(openrouterJson('FAKE-from-aws')));
    setAppSecretsForTests({ openrouter: { apiKey: FAKE_KEY }, 'oauth-jira': { clientId: 'x' } });
    const secret = await getAppSecret<{ apiKey: string }>('openrouter');
    assert.equal(secret.apiKey, FAKE_KEY);
    assert.ok(Object.isFrozen(secret));
    assert.equal(await reasonOf(getAppSecret('oauth-jira')), 'invalid');
    assert.equal(await reasonOf(getAppSecret('oauth-linear')), 'missing');
    assert.deepEqual(asked, []);
    setAppSecretsForTests(null);
    assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-from-aws');
  });
});

describe('googleOAuthCredentials, the call site', () => {
  it('returns the id and secret of google-calendar-oauth (deployed), and nothing more', async () => {
    onStage('dev');
    const asked = stubSecretsManager(answers(JSON.stringify({ ...FAKE_GOOGLE, extra: 'FAKE-x' })));
    assert.deepEqual(await googleOAuthCredentials(), FAKE_GOOGLE);
    assert.deepEqual(await googleOAuthCredentials(), FAKE_GOOGLE);
    assert.deepEqual(asked, ['todolist/dev/google-calendar-oauth']);
  });

  it('is null when the secret does not exist, and a generic error when it cannot be read', async () => {
    onStage('qa');
    stubSecretsManager(() => Promise.reject(sdkError('ResourceNotFoundException')));
    assert.equal(await googleOAuthCredentials(), null);
    mock.restoreAll();
    stubSecretsManager(() => Promise.reject(sdkError('AccessDeniedException')));
    await assert.rejects(googleOAuthCredentials(), {
      message: 'The Google Calendar OAuth secret could not be read',
    });
    mock.restoreAll();
    stubSecretsManager(answers('{"clientId":"FAKE-id"}'));
    await assert.rejects(googleOAuthCredentials(), {
      message: 'The Google Calendar OAuth secret could not be read',
    });
  });
});
