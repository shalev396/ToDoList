import type { AuthMethod } from '../../../types/domain.js';
import { AuthStrategy } from './AuthStrategy.js';

/**
 * Google Calendar read through a service account: the demo's fixture-mode calendar only (its
 * credential is FAKE, and nobody connects this way: Google Calendar connects with Google
 * sign-in). The sync adapter signs its own token exchange, so there are no static headers.
 */
export class ServiceAccountAuth extends AuthStrategy {
  static readonly instance = new ServiceAccountAuth();

  readonly kind = 'service_account';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]] = ['service_account'];

  /** No header: the adapter exchanges the key for a token itself (sync/providers/googleAuth.ts). */
  private constructor() {
    super((): Record<string, string> => ({}));
  }
}
