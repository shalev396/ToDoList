import type { AuthMethod } from '../../../types/domain.js';
import { AuthStrategy, type AuthKind, type SecretJson } from './AuthStrategy.js';

/**
 * The strategy of an integration stored with a method its class does not offer (a null object:
 * data written before a provider changed, a provider nobody connects). It builds no header; a
 * credential for it is checked against the shape that method has wherever it is offered
 * (`credentialOf`), so it still reads as what it is.
 */
export class UnofferedAuth<TSecret extends SecretJson = SecretJson> extends AuthStrategy<TSecret> {
  readonly kind: AuthKind;
  readonly methods: readonly [AuthMethod, ...AuthMethod[]];
  readonly #credentialOf: AuthStrategy | null;

  constructor(method: AuthMethod, credentialOf: AuthStrategy | null) {
    super((): Record<string, string> => ({}));
    this.methods = [method];
    this.kind =
      method === 'oauth' ? 'oauth' : method === 'service_account' ? 'service_account' : 'api_key';
    this.#credentialOf = credentialOf;
  }

  override parseCredential(method: AuthMethod, raw: unknown): Record<string, string> {
    if (this.#credentialOf === null || !this.handles(method)) {
      return super.parseCredential(method, raw);
    }
    return this.#credentialOf.parseCredential(method, raw);
  }
}
