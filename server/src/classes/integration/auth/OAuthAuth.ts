import { isLoopbackHost } from '../../../services/netGuard.js';
import { AppSecretError, getAppSecret, type AppSecretName } from '../../../services/appSecrets.js';
import { pkceChallenge } from '../../../services/crypto/hashing.js';
import { accessTokenStale, oauthSecretFromGrant } from '../../../services/oauth/secret.js';
import { oauthTransport } from '../../../services/oauth/transport.js';
import {
  createReadOnlyClient,
  DestinationRefusedError,
  ProviderHttpError,
  type HttpResponse,
  type ReadOnlyClient,
  type TokenGrant,
  type Transport,
} from '../../../sync/http.js';
import {
  isOAuthProviderId,
  oauthMockOrigin,
  standInEndpoints,
  type OAuthProviderEndpoints,
  type OAuthProviderId,
} from '../../../sync/providers/oauthEndpoints.js';
import type { AuthMethod } from '../../../types/domain.js';
import {
  AuthStrategy,
  type AdapterAuth,
  type AuthSession,
  type SecretJson,
} from './AuthStrategy.js';

/**
 * How an OAuth access token is kept fresh:
 * - `stored`: the sealed secret holds an expiring access token and its refresh token, refreshed
 *   (and sealed again) when it is close to its expiry (GitHub, Jira, ClickUp, Linear);
 * - `per_call`: the sealed secret holds the refresh token only, and every session trades it for
 *   an access token kept in memory for that session (Google Calendar).
 */
export type RefreshPolicy = 'stored' | 'per_call';

/** A provider that signs in with OAuth: the four of the shared routes, and Google Calendar. */
export type OAuthProvider = OAuthProviderId | 'google_calendar';

export type { OAuthProviderEndpoints };

/** The OAuth app's id and secret (and GitHub's slug, for its install link). */
export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
  /** GitHub only (optional in the secret): the app's slug, for its install link. */
  appSlug?: string;
}

/** What identify() learns: the account key and label, and the settings a new integration starts with. */
export interface ProviderIdentity {
  accountId: string;
  label: string;
  config: Record<string, unknown>;
  /** The default topic (slug) a new connection starts in. */
  topicSlug: string;
}

/** The texts of a provider's sign-in, as its routes and its errors say them. */
export interface OAuthMessages {
  /** 409 `oauth_unavailable`: this server has no OAuth app for the provider. */
  unavailable: string;
  /** 400: a reconnect started from an integration that is not this provider's OAuth one. */
  notReconnectable: string;
  /** A refresh on a server without the app (fixing the server fixes it). */
  notSetUp: string;
  /** The app secret exists but can't be read. */
  secretUnreadable: string;
}

/** A provider's OAuth app, as its definition declares it (definitions/*). */
export interface OAuthAppOptions {
  provider: OAuthProvider;
  /** The app secret holding `{clientId, clientSecret}`. */
  secretName: AppSecretName;
  /** The provider's own endpoints. */
  endpoints: OAuthProviderEndpoints;
  /** The endpoints to call now, when not the stand-in's of the four (Google: googleEndpoints()). */
  liveEndpoints?: () => OAuthProviderEndpoints;
  /** Where the provider sends the browser back: the URL the operator registers (never changes). */
  callbackPath: string;
  /** Requested on every connection: read-only where the provider has scopes. */
  scopes: readonly string[];
  /** Asked for later, by re-consent, when the user creates there (H5). Not requested by default. */
  writeScopes?: readonly string[];
  /** Scopes a grant must carry to be kept (Google lets the user untick one). */
  requiredScopes?: readonly string[];
  /** Linear takes its scopes comma separated; the others space separated. */
  scopeSeparator?: ' ' | ',';
  pkce: boolean;
  /** Sent with `response_type=code`; GitHub's and ClickUp's authorize pages take none. */
  sendResponseType: boolean;
  /** Extra authorize parameters. */
  authorizeParams?: Readonly<Record<string, string>>;
  /** A reconnect offers its account first (`login_hint`, Google). */
  loginHint?: boolean;
  /** Token requests as JSON (Atlassian) or a form. */
  tokenFormat?: 'form' | 'json';
  refresh: RefreshPolicy;
  /** An expiring access token must come with a refresh token (`stored` only). */
  refreshRequired?: boolean;
  /** Where the operator registers the OAuth app. */
  consoleUrl: string;
  /** The transport of the app's own calls (token, refresh, revoke, identity). */
  transport?: () => Transport;
  /** GraphQL read documents the identity step sends (Linear's `Viewer`), at `<api>/graphql`. */
  identityDocuments?: Readonly<Record<string, string>>;
  messages?: Partial<OAuthMessages>;
  /** The connected account, read with the grant's access token. */
  identify(client: ReadOnlyClient, accessToken: string): Promise<ProviderIdentity>;
  /** GitHub: where the user installs the app on what it may read. */
  installUrl?(credentials: OAuthAppCredentials | null): string | null;
  /** A callback the provider sends without our state, which only lands the user back (GitHub). */
  landsWithoutState?(query: Readonly<Record<string, unknown>>): boolean;
}

/** The authorize URL's inputs: the flow's state and verifier, and what this connection asks. */
export interface AuthorizeRequest {
  clientId: string;
  /** The callback URL registered with the provider (OAuthFlow: on the stage's own domain). */
  redirectUri: string;
  state: string;
  verifier: string;
  /** Also ask for the write scopes (H5). */
  includeWrite: boolean;
  /** The account a reconnect offers first, where the provider takes a hint. */
  loginHint: string | null;
}

/** The bearer header of a stored access token. */
const bearerOf = (secret: SecretJson): Record<string, string> => ({
  authorization: `Bearer ${secret['accessToken'] ?? ''}`,
});

/**
 * Connected through the provider's OAuth sign-in (OAuthFlow): the user's own grant, sealed as
 * `{accessToken, refreshToken?, accessTokenExpiresAt?, scope}` (or Google's `{refreshToken,
 * scope}`). Its credential arrives only through the OAuth callback; a credential PUT for it is
 * refused like any shape that doesn't fit.
 *
 * The strategy is also the provider's OAuth app: its endpoints, scopes and parameters, the token
 * client, the refresh and the revoke. Nothing secret is logged, returned or put in an error.
 */
export class OAuthAuth<TSecret extends SecretJson = SecretJson> extends AuthStrategy<TSecret> {
  readonly kind = 'oauth';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]] = ['oauth'];
  readonly provider: OAuthProvider;
  readonly refreshPolicy: RefreshPolicy;
  readonly secretName: AppSecretName;
  readonly callbackPath: string;
  readonly scopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly consoleUrl: string;
  readonly messages: OAuthMessages;
  readonly #app: OAuthAppOptions;

  constructor(app: OAuthAppOptions) {
    super((secret) => (app.refresh === 'stored' ? bearerOf(secret) : {}));
    this.#app = app;
    this.provider = app.provider;
    this.refreshPolicy = app.refresh;
    this.secretName = app.secretName;
    this.callbackPath = app.callbackPath;
    this.scopes = app.scopes;
    this.writeScopes = app.writeScopes ?? [];
    this.consoleUrl = app.consoleUrl;
    this.messages = {
      unavailable: `Signing in with ${app.provider} is not set up on this server`,
      notReconnectable: `integrationId: not a ${app.provider} connected with OAuth`,
      notSetUp: `${app.provider} sign-in is not set up on this server`,
      secretUnreadable: `The ${app.provider} OAuth secret could not be read`,
      ...app.messages,
    };
  }

  // ─── The app ──────────────────────────────────────────────────────────────

  /** The endpoints to call: the provider's, or a test's stand-in. */
  endpoints(): OAuthProviderEndpoints {
    if (this.#app.liveEndpoints !== undefined) return this.#app.liveEndpoints();
    const provider: string = this.provider;
    return isOAuthProviderId(provider)
      ? standInEndpoints(provider, this.#app.endpoints)
      : this.#app.endpoints;
  }

  /**
   * The OAuth app's id and secret, or null when this server has none configured. Any other
   * failure throws a generic error (appSecrets.ts has logged its kind, never the value).
   */
  async credentials(): Promise<OAuthAppCredentials | null> {
    try {
      const json = await getAppSecret<Record<string, unknown>>(this.secretName);
      const { clientId, clientSecret, appSlug } = json;
      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
      return {
        clientId,
        clientSecret,
        ...(typeof appSlug === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(appSlug)
          ? { appSlug }
          : {}),
      };
    } catch (error) {
      if (error instanceof AppSecretError && error.reason === 'missing') return null;
      throw new Error(this.messages.secretUnreadable);
    }
  }

  /** A client for the app's token, revoke and identity calls (the allow-listed URLs only). */
  client(transport: Transport = (this.#app.transport ?? oauthTransport)()): ReadOnlyClient {
    const endpoints = this.endpoints();
    const documents = this.#app.identityDocuments;
    return createReadOnlyClient({
      provider: this.provider,
      transport,
      tokenExchangeUrl: endpoints.token,
      ...(endpoints.revoke === null ? {} : { revokeUrl: endpoints.revoke }),
      ...(documents === undefined
        ? {}
        : { graphql: { endpoint: `${endpoints.api}/graphql`, documents: { ...documents } } }),
    });
  }

  /** The provider's authorize URL for one flow. */
  authorizeUrl(request: AuthorizeRequest): string {
    const app = this.#app;
    const params = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
    });
    if (app.sendResponseType) params.set('response_type', 'code');
    const scopes = request.includeWrite ? [...this.scopes, ...this.writeScopes] : this.scopes;
    if (scopes.length > 0) params.set('scope', scopes.join(app.scopeSeparator ?? ' '));
    for (const [name, value] of Object.entries(app.authorizeParams ?? {})) params.set(name, value);
    if (app.pkce) {
      params.set('code_challenge', pkceChallenge(request.verifier));
      params.set('code_challenge_method', 'S256');
    }
    if (app.loginHint === true && request.loginHint?.includes('@') === true) {
      params.set('login_hint', request.loginHint);
    }
    return `${this.endpoints().authorize}?${params.toString()}`;
  }

  /** The authorization code traded for a grant, at the allow-listed token URL. */
  exchangeCode(
    client: ReadOnlyClient,
    grant: { code: string; verifier: string; redirectUri: string },
    credentials: OAuthAppCredentials,
  ): Promise<TokenGrant> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code: grant.code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: grant.redirectUri,
    };
    if (this.#app.pkce) form['code_verifier'] = grant.verifier;
    return client.exchangeToken(form, { format: this.#app.tokenFormat ?? 'form' });
  }

  /**
   * Whether a grant can be kept: a per-call grant needs its refresh token, and an expiring access
   * token without one would stop working within hours.
   */
  grantUsable(grant: TokenGrant): boolean {
    if (this.refreshPolicy === 'per_call') return grant.refreshToken !== null;
    return !(
      grant.expiresIn !== null &&
      grant.refreshToken === null &&
      this.#app.refreshRequired === true
    );
  }

  /** The scopes a grant carries. */
  scopesOf(grant: TokenGrant): string[] {
    return (grant.scope ?? '').split(/[\s,]+/).filter((scope) => scope !== '');
  }

  /** Whether a scope the integration needs was left out of the grant. */
  lacksRequiredScope(scopes: readonly string[]): boolean {
    return (this.#app.requiredScopes ?? []).some((scope) => !scopes.includes(scope));
  }

  /** The secret sealed from a new grant. */
  secretFromGrant(grant: TokenGrant, scopes: readonly string[], now: Date): Record<string, string> {
    if (this.refreshPolicy === 'per_call') {
      return { refreshToken: grant.refreshToken ?? '', scope: scopes.join(' ') };
    }
    return oauthSecretFromGrant(grant, null, now);
  }

  /** The connected account, read with the grant's access token. */
  identify(client: ReadOnlyClient, accessToken: string): Promise<ProviderIdentity> {
    return this.#app.identify(client, accessToken);
  }

  /** GitHub: where the user installs the app; null for the others. */
  installUrl(credentials: OAuthAppCredentials | null): string | null {
    return this.#app.installUrl?.(credentials) ?? null;
  }

  /** A callback that carries no state of ours and only lands the user back (GitHub's install). */
  landsWithoutState(query: Readonly<Record<string, unknown>>): boolean {
    return this.#app.landsWithoutState?.(query) ?? false;
  }

  // ─── The grant ────────────────────────────────────────────────────────────

  /** A stored access token close to its expiry (ACCESS_TOKEN_SKEW_MS) is refreshed first. */
  needsRefresh(secret: SecretJson, now: Date): boolean {
    return this.refreshPolicy === 'stored' && accessTokenStale(secret, now);
  }

  /**
   * The next secret: the refresh token traded for a new grant at the provider, the old refresh
   * token kept when the provider did not rotate it. A refused refresh is `auth_failed`.
   */
  async refresh(secret: SecretJson): Promise<Record<string, string>> {
    if (this.refreshPolicy !== 'stored') {
      throw new Error(`${this.provider} does not refresh a stored access token`);
    }
    const refreshToken = secret['refreshToken'] ?? '';
    const grant = await this.#refreshGrant(this.client(), refreshToken);
    return oauthSecretFromGrant(grant, secret['refreshToken'] ?? null, new Date());
  }

  /**
   * A fresh access token of a per-call grant (Google), through `client` (built with the token
   * URL), kept by the caller in memory for one session only. A refresh token that no longer works
   * (revoked, or the 7-day expiry of a Google app in Testing) is `auth_failed`: the owner
   * reconnects. A server without the OAuth app is a plain error (fixing the server fixes it).
   */
  async freshAccessToken(secret: SecretJson, client: ReadOnlyClient): Promise<string> {
    if (this.refreshPolicy === 'stored') return secret['accessToken'] ?? '';
    return (await this.#refreshGrant(client, secret['refreshToken'] ?? '')).accessToken;
  }

  /**
   * Hands the grant back to the provider (RFC 7009), where it has a revocation endpoint. False
   * when it has none. Errors propagate: the caller decides (a disconnect never waits on it).
   */
  async revoke(secret: SecretJson): Promise<boolean> {
    if (this.endpoints().revoke === null) return false;
    await this.client().revokeToken(secret['refreshToken'] ?? secret['accessToken'] ?? '');
    return true;
  }

  /** A per-call grant trades its refresh token once per session (memory only); a stored one is a bearer. */
  override bind(session: AuthSession<TSecret>): AdapterAuth {
    if (this.refreshPolicy === 'stored') return super.bind(session);
    const { secret, client } = session;
    let token: Promise<string> | null = null;
    return {
      kind: this.kind,
      headers: async (): Promise<Record<string, string>> => {
        token ??= this.freshAccessToken(secret, client);
        return { authorization: `Bearer ${await token}` };
      },
      query: () => ({}),
    };
  }

  /**
   * The transport of a session of this integration. Unchanged in a server. While a test points
   * the providers at its in-process stand-in (setOAuthBaseUrlForTests), the provider's API base is
   * rewritten to the stand-in and any request left for a non-loopback host is refused. The
   * adapters stay unaware.
   */
  override transport(inner: Transport): Transport {
    const provider: string = this.provider;
    if (!isOAuthProviderId(provider) || oauthMockOrigin() === null) return inner;
    const real = this.#app.endpoints.api;
    const mocked = this.endpoints().api;
    return {
      ...(inner.maxRetries === undefined ? {} : { maxRetries: inner.maxRetries }),
      async send(request): Promise<HttpResponse> {
        const url =
          request.url === real || request.url.startsWith(`${real}/`)
            ? `${mocked}${request.url.slice(real.length)}`
            : request.url;
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          // Refused below.
        }
        if (!isLoopbackHost(host)) throw new DestinationRefusedError();
        return await inner.send({ ...request, url });
      },
    };
  }

  async #refreshGrant(client: ReadOnlyClient, refreshToken: string): Promise<TokenGrant> {
    const credentials = await this.credentials();
    if (credentials === null) throw new Error(this.messages.notSetUp);
    if (refreshToken === '') throw new ProviderHttpError(this.provider, null, 'auth_failed');
    return client.exchangeToken(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      },
      { format: this.#app.tokenFormat ?? 'form' },
    );
  }
}
