import { AppError } from './AppError.js';

/** 400: the integration (its provider, or the way it was connected) can't do what was asked. */
export class CapabilityError extends AppError {
  /** What was asked, as a verb phrase: "create tasks", "list calendars". */
  readonly capability: string;

  constructor(capability: string, message = `This integration can't ${capability}`) {
    super(400, message);
    this.name = 'CapabilityError';
    this.capability = capability;
  }
}
