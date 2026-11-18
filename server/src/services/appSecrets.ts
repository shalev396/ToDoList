/**
 * App-level secrets: this app's own OAuth clients and API keys. Users' provider tokens are not
 * here: they stay sealed in the credential vault (services/crypto/).
 *
 * They live in ONE Secrets Manager secret per stage, `todolist-<stage>-app-secrets` (appSecretName
 * in infra/lib/constants.ts; the auto-content-creation pattern): a flat JSON object of UPPER_SNAKE
 * keys, e.g. `{"GOOGLE_CALENDAR_CLIENT_ID":"…","GOOGLE_CALENDAR_CLIENT_SECRET":"…"}`. The backend
 * deploy creates it as `{}` when missing and never writes it after (scripts/app-secret.ts); the keys
 * are filled by hand. CDK grants GetSecretValue on that one secret only.
 *
 * Callers ask by logical name (APP_SECRETS) and get that name's fields only, never the rest of the
 * secret: `getAppSecret('oauth-github')` is `{ clientId, clientSecret, appSlug? }`. A name none of
 * whose required keys is in the secret is `missing` (its provider shows as not configured); a name
 * with only some of them, or one that is not a non-empty string, is `invalid`.
 *
 * The secret read is kept in memory for an hour at most (per cold start), then read again; a
 * failed read is never kept, so the next call tries again. A value is never taken from the
 * environment. Tests hand in their own values, by logical name (setAppSecretsForTests).
 *
 * A value is never logged, put in an error or attached as a cause: logs and errors carry names and
 * the kind of failure only, because an SDK message or a JSON parse error can quote what it read.
 *
 * The stage is read from the process environment when called, not through the `environment`
 * singleton (which reads it once, at import).
 *
 * Adding a secret: docs/dashboard/DEPLOY-PLAN.md, "App secrets in Secrets Manager".
 */
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { appSecretName, isStage } from '../../infra/lib/constants.js';
import { assertUnderTest } from '../config/testSwitches.js';
import { logger } from './logger.js';

/** One logical secret: each field the caller gets, and the key it is read from in the stage secret. */
export interface AppSecretSpec {
  /** Each must be a non-empty string. */
  readonly required: Readonly<Record<string, string>>;
  /** Passed on when a string, left out otherwise; the caller checks it. */
  readonly optional?: Readonly<Record<string, string>>;
}

/**
 * The allow-list: each logical app secret, its fields and their keys in
 * `todolist-<stage>-app-secrets`. A key not listed here is never handed to anyone.
 */
export const APP_SECRETS = {
  /** The Google Calendar OAuth client (INTEGRATIONS-SETUP.md §1). */
  'google-calendar-oauth': {
    required: {
      clientId: 'GOOGLE_CALENDAR_CLIENT_ID',
      clientSecret: 'GOOGLE_CALENDAR_CLIENT_SECRET',
    },
  },
  /** The OpenRouter API key. */
  openrouter: { required: { apiKey: 'OPENROUTER_API_KEY' } },
  /** The OpenRouteService API key (free tier: directions and geocoding). */
  openrouteservice: { required: { apiKey: 'OPENROUTESERVICE_API_KEY' } },
  /** Provider OAuth clients (INTEGRATIONS-SETUP.md §3 to §6). */
  'oauth-github': {
    required: { clientId: 'GITHUB_CLIENT_ID', clientSecret: 'GITHUB_CLIENT_SECRET' },
    optional: { appSlug: 'GITHUB_APP_SLUG' },
  },
  'oauth-jira': { required: { clientId: 'JIRA_CLIENT_ID', clientSecret: 'JIRA_CLIENT_SECRET' } },
  'oauth-clickup': {
    required: { clientId: 'CLICKUP_CLIENT_ID', clientSecret: 'CLICKUP_CLIENT_SECRET' },
  },
  'oauth-linear': {
    required: { clientId: 'LINEAR_CLIENT_ID', clientSecret: 'LINEAR_CLIENT_SECRET' },
  },
} as const satisfies Readonly<Record<string, AppSecretSpec>>;

export type AppSecretName = keyof typeof APP_SECRETS;

/** A logical secret as handed out: its fields, frozen. */
export type AppSecretJson = Readonly<Record<string, unknown>>;

/** How long the secret read from Secrets Manager is used before the next call reads it again. */
export const APP_SECRET_TTL_MS = 60 * 60 * 1000;

/**
 * Why a read failed:
 * - `unknown`: not a name in APP_SECRETS (a bug in the caller);
 * - `missing`: the stage secret does not exist, none of the name's keys is in it, or no stage;
 * - `unavailable`: Secrets Manager did not hand it over (access, throttling, network, KMS);
 * - `invalid`: the secret is not a JSON object, or the name's keys are not all non-empty strings.
 */
export type AppSecretFailure = 'unknown' | 'missing' | 'unavailable' | 'invalid';

/** Names the secret and the failure, never a value, and has no cause (a cause could quote one). */
export class AppSecretError extends Error {
  readonly reason: AppSecretFailure;

  constructor(reason: AppSecretFailure, message: string) {
    super(message);
    this.name = 'AppSecretError';
    this.reason = reason;
  }
}

export function isAppSecretName(value: unknown): value is AppSecretName {
  return typeof value === 'string' && Object.hasOwn(APP_SECRETS, value);
}

/**
 * The fields of `name`, each read through `read(field, key)`: `missing` when no required one is
 * set, `invalid` when any is not a non-empty string. The object is frozen.
 */
function project(
  name: AppSecretName,
  read: (field: string, key: string) => unknown,
): AppSecretJson {
  const spec: AppSecretSpec = APP_SECRETS[name];
  const required = Object.entries(spec.required);
  if (required.every(([field, key]) => read(field, key) === undefined)) {
    throw new AppSecretError('missing', `App secret "${name}" is not set`);
  }
  const out: Record<string, string> = {};
  for (const [field, key] of required) {
    const value = read(field, key);
    if (typeof value !== 'string' || value === '') {
      throw new AppSecretError(
        'invalid',
        `App secret "${name}" needs ${Object.values(spec.required).join(', ')} as non-empty strings`,
      );
    }
    out[field] = value;
  }
  for (const [field, key] of Object.entries(spec.optional ?? {})) {
    const value = read(field, key);
    if (typeof value === 'string') out[field] = value;
  }
  return Object.freeze(out);
}

/** A JSON object, or a generic `invalid` (a parse error quotes its input). */
function parseObject(text: string | undefined): Readonly<Record<string, unknown>> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    // Falls through to the generic error.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppSecretError('invalid', 'The app secrets are not a JSON object');
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

// ─── Secrets Manager ────────────────────────────────────────────────────────

type StageSecret = Readonly<Record<string, unknown>>;

interface CacheEntry {
  readonly value: Promise<StageSecret>;
  readonly expiresAt: number;
}

/** Keyed by the secret's name, so one stage never sees another's value. */
const cache = new Map<string, CacheEntry>();
let client: SecretsManagerClient | null = null;

/** One GetSecretValue by name (never a partial ARN: see DEPLOY-PLAN.md). */
async function readSecretString(secretId: string): Promise<string | undefined> {
  // A literal specifier, so esbuild bundles it and the import-graph test sees it.
  const sdk = await import('@aws-sdk/client-secrets-manager');
  client ??= new sdk.SecretsManagerClient({ region: process.env.AWS_REGION });
  const { SecretString } = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
  return SecretString;
}

async function fetchStageSecret(secretId: string): Promise<StageSecret> {
  let text: string | undefined;
  try {
    text = await readSecretString(secretId);
  } catch (error) {
    // The error's name only: its message can carry ARNs, and its cause the response.
    const errorName = error instanceof Error ? error.name : typeof error;
    if (errorName === 'ResourceNotFoundException') {
      logger.warn('App secrets not found in Secrets Manager', { secretId, errorName });
      throw new AppSecretError('missing', 'The app secrets do not exist in Secrets Manager');
    }
    logger.error('App secrets could not be read', { secretId, errorName });
    throw new AppSecretError('unavailable', 'The app secrets could not be read');
  }
  try {
    return parseObject(text);
  } catch (error) {
    logger.error('App secrets are not a JSON object', { secretId });
    throw error;
  }
}

function readDeployed(): Promise<StageSecret> {
  const env = process.env.ENV;
  if (!isStage(env)) {
    return Promise.reject(
      new AppSecretError('missing', 'App secrets are not configured on this server'),
    );
  }
  const secretId = appSecretName(env);
  const now = Date.now();
  const hit = cache.get(secretId);
  if (hit !== undefined && now < hit.expiresAt) return hit.value;
  // Concurrent callers share this one read until it settles.
  const value = fetchStageSecret(secretId);
  const entry: CacheEntry = { value, expiresAt: now + APP_SECRET_TTL_MS };
  cache.set(secretId, entry);
  void value.catch(() => {
    if (cache.get(secretId) === entry) cache.delete(secretId);
  });
  return value;
}

/** What a test hands in instead of Secrets Manager: each logical secret's fields, by name. */
export type AppSecretsForTests = Partial<Record<AppSecretName, object>>;

let valuesForTests: AppSecretsForTests | null = null;

/** A test's value for `name`, checked like a Secrets Manager answer; `missing` when absent. */
function readForTests(name: AppSecretName, values: AppSecretsForTests): AppSecretJson {
  const value = values[name];
  if (value === undefined) {
    throw new AppSecretError('missing', `App secret "${name}" is not set`);
  }
  const fields = value as Record<string, unknown>;
  return project(name, (field) => (Object.hasOwn(fields, field) ? fields[field] : undefined));
}

/**
 * The fields of app secret `name`, as `T`: the required ones are checked to be non-empty strings,
 * an optional one is there only when a string. The object is frozen and shared: read it, never
 * change or log it. Throws AppSecretError (see AppSecretFailure).
 */
export async function getAppSecret<T extends object = AppSecretJson>(
  name: AppSecretName,
): Promise<T> {
  // A name from a computed string is not echoed: it could be anything.
  if (!isAppSecretName(name)) throw new AppSecretError('unknown', 'Unknown app secret name');
  if (valuesForTests !== null) return readForTests(name, valuesForTests) as T;
  const secret = await readDeployed();
  try {
    return project(name, (_field, key) =>
      Object.hasOwn(secret, key) ? secret[key] : undefined,
    ) as T;
  } catch (error) {
    if (error instanceof AppSecretError && error.reason === 'invalid') {
      logger.error('App secret is not in its expected shape', { name });
    }
    throw error;
  }
}

/**
 * Tests only (node:test): the app secrets come from `values` (a name left out is `missing`)
 * instead of Secrets Manager; null goes back to Secrets Manager. It throws in a server.
 */
export function setAppSecretsForTests(values: AppSecretsForTests | null): void {
  assertUnderTest('setAppSecretsForTests');
  valuesForTests = values;
}

/**
 * Tests only: forgets every cached value and the Secrets Manager client. It throws outside
 * node:test (the runner sets NODE_TEST_CONTEXT in every test process).
 */
export function resetAppSecretsForTests(): void {
  assertUnderTest('resetAppSecretsForTests');
  cache.clear();
  client = null;
}
