import type { Role as RoleName } from '../types/domain.js';
import { AppError, type AppErrorOptions } from './AppError.js';

/** 403: the caller is a member and may know the thing exists, but their role may not do this. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options: AppErrorOptions = {}) {
    super(403, message, options);
    this.name = 'ForbiddenError';
  }

  /**
   * The role refusal the API has always answered: "Only an owner can …" for an owner-only action,
   * "Only an editor can …" for anything below it.
   */
  static forRole(minRole: RoleName, action = 'do this'): ForbiddenError {
    return new ForbiddenError(ForbiddenError.roleMessage(minRole, action));
  }

  /** The text of `forRole`. */
  static roleMessage(minRole: RoleName, action = 'do this'): string {
    return `Only ${minRole === 'owner' ? 'an owner' : 'an editor'} can ${action}`;
  }
}
