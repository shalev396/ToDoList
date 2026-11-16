import { AppError } from './AppError.js';

/**
 * 409 `integration_read_only`: a change at the provider through an integration in read-only mode.
 * Only its owner can switch it to read & write.
 *
 * A sibling of ConflictError, not a child: an `instanceof ConflictError` catch answers the version
 * conflict body (`currentVersion`), which this is not.
 */
export class ReadOnlyIntegrationError extends AppError {
  readonly integrationId: string;

  constructor(integrationId: string) {
    super(409, 'This integration is read-only: its owner can switch it to read & write', {
      code: 'integration_read_only',
    });
    this.name = 'ReadOnlyIntegrationError';
    this.integrationId = integrationId;
  }
}
