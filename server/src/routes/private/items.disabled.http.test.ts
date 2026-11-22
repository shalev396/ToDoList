/**
 * Disabling over HTTP (`PATCH …/items/:id/overlay` with `disabled`; classes/item/Disabled.ts): a
 * single item as a whole, a repeating time block by occurrence or series, a Google series with its
 * moved and cancelled occurrences, from the master or from an occurrence row. Kept in TodoList
 * only: nothing leaves the machine, and a sync that writes the event again keeps the mark. The
 * roles of an overlay edit; a travel leg is skipped, never disabled. A refused request writes
 * nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ItemUpsert } from '../../models/definitions/Item.js';
import type { TimeRow } from '../../types/recurrence/occurrences.js';
import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';

let api: ApiHarness;
let guard: OutboundGuard;
let models: typeof Models;
const token = { owner: '', editor: '', viewer: '', stranger: '' };
const userIds: Record<string, string> = {};
let wid = '';

type Who = keyof typeof token;

/** Sunday 22 November 2026, 13:00 in Jerusalem, and the Sundays after it. */
const SUNDAY = '2026-11-22T11:00:00.000Z';
const week = (n: number, hours = 0): string =>
  new Date(Date.parse(SUNDAY) + n * 7 * 24 * 3_600_000 + hours * 3_600_000).toISOString();

const GCAL = 'int-gcal-disabled';
const ACCOUNT = 'me@example.test';
const CALENDAR = 'primary@example.test';

interface Detail {
  id: string;
  title: string;
  topicId: string | null;
  status: string;
  openIn: { provider: string; url: string };
  overlay: {
    disabled: boolean | null;
    disabledOccurrences: string[];
    pinned: boolean | null;
    note: string | null;
  };
  seriesOccurrence?: { seriesId: string; originalStart: string; disabled: string | null };
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
}

async function overlay(
  id: string,
  body: Record<string, unknown>,
  who: Who = 'editor',
): Promise<Detail> {
  const res = await call(who, 'PATCH', `/items/${id}/overlay`, body);
  assert.equal(res.status, 200, res.text);
  return res.body?.['data'] as Detail;
}

async function detail(id: string): Promise<Detail> {
  const res = await call('editor', 'GET', `/items/${id}`);
  assert.equal(res.status, 200, res.text);
  return res.body?.['data'] as Detail;
}

/** A Google event of the editor's calendar, as the sync stores it. */
function event(
  eventId: string,
  fields: Partial<ItemUpsert> & { props?: Record<string, unknown> } = {},
): ItemUpsert {
  return {
    integrationId: GCAL,
    kind: 'event',
    topicId: null,
    title: `Event ${eventId}`,
    status: 'open',
    startAt: new Date(SUNDAY),
    endAt: new Date(week(0, 1)),
    syncResource: `calendar:${CALENDAR}`,
    ...fields,
    source: {
      provider: 'google_calendar',
      accountId: ACCOUNT,
      externalId: `${CALENDAR}:${eventId}`,
      key: null,
      url: `https://calendar.google.com/event?eid=${eventId}`,
      updatedAtSource: null,
      etag: null,
      hash: `sha256:${eventId}:${fields.title ?? ''}`,
    },
    props: {
      calendarId: CALENDAR,
      eventId,
      recurringEventId: null,
      originalStartAt: null,
      ...fields.props,
    },
  };
}

/** The daily meeting: a weekly master, one occurrence moved, one cancelled; and another event. */
const MEETING = [
  event('daily', {
    title: 'Daily meeting',
    props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] },
  }),
  event('daily_moved', {
    title: 'Daily meeting',
    startAt: new Date(week(1, 2)),
    endAt: new Date(week(1, 3)),
    props: { eventId: 'daily_moved', recurringEventId: 'daily', originalStartAt: week(1) },
  }),
  // As the sync stores what Google sends for a cancelled occurrence (its id, series and original
  // start, nothing else): its raw id for a title, no end, and an `eid` link Google can't open.
  event('daily_cancelled', {
    title: 'daily_cancelled',
    status: 'cancelled',
    statusRaw: 'cancelled',
    startAt: new Date(week(2)),
    endAt: null,
    props: {
      eventId: 'daily_cancelled',
      recurringEventId: 'daily',
      originalStartAt: week(2),
      location: null,
      transparency: 'opaque',
    },
  }),
  event('other', { title: 'Dentist', startAt: new Date(week(0, 3)), endAt: new Date(week(0, 4)) }),
];

async function idOf(externalId: string): Promise<string> {
  const [row] = await (
    await models.getItemRepository()
  ).aggregate<{ _id: string }>(wid, [
    { $match: { 'source.externalId': `${CALENDAR}:${externalId}` } },
    { $project: { _id: 1 } },
  ]);
  assert.ok(row, externalId);
  return row._id;
}

before(async () => {
  guard = installOutboundGuard();
  api = await startApiHarness('todolist_items_disabled_http');
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`disabled-http-${who}@example.test`)).token;
  }
  const workspace = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Disabled HTTP' },
  });
  wid = (workspace.body?.['data'] as { id: string }).id;
  models = await import('../../models/index.js');
  const users = await models.getUserRepository();
  for (const who of Object.keys(token)) {
    const user = await users.findByEmail(`disabled-http-${who}@example.test`);
    assert.ok(user);
    userIds[who] = user.id;
  }
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: userIds['editor'] ?? '', role: 'editor' });
  await memberships.create(wid, { userId: userIds['viewer'] ?? '', role: 'viewer' });
  const { seedIntegration, shareIntegrations } =
    await import('../../testing/integrationFixtures.js');
  await seedIntegration(wid, {
    id: GCAL,
    ownerUserId: userIds['editor'] ?? '',
    provider: 'google_calendar',
    accountId: ACCOUNT,
  });
  await shareIntegrations(wid, userIds['editor'] ?? '', [GCAL]);
  await (await models.getItemRepository()).bulkUpsert(wid, MEETING);
});

after(async () => {
  await api.stop();
  guard.restore();
  assert.deepEqual(guard.externalHosts(), [], 'nothing is sent to a provider');
});

describe('a single item', () => {
  it('a to-do is disabled and enabled as a whole, with the rest of the overlay alongside', async () => {
    const made = await call('editor', 'POST', '/items', { title: 'Call the bank' });
    assert.equal(made.status, 201, made.text);
    const id = (made.body?.['data'] as Detail).id;
    const off = await overlay(id, { disabled: true, pinned: true });
    assert.deepEqual([off.overlay.disabled, off.overlay.pinned, off.status], [true, true, 'open']);
    // A scope or an occurrence names nothing more on an item that does not repeat.
    const again = await overlay(id, { disabled: false, scope: 'series' });
    assert.equal(again.overlay.disabled, null);
  });

  it('roles: a viewer is 403, a stranger 404; scope alone is 400; an unknown scope is 400', async () => {
    const id = await idOf('other');
    assert.equal(
      (await call('viewer', 'PATCH', `/items/${id}/overlay`, { disabled: true })).status,
      403,
    );
    assert.equal(
      (await call('stranger', 'PATCH', `/items/${id}/overlay`, { disabled: true })).status,
      404,
    );
    for (const body of [
      { scope: 'series' },
      { occurrenceStart: SUNDAY },
      { disabled: true, scope: 'all' },
      { disabled: true, occurrenceStart: 'Sunday' },
    ]) {
      const res = await call('editor', 'PATCH', `/items/${id}/overlay`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await detail(id)).overlay.disabled, null);
  });

  it('a travel leg is skipped, never disabled (400)', async () => {
    const { item } = await (
      await models.getItemRepository()
    ).upsertTravelLeg(wid, `${userIds['editor'] ?? ''}|x|single|there`, {
      ownerUserId: userIds['editor'] ?? '',
      title: 'Walk',
      topicId: null,
      startAt: new Date(week(0, -1)),
      endAt: new Date(SUNDAY),
      travel: { anchorItemId: 'x', occurrence: 'single', direction: 'there', mode: 'walk' },
    });
    const res = await call('editor', 'PATCH', `/items/${item.id}/overlay`, { disabled: true });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /skipped/);
  });
});

describe('a repeating time block', () => {
  let blockId = '';

  before(async () => {
    const res = await call('editor', 'POST', '/time-blocks', {
      title: 'Gym',
      startAt: SUNDAY,
      endAt: week(0, 1),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
    });
    assert.equal(res.status, 201, res.text);
    blockId = (res.body?.['data'] as Detail).id;
  });

  it('one occurrence, then another: listed by original start, in order', async () => {
    await overlay(blockId, { disabled: true, scope: 'occurrence', occurrenceStart: week(2) });
    const two = await overlay(blockId, { disabled: true, occurrenceStart: week(1) });
    assert.deepEqual(
      [two.overlay.disabled, two.overlay.disabledOccurrences],
      [null, [week(1), week(2)]],
    );
    const one = await overlay(blockId, { disabled: false, occurrenceStart: week(2) });
    assert.deepEqual(one.overlay.disabledOccurrences, [week(1)]);
  });

  it('a start that is none of its slots is 400 not_an_occurrence', async () => {
    const res = await call('editor', 'PATCH', `/items/${blockId}/overlay`, {
      disabled: true,
      occurrenceStart: week(1, 2),
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body?.['code'], 'not_an_occurrence');
  });

  it('the series: every occurrence, the one-by-one marks dropped; one is not enabled alone', async () => {
    const all = await overlay(blockId, { disabled: true, scope: 'series' });
    assert.deepEqual([all.overlay.disabled, all.overlay.disabledOccurrences], [true, []]);
    const alone = await call('editor', 'PATCH', `/items/${blockId}/overlay`, {
      disabled: false,
      occurrenceStart: week(1),
    });
    assert.equal(alone.status, 400, alone.text);
    // No scope and no occurrence on a series: the whole of it.
    const back = await overlay(blockId, { disabled: false });
    assert.deepEqual([back.overlay.disabled, back.overlay.disabledOccurrences], [null, []]);
  });
});

describe('a Google series (its master, a moved and a cancelled occurrence)', () => {
  it('series from the master marks every row of it, and only those', async () => {
    const master = await idOf('daily');
    const off = await overlay(master, { disabled: true, scope: 'series' });
    assert.equal(off.overlay.disabled, true);
    for (const row of ['daily_moved', 'daily_cancelled']) {
      assert.equal((await detail(await idOf(row))).overlay.disabled, true, row);
    }
    assert.equal((await detail(await idOf('other'))).overlay.disabled, null);
    const moved = await detail(await idOf('daily_moved'));
    assert.deepEqual(moved.seriesOccurrence, {
      seriesId: master,
      originalStart: week(1),
      disabled: 'series',
    });
  });

  it('a sync writing the master again keeps the mark (the sync never writes the overlay)', async () => {
    const master = MEETING[0];
    assert.ok(master);
    await (
      await models.getItemRepository()
    ).bulkUpsert(wid, [
      { ...master, title: 'Daily meeting (renamed)', source: { ...master.source, hash: 'new' } },
    ]);
    const stored = await detail(await idOf('daily'));
    assert.deepEqual([stored.title, stored.overlay.disabled], ['Daily meeting (renamed)', true]);
  });

  it('one occurrence is not enabled alone while the series is disabled; series from a row enables all', async () => {
    const moved = await idOf('daily_moved');
    const alone = await call('editor', 'PATCH', `/items/${moved}/overlay`, { disabled: false });
    assert.equal(alone.status, 400, alone.text);
    const on = await overlay(moved, { disabled: false, scope: 'series' });
    assert.equal(on.overlay.disabled, null);
    for (const row of ['daily', 'daily_cancelled']) {
      assert.equal((await detail(await idOf(row))).overlay.disabled, null, row);
    }
  });

  it('one occurrence: its exception row if it has one, else the slot on the master', async () => {
    const master = await idOf('daily');
    const cancelled = await idOf('daily_cancelled');
    // The cancelled occurrence's slot, named on the master: its row takes the mark.
    const viaMaster = await overlay(master, {
      disabled: true,
      scope: 'occurrence',
      occurrenceStart: week(2),
    });
    assert.deepEqual(viaMaster.overlay.disabledOccurrences, []);
    assert.equal((await detail(cancelled)).overlay.disabled, true);
    // A plain slot goes on the master's list.
    const plain = await overlay(master, { disabled: true, occurrenceStart: week(3) });
    assert.deepEqual(plain.overlay.disabledOccurrences, [week(3)]);
    // A slot that is none of the series' is 400.
    const stray = await call('editor', 'PATCH', `/items/${master}/overlay`, {
      disabled: true,
      occurrenceStart: week(3, 1),
    });
    assert.equal(stray.status, 400, stray.text);
    // From the occurrence row itself, with no scope: that occurrence.
    const back = await overlay(cancelled, { disabled: false });
    assert.equal(back.overlay.disabled, null);
    assert.equal((await detail(master)).overlay.disabled, null);
  });

  it('an exception row whose slot the master lists says so, and enabling it clears the list', async () => {
    const master = await idOf('daily');
    const moved = await idOf('daily_moved');
    // As if the slot was disabled on the master before Google moved that occurrence.
    await (
      await models.getItemRepository()
    ).setOccurrenceDisabled(wid, master, week(1), true, new Date());
    assert.equal((await detail(moved)).seriesOccurrence?.disabled, 'occurrence');
    await overlay(moved, { disabled: false, scope: 'occurrence' });
    assert.deepEqual((await detail(master)).overlay.disabledOccurrences, [week(3)]);
    assert.equal((await detail(moved)).seriesOccurrence?.disabled, null);
  });
});

describe('a refused request writes nothing (everything is checked first)', () => {
  it('a field and a slot that is none of the series: 400, the field not stored', async () => {
    const res = await call('editor', 'POST', '/time-blocks', {
      title: 'Swim',
      startAt: SUNDAY,
      endAt: week(0, 1),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
    });
    const id = (res.body?.['data'] as Detail).id;
    const refused = await call('editor', 'PATCH', `/items/${id}/overlay`, {
      pinned: true,
      disabled: true,
      occurrenceStart: week(1, 2),
    });
    assert.equal(refused.status, 400, refused.text);
    assert.equal((await detail(id)).overlay.pinned, null);
    // One occurrence enabled alone in a series disabled as a whole: 400, the note not stored.
    await overlay(id, { disabled: true, scope: 'series' });
    const alone = await call('editor', 'PATCH', `/items/${id}/overlay`, {
      note: 'swim later',
      disabled: false,
      occurrenceStart: week(1),
    });
    assert.equal(alone.status, 400, alone.text);
    assert.equal((await detail(id)).overlay.note, null);
  });

  it('a travel leg with a note and disabled: 400, the note not stored', async () => {
    const { item } = await (
      await models.getItemRepository()
    ).upsertTravelLeg(wid, `${userIds['editor'] ?? ''}|y|single|there`, {
      ownerUserId: userIds['editor'] ?? '',
      title: 'Walk',
      topicId: null,
      startAt: new Date(week(0, -1)),
      endAt: new Date(SUNDAY),
      travel: { anchorItemId: 'y', occurrence: 'single', direction: 'there', mode: 'walk' },
    });
    const res = await call('editor', 'PATCH', `/items/${item.id}/overlay`, {
      note: 'umbrella',
      disabled: true,
    });
    assert.equal(res.status, 400, res.text);
    assert.equal((await detail(item.id)).overlay.note, null);
  });
});

describe('a cancelled Google occurrence reads as its series (I1)', () => {
  it('its detail has the master’s title, topic and link, never its raw id', async () => {
    const master = await detail(await idOf('daily'));
    const cancelled = await detail(await idOf('daily_cancelled'));
    assert.deepEqual(
      [cancelled.title, cancelled.topicId, cancelled.openIn.url, cancelled.status],
      [master.title, master.topicId, master.openIn.url, 'cancelled'],
    );
    assert.notEqual(cancelled.title, 'daily_cancelled');
  });
});

describe('marks follow the series and the cap (M4)', () => {
  let id = '';

  before(async () => {
    const res = await call('editor', 'POST', '/time-blocks', {
      title: 'Choir',
      startAt: SUNDAY,
      endAt: week(0, 1),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
    });
    id = (res.body?.['data'] as Detail).id;
  });

  it('an "all" edit that moves the series drops the marks that are no longer slots', async () => {
    await overlay(id, { disabled: true, occurrenceStart: week(1) });
    await overlay(id, { disabled: true, occurrenceStart: week(2) });
    // The same time of day: the marks are still slots.
    const renamed = await call('editor', 'PATCH', `/time-blocks/${id}`, {
      scope: 'all',
      title: 'Choir practice',
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.deepEqual((await detail(id)).overlay.disabledOccurrences, [week(1), week(2)]);
    const moved = await call('editor', 'PATCH', `/time-blocks/${id}`, {
      scope: 'all',
      startAt: week(0, 2),
      endAt: week(0, 3),
    });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual((await detail(id)).overlay.disabledOccurrences, []);
  });

  it('with the list full, an occurrence older than all it holds is refused (400)', async () => {
    const slots = Array.from({ length: 366 }, (_, n) => week(n + 1, 2));
    await (await models.getItemRepository()).setOverlay(wid, id, { disabledOccurrences: slots });
    const refused = await call('editor', 'PATCH', `/items/${id}/overlay`, {
      disabled: true,
      occurrenceStart: week(0, 2),
    });
    assert.equal(refused.status, 400, refused.text);
    assert.equal((await detail(id)).overlay.disabledOccurrences.length, 366);
    // A newer one still fits (the oldest goes): week 367 is a winter Sunday, a slot at 15:00.
    const fits = await overlay(id, { disabled: true, occurrenceStart: week(367, 2) });
    assert.equal(fits.overlay.disabledOccurrences.length, 366);
    assert.equal(fits.overlay.disabledOccurrences.at(-1), week(367, 2));
  });
});

describe('only rows the caller may see are written (M2)', () => {
  it('a caller narrowed to one topic disables only its rows of the series', async () => {
    const items = await models.getItemRepository();
    await items.bulkUpsert(wid, [
      event('narrow', {
        title: 'Narrow',
        topicId: 'college-topic',
        props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] },
      }),
      event('narrow_moved', {
        title: 'Narrow',
        topicId: 'work-topic',
        startAt: new Date(week(1, 2)),
        endAt: new Date(week(1, 3)),
        props: { eventId: 'narrow_moved', recurringEventId: 'narrow', originalStartAt: week(1) },
      }),
    ]);
    const { contextFor, callerOf } = await import('../../testing/workspaceFixtures.js');
    const { Item } = await import('../../classes/item/index.js');
    const editor = userIds['editor'] ?? '';
    const narrowed = callerOf(
      { ...(await contextFor(wid, editor)), onlyTopics: ['work-topic'] },
      editor,
    );
    const moved = await Item.find(narrowed, await idOf('narrow_moved'));
    await moved.setDisabled(narrowed, { disabled: true, scope: 'series' });
    assert.equal((await detail(await idOf('narrow_moved'))).overlay.disabled, true);
    assert.equal((await detail(await idOf('narrow'))).overlay.disabled, null);
  });
});

describe('across a DST change (the server’s slot check against the shared expansion)', () => {
  it('an occurrence after the clocks went back is disabled at its own wall time', async () => {
    // Sundays 13:00 in Jerusalem from 18 Oct 2026 (UTC+3); the clocks go back on 25 Oct (UTC+2).
    const res = await call('editor', 'POST', '/time-blocks', {
      title: 'Seminar',
      startAt: '2026-10-18T10:00:00.000Z',
      endAt: '2026-10-18T11:00:00.000Z',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
    });
    assert.equal(res.status, 201, res.text);
    const id = (res.body?.['data'] as Detail).id;
    // 13:00 on 1 Nov is 11:00Z; 10:00Z (the old offset's instant) is no slot.
    const wrong = await call('editor', 'PATCH', `/items/${id}/overlay`, {
      disabled: true,
      occurrenceStart: '2026-11-01T10:00:00.000Z',
    });
    assert.equal(wrong.status, 400, wrong.text);
    await overlay(id, { disabled: true, occurrenceStart: '2026-11-01T11:00:00.000Z' });
    const stored = (await call('editor', 'GET', `/items/${id}`)).body?.['data'] as TimeRow;
    const { expandOccurrences } = await import('../../types/recurrence/occurrences.js');
    const out = expandOccurrences(
      [stored],
      { from: new Date('2026-10-17T21:00:00.000Z'), to: new Date('2026-11-08T22:00:00.000Z') },
      'Asia/Jerusalem',
    );
    assert.deepEqual(
      out.map((o) => [o.start.toISOString(), o.inactive]),
      [
        ['2026-10-18T10:00:00.000Z', null],
        ['2026-10-25T11:00:00.000Z', null],
        ['2026-11-01T11:00:00.000Z', 'disabled'],
        ['2026-11-08T11:00:00.000Z', null],
      ],
    );
  });
});

describe('one calendar seen through two accounts', () => {
  it('the cancelled occurrence’s sheet reads as its own copy’s series', async () => {
    const { seedIntegration, shareIntegrations } =
      await import('../../testing/integrationFixtures.js');
    await seedIntegration(wid, {
      id: `${GCAL}-2`,
      ownerUserId: userIds['editor'] ?? '',
      provider: 'google_calendar',
      accountId: 'other@example.test',
    });
    await shareIntegrations(wid, userIds['editor'] ?? '', [GCAL, `${GCAL}-2`]);
    const master = MEETING[0];
    assert.ok(master);
    await (
      await models.getItemRepository()
    ).bulkUpsert(wid, [
      {
        ...master,
        integrationId: `${GCAL}-2`,
        title: 'Daily meeting (their copy)',
        source: { ...master.source, accountId: 'other@example.test' },
      },
    ]);
    const cancelled = await detail(await idOf('daily_cancelled'));
    const own = await detail(await idOf('daily'));
    assert.equal(cancelled.title, own.title);
    assert.equal(cancelled.openIn.url, own.openIn.url);
  });
});
