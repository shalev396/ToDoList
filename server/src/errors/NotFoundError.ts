import { AppError, type AppErrorOptions } from './AppError.js';

/**
 * 404. Also what a caller gets for something it may not know exists: another workspace's id,
 * another member's integration or private dashboard all read as "Not found", never 403.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found', options: AppErrorOptions = {}) {
    super(404, message, options);
    this.name = 'NotFoundError';
  }
}
