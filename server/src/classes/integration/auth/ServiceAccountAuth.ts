import { bearerHeaders, serviceAccountToken } from './googleServiceAccount.js';
import type { AuthMethod, Provider } from '../../../types/domain.js';
import {
  AuthStrategy,
  type AdapterAuth,
  type AuthSession,
  type CredentialShape,
  type SecretJson,
} from './AuthStrategy.js';

export interface ServiceAccountAuthOptions {
  provider: Provider;
  /** The one scope each exchanged token carries (read only). */
  scope: string;
  credential: CredentialShape;
}

/**
 * Read through a Google service account: the demo's fixture-mode calendar only (its credential is
 * FAKE, and nobody connects this way: Google Calendar connects with Google sign-in). There are no
 * static headers: each call of a session signs an assertion and trades it for an access token
 * through the session's client (googleServiceAccount.ts), one exchange per resource.
 */
export class ServiceAccountAuth<
  TSecret extends SecretJson = SecretJson,
> extends AuthStrategy<TSecret> {
  readonly kind = 'service_account';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]] = ['service_account'];
  readonly provider: Provider;
  readonly scope: string;
  protected override readonly credentialShape: CredentialShape;

  constructor(options: ServiceAccountAuthOptions) {
    super((): Record<string, string> => ({}));
    this.provider = options.provider;
    this.scope = options.scope;
    this.credentialShape = options.credential;
  }

  /**
   * Every call of the session exchanges a fresh assertion: nothing is kept between them. The
   * account it names (the service account's email, a label, not a secret) is what a connection
   * test reports.
   */
  override bind(session: AuthSession<TSecret>): AdapterAuth {
    const email = session.secret['clientEmail'];
    return {
      kind: this.kind,
      headers: async (): Promise<Record<string, string>> =>
        bearerHeaders(await serviceAccountToken(session, this.provider, this.scope)),
      query: () => ({}),
      account: () => (typeof email === 'string' && email.trim() !== '' ? email : null),
    };
  }
}
