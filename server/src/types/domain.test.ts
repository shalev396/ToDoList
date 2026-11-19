import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as domain from './domain.js';

describe('domain enums (shared with the client)', () => {
  it('lists the exact values of the data model', () => {
    assert.deepEqual(domain.PROVIDERS, [
      'google_calendar',
      'jira',
      'clickup',
      'linear',
      'moodle',
      'slack',
      'github',
      'notion',
      'local',
    ]);
    assert.deepEqual(domain.ITEM_KINDS, [
      'todo',
      'issue',
      'task',
      'event',
      'assignment',
      'deadline',
      'message',
      'pr',
      'block',
      'travel',
    ]);
    assert.deepEqual(domain.SCHEDULED_KINDS, ['block', 'travel']);
    assert.deepEqual(domain.ITEM_STATUSES, ['open', 'in_progress', 'done', 'cancelled']);
    assert.deepEqual(domain.CONTAINER_TYPES, [
      'project',
      'course',
      'list',
      'calendar',
      'folder',
      'repo',
    ]);
    assert.deepEqual(domain.ROLES, ['viewer', 'editor', 'owner']);
    assert.deepEqual(domain.MEMBERSHIP_STATUSES, ['active', 'revoked']);
    assert.deepEqual(domain.INVITE_STATUSES, ['pending', 'accepted', 'revoked']);
    assert.deepEqual(domain.INTEGRATION_STATUSES, [
      'active',
      'expiring',
      'expired',
      'error',
      'paused',
    ]);
    assert.deepEqual(domain.PUBLIC_INTEGRATION_STATUSES, ['connected', 'expired', 'error']);
    assert.deepEqual(domain.AUTH_METHODS, [
      'oauth',
      'service_account',
      'api_token_basic',
      'personal_token',
      'personal_api_key',
      'moodle_ws_token',
      'fine_grained_pat',
      'classic_pat',
      'internal_integration',
      'none',
    ]);
    assert.deepEqual(domain.INTEGRATION_MODES, ['read', 'read_write']);
    assert.deepEqual(domain.VISIBILITIES, ['workspace', 'private']);
    assert.deepEqual(domain.SYNC_TRIGGERS, [
      'schedule',
      'manual',
      'webhook',
      'calendar_push',
      'seed',
    ]);
    assert.deepEqual(domain.SYNC_RUN_STATUSES, [
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
    ]);
    assert.deepEqual(domain.AGENT_SCOPES, [
      'read',
      'items:write',
      'sync',
      'gcal:write',
      'providers:create',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
      'workspace:share',
      'builder:write',
      'builder:publish',
    ]);
    assert.deepEqual(domain.CALENDAR_LINK_DIRECTIONS, ['to_google', 'from_google']);
    assert.deepEqual(domain.DASHBOARD_PAGES, ['topic', 'group']);
  });

  it('ranks roles viewer < editor < owner', () => {
    assert.deepEqual(domain.ROLE_RANK, { viewer: 1, editor: 2, owner: 3 });
  });

  it('imports nothing, so the client can use it as is', () => {
    const source = readFileSync(new URL('./domain.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\s/m);
  });
});
