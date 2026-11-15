import type { AuthMethod } from '../../../types/domain.js';
import { AuthStrategy, type HeaderBuilder, type SecretJson } from './AuthStrategy.js';

export interface ApiKeyAuthOptions<TSecret extends SecretJson> {
  /** The stored auth methods (the first is the default of a new connection). */
  methods: readonly [AuthMethod, ...AuthMethod[]];
  headers: HeaderBuilder<TSecret>;
}

/**
 * Connected with a key or token the user pasted (the fallback to OAuth, INTEGRATIONS-SETUP.md):
 * Jira's email and API token (Basic), ClickUp's personal token, Linear's personal API key,
 * GitHub's personal access token, Moodle's web-service token. Saved through
 * `PUT …/credential` and validated per method; it never expires on its own schedule here.
 */
export class ApiKeyAuth<TSecret extends SecretJson = SecretJson> extends AuthStrategy<TSecret> {
  readonly kind = 'api_key';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]];

  constructor(options: ApiKeyAuthOptions<TSecret>) {
    super(options.headers);
    this.methods = options.methods;
  }
}
