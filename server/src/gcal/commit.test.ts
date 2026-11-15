/**
 * The commit engine: echoes, last write wins both ways and on a tie, a Google
 * delete of a provider item, the 410 reset and when a sync token may be saved.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startGcalFixture, type GcalFixture } from '../testing/gcalFixture.js';
import type { CalendarLinkData, IntegrationData, ItemData } from '../models/index.js';
import type { applyCommit as applyCommitType, CommitCounts } from './commit.js';
import { eventIdFor } from './diff.js';

let fx: GcalFixture;
let applyCommit: typeof applyCommitType;

before(async () => {
  fx = await startGcalFixture('todolist_gcal_commit');
  ({ applyCommit } = await import('./commit.js'));
});
after(async () => {
  await fx.stop();
});

const T0 = Date.parse('2026-11-12T10:00:00Z');

async function integration(): Promise<IntegrationData> {
  const found = await (
    await fx.models.getIntegrationRepository()
  ).findById(fx.workspaceId, fx.integrationId);
  assert.ok(found);
  return found;
}

/** Opens a run and commits `body` into it. */
async function commit(body: Record<string, unknown>): Promise<CommitCounts> {
  const run = await (
    await fx.models.getSyncRunRepository()
  ).create(fx.workspaceId, {
    integrationId: fx.integrationId,
    trigger: 'calendar_push',
    status: 'running',
  });
  return applyCommit(await integration(), { runId: run.id, ...body });
}

function slim(itemId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: eventIdFor(itemId),
    status: 'confirmed',
    etag: '"g2"',
    updated: new Date(T0).toISOString(),
    summary: 'Google title',
    start: { dateTime: '2026-11-20T08:00:00Z' },
    end: { dateTime: '2026-11-20T09:00:00Z' },
    htmlLink: 'https://www.google.com/calendar/event?eid=x',
    priv: { origin: 'todolist', todolistItemId: itemId },
    ...over,
  };
}

/** A local item with a live link; `dashboardEdited` puts the link's last item time before the edit. */
async function linked(title: string, dashboardEdited: boolean): Promise<ItemData> {
  const item = await fx.item(title, 3);
  await (
    await fx.models.getCalendarLinkRepository()
  ).upsert(
    fx.workspaceId,
    fx.integrationId,
    { calendarId: 'primary', googleEventId: eventIdFor(item.id) },
    {
      itemId: item.id,
      direction: 'to_google',
      lastEtag: '"g1"',
      lastGoogleUpdated: new Date(T0 - 60_000),
      lastItemUpdatedAt: new Date(item.updatedAt.getTime() - (dashboardEdited ? 60_000 : 0)),
      pushedHash: '0123456789abcdef',
    },
  );
  return item;
}

/** The user edited the item at `at`, a minute after the last push the link remembers. */
async function setUpdatedAt(itemId: string, at: Date): Promise<void> {
  const mongoose = (await import('mongoose')).default;
  const db = mongoose.connection.db;
  assert.ok(db);
  await db.collection('Items').updateOne({ _id: itemId as never }, { $set: { updatedAt: at } });
  const link = await linkOf(itemId);
  await (
    await fx.models.getCalendarLinkRepository()
  ).upsert(
    fx.workspaceId,
    fx.integrationId,
    { calendarId: link.calendarId, googleEventId: link.googleEventId },
    { itemId, direction: link.direction, lastItemUpdatedAt: new Date(T0 - 120_000) },
  );
}

async function titleOf(itemId: string): Promise<string | undefined> {
  return (await (await fx.models.getItemRepository()).findById(fx.workspaceId, itemId))?.title;
}
async function linkOf(itemId: string): Promise<CalendarLinkData> {
  const link = await (
    await fx.models.getCalendarLinkRepository()
  ).findByItem(fx.workspaceId, fx.integrationId, itemId);
  assert.ok(link);
  return link;
}

describe('commit: pulled events of linked items', () => {
  it('skips an echo of our own write (same etag)', async () => {
    const item = await linked('Echo', false);
    const counts = await commit({
      calendars: [{ id: 'primary', events: [slim(item.id, { etag: '"g1"', summary: 'Changed' })] }],
    });
    assert.equal(counts.echoesSkipped, 1);
    assert.equal(await titleOf(item.id), 'Echo');
  });

  it('applies a Google edit of a local item when only Google changed', async () => {
    const item = await linked('Only Google', false);
    const counts = await commit({ calendars: [{ id: 'primary', events: [slim(item.id)] }] });
    assert.equal(counts.conflicts, 0);
    assert.equal(counts.updated, 1);
    assert.equal(await titleOf(item.id), 'Google title');
    const link = await linkOf(item.id);
    assert.equal(link.lastEtag, '"g2"');
    assert.notEqual(link.pushedHash, null); // what Google now shows is what we would push: idle next run
  });

  it('last write wins: Google, when it is newer than the dashboard edit', async () => {
    const item = await linked('Dash older', true);
    await setUpdatedAt(item.id, new Date(T0 - 10_000));
    const counts = await commit({ calendars: [{ id: 'primary', events: [slim(item.id)] }] });
    assert.equal(counts.conflicts, 1);
    assert.equal(await titleOf(item.id), 'Google title');
    const audit = await (
      await fx.models.getAuditLogRepository()
    ).list(fx.workspaceId, { action: 'gcal.conflict' }, 10);
    assert.ok(
      audit.some((entry) => entry.targetId === item.id && entry.meta['winner'] === 'google'),
    );
  });

  it('last write wins: the dashboard, when it is newer; its version is re-pushed', async () => {
    const item = await linked('Dash newer', true);
    await setUpdatedAt(item.id, new Date(T0 + 10_000));
    const counts = await commit({ calendars: [{ id: 'primary', events: [slim(item.id)] }] });
    assert.equal(counts.conflicts, 1);
    assert.equal(await titleOf(item.id), 'Dash newer');
    const link = await linkOf(item.id);
    assert.equal(link.pushedHash, null);
    assert.equal(link.lastEtag, '"g2"'); // so the next conditional update passes
  });

  it('a tie goes to Google', async () => {
    const item = await linked('Tie', true);
    await setUpdatedAt(item.id, new Date(T0));
    const counts = await commit({ calendars: [{ id: 'primary', events: [slim(item.id)] }] });
    assert.equal(counts.conflicts, 1);
    assert.equal(await titleOf(item.id), 'Google title');
  });

  it('a Google delete of a local item soft-deletes it and tombstones the link', async () => {
    const item = await linked('Local gone', false);
    const counts = await commit({
      calendars: [{ id: 'primary', events: [slim(item.id, { status: 'cancelled' })] }],
    });
    assert.equal(counts.deleted, 1);
    assert.equal(await titleOf(item.id), undefined);
    const link = await linkOf(item.id);
    assert.equal(link.deletedBy, 'google');
    assert.notEqual(link.tombstonedAt, null);
  });

  it('a Google delete of a provider item sets calendarSync=false and never touches the provider', async () => {
    const items = await fx.models.getItemRepository();
    await items.bulkUpsert(fx.workspaceId, [
      {
        integrationId: fx.integrationId,
        kind: 'task',
        topicId: 'personal',
        title: 'Linear ticket',
        status: 'open',
        dueAt: new Date(T0 + 86_400_000),
        source: {
          provider: 'linear',
          accountId: 'acct',
          externalId: 'FAKE-9',
          key: null,
          url: 'https://linear.app/fake/issue/FAKE-9',
          updatedAtSource: null,
          etag: null,
          hash: 'h9',
        },
      },
    ]);
    const [doc] = await items.aggregate<{ _id: string }>(fx.workspaceId, [
      { $match: { 'source.externalId': 'FAKE-9' } },
    ]);
    assert.ok(doc);
    await (
      await fx.models.getCalendarLinkRepository()
    ).upsert(
      fx.workspaceId,
      fx.integrationId,
      { calendarId: 'primary', googleEventId: eventIdFor(doc._id) },
      { itemId: doc._id, direction: 'to_google', lastEtag: '"g1"', pushedHash: 'x' },
    );
    await commit({
      calendars: [{ id: 'primary', events: [slim(doc._id, { status: 'cancelled' })] }],
    });
    const after = await items.findById(fx.workspaceId, doc._id);
    assert.ok(after);
    assert.equal(after.deletedAt, null);
    assert.equal(after.overlay.calendarSync, false);
    assert.equal((await linkOf(doc._id)).deletedBy, 'google');
  });
});

describe('commit: a move in Google becomes the plan, never a due or start date (I2)', () => {
  const item = (id: string): Promise<ItemData | null> =>
    fx.models.getItemRepository().then((items) => items.findById(fx.workspaceId, id));

  it('a planned-only to-do moved in Google keeps no due date and gets the new plannedAt', async () => {
    const created = await fx.item('Planned only', 0, { dueAt: null });
    const items = await fx.models.getItemRepository();
    await items.setOverlay(fx.workspaceId, created.id, { plannedAt: '2026-11-18' });
    const planned = await item(created.id);
    assert.ok(planned);
    await (
      await fx.models.getCalendarLinkRepository()
    ).upsert(
      fx.workspaceId,
      fx.integrationId,
      { calendarId: 'primary', googleEventId: eventIdFor(created.id) },
      {
        itemId: created.id,
        direction: 'to_google',
        lastEtag: '"g1"',
        lastItemUpdatedAt: planned.updatedAt,
        pushedHash: 'x',
      },
    );
    await commit({
      calendars: [
        {
          id: 'primary',
          events: [
            slim(created.id, {
              summary: 'Planned only',
              start: { date: '2026-11-20' },
              end: { date: '2026-11-21' },
            }),
          ],
        },
      ],
    });
    const after = await item(created.id);
    assert.equal(after?.dueAt, null);
    assert.equal(after.startAt, null);
    assert.equal(after.overlay.plannedAt, '2026-11-20');
    // What Google shows is what we would push now: idle on the next run, no ping-pong.
    const { hashEvent, projectEvent } = await import('./diff.js');
    const { toPushItem } = await import('./commit.js');
    const projection = projectEvent(toPushItem(after), fx.workspaceId, 'Asia/Jerusalem');
    assert.ok(projection);
    assert.equal((await linkOf(created.id)).pushedHash, hashEvent(projection));
  });

  it('a mirrored item moved in Google keeps its provider due date and gets plannedAt (a timed move)', async () => {
    const items = await fx.models.getItemRepository();
    const due = new Date(T0 + 3 * 86_400_000);
    await items.bulkUpsert(fx.workspaceId, [
      {
        integrationId: fx.integrationId,
        kind: 'issue',
        topicId: 'personal',
        title: 'Jira issue',
        status: 'open',
        dueAt: due,
        source: {
          provider: 'jira',
          accountId: 'acct',
          externalId: 'JIRA-7',
          key: 'J-7',
          url: 'https://example.atlassian.net/browse/J-7',
          updatedAtSource: null,
          etag: null,
          hash: 'h7',
        },
      },
    ]);
    const [doc] = await items.aggregate<{ _id: string }>(fx.workspaceId, [
      { $match: { 'source.externalId': 'JIRA-7' } },
    ]);
    assert.ok(doc);
    const stored = await item(doc._id);
    assert.ok(stored);
    await (
      await fx.models.getCalendarLinkRepository()
    ).upsert(
      fx.workspaceId,
      fx.integrationId,
      { calendarId: 'primary', googleEventId: eventIdFor(doc._id) },
      {
        itemId: doc._id,
        direction: 'to_google',
        lastEtag: '"g1"',
        lastItemUpdatedAt: stored.updatedAt,
        pushedHash: 'x',
      },
    );
    await commit({
      calendars: [
        {
          id: 'primary',
          events: [
            slim(doc._id, {
              summary: 'Jira issue (renamed in Google)',
              start: { dateTime: '2026-11-25T08:30:00Z' },
              end: { dateTime: '2026-11-25T09:00:00Z' },
            }),
          ],
        },
      ],
    });
    const after = await item(doc._id);
    assert.equal(after?.dueAt?.getTime(), due.getTime(), 'Jira’s due date stays');
    assert.equal(after.title, 'Jira issue', 'a provider’s title is never taken from Google');
    // 08:30Z is 10:30 in Jerusalem.
    assert.equal(after.overlay.plannedAt, '2026-11-25T10:30');
    // Its title differs from Google's: pushed back over it next run.
    assert.equal((await linkOf(doc._id)).pushedHash, null);
  });
});

describe('commit: another member’s shared item never changes from Google (I6)', () => {
  async function theirs(title: string): Promise<ItemData> {
    const created = await fx.item(title, 3, { ownerUserId: 'u-another-member' });
    await (
      await fx.models.getCalendarLinkRepository()
    ).upsert(
      fx.workspaceId,
      fx.integrationId,
      { calendarId: 'primary', googleEventId: eventIdFor(created.id) },
      {
        itemId: created.id,
        direction: 'to_google',
        lastEtag: '"g1"',
        lastItemUpdatedAt: created.updatedAt,
        pushedHash: '0123456789abcdef',
      },
    );
    return created;
  }

  it('a move or rename in Google loses: the item stays, its event is pushed back', async () => {
    const created = await theirs('Their to-do');
    await commit({ calendars: [{ id: 'primary', events: [slim(created.id)] }] });
    const after = await (await fx.models.getItemRepository()).findById(fx.workspaceId, created.id);
    assert.equal(after?.title, 'Their to-do');
    assert.equal(after.dueAt?.getTime(), created.dueAt?.getTime());
    assert.equal(after.overlay.plannedAt, null);
    assert.equal((await linkOf(created.id)).pushedHash, null);
  });

  it('a delete in Google only takes our link: never their item, never calendarSync', async () => {
    const created = await theirs('Their other to-do');
    await commit({
      calendars: [{ id: 'primary', events: [slim(created.id, { status: 'cancelled' })] }],
    });
    const after = await (await fx.models.getItemRepository()).findById(fx.workspaceId, created.id);
    assert.equal(after?.deletedAt, null);
    assert.equal(after.overlay.calendarSync, null);
    const link = await linkOf(created.id);
    // Held back for good (never ages out), until their item is edited.
    assert.equal(link.deletedBy, 'google_kept');
    assert.notEqual(link.tombstonedAt, null);
  });
});

describe('commit: sync tokens and runs', () => {
  const stateOf = async (): Promise<string | null | undefined> =>
    (
      await (
        await fx.models.getSyncStateRepository()
      ).get(fx.workspaceId, fx.integrationId, 'gcal:tok')
    )?.syncToken;

  it('saves the token of a complete listing, not of a partial one', async () => {
    await commit({
      calendars: [{ id: 'tok', events: [], nextSyncToken: 'tok-1', partial: true }],
    });
    assert.equal(await stateOf(), undefined);
    await commit({
      calendars: [{ id: 'tok', events: [], nextSyncToken: 'tok-2', fullSync: true }],
    });
    assert.equal(await stateOf(), 'tok-2');
  });

  it('a reset (410) clears the token', async () => {
    await commit({ calendars: [{ id: 'tok', events: [], reset: true }] });
    assert.equal(await stateOf(), null);
  });

  it('refuses a commit for a run that is not open, and a malformed one', async () => {
    await assert.rejects(
      applyCommit(await integration(), { runId: 'no-such-run' }),
      /No such open run/,
    );
    await assert.rejects(applyCommit(await integration(), { nonsense: true }), /Invalid commit/);
  });

  it('records op results: a created link with its etag and hash, a conflict counted', async () => {
    const item = await fx.item('Created by op', 3);
    const hash = '0123456789abcdef';
    const counts = await commit({
      opResults: [
        {
          opId: `create.${item.id}.${hash}`,
          ok: true,
          eventId: eventIdFor(item.id),
          etag: '"e9"',
          updated: new Date(T0).toISOString(),
        },
        { opId: `update.${item.id}.${hash}`, ok: false, code: 'conflict' },
      ],
    });
    assert.equal(counts.created, 1);
    assert.equal(counts.conflicts, 1);
    const link = await linkOf(item.id);
    assert.equal(link.lastEtag, '"e9"');
    assert.equal(link.pushedHash, hash);
  });
});
