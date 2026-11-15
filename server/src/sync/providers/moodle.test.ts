import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { HttpRequest, HttpResponse, Transport } from '../http.js';
import { fixtureSetDir } from '../fixtureSets.js';
import { setVaultLoaderForTests } from '../secrets.js';
import { fixtureTransport, loadFixtureSet, type FixtureTransport } from '../transports/fixtures.js';
import type { AdapterContext } from '../types.js';
import {
  mapMoodleAssignment,
  mapMoodleCourse,
  mapMoodleEvent,
  moodleAdapter,
  moodleSemester,
  submissionStatusOf,
  type MoodleMapEnv,
} from './moodle.js';
import {
  counts,
  FIXTURE_NOW,
  need,
  OWNER,
  registerWithInstantClock,
  setTransport,
  startKit,
  TIME_ZONE,
  type Kit,
} from '../../testing/trackerTestKit.js';
import { bindAuth } from '../../classes/integration/definitions/IntegrationDefinition.js';
import { MOODLE } from '../../classes/integration/definitions/moodle.js';

const SITE = 'https://example.invalid/moodle';
const FAKE_TOKEN = 'FAKE0123456789abcdef0123456789ab';
const DAY_MS = 24 * 3600 * 1000;

const ENV: MoodleMapEnv = {
  accountId: 'example.invalid',
  siteUrl: SITE,
  connectedBy: OWNER,
  userFullName: 'Demo Student',
};

const seconds = (iso: string): number => Date.parse(iso) / 1000;

describe('submissionStatusOf', () => {
  it('maps the submission status to the normalized status', () => {
    assert.deepEqual(submissionStatusOf('submitted'), { status: 'done', raw: 'submitted' });
    assert.deepEqual(submissionStatusOf('draft'), { status: 'in_progress', raw: 'draft' });
    assert.deepEqual(submissionStatusOf('new'), { status: 'open', raw: 'new' });
    assert.deepEqual(submissionStatusOf(null), { status: 'open', raw: null });
    assert.deepEqual(submissionStatusOf('reopened'), { status: 'open', raw: 'reopened' });
  });
});

describe('moodleSemester', () => {
  it('Oct-Feb is A, Mar-Jun is B, Jul-Sep is summer (in the workspace zone)', () => {
    assert.equal(moodleSemester(seconds('2026-10-23T00:00:00Z'), TIME_ZONE), '2026-A');
    assert.equal(moodleSemester(seconds('2027-03-10T10:00:00Z'), TIME_ZONE), '2027-B');
    assert.equal(moodleSemester(seconds('2026-07-20T10:00:00Z'), TIME_ZONE), '2026-S');
    assert.equal(moodleSemester(0, TIME_ZONE), null);
    assert.equal(moodleSemester(undefined, TIME_ZONE), null);
  });
});

describe('mapMoodleCourse', () => {
  it('maps a course container', () => {
    const result = mapMoodleCourse(
      {
        id: 101,
        shortname: 'ALG101',
        fullname: 'Algorithms',
        startdate: seconds('2026-10-23T00:00:00Z'),
      },
      ENV,
      TIME_ZONE,
    );
    assert.ok('container' in result);
    const c = result.container;
    assert.equal(c.type, 'course');
    assert.equal(c.name, 'Algorithms');
    assert.equal(c.source.externalId, 'course:101');
    assert.equal(c.source.url, `${SITE}/course/view.php?id=101`);
    assert.deepEqual(c.props, { shortname: 'ALG101', moodleCourseId: 101, semester: '2026-A' });
  });

  it('a course without an id is a failure', () => {
    assert.deepEqual(mapMoodleCourse({ fullname: 'X' }, ENV, TIME_ZONE), {
      failure: { externalId: '', code: 'missing_id' },
    });
  });
});

describe('mapMoodleAssignment', () => {
  const raw = {
    id: 2,
    cmid: 2012,
    course: 101,
    name: 'HW4',
    duedate: seconds('2026-11-12T21:59:00Z'),
    cutoffdate: seconds('2026-11-19T21:59:00Z'),
    gradingduedate: 0,
  };

  it('maps an assignment: prefixed id, url from cmid, epoch seconds, props, assignee', () => {
    const result = mapMoodleAssignment(raw, 'draft', null, ENV);
    assert.ok('item' in result);
    const { item } = result;
    assert.equal(item.kind, 'assignment');
    assert.equal(item.title, 'HW4');
    assert.equal(item.status, 'in_progress');
    assert.equal(item.statusRaw, 'draft');
    assert.equal(item.dueAt?.toISOString(), '2026-11-12T21:59:00.000Z');
    assert.equal(item.allDay ?? false, false);
    assert.equal(item.source.externalId, 'assign:2');
    assert.equal(item.source.url, `${SITE}/mod/assign/view.php?id=2012`);
    assert.equal(item.containerExternalId, 'course:101');
    assert.deepEqual(item.assignees, [OWNER]);
    assert.deepEqual(item.props, {
      courseId: 101,
      cmid: 2012,
      modname: 'assign',
      submissionStatus: 'draft',
      cutoffAt: '2026-11-19T21:59:00.000Z',
      gradingDueAt: null,
      assigneeNames: ['Demo Student'],
    });
  });

  it('a submitted assignment is done, closed at the submission time', () => {
    const closedAt = new Date('2026-11-11T08:00:00Z');
    const result = mapMoodleAssignment(raw, 'submitted', closedAt, ENV);
    assert.ok('item' in result);
    assert.equal(result.item.status, 'done');
    assert.equal(result.item.closedAt?.toISOString(), closedAt.toISOString());
  });

  it('no due date means no dueAt', () => {
    const result = mapMoodleAssignment({ ...raw, duedate: 0 }, 'new', null, ENV);
    assert.ok('item' in result);
    assert.equal(result.item.dueAt ?? null, null);
  });

  it('without a cmid there is no usable url', () => {
    const result = mapMoodleAssignment({ ...raw, cmid: undefined }, 'new', null, ENV);
    assert.ok('item' in result);
    assert.equal(result.item.source.url, '');
  });

  it('a bad due date is a failure under the PREFIXED id', () => {
    assert.deepEqual(mapMoodleAssignment({ ...raw, duedate: 'soon' }, 'new', null, ENV), {
      failure: { externalId: 'assign:2', code: 'bad_due_date' },
    });
  });

  it('a missing id is a failure, not a throw', () => {
    assert.deepEqual(mapMoodleAssignment({ ...raw, id: undefined }, 'new', null, ENV), {
      failure: { externalId: '', code: 'missing_id' },
    });
  });
});

describe('mapMoodleEvent', () => {
  const raw = {
    id: 9001,
    name: 'Quiz 2 closes',
    eventtype: 'close',
    modulename: 'quiz',
    instance: 301,
    timestart: seconds('2026-11-13T10:00:00Z'),
    course: { id: 101 },
    url: `${SITE}/mod/quiz/view.php?id=3011`,
    action: { url: `${SITE}/mod/quiz/view.php?id=3011`, actionable: true },
  };

  it('maps a quiz deadline', () => {
    const result = mapMoodleEvent(raw, ENV);
    assert.ok('item' in result);
    const { item } = result;
    assert.equal(item.kind, 'deadline');
    assert.equal(item.status, 'open');
    assert.equal(item.dueAt?.toISOString(), '2026-11-13T10:00:00.000Z');
    assert.equal(item.source.externalId, 'event:9001');
    assert.equal(item.source.url, raw.url);
    assert.equal(item.containerExternalId, 'course:101');
    assert.deepEqual(item.assignees, [OWNER]);
    assert.deepEqual(item.props, {
      courseId: 101,
      modname: 'quiz',
      eventType: 'close',
      assigneeNames: ['Demo Student'],
    });
  });

  it('the url falls back to the action url, then to nothing', () => {
    const viaAction = mapMoodleEvent({ ...raw, url: '' }, ENV);
    assert.ok('item' in viaAction);
    assert.equal(viaAction.item.source.url, raw.action.url);
    const none = mapMoodleEvent({ ...raw, url: '', action: {} }, ENV);
    assert.ok('item' in none);
    assert.equal(none.item.source.url, '');
  });

  it('a completed activity is done, closed at its completion time', () => {
    const at = new Date('2026-11-12T08:00:00Z');
    const result = mapMoodleEvent(raw, ENV, { done: true, at });
    assert.ok('item' in result);
    assert.equal(result.item.status, 'done');
    assert.equal(result.item.closedAt?.toISOString(), at.toISOString());
    const open = mapMoodleEvent(raw, ENV, { done: false, at: null });
    assert.ok('item' in open);
    assert.equal(open.item.status, 'open');
  });

  it('an event with no time is a failure', () => {
    assert.deepEqual(mapMoodleEvent({ ...raw, timestart: 0 }, ENV), {
      failure: { externalId: 'event:9001', code: 'bad_event_time' },
    });
  });
});

function contextFor(
  integration: IntegrationData,
  transport: Transport,
  secret: Record<string, string> = {},
): AdapterContext {
  const client = moodleAdapter.createClient(transport);
  return {
    integration,
    secret,
    client,
    // The headers come from the integration's auth strategy, as in a run.
    auth: bindAuth(MOODLE.auth, integration.authMethod, { secret, client, now: FIXTURE_NOW }),
    now: FIXTURE_NOW,
    timeZone: TIME_ZONE,
    fullSyncDue: false,
  };
}

/** A transport that answers every request with one canned response, recording the requests. */
function canned(status: number, body: string, seen: HttpRequest[]): Transport {
  return {
    send(request): Promise<HttpResponse> {
      seen.push(request);
      return Promise.resolve({ status, headers: {}, body });
    },
  };
}

type Body = Record<string, unknown>;

/** The v1 fixtures with `edit` applied to the body of every entry of one web-service function. */
async function editedV1(edits: Record<string, (body: Body) => void>): Promise<FixtureTransport> {
  const entries = await loadFixtureSet(fixtureSetDir(moodleAdapter, 'v1'));
  const copy = structuredClone(entries);
  for (const entry of copy) {
    for (const [wsfunction, edit] of Object.entries(edits)) {
      if (entry.request.url?.includes(`wsfunction=${wsfunction}`) === true) {
        edit(entry.response.body as Body);
      }
    }
  }
  return fixtureTransport(copy, { now: FIXTURE_NOW, timeZone: TIME_ZONE });
}

function eventsOf(body: Body): Body[] {
  return body['events'] as Body[];
}

describe('moodle adapter: engine runs over fixtures', () => {
  let kit: Kit;
  before(async () => {
    kit = await startKit('todolist_moodle_test');
    registerWithInstantClock(moodleAdapter);
  });
  after(async () => {
    await kit.stop();
  });

  const config = { siteUrl: SITE };

  it('resources: courses first, then assignments, then the windowed events', () => {
    assert.deepEqual(moodleAdapter.resources({} as IntegrationData), [
      'courses',
      'assignments',
      'events',
    ]);
  });

  it('v1 then v1 then v2: counts, failures, closed and deleted', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const first = await kit.run(s, moodleAdapter);
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.counts, counts({ fetched: 12, inserted: 10, failed: 2 }));

    const containers = await kit.containers(s);
    assert.equal(containers.size, 3);
    const alg = need(containers, 'course:101');
    assert.deepEqual([alg.type, alg.name, alg.topicId], ['course', 'Algorithms', 'college']);
    assert.equal(need(containers, 'course:102').name, 'Data Structures');
    assert.equal(need(containers, 'course:103').name, 'Physics 1');
    assert.equal(alg.props['shortname'], 'ALG101');

    const items = await kit.items(s);
    assert.equal(items.size, 10);
    assert.ok(!items.has('assign:7'), 'no cmid, no link: not stored');
    assert.ok(!items.has('event:9005'), 'event without url: not stored');
    assert.ok(!items.has('event:9006'), 'the calendar copy of an assignment is skipped');
    const hw3 = need(items, 'assign:1');
    assert.equal(hw3.kind, 'assignment');
    assert.equal(hw3.containerId, alg.id);
    assert.deepEqual(hw3.assignees, [OWNER]);
    assert.equal(hw3.status, 'open');
    assert.equal(need(items, 'assign:2').status, 'in_progress');
    assert.equal(need(items, 'assign:5').status, 'done');
    assert.equal(need(items, 'event:9001').kind, 'deadline');
    assert.equal(need(items, 'event:9001').topicId, 'college');
    // overdue, today, tomorrow, next week
    const dueAt = (id: string): string | undefined => need(items, id).dueAt?.toISOString();
    assert.equal(dueAt('assign:1'), '2026-11-09T21:59:00.000Z');
    assert.equal(dueAt('assign:2'), '2026-11-12T21:59:00.000Z');
    assert.equal(dueAt('event:9001'), '2026-11-13T10:00:00.000Z');
    assert.equal(dueAt('assign:6'), '2026-11-21T21:59:00.000Z');

    const again = await kit.run(s, moodleAdapter);
    assert.deepEqual(again.counts, counts({ fetched: 12, unchanged: 10, failed: 2 }));

    const v2 = await kit.run(s, moodleAdapter, { set: 'v2', later: true });
    assert.deepEqual(
      v2.counts,
      counts({ fetched: 11, updated: 2, unchanged: 7, closed: 1, deleted: 1, failed: 2 }),
    );
    const after = await kit.items(s);
    assert.equal(need(after, 'assign:3').title, 'Lab 2: Hash tables (extended)');
    // The quiz completed between v1 and v2 is still listed: it turns done, it is not deleted.
    const closed = need(after, 'event:9002');
    assert.equal(closed.status, 'done');
    assert.ok(closed.closedAt instanceof Date);
    assert.equal(closed.deletedAt, null);
    assert.ok(need(after, 'assign:4').deletedAt instanceof Date, 'removed at the source');
    assert.equal(need(after, 'assign:1').deletedAt, null);
    assert.equal(need(after, 'event:9004').deletedAt, null);
  });

  it('the events sweep is windowed: missing inside [now-30d, now+90d) is deleted, outside is kept', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    await kit.run(s, moodleAdapter);
    const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
    const old = new Date(FIXTURE_NOW.getTime() - 60 * DAY_MS);
    const move = (externalId: string): Promise<unknown> =>
      ItemMongoModel.updateOne(
        {
          workspaceId: s.workspaceId,
          integrationId: s.integration.id,
          'source.externalId': externalId,
        },
        { $set: { dueAt: old } },
      );
    await move('event:9004'); // out of the window, and missing below: kept
    const stripped = await editedV1({
      core_calendar_get_calendar_events: (body) => {
        body['events'] = eventsOf(body).filter(
          (event) => event['id'] !== 9004 && event['id'] !== 9003,
        );
      },
    });
    await kit.run(s, moodleAdapter, { transport: stripped });
    const items = await kit.items(s);
    assert.equal(need(items, 'event:9004').deletedAt, null, 'outside the window: history kept');
    assert.ok(need(items, 'event:9003').deletedAt instanceof Date, 'inside the window: deleted');
    assert.equal(need(items, 'event:9001').deletedAt, null);
  });

  it('a failing record keeps its stored row live (failure ids are the prefixed ids)', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    await kit.run(s, moodleAdapter);
    // assign:1 gets a due date Moodle would never send, event:9001 loses its time.
    const broken = await editedV1({
      mod_assign_get_assignments: (body) => {
        const course = (body['courses'] as Body[]).at(0) ?? {};
        const assignment = (course['assignments'] as Body[]).at(0) ?? {};
        assignment['duedate'] = 'soon';
      },
      core_calendar_get_calendar_events: (body) => {
        const event = eventsOf(body).find((e) => e['id'] === 9001) ?? {};
        event['timestart'] = 0;
        event['timesort'] = 0;
      },
    });
    const run = await kit.run(s, moodleAdapter, { transport: broken });
    assert.equal(run.counts.failed, 4, 'two bad records and two without a link');
    assert.equal(need(await kit.items(s), 'assign:1').deletedAt, null);
    const items = await kit.items(s);
    assert.equal(
      need(items, 'event:9001').deletedAt,
      null,
      'bad_event_time failure under event:9001',
    );
    assert.equal(run.counts.deleted, 0);
  });

  describe('a status lookup that fails never reopens work', () => {
    const exception = { exception: 'moodle_exception', errorcode: 'cannotviewsubmission' };

    it('submission status answers an exception: assign:5 stays done, untouched', async () => {
      const s = await kit.setup('moodle', { config, topicId: 'college' });
      await kit.run(s, moodleAdapter);
      const before = need(await kit.items(s), 'assign:5');
      assert.equal(before.status, 'done');
      const transport = await editedV1({
        'mod_assign_get_submission_status&assignid=5': (body) => {
          for (const key of Object.keys(body)) Reflect.deleteProperty(body, key);
          Object.assign(body, exception);
        },
      });
      const run = await kit.run(s, moodleAdapter, { transport });
      assert.equal(run.counts.failed, 3, 'assign:5 plus the two records without a link');
      assert.equal(run.counts.deleted, 0);
      const after = need(await kit.items(s), 'assign:5');
      assert.equal(after.status, 'done');
      assert.equal(after.deletedAt, null);
      assert.equal(after.closedAt?.toISOString(), before.closedAt?.toISOString());
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    });

    it('submission status unreachable (network): same, the row is left alone', async () => {
      const s = await kit.setup('moodle', { config, topicId: 'college' });
      await kit.run(s, moodleAdapter);
      const before = need(await kit.items(s), 'assign:5');
      const base = await setTransport(moodleAdapter, 'v1');
      const transport = {
        calls: base.calls,
        send(request: HttpRequest): ReturnType<Transport['send']> {
          if (
            request.url.includes('mod_assign_get_submission_status') &&
            request.url.includes('assignid=5')
          ) {
            return Promise.reject(new Error(`connection reset ${request.url}`));
          }
          return base.send(request);
        },
      };
      const run = await kit.run(s, moodleAdapter, { transport });
      assert.equal(run.counts.failed, 3);
      const after = need(await kit.items(s), 'assign:5');
      assert.equal(after.status, 'done');
      assert.equal(after.deletedAt, null);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    });

    it('a course whose completion lookup fails: its deadlines are failures, stored rows stay', async () => {
      const s = await kit.setup('moodle', { config, topicId: 'college' });
      // v2 first: event:9002 is stored as done.
      await kit.run(s, moodleAdapter, { set: 'v2' });
      const before = need(await kit.items(s), 'event:9002');
      assert.equal(before.status, 'done');
      const transport = await editedV1({
        'core_completion_get_activities_completion_status&courseid=102': (body) => {
          for (const key of Object.keys(body)) Reflect.deleteProperty(body, key);
          Object.assign(body, exception);
        },
      });
      await kit.run(s, moodleAdapter, { transport });
      const after = need(await kit.items(s), 'event:9002');
      assert.equal(after.status, 'done', 'not reopened by the v1 listing');
      assert.equal(after.deletedAt, null);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    });
  });

  it('completion state 3 (complete, failed grade) counts as finished', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const transport = await editedV1({
      'core_completion_get_activities_completion_status&courseid=102': (body) => {
        const statuses = body['statuses'] as Body[];
        for (const status of statuses) status['state'] = 3;
      },
    });
    await kit.run(s, moodleAdapter, { transport });
    assert.equal(need(await kit.items(s), 'event:9002').status, 'done');
  });

  it('the enrolled courses are fetched once per run', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const transport = await setTransport(moodleAdapter, 'v1');
    await kit.run(s, moodleAdapter, { transport });
    const enrol = transport.calls.filter((call) =>
      call.url.includes('core_enrol_get_users_courses'),
    );
    assert.equal(enrol.length, 1);
  });

  it('asks for the calendar events of the window, and uses GET only', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const transport = await setTransport(moodleAdapter, 'v1');
    await kit.run(s, moodleAdapter, { transport });
    assert.ok(transport.calls.length >= 12);
    for (const call of transport.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.graphqlOperation, undefined);
      assert.equal(call.body, undefined);
      assert.ok(call.url.startsWith(`${SITE}/webservice/rest/server.php?`), call.url);
      assert.equal(new URL(call.url).searchParams.get('moodlewsrestformat'), 'json');
    }
    const eventCall = transport.calls.find((call) =>
      call.url.includes('core_calendar_get_calendar_events'),
    );
    assert.ok(eventCall !== undefined);
    const params = new URL(eventCall.url).searchParams;
    assert.equal(
      Number(params.get('options[timestart]')),
      Math.floor((FIXTURE_NOW.getTime() - 30 * DAY_MS) / 1000),
    );
    assert.equal(
      Number(params.get('options[timeend]')),
      Math.floor((FIXTURE_NOW.getTime() + 90 * DAY_MS) / 1000) - 1,
    );
  });

  it('test(): who am I, with the Moodle user id as account id', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const transport = await setTransport(moodleAdapter, 'v1');
    const result = await moodleAdapter.test?.(contextFor(s.integration, transport));
    assert.deepEqual(result, { accountLabel: 'Demo Student', accountId: '4242' });
    assert.deepEqual(
      transport.calls.map((call) => call.method),
      ['GET'],
    );
  });

  it('live: the token goes in the query string as wstoken', async () => {
    const s = await kit.setup('moodle', { config, topicId: 'college' });
    const seen: HttpRequest[] = [];
    const body = JSON.stringify({ userid: 7, fullname: 'Demo Student' });
    await moodleAdapter.test?.(
      contextFor(s.integration, canned(200, body, seen), { token: FAKE_TOKEN }),
    );
    const url = new URL(seen[0]?.url ?? '');
    assert.equal(url.searchParams.get('wstoken'), FAKE_TOKEN);
    assert.equal(url.searchParams.get('wsfunction'), 'core_webservice_get_site_info');
    assert.equal(seen[0]?.method, 'GET');
  });

  describe('the token never leaks', () => {
    it('a Moodle exception answered with 200 is auth_failed and carries no token', async () => {
      const s = await kit.setup('moodle', { config, topicId: 'college' });
      const body = JSON.stringify({
        exception: 'moodle_exception',
        errorcode: 'invalidtoken',
        message: `Invalid token ${FAKE_TOKEN}`,
      });
      const context = contextFor(s.integration, canned(200, body, []), { token: FAKE_TOKEN });
      await assert.rejects(moodleAdapter.test?.(context) ?? Promise.resolve(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'auth_failed');
        assert.ok(!error.message.includes(FAKE_TOKEN));
        assert.ok(!JSON.stringify(error).includes(FAKE_TOKEN));
        assert.ok(!(error.stack ?? '').includes(FAKE_TOKEN));
        return true;
      });
    });

    it('no error, log line or SyncRun error holds the token (live runs, every failure style)', async () => {
      const logged: string[] = [];
      const stored: string[] = [];
      const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const sink = console as unknown as Record<string, unknown>;
      const originals = methods.map((name) => sink[name]);
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      const stderrWrite = process.stderr.write.bind(process.stderr);
      const capture = (...args: unknown[]): void => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
        );
      };
      const exception = (errorcode: string): string =>
        JSON.stringify({ exception: 'moodle_exception', errorcode, message: FAKE_TOKEN });
      const responses: [number, string][] = [
        [200, exception('invalidtoken')],
        [200, exception('somethingelse')],
        [200, `not json ${FAKE_TOKEN}`],
        [403, `forbidden ${FAKE_TOKEN}`],
        [404, `missing ${FAKE_TOKEN}`],
        [500, `boom ${FAKE_TOKEN}`],
      ];
      const { runIntegrationSync } = await import('../runSync.js');
      const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
      const { IntegrationMongoModel } = await import('../../models/mongoose/Integration.js');
      try {
        for (const name of methods) sink[name] = capture;
        process.stdout.write = (chunk: unknown): boolean => {
          capture(String(chunk));
          return true;
        };
        process.stderr.write = (chunk: unknown): boolean => {
          capture(String(chunk));
          return true;
        };
        setVaultLoaderForTests(() =>
          Promise.resolve({ decryptForSync: (_id, fn) => fn({ token: FAKE_TOKEN }) }),
        );
        for (const [status, body] of responses) {
          const s = await kit.setup('moodle', { config, topicId: 'college' });
          const seen: HttpRequest[] = [];
          const summary = await runIntegrationSync(s.integration.id, {
            trigger: 'manual',
            mode: 'live',
            transport: canned(status, body, seen),
          });
          assert.equal(summary.status, 'failed');
          assert.ok(seen.length > 0, 'the run reached the provider');
          assert.ok(
            seen.some((request) => request.url.includes(FAKE_TOKEN)),
            'the token was really sent',
          );
          stored.push(JSON.stringify(summary));
          stored.push(
            JSON.stringify(
              await SyncRunMongoModel.find({ integrationId: s.integration.id }).lean(),
            ),
          );
          stored.push(
            JSON.stringify(await IntegrationMongoModel.findOne({ _id: s.integration.id }).lean()),
          );
        }
      } finally {
        methods.forEach((name, index) => {
          sink[name] = originals[index];
        });
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
        setVaultLoaderForTests(null);
      }
      assert.ok(logged.length > 0, 'the failures were logged');
      for (const line of logged) assert.ok(!line.includes(FAKE_TOKEN), 'log line');
      for (const text of stored) assert.ok(!text.includes(FAKE_TOKEN), 'stored data');
    });
  });
});
