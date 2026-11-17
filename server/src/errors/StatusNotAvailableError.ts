import type { ItemStatus } from '../types/domain.js';
import { AppError } from './AppError.js';

/**
 * 422 `status_not_available`: a write-back asked for a status the provider has no way to reach for
 * this item (no Jira transition into that status category, no ClickUp status of that type in the
 * list, no Linear workflow state of that type, GitHub's "in progress" lives on a board). Nothing
 * was sent.
 */
export class StatusNotAvailableError extends AppError {
  readonly provider: string;
  readonly status: ItemStatus;

  constructor(provider: string, status: ItemStatus) {
    super(422, `${provider} has no way to set this item to ${status}`, {
      code: 'status_not_available',
    });
    this.name = 'StatusNotAvailableError';
    this.provider = provider;
    this.status = status;
  }
}
