import type { AuthMethod } from '../../../types/domain.js';
import { parseCredential } from '../../../services/integrationConfig.js';

/** A decrypted credential, e.g. Jira `{email, token}`: text values only, read-only. */
export type SecretJson = Readonly<Record<string, string>>;

/** How an integration proves itself to its provider. */
export type AuthKind = 'oauth' | 'api_key' | 'service_account';

/** What a request is for: some providers sign a write differently (none today). */
export type HeaderPurpose = 'read' | 'write';

/** The request headers a provider call carries, built from the opened secret. */
export type HeaderBuilder<TSecret extends SecretJson> = (
  secret: TSecret,
  purpose: HeaderPurpose,
) => Record<string, string>;

/**
 * One way of connecting an integration (strategy): OAuth, an API key or token, or the demo's
 * service account. An integration holds the strategy of its stored `authMethod`
 * (Integration#auth); the provider classes declare which ones they offer through the
 * SupportsOAuth and SupportsApiKey contracts.
 *
 * A strategy holds no secret: the credential is opened for one call (Credential#open) and handed
 * to `headers`, which only shapes it into request headers.
 */
export abstract class AuthStrategy<TSecret extends SecretJson = SecretJson> {
  abstract readonly kind: AuthKind;
  /** The stored auth methods this strategy reads (the first is the default). */
  abstract readonly methods: readonly [AuthMethod, ...AuthMethod[]];

  /** Held as a method, so a strategy of a narrower secret still is a strategy (bivariant). */
  readonly #headers: { build(secret: TSecret, purpose: HeaderPurpose): Record<string, string> };

  protected constructor(headers: HeaderBuilder<TSecret>) {
    this.#headers = { build: headers };
  }

  /** Whether an integration stored with `method` connects this way. */
  handles(method: AuthMethod): boolean {
    return this.methods.includes(method);
  }

  /**
   * The credential JSON a client sent (`PUT …/credential`) for `method`, validated and trimmed.
   * Anything else is one fixed 400 that repeats nothing of the input (integrationConfig.ts).
   */
  parseCredential(method: AuthMethod, raw: unknown): Record<string, string> {
    return parseCredential(method, raw);
  }

  /** The provider's request headers from the opened secret (empty values in fixtures mode). */
  headers(secret: TSecret, purpose: HeaderPurpose = 'read'): Record<string, string> {
    return this.#headers.build(secret, purpose);
  }
}
