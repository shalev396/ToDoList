/**
 * The integration classes without a database: the Mode value object, the polymorphic factory
 * (IntegrationRegistry), the capability contracts each provider class implements, the auth
 * strategies' headers, and the write gate's order (demo data, then read-only) and ownership: every
 * write a class can make, write-back included, is refused while read-only before anything is
 * read or sent.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError } from '../../errors/NotFoundError.js';
import { ReadOnlyIntegrationError } from '../../errors/ReadOnlyIntegrationError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import type { AuthMethod, Provider } from '../../types/domain.js';
import type { CreateOptionsQuery, CreateTarget } from '../../types/providerCreate.js';
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import {
  ClickUpIntegration,
  GitHubIntegration,
  GoogleCalendarIntegration,
  Integration,
  IntegrationRegistry,
  isCalendarProvider,
  isResourcePicker,
  isRevocable,
  isTaskProvider,
  JiraIntegration,
  LinearIntegration,
  Mode,
  MoodleIntegration,
  picksFrom,
  supportsApiKey,
  supportsOAuth,
  UnlistedIntegration,
} from './index.js';
import { setCreateTransportForTests } from './TrackerIntegration.js';

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
    assert.equal(MoodleIntegration.definition.comingSoon, true);
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

describe('ResourcePicker', () => {
  it('picks by kind; a token connection has nothing to pick and refuses before any call', async () => {
    const jira = Integration.from(stored('jira'));
    const tokenJira = Integration.from(stored('jira', {}, 'api_token_basic'));
    const clickup = Integration.from(stored('clickup'));
    const google = Integration.from(stored('google_calendar'));
    const demoCalendar = Integration.from(stored('google_calendar', {}, 'service_account'));
    assert.ok(picksFrom(jira, 'sites') && !picksFrom(jira, 'workspaces'));
    assert.ok(picksFrom(clickup, 'workspaces'));
    assert.ok(picksFrom(google, 'calendars'));
    assert.ok(!picksFrom(tokenJira, 'sites') && !picksFrom(demoCalendar, 'calendars'));
    assert.ok(!isResourcePicker(Integration.from(stored('linear'))));
    for (const picker of [tokenJira, demoCalendar]) {
      assert.ok(isResourcePicker(picker));
      assert.equal(picker.pickerKind, null);
      await assert.rejects(picker.pickerResources(caller()), { statusCode: 409 });
      await assert.rejects(picker.choose(caller(), ['x']), { statusCode: 409 });
    }
    assert.ok(isResourcePicker(jira));
    // Someone else's: 404 before anything else.
    await assert.rejects(jira.pickerResources(caller('u-other')), NotFoundError);
    await assert.rejects(jira.choose(caller('u-other'), ['x']), NotFoundError);
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

  it('the owner check comes first: someone else on demo data gets 404, not provider_writes_off', () => {
    const demo = Integration.from(
      stored('clickup', { demo: true, mode: 'read_write' }, 'personal_token'),
    );
    assert.throws(() => {
      demo.assertWritable(caller('u-other'));
    }, NotFoundError);
  });

  it('checkMode: its owner only; read is always allowed; demo data never read & write', () => {
    const live = Integration.from(stored('linear'));
    assert.equal(live.checkMode(caller(), 'read_write'), Mode.readWrite);
    assert.throws(() => live.checkMode(caller('u-other'), 'read'), NotFoundError);
    const demo = Integration.from(stored('linear', { demo: true }, 'personal_api_key'));
    assert.equal(demo.canSwitchMode, false);
    assert.equal(demo.toView().canSwitchMode, false);
    assert.equal(demo.checkMode(caller(), 'read'), Mode.read);
    assert.throws(
      () => demo.checkMode(caller(), 'read_write'),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
    assert.equal(live.toView().canSwitchMode, true);
  });

  it('Google Calendar is writable on a fixtures stage too; demo data never is', () => {
    const google = Integration.from(stored('google_calendar', { mode: 'read_write' }));
    assert.equal(google.allowsWrites, true);
    const demo = Integration.from(stored('google_calendar', { mode: 'read_write', demo: true }));
    assert.equal(demo.allowsWrites, false);
  });
});

/** Each tracker's first funnel step and a target of its own. */
const TRACKERS: Partial<Record<Provider, { step: CreateOptionsQuery; target: CreateTarget }>> = {
  jira: {
    step: { step: 'site' },
    target: { provider: 'jira', projectId: '10001', issueTypeId: '10002' },
  },
  clickup: {
    step: { step: 'workspace' },
    target: { provider: 'clickup', listId: '90200' },
  },
  linear: {
    step: { step: 'linearTeam' },
    target: { provider: 'linear', teamId: '4a1b2c3d-0000-4000-8000-000000000001' },
  },
  github: {
    step: { step: 'repo' },
    target: { provider: 'github', repo: 'mock-org/mock-repo' },
  },
};

describe('every provider class, read-only: refused before anything is sent', () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  const recording: Transport = {
    send(request: HttpRequest): Promise<HttpResponse> {
      sent.push(`${request.method} ${request.url}`);
      return Promise.reject(new Error('nothing may be sent'));
    },
  };

  before(() => {
    setCreateTransportForTests(() => recording);
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      sent.push(`${init?.method ?? 'GET'} ${url}`);
      return Promise.reject(new Error('nothing may be sent'));
    };
  });

  after(() => {
    setCreateTransportForTests(null);
    globalThis.fetch = realFetch;
  });

  const fields = {
    title: 'Write the report',
    description: null,
    dueAt: NOW,
    allDay: false,
    priority: null,
    timeZone: 'UTC',
  };
  const readOnly = (error: unknown): boolean =>
    error instanceof ReadOnlyIntegrationError && error.code === 'integration_read_only';

  for (const provider of [
    'jira',
    'clickup',
    'linear',
    'github',
    'google_calendar',
    'moodle',
    'slack',
  ] as const) {
    it(`${provider}: every write it can make is refused while read-only`, async () => {
      const integration = Integration.from(stored(provider));
      const tracker = TRACKERS[provider];
      if (isTaskProvider(integration)) {
        assert.ok(tracker, provider);
        const settled: unknown[] = [];
        await assert.rejects(integration.createOptions(caller(), tracker.step), readOnly);
        await assert.rejects(
          integration.createTask(caller(), {
            target: tracker.target,
            fields,
            settle: (result) => {
              settled.push(result);
              return Promise.resolve();
            },
          }),
          readOnly,
        );
        assert.deepEqual(settled, []);
        // updateTask reads its item first (the gate waits for what changes): the write-back
        // tests hold it with a database.
      } else if (isCalendarProvider(integration)) {
        await assert.rejects(integration.createOptions(caller(), { step: 'calendar' }), readOnly);
        await assert.rejects(
          integration.insertEvent(caller(), 'primary', {
            id: 'h5abc',
            summary: 'Dentist',
            description: '',
            start: { date: '2026-11-20' },
            end: { date: '2026-11-21' },
            status: 'confirmed',
          }),
          readOnly,
        );
        await assert.rejects(integration.push(caller(), { ops: [], now: NOW }), readOnly);
        await assert.rejects(
          integration.insertEvent(
            caller(),
            'primary',
            {
              id: 'h5abd',
              summary: 'Gym',
              description: '',
              start: { date: '2026-11-20' },
              end: { date: '2026-11-21' },
              status: 'confirmed',
            },
            ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
          ),
          readOnly,
        );
        await assert.rejects(
          integration.updateEvent(caller(), 'primary', 'h5abc', { title: 'Dentist at 9' }),
          readOnly,
        );
        await assert.rejects(integration.deleteEvent(caller(), 'primary', 'h5abc'), readOnly);
        await assert.rejects(integration.createCalendar(caller(), 'TodoList'), readOnly);
      } else {
        // Nothing it could write: no to-do or calendar capability at all.
        assert.equal(tracker, undefined);
      }
      assert.deepEqual(sent, []);
    });
  }
});
