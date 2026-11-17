import { ForbiddenError } from './ForbiddenError.js';

/**
 * 403 `integration_not_owner`: a change at the provider through an integration the caller does not
 * own (a shared integration's item): only its owner writes there. The caller sees the item, so
 * this is a 403, not the 404 an integration's own routes answer; the fields its provider lacks
 * stay editable as local overrides.
 */
export class IntegrationNotOwnerError extends ForbiddenError {
  readonly integrationId: string;

  constructor(integrationId: string) {
    super('Only the owner of this integration can change this at its provider', {
      code: 'integration_not_owner',
    });
    this.name = 'IntegrationNotOwnerError';
    this.integrationId = integrationId;
  }
}
