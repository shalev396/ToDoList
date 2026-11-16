import { AppError } from './AppError.js';

/**
 * 409 `scope_missing`: the integration's grant was given before TodoList asked for a scope this
 * operation needs (creating its own Google calendar needs `calendar.app.created`). Its owner
 * connects it again to grant it; nothing was sent.
 */
export class ScopeMissingError extends AppError {
  readonly integrationId: string;
  readonly scope: string;

  constructor(integrationId: string, scope: string, message: string) {
    super(409, message, { code: 'scope_missing' });
    this.name = 'ScopeMissingError';
    this.integrationId = integrationId;
    this.scope = scope;
  }
}
