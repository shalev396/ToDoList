import { AppError, type AppErrorOptions } from './AppError.js';

/** 400: the input is not valid. The message names the field and the rule, never its value. */
export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(400, message, options);
    this.name = 'ValidationError';
  }
}
