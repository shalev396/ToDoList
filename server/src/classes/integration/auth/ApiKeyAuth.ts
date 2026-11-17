import type { AuthMethod } from '../../../types/domain.js';
import {
  AuthStrategy,
  type CredentialShape,
  type HeaderBuilder,
  type QueryBuilder,
  type SecretJson,
} from './AuthStrategy.js';

export interface ApiKeyAuthOptions<TSecret extends SecretJson> {
  /** The stored auth methods (the first is the default of a new connection). */
  methods: readonly [AuthMethod, ...AuthMethod[]];
  headers: HeaderBuilder<TSecret>;
  /** A key the provider takes in the query string instead (Moodle's `wstoken`). */
  query?: QueryBuilder<TSecret>;
  /** What a client's PUT is checked against, and the demo's FAKE credential. */
  credential: CredentialShape;
}

/**
 * Connected with a key or token the user pasted (the fallback to OAuth): Jira's email and API
 * token (Basic), ClickUp's personal token, Linear's personal API key, GitHub's personal access
 * token, Moodle's web-service token. Saved through `PUT …/credential` and validated against the
 * strategy's schema; it never expires on its own schedule here.
 */
export class ApiKeyAuth<TSecret extends SecretJson = SecretJson> extends AuthStrategy<TSecret> {
  readonly kind = 'api_key';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]];
  protected override readonly credentialShape: CredentialShape;

  constructor(options: ApiKeyAuthOptions<TSecret>) {
    super(options.headers, options.query);
    this.methods = options.methods;
    this.credentialShape = options.credential;
  }
}
