import { AppError } from '../../../errors/AppError.js';
import type { ReadOnlyClient, Transport } from '../../../sync/http.js';
import type { AdapterAuth, AuthKind, HeaderPurpose } from '../../../sync/types.js';
import type { AuthMethod } from '../../../types/domain.js';
import { INVALID_CREDENTIAL, type CredentialSchema } from '../definitions/fields.js';

export type { AdapterAuth, AuthKind, HeaderPurpose };

/** A decrypted credential, e.g. Jira `{email, token}`: text values only, read-only. */
export type SecretJson = Readonly<Record<string, string>>;

/** The request headers a provider call carries, built from the opened secret. */
export type HeaderBuilder<TSecret extends SecretJson> = (
  secret: TSecret,
  purpose: HeaderPurpose,
) => Record<string, string>;

/** One session a strategy's auth is bound to: the opened secret, the session's client, its time. */
export interface AuthSession<TSecret extends SecretJson> {
  secret: TSecret;
  /** For a provider that trades its credential for a token first (Google). */
  client: ReadOnlyClient;
  now: Date;
}

/** A credential the provider takes in the query string instead of a header (Moodle). */
export type QueryBuilder<TSecret extends SecretJson> = (secret: TSecret) => Record<string, string>;

/** What a strategy's credential is checked against, and the demo data's FAKE one. */
export interface CredentialShape {
  schema: CredentialSchema;
  /** The demo integration's credential (definitions/fake.ts): its shape, the FAKE mark. */
  fake(name: string): Record<string, string>;
}

/**
 * One way of connecting an integration (strategy): OAuth, an API key or token, or the demo's
 * service account. A provider's definition (definitions/*) holds the strategies it offers, and an
 * integration uses the one of its stored `authMethod` (Integration#auth).
 *
 * A strategy holds no secret: the credential is opened for one call (Credential#open) and handed
 * to it, and it shapes it into what the provider calls carry. It is the only code that builds an
 * auth header: the sync adapters, the connection test and the create path all get theirs here
 * (`headers`, or `bind` for a session).
 */
export abstract class AuthStrategy<TSecret extends SecretJson = SecretJson> {
  abstract readonly kind: AuthKind;
  /** The stored auth methods this strategy reads (the first is the default). */
  abstract readonly methods: readonly [AuthMethod, ...AuthMethod[]];

  /** The credential's shape for a client's PUT, and the demo's FAKE one; null: none is taken. */
  protected readonly credentialShape: CredentialShape | null = null;

  /** Held as methods, so a strategy of a narrower secret still is a strategy (bivariant). */
  readonly #headers: { build(secret: TSecret, purpose: HeaderPurpose): Record<string, string> };
  readonly #query: { build(secret: TSecret): Record<string, string> } | null;

  protected constructor(headers: HeaderBuilder<TSecret>, query?: QueryBuilder<TSecret>) {
    this.#headers = { build: headers };
    this.#query = query === undefined ? null : { build: query };
  }

  /** Whether an integration stored with `method` connects this way. */
  handles(method: AuthMethod): boolean {
    return this.methods.includes(method);
  }

  /**
   * The credential JSON a client sent (`PUT …/credential`) for `method`, validated and trimmed.
   * Anything else is one fixed 400 that repeats nothing of the input. None by default: an OAuth
   * grant arrives through its callback only.
   */
  parseCredential(method: AuthMethod, raw: unknown): Record<string, string> {
    const shape = this.handles(method) ? this.credentialShape : null;
    const result = shape?.schema.safeParse(raw);
    if (result?.success !== true) throw new AppError(400, INVALID_CREDENTIAL);
    const secret: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.data)) {
      if (typeof value === 'string') secret[key] = value;
    }
    return secret;
  }

  /** The demo data's FAKE credential for `method`, as `PUT …/credential` takes it; null: none. */
  fakeCredential(method: AuthMethod, name: string): Record<string, string> | null {
    return this.handles(method) ? (this.credentialShape?.fake(name) ?? null) : null;
  }

  /** The provider's request headers from the opened secret (empty values in fixtures mode). */
  headers(secret: TSecret, purpose: HeaderPurpose = 'read'): Record<string, string> {
    return this.#headers.build(secret, purpose);
  }

  /** A credential the provider takes in the query string instead of a header (Moodle). */
  query(secret: TSecret): Record<string, string> {
    return this.#query?.build(secret) ?? {};
  }

  /**
   * One session's auth (a sync run, a connection test, a create): the headers of each call, from
   * the opened secret. The session's client is for a provider that trades its credential for a
   * token first (Google); the others build their headers from the secret alone.
   */
  bind(session: AuthSession<TSecret>): AdapterAuth {
    const { secret } = session;
    return {
      kind: this.kind,
      headers: (purpose: HeaderPurpose = 'read') => Promise.resolve(this.headers(secret, purpose)),
      query: () => this.query(secret),
    };
  }

  /**
   * The transport a session of this integration goes out on: unchanged, except while a test
   * points the OAuth providers at its in-process stand-in (OAuthAuth).
   */
  transport(inner: Transport): Transport {
    return inner;
  }
}
