/**
 * Scheduled items (docs/superpowers/specs/2026-11-17-time-blocks-design.md, "Decisions after
 * review" 1 and 6): a local item of kind `block` is a TimeBlock (a TimeArea when `props.layer` is
 * `area`), one of kind `travel` is a TravelLeg. They are TodoList's own reserved time: never a
 * Todo, never completable, and a block repeats on the workspace's wall clock.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type { CreateLocalItemInput, ItemData } from '../../models/definitions/Item.js';
import type * as Models from '../../models/index.js';
import type { Provider } from '../../types/domain.js';
import { layerOf, isScheduledKind } from '../../types/scheduled.js';
import { travelPropsOf, type TravelLegProps } from '../../types/travel.js';
import type { Caller } from '../base/Caller.js';
import type * as Items from './index.js';

let db: TestDatabase;
let items: typeof Items;
let models: typeof Models;

const OWNER = 'u-scheduled-owner';
const ZONE = 'Asia/Jerusalem';
let workspaces = 0;

const LEG: TravelLegProps = {
  anchorItemId: 'lecture-1',
  occurrence: '2026-11-22T11:00:00.000Z',
  anchorStart: '2026-11-22T11:00:00.000Z',
  direction: 'there',
  mode: 'transit',
  fromPlaceId: 'place-home',
  fromName: 'Home',
  toPlaceId: 'place-braude',
  toName: 'Braude',
  fromHome: true,
  toHome: false,
  minutes: 40,
  source: 'estimate',
  computedAt: '2026-11-18T08:00:00.000Z',
  conflict: false,
  edited: false,
  anchorMoved: false,
  removedReason: null,
};

before(async () => {
  db = await startTestDatabase('todolist_scheduled_items_test');
  items = await import('./index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function workspace(): Promise<{ id: string; editor: Caller }> {
  workspaces += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Reserved time', slug: `reserved-${String(workspaces)}`, ownerId: OWNER });
  const context = { id: created.id, role: 'editor' as const, settings: created.settings };
  return { id: created.id, editor: callerOf(context, OWNER) };
}

async function stored(
  workspaceId: string,
  input: Partial<CreateLocalItemInput> & Pick<CreateLocalItemInput, 'title'>,
): Promise<ItemData> {
  return (await models.getItemRepository()).createLocal(workspaceId, {
    ownerUserId: OWNER,
    topicId: null,
    ...input,
  });
}

describe('kinds and layers', () => {
  it('block and travel are the scheduled kinds; a block is an area by its props', () => {
    assert.equal(isScheduledKind('block'), true);
    assert.equal(isScheduledKind('travel'), true);
    assert.equal(isScheduledKind('todo'), false);
    assert.equal(isScheduledKind('event'), false);
    assert.equal(layerOf({ kind: 'block', props: {} }), 'block');
    assert.equal(layerOf({ kind: 'block', props: { layer: 'area' } }), 'area');
    assert.equal(layerOf({ kind: 'block', props: { layer: 'nonsense' } }), 'block');
    assert.equal(layerOf({ kind: 'travel', props: { layer: 'area' } }), null);
    assert.equal(layerOf({ kind: 'todo', props: {} }), null);
  });

  it('a leg’s travel props are read whole, or not at all', () => {
    assert.deepEqual(travelPropsOf({ travel: LEG }), LEG);
    const flags = ['conflict', 'edited', 'anchorMoved', 'removedReason'];
    const required = Object.fromEntries(
      Object.entries(LEG).filter(([key]) => !flags.includes(key)),
    );
    assert.deepEqual(travelPropsOf({ travel: required }), LEG, 'flags default off');
    assert.equal(travelPropsOf({}), null);
    assert.equal(travelPropsOf({ travel: { ...LEG, mode: 'teleport' } }), null);
    assert.equal(travelPropsOf({ travel: { ...LEG, minutes: -1 } }), null);
    assert.equal(travelPropsOf({ travel: { ...LEG, anchorStart: 'soon' } }), null);
    assert.equal(travelPropsOf({ travel: { ...LEG, removedReason: 'bored' } }), null);
    assert.deepEqual(travelPropsOf({ travel: { ...LEG, removedReason: 'skipped' } }), {
      ...LEG,
      removedReason: 'skipped',
    });
  });
});

describe('scheduled item classes', () => {
  it('classOf maps local block, area and travel', () => {
    const { Item } = items;
    const from = (provider: Provider): Pick<ItemData, 'source'> => ({
      source: {
        provider,
        accountId: '',
        externalId: 'x',
        key: null,
        url: '',
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    });
    const local = from('local');
    assert.equal(Item.classOf({ ...local, kind: 'block', props: {} }), 'block');
    assert.equal(Item.classOf({ ...local, kind: 'block', props: { layer: 'block' } }), 'block');
    assert.equal(Item.classOf({ ...local, kind: 'block', props: { layer: 'area' } }), 'area');
    assert.equal(Item.classOf({ ...local, kind: 'travel', props: {} }), 'travel');
    assert.equal(Item.classOf({ ...local, kind: 'todo', props: {} }), 'todo');
    // Mirrored items are as they were, whatever their props.
    const google = from('google_calendar');
    assert.equal(Item.classOf({ ...google, kind: 'event', props: { layer: 'area' } }), 'event');
    assert.equal(Item.classOf({ ...from('jira'), kind: 'issue', props: {} }), 'task');
  });

  it('Item.from gives TimeBlock, TimeArea and TravelLeg instances', async () => {
    const { Item, TimeArea, TimeBlock, TravelLeg, ScheduledItem, Todo } = items;
    const ws = await workspace();
    const block = Item.from(await stored(ws.id, { title: 'Study: Math', kind: 'block' }));
    const area = Item.from(
      await stored(ws.id, { title: 'Studying', kind: 'block', props: { layer: 'area' } }),
    );
    const leg = Item.from(
      await stored(ws.id, {
        title: 'Bus to Braude',
        kind: 'travel',
        visibility: 'private',
        props: { travel: LEG, travelKey: 'k' },
      }),
    );
    const todo = Item.from(await stored(ws.id, { title: 'Submit homework' }));

    assert.ok(block instanceof TimeBlock && !(block instanceof TimeArea));
    assert.ok(area instanceof TimeArea);
    assert.ok(area instanceof TimeBlock, 'an area is a time block');
    assert.ok(leg instanceof TravelLeg);
    for (const scheduled of [block, area, leg]) {
      assert.ok(scheduled instanceof ScheduledItem);
      assert.ok(!(scheduled instanceof Todo));
      assert.equal(scheduled.isLocal, true);
    }
    assert.ok(todo instanceof Todo);
    assert.equal(block.layer, 'block');
    assert.equal(area.layer, 'area');
    assert.equal(leg.layer, null);
    assert.deepEqual(leg.travel, LEG);
    assert.deepEqual(
      [block, area, leg].map((item) => item.toSummary().layer),
      ['block', 'area', undefined],
    );
    assert.equal('layer' in todo.toSummary(), false);
    // The sheet's hints: every field is TodoList's own, nothing goes to a provider.
    assert.equal((await block.editing()).toView().origin, 'local');
    assert.deepEqual(await leg.providerChanges(), {});
  });

  it('a scheduled item is not completable', async () => {
    const { Item, TimeBlock, TravelLeg, isCompletable, isDeletable } = items;
    const ws = await workspace();
    const block = Item.from(await stored(ws.id, { title: 'Study', kind: 'block' }));
    const area = Item.from(
      await stored(ws.id, { title: 'Work', kind: 'block', props: { layer: 'area' } }),
    );
    const leg = Item.from(
      await stored(ws.id, { title: 'Bus', kind: 'travel', props: { travel: LEG } }),
    );
    const todo = Item.from(await stored(ws.id, { title: 'Chore' }));
    assert.equal(isCompletable(block), false);
    assert.equal(isCompletable(area), false);
    assert.equal(isCompletable(leg), false);
    assert.equal(isCompletable(todo), true);
    // A block and an area are deleted here; a leg is skipped, never deleted.
    assert.deepEqual([block, area, leg, todo].map(isDeletable), [true, true, false, true]);
    assert.ok(block instanceof TimeBlock && leg instanceof TravelLeg);
    // The compiler forbids it too: neither class has a `complete`.
    // @ts-expect-error a time block has no status to complete
    assert.equal(block.complete, undefined);
    // @ts-expect-error a travel leg has no status to complete
    assert.equal(leg.complete, undefined);
    // The guards answer the codes the API answers.
    assert.throws(() => block.completable(), { statusCode: 409, code: 'not_completable' });
    assert.throws(() => leg.completable(), { statusCode: 409, code: 'not_completable' });
    assert.throws(() => leg.deletable(), { statusCode: 409, code: 'not_deletable' });
    assert.equal(todo.completable(), todo);
    assert.equal(block.deletable(), block);
  });

  it('weekly block yields its occurrences in the workspace zone', async () => {
    const { Item, TimeBlock } = items;
    const ws = await workspace();
    // Sunday 13:00–17:00 in Jerusalem, from the last Sunday of summer time (IDT, UTC+3).
    const block = Item.from(
      await stored(ws.id, {
        title: 'Study: Math',
        kind: 'block',
        startAt: new Date('2026-10-18T10:00:00.000Z'),
        endAt: new Date('2026-10-18T14:00:00.000Z'),
        props: {
          layer: 'block',
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
          exceptions: [{ originalStart: '2026-11-01T11:00:00.000Z', skipped: true }],
        },
      }),
    );
    assert.ok(block instanceof TimeBlock);
    assert.equal(block.isRecurring, true);
    assert.deepEqual(block.recurrenceLines, ['RRULE:FREQ=WEEKLY;BYDAY=SU']);
    assert.deepEqual(block.exceptions, [
      { originalStart: '2026-11-01T11:00:00.000Z', skipped: true },
    ]);
    const range = {
      from: new Date('2026-10-17T21:00:00.000Z'),
      to: new Date('2026-11-14T22:00:00.000Z'),
    };
    const occurrences = block.occurrences(range, ZONE);
    // Still 13:00 on the wall clock after the clocks went back (2026-10-25): 11:00Z. The skipped
    // Sunday is left out.
    assert.deepEqual(
      occurrences.map((o) => [o.start.toISOString(), o.end?.toISOString()]),
      [
        ['2026-10-18T10:00:00.000Z', '2026-10-18T14:00:00.000Z'],
        ['2026-10-25T11:00:00.000Z', '2026-10-25T15:00:00.000Z'],
        ['2026-11-08T11:00:00.000Z', '2026-11-08T15:00:00.000Z'],
      ],
    );
    assert.ok(occurrences.every((o) => o.seriesRowId === block.id));
    assert.deepEqual(block.timeRange?.toJSON(), {
      start: '2026-10-18T10:00:00.000Z',
      end: '2026-10-18T14:00:00.000Z',
      allDay: false,
    });

    const once = Item.from(
      await stored(ws.id, {
        title: 'Exam prep',
        kind: 'block',
        startAt: new Date('2026-11-02T08:00:00.000Z'),
        endAt: new Date('2026-11-02T09:00:00.000Z'),
      }),
    );
    assert.ok(once instanceof TimeBlock);
    assert.equal(once.isRecurring, false);
    assert.deepEqual(once.recurrenceLines, []);
    assert.deepEqual(
      once.occurrences(range, ZONE).map((o) => o.start.toISOString()),
      ['2026-11-02T08:00:00.000Z'],
    );
  });

  it('a block reads its subject from its Subject attribute', async () => {
    const { Item, TimeBlock } = items;
    const ws = await workspace();
    const block = Item.from(
      await stored(ws.id, { title: 'Study', kind: 'block', startAt: new Date(), endAt: null }),
    );
    assert.ok(block instanceof TimeBlock);
    assert.equal(block.subject, null);
    await (
      await models.getItemRepository()
    ).setOverlay(ws.id, block.id, {
      attrs: { subject: 'Math' },
    });
    const reread = await Item.find(ws.editor, block.id);
    assert.ok(reread instanceof TimeBlock);
    assert.equal(reread.subject, 'Math');
  });

  it('a generic edit of a block takes its own fields; a leg takes only its start and end; a block is soft-deleted, by an editor who sees it', async () => {
    const { Item, ItemEdit, TimeBlock } = items;
    const ws = await workspace();
    const block = await Item.find(
      ws.editor,
      (
        await stored(ws.id, {
          title: 'Study',
          kind: 'block',
          startAt: new Date('2026-11-22T11:00:00.000Z'),
          endAt: new Date('2026-11-22T15:00:00.000Z'),
        })
      ).id,
    );
    const leg = await Item.find(
      ws.editor,
      (
        await stored(ws.id, {
          title: 'Bus',
          kind: 'travel',
          visibility: 'private',
          props: { travel: LEG },
        })
      ).id,
    );
    await assert.rejects(block.edit(ws.editor, ItemEdit.of({ status: 'done' })), {
      statusCode: 400,
      message: /^status: a time block takes a title, note, topic, start and end/,
    });
    assert.equal((await block.edit(ws.editor, ItemEdit.of({ title: 'x' }))).title, 'x');
    await assert.rejects(leg.edit(ws.editor, ItemEdit.of({ title: 'x' })), {
      statusCode: 400,
      message: /^title: travel takes a new start and end/,
    });
    assert.ok(block instanceof TimeBlock);
    const viewer = callerOf({ ...ws.editor.context, role: 'viewer' }, OWNER);
    await assert.rejects(block.delete(viewer), { statusCode: 403 });
    await block.delete(ws.editor);
    assert.equal(await (await models.getItemRepository()).findById(ws.id, block.id), null);
    await assert.rejects(Item.find(ws.editor, block.id), { statusCode: 404 });
  });

  it('a leg takes its topic and subject from its event, never its own', async () => {
    const { Item } = items;
    const ws = await workspace();
    const leg = await Item.find(
      ws.editor,
      (
        await stored(ws.id, {
          title: 'Bus',
          kind: 'travel',
          visibility: 'private',
          props: { travel: LEG },
        })
      ).id,
    );
    await assert.rejects(leg.setOverlay(ws.editor, { topicOverride: null }), {
      statusCode: 400,
    });
    await assert.rejects(leg.setOverlay(ws.editor, { attrs: { subject: 'Math' } }), {
      statusCode: 400,
    });
    await assert.rejects(leg.setAttributes(ws.editor, { subject: 'Math' }), { statusCode: 400 });
    // TodoList's other own fields stay open to it.
    const pinned = await leg.setOverlay(ws.editor, { pinned: true });
    assert.equal(pinned.overlay.pinned, true);
  });

  it('the to-do paths never take a scheduled item', async () => {
    const { Todo } = items;
    const ws = await workspace();
    const block = await stored(ws.id, { title: 'Study', kind: 'block' });
    const leg = await stored(ws.id, { title: 'Bus', kind: 'travel', props: { travel: LEG } });
    for (const id of [block.id, leg.id]) {
      await assert.rejects(Todo.findOwn(ws.editor, id), { statusCode: 404 });
      await assert.rejects(
        Todo.copyOwn(ws.editor, id, {
          integrationId: 'nowhere',
          requestId: '00000000-0000-4000-8000-000000000000',
          target: { provider: 'clickup', listId: 'list-1' },
        }),
        { statusCode: 404 },
      );
    }
    // Nor does a provider copy attach to one at the repository.
    const repository = await models.getItemRepository();
    const copy = {
      integrationId: 'i-1',
      provider: 'jira' as const,
      externalId: '',
      key: null,
      url: '',
      status: 'pending' as const,
      requestId: 'r-1',
      at: new Date(),
    };
    assert.equal(await repository.addCopy(ws.id, block.id, copy), false);
    assert.equal(await repository.addCopy(ws.id, leg.id, copy), false);
    const todo = await stored(ws.id, { title: 'Chore' });
    assert.equal(await repository.addCopy(ws.id, todo.id, copy), true);
  });
});
