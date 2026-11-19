import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isExpiring,
  toIntegrationStatus,
  type IntegrationData,
} from '../definitions/Integration.js';
import {
  INTEGRATION_STATUSES,
  type IntegrationStatus,
  type PublicIntegrationStatus,
} from '../../types/domain.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-11T10:00:00Z');

function integration(status: IntegrationStatus): IntegrationData {
  return {
    id: 'i-1',
    workspaceId: 'w-1',
    connectedBy: 'u-1',
    ownerUserId: 'u-1',
    provider: 'jira',
    accountId: 'example.atlassian.net',
    label: 'Work Jira',
    authMethod: 'api_token_basic',
    topicId: 'work',
    mode: 'read',
    config: { baseUrl: 'https://example.invalid' },
    credentialId: 'c-1',
    status,
    expiresAt: new Date(now.getTime() + 30 * DAY),
    lastSyncAt: new Date(now.getTime() - 60_000),
    lastError: { code: 'HTTP_500', message: 'provider error' },
    color: '#336699',
    demo: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('toIntegrationStatus', () => {
  it('returns exactly id, provider, authMethod, accountLabel, status, mode, topicId, expiresAt and lastSyncAt', () => {
    const data = integration('active');
    const view = toIntegrationStatus(data);
    assert.deepEqual(Object.keys(view).sort(), [
      'accountLabel',
      'authMethod',
      'expiresAt',
      'id',
      'lastSyncAt',
      'mode',
      'provider',
      'status',
      'topicId',
    ]);
    assert.deepEqual(view, {
      id: 'i-1',
      provider: 'jira',
      authMethod: data.authMethod,
      accountLabel: 'Work Jira',
      status: 'connected',
      mode: 'read',
      topicId: 'work',
      expiresAt: data.expiresAt,
      lastSyncAt: data.lastSyncAt,
    });
  });

  it('maps internal statuses to connected | expired | error', () => {
    const expected: Record<IntegrationStatus, PublicIntegrationStatus> = {
      active: 'connected',
      expiring: 'connected',
      expired: 'expired',
      error: 'error',
      paused: 'error',
    };
    for (const status of INTEGRATION_STATUSES) {
      assert.equal(toIntegrationStatus(integration(status)).status, expected[status], status);
    }
  });
});

describe('isExpiring', () => {
  it('is true with fewer than 14 days left', () => {
    assert.equal(isExpiring(new Date(now.getTime() + 13 * DAY), now), true);
    assert.equal(isExpiring(new Date(now.getTime() + 14 * DAY - 1), now), true);
    assert.equal(isExpiring(new Date(now.getTime() + 1000), now), true);
  });

  it('is false with 14 days or more left', () => {
    assert.equal(isExpiring(new Date(now.getTime() + 14 * DAY), now), false);
    assert.equal(isExpiring(new Date(now.getTime() + 365 * DAY), now), false);
  });

  it('is false without an expiry, or once it has passed (that is expired, not expiring)', () => {
    assert.equal(isExpiring(null, now), false);
    assert.equal(isExpiring(now, now), false);
    assert.equal(isExpiring(new Date(now.getTime() - DAY), now), false);
  });
});
