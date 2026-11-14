/**
 * The only code that decrypts provider credentials (DATA.md §0, §3.5, §7; DECISIONS D14). One
 * door:
 * - decryptForSync: outbound provider calls (sync worker, "test connection", Calendar pushes).
 *   The secret is handed to a callback and never returned.
 * The plaintext lives for one call and is never cached. vaultImports.test.ts fails when a module
 * outside its allow-list imports this file.
 */
import { AppError } from '../../errors/AppError.js';
import { getCredentialRepository, getIntegrationRepository } from '../../models/index.js';
import { logger } from '../logger.js';
import { ProviderHttpError } from '../../sync/errors.js';
import { isOAuthProviderId } from '../oauth/providers.js';
import { refreshGrant } from '../oauth/client.js';
import { accessTokenStale, oauthSecretFromGrant } from '../oauth/secret.js';
import { open, seal, type EncBlob } from './envelope.js';
import { carriesSecret, redactSecrets, secretValuesOf } from './secretHygiene.js';
import { stageKeyProvider } from './stageKeyProvider.js';

/** A decrypted credential, e.g. Jira `{email, token}`. Frozen: callers can't change it. */
export type SecretJson = Readonly<Record<string, string>>;

interface Opened {
  workspaceId: string;
  provider: string;
  /** The credential's version (compare-and-set key of an OAuth refresh). */
  version: number;
  plaintext: Buffer;
}

/** Decrypts the integration's credential. The caller zeroes `plaintext`. */
async function openCredential(integrationId: string): Promise<Opened> {
  const integration = await (await getIntegrationRepository()).findByIdForWorker(integrationId);
  if (integration === null) throw new AppError(404, 'Integration not found');
  const { workspaceId, provider } = integration;
  const sealed = await (await getCredentialRepository()).findSealed(workspaceId, integrationId);
  if (sealed === null) throw new AppError(404, 'Credential not found');
  try {
    // open() checks the stored algorithm, AAD and key provider at runtime before decrypting.
    const blob = sealed.enc as EncBlob;
    const plaintext = await open(
      blob,
      { workspaceId, integrationId, provider },
      stageKeyProvider(),
    );
    return { workspaceId, provider, version: sealed.version, plaintext };
  } catch (error) {
    // Callers only learn that it failed. The log names the error, which tells KMS trouble
    // (ThrottlingException, AccessDeniedException…) from a tampered or misplaced ciphertext (Error).
    logger.error('A credential could not be opened', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new Error('The credential could not be decrypted');
  }
}

/** The secret JSON. JSON.parse errors quote their input, so they are never passed on. */
function parseSecret(plaintext: Buffer): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('The credential is not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === 'string')
  ) {
    throw new Error('The credential is not a JSON object of strings');
  }
  return parsed as Record<string, string>;
}

/** lastUsedAt is bookkeeping: failing to record it never fails the call. */
async function recordUse(workspaceId: string, integrationId: string): Promise<void> {
  try {
    await (await getCredentialRepository()).touch(workspaceId, integrationId, new Date());
  } catch (error) {
    logger.warn('Could not record a credential use', error);
  }
}

interface Versioned {
  secret: SecretJson;
  version: number;
}

/** Opens the credential again: what another refresh may have stored meanwhile. */
async function readVersioned(integrationId: string): Promise<Versioned> {
  const { plaintext, version } = await openCredential(integrationId);
  try {
    return { secret: Object.freeze(parseSecret(plaintext)), version };
  } finally {
    plaintext.fill(0);
  }
}

/** Refreshes of one integration run one at a time in this process. */
const refreshTails = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = refreshTails.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  refreshTails.set(key, tail);
  void tail.then(() => {
    if (refreshTails.get(key) === tail) refreshTails.delete(key);
  });
  return result;
}

const MAX_REFRESH_ATTEMPTS = 4;

/**
 * A stale OAuth access token, refreshed and sealed again. Safe against a concurrent refresh
 * (this process: one at a time; another one: compare-and-set on the credential's version):
 * - the new secret (with a rotated refresh token) is stored only while the credential is still at
 *   the version it was read at; if someone else stored one first, that one is re-read and used,
 *   and ours is dropped, so a rotated refresh token is never overwritten by an older one;
 * - a refresh the provider refuses is re-read first: if the credential moved on, the refusal was
 *   for a token already rotated away, and the new secret is used; otherwise it is `auth_failed`
 *   (the owner reconnects), never retried in a loop.
 */
async function refreshOAuthSecret(
  integrationId: string,
  workspaceId: string,
  provider: Parameters<typeof refreshGrant>[0],
): Promise<SecretJson> {
  return serialized(integrationId, async () => {
    let current = await readVersioned(integrationId);
    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
      if (!accessTokenStale(current.secret, new Date())) return current.secret;
      let next: Record<string, string>;
      try {
        const grant = await refreshGrant(provider, current.secret['refreshToken'] ?? '');
        next = oauthSecretFromGrant(grant, current.secret['refreshToken'] ?? null, new Date());
      } catch (error) {
        if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
          const again = await readVersioned(integrationId);
          if (again.version !== current.version) {
            current = again;
            continue;
          }
        }
        throw error;
      }
      const plaintext = Buffer.from(JSON.stringify(next), 'utf8');
      let enc: EncBlob;
      try {
        enc = await seal(plaintext, { workspaceId, integrationId, provider }, stageKeyProvider());
      } finally {
        plaintext.fill(0);
      }
      const stored = await (
        await getCredentialRepository()
      ).replaceSealedIf(workspaceId, integrationId, current.version, enc);
      if (stored) return Object.freeze(next);
      current = await readVersioned(integrationId);
    }
    // Contention on the version, not a refusal: transient, never "reconnect".
    throw new ProviderHttpError(provider, null, 'server_error');
  });
}

/**
 * Decrypts the integration's credential and hands it to `fn`; returns what `fn` returns. The
 * decrypted buffer is zeroed before `fn` runs, and `lastUsedAt` is recorded even when `fn` fails.
 * Nothing of the secret gets out (secretHygiene.ts): a result that carries a secret value is
 * refused with a 500, and what `fn` throws has every secret value replaced with [REDACTED] (same
 * error object, so its class, name and code still say what failed). Identity fields such as the
 * account email are labels, not secrets (IDENTITY_FIELDS): they pass both ways.
 * 404 when the integration (not deleted) or its credential is missing.
 */
export async function decryptForSync<T>(
  integrationId: string,
  fn: (secret: SecretJson) => Promise<T>,
): Promise<T> {
  const { workspaceId, provider, plaintext } = await openCredential(integrationId);
  let secret: SecretJson;
  try {
    secret = Object.freeze(parseSecret(plaintext));
  } finally {
    plaintext.fill(0);
  }
  if (isOAuthProviderId(provider) && accessTokenStale(secret, new Date())) {
    secret = await refreshOAuthSecret(integrationId, workspaceId, provider);
  }
  const values = secretValuesOf(secret);
  let result: T;
  try {
    result = await fn(secret);
  } catch (error) {
    throw redactSecrets(error, values);
  } finally {
    await recordUse(workspaceId, integrationId);
  }
  if (carriesSecret(result, values)) {
    logger.error('The credential vault refused a result', {
      integrationId,
      reason: 'vault_result_leak',
    });
    throw new AppError(500, 'The credential vault refused a result that carries the secret');
  }
  return result;
}
