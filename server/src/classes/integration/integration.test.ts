/**
 * The integration classes without a database: the Mode value object, the polymorphic factory
 * (IntegrationRegistry), the capability contracts each provider class implements, the auth
 * strategies' headers, and the write gate's order (demo data, then read-only) and ownership.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError } from '../../errors/NotFoundError.js';
import { ReadOnlyIntegrationError } from '../../errors/ReadOnlyIntegrationError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { AuthMethod, Provider } from '../../types/domain.js';
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import {
  ClickUpIntegration,
  GitHubIntegration,
  GoogleCalendarIntegration,
  Integration,
  IntegrationRegistry,
  isCalendarProvider,
  isRevocable,
  isTaskProvider,
  JiraIntegration,
  LinearIntegration,
  Mode,
  MoodleIntegration,
  supportsApiKey,
  supportsOAuth,
  UnlistedIntegration,
} from './index.js';

const SETTINGS = { timezone: 'UTC', weekStart: 1 } as unknown as WorkspaceSettings;
const NOW = new Date('2026-11-15T10:00:00Z');

function stored(
  provider: Provider,
  over: Partial<IntegrationData> = {},
  authMethod: AuthMethod = 'oauth',
): IntegrationData {
  return {
    id: `i-${provider}`,
    workspaceId: 'w-1',
    connectedBy: 'u-owner',
    ownerUserId: 'u-owner',
    provider,
    accountId: `account-${provider}`,
    label: provider,
    authMethod,
    topicId: null,
    mode: 'read',
    config: {},
    credentialId: 'c-1',
    status: 'active',
    expiresAt: null,
    lastSyncAt: null,
    lastError: null,
    color: null,
    demo: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const caller = (userId = 'u-owner', workspaceId = 'w-1'): Caller =>
  Caller.fromContext({ id: workspaceId, role: 'editor', settings: SETTINGS }, Actor.user(userId));

describe('Mode', () => {
  it('is a value: one frozen instance per mode, read-only by default meaning', () => {
    assert.equal(Mode.of('read'), Mode.read);
    assert.equal(Mode.of(Mode.readWrite), Mode.readWrite);
    assert.ok(Object.isFrozen(Mode.read));
    assert.equal(Mode.read.allowsWrites, false);
    assert.equal(Mode.readWrite.allowsWrites, true);
    assert.ok(Mode.readWrite.equals('read_write') && !Mode.read.equals(Mode.readWrite));
    assert.equal(JSON.stringify({ mode: Mode.readWrite }), '{"mode":"read_write"}');
    assert.equal(Mode.read.toString(), 'read');
  });

  it('parses only the two mode names; a stored value outside them is a clear error', () => {
    assert.equal(Mode.parse('read_write'), Mode.readWrite);
    for (const bad of ['write', 'READ', '', null, 1]) assert.equal(Mode.parse(bad), null);
    assert.throws(() => Mode.of('write' as never), /^Error: Unknown integration mode: "write"$/);
  });
});

describe('Integration.from (the polymorphic factory)', () => {
  it('makes each provider’s own class, and the fallback for the rest', () => {
    // Each class's prototype: the exact class, not just a subclass of the base.
    const cases: [Provider, object][] = [
      ['jira', JiraIntegration.prototype],
      ['clickup', ClickUpIntegration.prototype],
      ['linear', LinearIntegration.prototype],
      ['github', GitHubIntegration.prototype],
      ['google_calendar', GoogleCalendarIntegration.prototype],
      ['moodle', MoodleIntegration.prototype],
      ['slack', UnlistedIntegration.prototype],
      ['notion', UnlistedIntegration.prototype],
    ];
    for (const [provider, expected] of cases) {
      const integration = Integration.from(stored(provider));
      assert.equal(Object.getPrototypeOf(integration), expected, provider);
      assert.ok(integration instanceof Integration, provider);
      assert.equal(integration.provider, provider);
    }
    assert.deepEqual(IntegrationRegistry.instance.providers(), [
      'clickup',
      'github',
      'google_calendar',
      'jira',
      'linear',
      'moodle',
    ]);
  });

  it('keeps what it was made from: a deep copy, frozen, with the status view’s mode', () => {
    const data = stored('jira', { config: { baseUrl: 'https://a.atlassian.net' } });
    const integration = Integration.from(data);
    data.label = 'changed later';
    assert.equal(integration.label, 'jira');
    assert.ok(Object.isFrozen(integration.config));
    assert.equal(integration.mode, Mode.read);
    assert.equal(integration.toView().mode, 'read');
    assert.equal(integration.auditTarget().id, 'i-jira');
    assert.ok(integration.isOwnedBy('u-owner') && !integration.isOwnedBy('u-other'));
  });
});

describe('capability contracts', () => {
  it('each provider class implements what it can do, and nothing else', () => {
    const row = (provider: Provider): boolean[] => {
      const integration = Integration.from(stored(provider));
      return [
        isTaskProvider(integration),
        isCalendarProvider(integration),
        isRevocable(integration),
        supportsOAuth(integration),
        supportsApiKey(integration),
      ];
    };
    // [TaskProvider, CalendarProvider, Revocable, SupportsOAuth, SupportsApiKey]
    assert.deepEqual(row('jira'), [true, false, false, true, true]);
    assert.deepEqual(row('clickup'), [true, false, false, true, true]);
    assert.deepEqual(row('linear'), [true, false, true, true, true]);
    assert.deepEqual(row('github'), [true, false, false, true, true]);
    assert.deepEqual(row('google_calendar'), [false, true, true, true, false]);
    assert.deepEqual(row('moodle'), [false, false, false, false, true]);
    assert.deepEqual(row('slack'), [false, false, false, false, false]);
    assert.equal(MoodleIntegration.comingSoon, true);
  });

  it('each auth strategy shapes its own headers (OAuth bearer, API key as the provider wants it)', () => {
    const jira = Integration.from(stored('jira')) as JiraIntegration;
    assert.deepEqual(jira.oauth.headers({ accessToken: 'FAKE-a' }), {
      authorization: 'Bearer FAKE-a',
    });
    assert.deepEqual(jira.apiKey.headers({ email: 'me@example.test', token: 'FAKE-t' }), {
      authorization: `Basic ${Buffer.from('me@example.test:FAKE-t').toString('base64')}`,
    });
    assert.deepEqual(jira.apiKey.methods, ['api_token_basic']);
    const clickup = Integration.from(stored('clickup')) as ClickUpIntegration;
    assert.deepEqual(clickup.apiKey.headers({ token: 'pk_FAKE' }), { authorization: 'pk_FAKE' });
    const linear = Integration.from(stored('linear')) as LinearIntegration;
    assert.deepEqual(linear.apiKey.headers({ apiKey: 'lin_FAKE' }), { authorization: 'lin_FAKE' });
    const github = Integration.from(stored('github')) as GitHubIntegration;
    assert.equal(github.apiKey.headers({ token: 'ghp_FAKE' })['authorization'], 'Bearer ghp_FAKE');
    assert.equal(github.oauth.kind, 'oauth');
    assert.equal(github.oauth.refreshPolicy, 'stored');
    const google = Integration.from(stored('google_calendar')) as GoogleCalendarIntegration;
    assert.equal(google.oauth.refreshPolicy, 'per_call');
  });
});

describe('the write gate', () => {
  it('refuses demo data first (provider_writes_off), even when read & write', () => {
    const demo = Integration.from(
      stored('clickup', { demo: true, mode: 'read_write' }, 'personal_token'),
    );
    assert.equal(demo.allowsWrites, false);
    assert.throws(
      () => {
        demo.assertWritable(caller());
      },
      (error: unknown) =>
        (error as { code?: string; statusCode?: number }).code === 'provider_writes_off' &&
        (error as { statusCode?: number }).statusCode === 409,
    );
  });

  it('then a read-only integration (409 integration_read_only)', () => {
    const readOnly = Integration.from(stored('linear'));
    assert.equal(readOnly.allowsWrites, false);
    assert.throws(
      () => {
        readOnly.assertWritable(caller());
      },
      (error: unknown) =>
        error instanceof ReadOnlyIntegrationError &&
        error.statusCode === 409 &&
        error.code === 'integration_read_only' &&
        error.integrationId === 'i-linear',
    );
  });

  it('a read & write integration passes, for its owner only (anyone else: 404)', () => {
    const writable = Integration.from(stored('linear', { mode: 'read_write' }));
    assert.equal(writable.allowsWrites, true);
    writable.assertWritable(caller());
    assert.throws(() => {
      writable.assertWritable(caller('u-other'));
    }, NotFoundError);
    assert.throws(() => {
      writable.assertWritable(caller('u-owner', 'w-other'));
    }, NotFoundError);
  });

  it('Google Calendar is writable on a fixtures stage too; demo data never is', () => {
    const google = Integration.from(stored('google_calendar', { mode: 'read_write' }));
    assert.equal(google.allowsWrites, true);
    const demo = Integration.from(stored('google_calendar', { mode: 'read_write', demo: true }));
    assert.equal(demo.allowsWrites, false);
  });
});
