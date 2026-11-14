/**
 * App-level secrets: this app's own OAuth clients and API keys, one JSON secret each. Users'
 * provider tokens are not here: they stay sealed in the credential vault (services/crypto/).
 *
 * They live in Secrets Manager only, by name `todolist/<stage>/<name>`, the prefix derived from ENV
 * (appSecretsPrefix in infra/lib/constants.ts); CDK grants GetSecretValue under it only. A value
 * read is kept in memory for an hour at most (per secret, per cold start), then read again; a
 * failed read is never kept, so the next call tries again. A value is never taken from the
 * environment. Tests hand in their own values (setAppSecretsForTests).
 *
 * Only the names in APP_SECRETS can be read. A value is never logged, put in an error or attached
 * as a cause: logs and errors carry the name and the kind of failure only, because an SDK message
 * or a JSON parse error can quote what it read.
 *
 * The stage is read from the process environment when called, not through the `environment`
 * singleton (which reads it once, at import).
 *
 * Adding a secret: docs/dashboard/DEPLOY-PLAN.md, "App secrets in Secrets Manager".
 */
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { appSecretsPrefix, isStage } from '../../infra/lib/constants.js';
import { assertUnderTest } from '../config/testSwitches.js';
import { logger } from './logger.js';

/**
 * The allow-list: each app secret's name and the fields its JSON must carry as non-empty strings
 * (any other field passes through unchecked). Its Secrets Manager name is `todolist/<stage>/<name>`.
 */
export const APP_SECRETS = {
  /** The Google Calendar OAuth client (INTEGRATIONS-SETUP.md §1). */
  'google-calendar-oauth': ['clientId', 'clientSecret'],
  /** The OpenRouter API key. */
  openrouter: ['apiKey'],
  /** Provider OAuth clients (INTEGRATIONS-SETUP.md §3 to §6). */
  'oauth-github': ['clientId', 'clientSecret'],
  'oauth-jira': ['clientId', 'clientSecret'],
  'oauth-clickup': ['clientId', 'clientSecret'],
  'oauth-linear': ['clientId', 'clientSecret'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type AppSecretName = keyof typeof APP_SECRETS;

/** A secret's JSON as read: an object whose registry fields are non-empty strings. */
export type AppSecretJson = Readonly<Record<string, unknown>>;

/** How long a value read from Secrets Manager is used before the next call reads it again. */
export const APP_SECRET_TTL_MS = 60 * 60 * 1000;

/** A Secrets Manager name prefix ending in `/`, e.g. `todolist/dev/`. */
const PREFIX_SHAPE = /^[A-Za-z0-9/_+=.@-]+\/$/;

/**
 * Why a read failed:
 * - `unknown`: not a name in APP_SECRETS (a bug in the caller);
 * - `missing`: there is no such secret (or no prefix: not a stage);
 * - `unavailable`: Secrets Manager did not hand it over (access, throttling, network, KMS);
 * - `invalid`: not a JSON object with the registry fields as non-empty strings.
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

function invalid(name: AppSecretName): AppSecretError {
  return new AppSecretError(
    'invalid',
    `App secret "${name}" is not a JSON object with ${APP_SECRETS[name].join(', ')}`,
  );
}

/** The secret's JSON, checked against the registry and frozen; any failure is generic. */
function parseSecret(name: AppSecretName, text: string | undefined): AppSecretJson {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    // Falls through to the generic error: a parse error quotes its input.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid(name);
  const json = parsed as Record<string, unknown>;
  for (const field of APP_SECRETS[name]) {
    const value = json[field];
    if (typeof value !== 'string' || value === '') throw invalid(name);
  }
  return Object.freeze(json);
}

// ─── Secrets Manager ────────────────────────────────────────────────────────

interface CacheEntry {
  readonly value: Promise<AppSecretJson>;
  readonly expiresAt: number;
}

/** Keyed by the full secret name, so a different prefix never sees another's value. */
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

async function fetchSecret(name: AppSecretName, secretId: string): Promise<AppSecretJson> {
  let text: string | undefined;
  try {
    text = await readSecretString(secretId);
  } catch (error) {
    // The error's name only: its message can carry ARNs, and its cause the response.
    const errorName = error instanceof Error ? error.name : typeof error;
    if (errorName === 'ResourceNotFoundException') {
      logger.warn('App secret not found in Secrets Manager', { name, errorName });
      throw new AppSecretError('missing', `App secret "${name}" does not exist in Secrets Manager`);
    }
    logger.error('App secret could not be read', { name, errorName });
    throw new AppSecretError('unavailable', `App secret "${name}" could not be read`);
  }
  try {
    return parseSecret(name, text);
  } catch (error) {
    logger.error('App secret is not in its expected JSON shape', { name });
    throw error;
  }
}

function readDeployed(name: AppSecretName, prefix: string): Promise<AppSecretJson> {
  if (!PREFIX_SHAPE.test(prefix)) {
    return Promise.reject(
      new AppSecretError('missing', 'App secrets are not configured on this server'),
    );
  }
  const secretId = `${prefix}${name}`;
  const now = Date.now();
  const hit = cache.get(secretId);
  if (hit !== undefined && now < hit.expiresAt) return hit.value;
  // Concurrent callers share this one read until it settles.
  const value = fetchSecret(name, secretId);
  const entry: CacheEntry = { value, expiresAt: now + APP_SECRET_TTL_MS };
  cache.set(secretId, entry);
  void value.catch(() => {
    if (cache.get(secretId) === entry) cache.delete(secretId);
  });
  return value;
}

/** What a test hands in instead of Secrets Manager: each secret's JSON, by name. */
export type AppSecretsForTests = Partial<Record<AppSecretName, object>>;

let valuesForTests: AppSecretsForTests | null = null;

/** A test's value for `name`, checked like a Secrets Manager answer; `missing` when absent. */
function readForTests(name: AppSecretName, values: AppSecretsForTests): AppSecretJson {
  const value = values[name];
  if (value === undefined) {
    throw new AppSecretError('missing', `App secret "${name}" is not set`);
  }
  return parseSecret(name, JSON.stringify(value));
}

/**
 * The JSON of app secret `name`, as `T`: the registry's fields are checked to be non-empty
 * strings; anything else in `T` is the caller's to check. The object is frozen and shared: read
 * it, never change or log it. Throws AppSecretError (see AppSecretFailure).
 */
export async function getAppSecret<T extends object = AppSecretJson>(
  name: AppSecretName,
): Promise<T> {
  // A name from a computed string is not echoed: it could be anything.
  if (!isAppSecretName(name)) throw new AppSecretError('unknown', 'Unknown app secret name');
  const json =
    valuesForTests !== null
      ? readForTests(name, valuesForTests)
      : await readDeployed(name, isStage(process.env.ENV) ? appSecretsPrefix(process.env.ENV) : '');
  return json as T;
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
