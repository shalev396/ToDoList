/** How a provider's refusal reads to the user (H5): the same 403 means different things per connection. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IntegrationData } from '../../models/definitions/Integration.js';
import { failureFor } from './service.js';

const integration = (provider: string, authMethod: string): IntegrationData =>
  ({ provider, authMethod }) as IntegrationData;

describe('failureFor', () => {
  it('a token that cannot create items says so, and points at write access or signing in', () => {
    assert.equal(failureFor(integration('jira', 'api_token'), 'forbidden'), 'token_cannot_create');
    assert.equal(failureFor(integration('github', 'token'), 'forbidden'), 'token_cannot_create');
    assert.equal(failureFor(integration('clickup', 'token'), 'forbidden'), 'token_cannot_create');
  });

  it('a GitHub App refusing is a permission the user grants in the app settings', () => {
    assert.equal(failureFor(integration('github', 'oauth'), 'forbidden'), 'needs_permission');
  });

  it('other 403s of an OAuth connection are just refused', () => {
    assert.equal(failureFor(integration('clickup', 'oauth'), 'forbidden'), 'rejected');
  });

  it('the other refusals keep their meaning', () => {
    const jira = integration('jira', 'oauth');
    assert.equal(failureFor(jira, 'auth'), 'auth_failed');
    assert.equal(failureFor(jira, 'rate_limited'), 'rate_limited');
    assert.equal(failureFor(jira, 'unreachable'), 'unreachable');
    assert.equal(failureFor(jira, 'rejected'), 'rejected');
  });
});
