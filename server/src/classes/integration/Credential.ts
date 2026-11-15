/**
 * An integration's credential (DATA.md §0, §3.5, §7; DECISIONS D14): the ONLY code that encrypts
 * or decrypts a provider secret, internal to classes/integration/ (vaultImports.test.ts: only
 * Integration.ts may use it, and MCP code never may).
 *
 * - `Credential.seal` is the one encrypt path: the secret is sealed (AES-256-GCM under a fresh
 *   data key from KMS or the local master key, bound to workspace|integration|provider) and
 *   stored; nothing on that path can decrypt.
 * - `open(fn)` is the one decrypt path: the secret is handed to a callback and never returned.
 *   The plaintext lives for one call and is never cached.
 * - `refreshIfStale` keeps a stored OAuth access token fresh (compare-and-set on the version).
 *
 * KMS envelope encryption is unchanged (services/crypto/envelope.ts, stageKeyProvider.ts).
 */
import { Actor, type ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { AuditLog } from '../AuditLog.js';
import { AppError } from '../../errors/AppError.js';
import type { CredentialData } from '../../models/definitions/Credential.js';
import { getCredentialRepository, getIntegrationRepository } from '../../models/index.js';
import { open, seal, type EncBlob } from '../../services/crypto/envelope.js';
import {
  carriesSecret,
  redactSecrets,
  secretValuesOf,
} from '../../services/crypto/secretHygiene.js';
import { stageKeyProvider } from '../../services/crypto/stageKeyProvider.js';
import { logger } from '../../services/logger.js';
import { ProviderHttpError } from '../../sync/errors.js';
import type { Provider } from '../../types/domain.js';
import type { SecretJson } from './auth/AuthStrategy.js';
import type { OAuthAuth } from './auth/OAuthAuth.js';
import { definitionOf } from './definitions/index.js';

export type { SecretJson };

/** What sealing needs: the integration it belongs to and the secret, write-only from here on. */
export interface SealInput {
  workspaceId: string;
  integrationId: string;
  /** Must be the integration's provider: it is part of what the ciphertext is bound to. */
  provider: Provider;
  ownerUserId: string;
  kind: string;
  scopes?: string[] | undefined;
  /** Every secret the provider needs, e.g. Jira `{email, token}`. Write-only from here on. */
  secret: Record<string, string>;
  expiresAt?: Date | null | undefined;
}

interface Opened {
  workspaceId: string;
  provider: string;
  /** The credential's version (compare-and-set key of an OAuth refresh). */
  version: number;
  plaintext: Buffer;
}

interface Versioned {
  secret: SecretJson;
  version: number;
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

export class Credential<TSecret extends SecretJson = SecretJson> {
  readonly #integrationId: string;

  private constructor(integrationId: string) {
    this.#integrationId = integrationId;
    Object.freeze(this);
  }

  /** The credential of an integration, by its id (nothing is read until `open`). */
  static of<TSecret extends SecretJson = SecretJson>(integrationId: string): Credential<TSecret> {
    return new Credential<TSecret>(integrationId);
  }

  /**
   * Seals and stores the integration's credential, replacing the one it has (`rotatedAt` is then
   * set), and links it as `Integration.credentialId`. Audited as `integration.connect` (the first
   * credential) or `credential.rotate` (a replacement), by `ownerUserId`, from `actor`'s request
   * (its address and user agent; none for a seed or a test). 404 for an unknown integration.
   */
  static async seal(input: SealInput, actor?: ActorRef): Promise<void> {
    const { workspaceId, integrationId, provider } = input;
    const integrations = await getIntegrationRepository();
    const integration = await integrations.findById(workspaceId, integrationId);
    if (integration === null) throw new AppError(404, 'Integration not found');
    if (integration.provider !== provider) {
      throw new Error('Credential.seal: the provider is not the integration’s');
    }
    const values = Object.values(input.secret);
    if (values.length === 0 || !values.every((value) => typeof value === 'string')) {
      throw new AppError(400, 'A secret is a non-empty set of text values');
    }

    const credentials = await getCredentialRepository();
    const replacing = (await credentials.findMeta(workspaceId, integrationId)) !== null;
    const plaintext = Buffer.from(JSON.stringify(input.secret), 'utf8');
    let enc: EncBlob;
    try {
      enc = await seal(plaintext, { workspaceId, integrationId, provider }, stageKeyProvider());
    } finally {
      plaintext.fill(0);
    }
    const stored = await credentials.upsertSealed(workspaceId, integrationId, {
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      scopes: input.scopes ?? [],
      expiresAt: input.expiresAt ?? null,
      enc,
      ...(replacing ? { rotatedAt: new Date() } : {}),
    });
    if (integration.credentialId !== stored.id) {
      await integrations.update(workspaceId, integrationId, { credentialId: stored.id });
    }
    // No secret data (DATA.md §3.10): the credential is referenced by its id only.
    await AuditLog.record(
      {
        workspaceId,
        actor: Actor.user(input.ownerUserId, { ip: actor?.ip, userAgent: actor?.userAgent }),
      },
      replacing ? 'credential.rotate' : 'integration.connect',
      AuditTarget.integration(integrationId),
      { credentialId: stored.id, provider, kind: input.kind },
    );
  }

  /** The credential's metadata (kind, scopes, dates; never the ciphertext), or null: none yet. */
  static async meta(workspaceId: string, integrationId: string): Promise<CredentialData | null> {
    return (await getCredentialRepository()).findMeta(workspaceId, integrationId);
  }

  /** Hard-deletes the credential, then checks it is gone (a survivor is a 500, loudly). */
  static async destroy(workspaceId: string, integrationId: string): Promise<void> {
    const credentials = await getCredentialRepository();
    await credentials.delete(workspaceId, integrationId);
    if ((await credentials.findMeta(workspaceId, integrationId)) !== null) {
      throw new Error('A disconnect left its credential behind');
    }
  }

  get integrationId(): string {
    return this.#integrationId;
  }

  /**
   * Decrypts the integration's credential and hands it to `fn`; returns what `fn` returns. The
   * decrypted buffer is zeroed before `fn` runs, and `lastUsedAt` is recorded even when `fn`
   * fails. A stored OAuth access token close to its expiry is refreshed first
   * (refreshIfStale). Nothing of the secret gets out (secretHygiene.ts): a result that carries a
   * secret value is refused with a 500, and what `fn` throws has every secret value replaced with
   * [REDACTED] (same error object, so its class, name and code still say what failed). Identity
   * fields such as the account email are labels, not secrets (IDENTITY_FIELDS): they pass both
   * ways. 404 when the integration (not deleted) or its credential is missing.
   */
  async open<T>(fn: (secret: TSecret) => Promise<T>): Promise<T> {
    const integrationId = this.#integrationId;
    const { workspaceId, provider, plaintext } = await this.#openSealed();
    let secret: SecretJson;
    try {
      secret = Object.freeze(parseSecret(plaintext));
    } finally {
      plaintext.fill(0);
    }
    // The provider's OAuth strategy keeps a stored access token fresh (a per-call grant never is).
    const oauth = definitionOf(provider)?.auth.oauth;
    if (oauth?.needsRefresh(secret, new Date()) === true) {
      secret = await this.refreshIfStale(oauth, workspaceId);
    }
    const values = secretValuesOf(secret);
    let result: T;
    try {
      result = await fn(secret as TSecret);
    } catch (error) {
      throw redactSecrets(error, values);
    } finally {
      await Credential.#recordUse(workspaceId, integrationId);
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

  /**
   * A stale OAuth access token, refreshed through `auth` and sealed again. Safe against a
   * concurrent refresh (this process: one at a time; another one: compare-and-set on the
   * credential's version):
   * - the new secret (with a rotated refresh token) is stored only while the credential is still
   *   at the version it was read at; if someone else stored one first, that one is re-read and
   *   used, and ours is dropped, so a rotated refresh token is never overwritten by an older one;
   * - a refresh the provider refuses is re-read first: if the credential moved on, the refusal
   *   was for a token already rotated away, and the new secret is used; otherwise it is
   *   `auth_failed` (the owner reconnects), never retried in a loop.
   */
  async refreshIfStale(auth: OAuthAuth, workspaceId: string): Promise<SecretJson> {
    const integrationId = this.#integrationId;
    const provider = auth.provider;
    return serialized(integrationId, async () => {
      let current = await this.#readVersioned();
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
        if (!auth.needsRefresh(current.secret, new Date())) return current.secret;
        let next: Record<string, string>;
        try {
          next = await auth.refresh(current.secret);
        } catch (error) {
          if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
            const again = await this.#readVersioned();
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
        current = await this.#readVersioned();
      }
      // Contention on the version, not a refusal: transient, never "reconnect".
      throw new ProviderHttpError(provider, null, 'server_error');
    });
  }

  /** Decrypts the integration's credential. The caller zeroes `plaintext`. */
  async #openSealed(): Promise<Opened> {
    const integrationId = this.#integrationId;
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
      // (ThrottlingException, AccessDeniedException…) from a tampered or misplaced ciphertext.
      logger.error('A credential could not be opened', {
        integrationId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new Error('The credential could not be decrypted');
    }
  }

  /** Opens the credential again: what another refresh may have stored meanwhile. */
  async #readVersioned(): Promise<Versioned> {
    const { plaintext, version } = await this.#openSealed();
    try {
      return { secret: Object.freeze(parseSecret(plaintext)), version };
    } finally {
      plaintext.fill(0);
    }
  }

  /** lastUsedAt is bookkeeping: failing to record it never fails the call. */
  static async #recordUse(workspaceId: string, integrationId: string): Promise<void> {
    try {
      await (await getCredentialRepository()).touch(workspaceId, integrationId, new Date());
    } catch (error) {
      logger.warn('Could not record a credential use', error);
    }
  }
}
