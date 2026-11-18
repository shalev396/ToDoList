/**
 * App secrets (services/appSecrets.ts): the allow-list and its keys; the one Secrets Manager read
 * of `todolist-<stage>-app-secrets`, kept for an hour and read again after; each name getting its
 * own fields only; that the environment is never read; and the test seam (setAppSecretsForTests).
 * Secrets Manager is a stub on the SDK client, so no AWS call is made. Every value is FAKE.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { appSecretName, STAGES } from '../../infra/lib/constants.js';
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
  type AppSecretSpec,
} from './appSecrets.js';
import { GOOGLE_CALENDAR_OAUTH } from '../classes/integration/definitions/googleCalendar.js';

/** Google Calendar's OAuth app credentials, as its strategy reads them. */
const googleOAuthCredentials = (): ReturnType<typeof GOOGLE_CALENDAR_OAUTH.credentials> =>
  GOOGLE_CALENDAR_OAUTH.credentials();

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

/** The stage secret's text: a flat JSON object of UPPER_SNAKE keys. */
const stageJson = (keys: Record<string, unknown>): string => JSON.stringify(keys);
const openrouterJson = (apiKey: string): string => stageJson({ OPENROUTER_API_KEY: apiKey });
const GOOGLE_KEYS = {
  GOOGLE_CALENDAR_CLIENT_ID: FAKE_GOOGLE.clientId,
  GOOGLE_CALENDAR_CLIENT_SECRET: FAKE_GOOGLE.clientSecret,
};

describe('the allow-list', () => {
  it('holds exactly the six app secrets, each with its own UPPER_SNAKE keys', () => {
    assert.deepEqual(Object.keys(APP_SECRETS).sort(), NAMES);
    const keys: string[] = [];
    for (const name of NAMES) {
      assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const spec: AppSecretSpec = APP_SECRETS[name];
      assert.ok(Object.keys(spec.required).length > 0, `${name} names no field`);
      for (const key of [...Object.values(spec.required), ...Object.values(spec.optional ?? {})]) {
        assert.match(key, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, key);
        keys.push(key);
      }
    }
    assert.equal(new Set(keys).size, keys.length, 'a key is shared by two names');
    assert.deepEqual(APP_SECRETS['google-calendar-oauth'].required, {
      clientId: 'GOOGLE_CALENDAR_CLIENT_ID',
      clientSecret: 'GOOGLE_CALENDAR_CLIENT_SECRET',
    });
    assert.deepEqual(APP_SECRETS.openrouter.required, { apiKey: 'OPENROUTER_API_KEY' });
    assert.deepEqual(APP_SECRETS['oauth-github'].optional, { appSlug: 'GITHUB_APP_SLUG' });
  });

  it('names one secret per stage, todolist-<stage>-app-secrets', () => {
    for (const stage of STAGES) assert.equal(appSecretName(stage), `todolist-${stage}-app-secrets`);
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
    it(`ENV=${stage} reads todolist-${stage}-app-secrets by name, with GetSecretValue`, async () => {
      onStage(stage);
      const asked = stubSecretsManager(answers(openrouterJson(FAKE_KEY)));
      const secret = await getAppSecret<{ apiKey: string }>('openrouter');
      assert.deepEqual(secret, { apiKey: FAKE_KEY });
      assert.ok(Object.isFrozen(secret));
      assert.deepEqual(asked, [`todolist-${stage}-app-secrets`]);
    });
  }

  it("hands each name its own fields only, never another name's keys", async () => {
    onStage('dev');
    stubSecretsManager(
      answers(
        stageJson({
          ...GOOGLE_KEYS,
          OPENROUTER_API_KEY: FAKE_KEY,
          JIRA_CLIENT_ID: 'FAKE-jira-id',
          JIRA_CLIENT_SECRET: 'FAKE-jira-secret',
          SOMETHING_ELSE: 'FAKE-other',
        }),
      ),
    );
    assert.deepEqual(await getAppSecret('google-calendar-oauth'), FAKE_GOOGLE);
    assert.deepEqual(await getAppSecret('oauth-jira'), {
      clientId: 'FAKE-jira-id',
      clientSecret: 'FAKE-jira-secret',
    });
    assert.deepEqual(await getAppSecret('openrouter'), { apiKey: FAKE_KEY });
  });

  it('reads the secret once for the hour, for every name, concurrent calls included', async () => {
    mock.timers.enable({ apis: ['Date'], now: START });
    onStage('dev');
    const asked = stubSecretsManager(
      answers(stageJson({ ...GOOGLE_KEYS, OPENROUTER_API_KEY: FAKE_KEY })),
    );
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => getAppSecret<{ apiKey: string }>('openrouter')),
    );
    assert.ok(concurrent.every((secret) => secret.apiKey === FAKE_KEY));
    mock.timers.tick(APP_SECRET_TTL_MS / 2);
    await getAppSecret('openrouter');
    await getAppSecret('google-calendar-oauth');
    assert.deepEqual(asked, ['todolist-dev-app-secrets']);
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
    assert.deepEqual(asked, ['todolist-qa-app-secrets', 'todolist-qa-app-secrets']);
  });

  it('keeps each stage on its own', async () => {
    const asked = stubSecretsManager((secretId) =>
      Promise.resolve({ SecretString: openrouterJson(`FAKE-${secretId}`) }),
    );
    onStage('dev');
    assert.equal(
      (await getAppSecret<{ apiKey: string }>('openrouter')).apiKey,
      'FAKE-todolist-dev-app-secrets',
    );
    onStage('prod');
    assert.equal(
      (await getAppSecret<{ apiKey: string }>('openrouter')).apiKey,
      'FAKE-todolist-prod-app-secrets',
    );
    onStage('dev');
    await getAppSecret('openrouter');
    assert.deepEqual(asked, ['todolist-dev-app-secrets', 'todolist-prod-app-secrets']);
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

  it('names each failure of the read: missing, unavailable', async () => {
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

  it('refuses a secret that is not a JSON object, for every name', async () => {
    onStage('dev');
    for (const text of [undefined, '', 'FAKE-not-json', '[]', '"FAKE-a-string"', 'null', '7']) {
      mock.restoreAll();
      resetAppSecretsForTests();
      stubSecretsManager(answers(text));
      assert.equal(await reasonOf(getAppSecret('oauth-github')), 'invalid', String(text));
      assert.equal(await reasonOf(getAppSecret('openrouter')), 'invalid', String(text));
    }
  });

  it("is missing when none of a name's keys is set: {} configures nothing", async () => {
    onStage('dev');
    stubSecretsManager(answers('{}'));
    for (const name of NAMES) assert.equal(await reasonOf(getAppSecret(name)), 'missing', name);
  });

  it('is invalid when only some keys are set or one is not a non-empty string, for that name only', async () => {
    onStage('dev');
    const bad: Record<string, unknown>[] = [
      { GITHUB_CLIENT_ID: 'FAKE-id' },
      { GITHUB_CLIENT_SECRET: 'FAKE-secret' },
      { GITHUB_CLIENT_ID: 'FAKE-id', GITHUB_CLIENT_SECRET: '' },
      { GITHUB_CLIENT_ID: 'FAKE-id', GITHUB_CLIENT_SECRET: 7 },
      { GITHUB_CLIENT_ID: ['FAKE-id'], GITHUB_CLIENT_SECRET: 'FAKE-secret' },
      { GITHUB_CLIENT_ID: null, GITHUB_CLIENT_SECRET: 'FAKE-secret' },
    ];
    for (const keys of bad) {
      mock.restoreAll();
      resetAppSecretsForTests();
      stubSecretsManager(answers(stageJson({ ...keys, OPENROUTER_API_KEY: FAKE_KEY })));
      assert.equal(await reasonOf(getAppSecret('oauth-github')), 'invalid', JSON.stringify(keys));
      assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, FAKE_KEY);
    }
  });

  it('passes an optional field on only when it is a string', async () => {
    onStage('dev');
    const keys = { GITHUB_CLIENT_ID: 'FAKE-id', GITHUB_CLIENT_SECRET: 'FAKE-secret' };
    stubSecretsManager(answers(stageJson({ ...keys, GITHUB_APP_SLUG: 'todolist-dev' })));
    assert.deepEqual(await getAppSecret('oauth-github'), {
      clientId: 'FAKE-id',
      clientSecret: 'FAKE-secret',
      appSlug: 'todolist-dev',
    });
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(answers(stageJson({ ...keys, GITHUB_APP_SLUG: 7 })));
    assert.deepEqual(await getAppSecret('oauth-github'), {
      clientId: 'FAKE-id',
      clientSecret: 'FAKE-secret',
    });
  });

  it('reads no inherited key', async () => {
    onStage('dev');
    stubSecretsManager(answers('{"__proto__":{"OPENROUTER_API_KEY":"FAKE-inherited"}}'));
    assert.equal(await reasonOf(getAppSecret('openrouter')), 'missing');
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
    it(`ENV=${stage}: an APP_SECRET_*, a key of the secret or the older Google pair stands in for nothing`, async () => {
      onStage(stage);
      Object.assign(process.env, {
        APP_SECRET_OPENROUTER: JSON.stringify({ apiKey: 'FAKE-from-env' }),
        APP_SECRET_GOOGLE_CALENDAR_OAUTH: JSON.stringify(FAKE_GOOGLE),
        GOOGLE_CALENDAR_CLIENT_ID: FAKE_GOOGLE.clientId,
        GOOGLE_CALENDAR_CLIENT_SECRET: FAKE_GOOGLE.clientSecret,
        GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE.clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: FAKE_GOOGLE.clientSecret,
      });
      const asked = stubSecretsManager(answers(openrouterJson('FAKE-from-aws')));
      assert.equal((await getAppSecret<{ apiKey: string }>('openrouter')).apiKey, 'FAKE-from-aws');
      assert.equal(await reasonOf(getAppSecret('google-calendar-oauth')), 'missing');
      assert.equal(await googleOAuthCredentials(), null);
      assert.deepEqual(asked, [`todolist-${stage}-app-secrets`]);
    });
  }
});

describe('setAppSecretsForTests', () => {
  it("answers a test's values, by field, checked like a read, and never Secrets Manager", async () => {
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
    const asked = stubSecretsManager(answers(stageJson({ ...GOOGLE_KEYS, EXTRA: 'FAKE-x' })));
    assert.deepEqual(await googleOAuthCredentials(), FAKE_GOOGLE);
    assert.deepEqual(await googleOAuthCredentials(), FAKE_GOOGLE);
    assert.deepEqual(asked, ['todolist-dev-app-secrets']);
  });

  it('is null when not set, and a generic error when it cannot be read', async () => {
    onStage('qa');
    stubSecretsManager(() => Promise.reject(sdkError('ResourceNotFoundException')));
    assert.equal(await googleOAuthCredentials(), null);
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(answers('{}'));
    assert.equal(await googleOAuthCredentials(), null);
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(() => Promise.reject(sdkError('AccessDeniedException')));
    await assert.rejects(googleOAuthCredentials(), {
      message: 'The Google Calendar OAuth secret could not be read',
    });
    mock.restoreAll();
    resetAppSecretsForTests();
    stubSecretsManager(answers(stageJson({ GOOGLE_CALENDAR_CLIENT_ID: 'FAKE-id' })));
    await assert.rejects(googleOAuthCredentials(), {
      message: 'The Google Calendar OAuth secret could not be read',
    });
  });
});
