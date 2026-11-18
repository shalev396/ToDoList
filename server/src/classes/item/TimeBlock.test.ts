/**
 * TimeBlock's own writes (docs/superpowers/specs/2026-11-17-time-blocks-design.md, "Subject",
 * "Creating and filling the week", Decisions 2 and 5; plan Rulings 2 and 3): a block is created
 * with its subject (added to the workspace on first use), a title and a topic by default; one
 * occurrence is moved ("this one": an exception keyed by its original start) or skipped; the series
 * is edited ("all"), dropping the exceptions that are no longer its occurrences; and every save of
 * a series stores when it ends (`props.recurrenceEnd`).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { addDefaultTopics, callerOf } from '../../testing/workspaceFixtures.js';
import type * as Models from '../../models/index.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import type { LocalException } from '../../types/recurrence/occurrences.js';
import type { Caller } from '../base/Caller.js';
import type * as Workspaces from '../workspace/index.js';
import type * as Items from './index.js';
import type { NewTimeBlock } from './TimeBlock.js';

let db: TestDatabase;
let items: typeof Items;
let workspaces: typeof Workspaces;
let models: typeof Models;

const OWNER = 'u-blocks-owner';
const OTHER = 'u-blocks-other';
const HOUR = 3_600_000;
/** Sunday 22 November 2026, 13:00 in Jerusalem (UTC+2). */
const SUNDAY = new Date('2026-11-22T11:00:00.000Z');
const WEEKLY = ['RRULE:FREQ=WEEKLY;BYDAY=SU'];
let count = 0;

interface Ws {
  id: string;
  editor: Caller;
  viewer: Caller;
  topics: Record<'work' | 'college' | 'personal', string>;
}

before(async () => {
  db = await startTestDatabase('todolist_time_block_test');
  items = await import('./index.js');
  workspaces = await import('../workspace/index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function workspace(): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Blocks', slug: `blocks-${String(count)}`, ownerId: OWNER });
  const topics = await addDefaultTopics(created.id);
  const context = { id: created.id, role: 'editor' as const, settings: created.settings };
  return {
    id: created.id,
    editor: callerOf(context, OWNER),
    viewer: callerOf({ ...context, role: 'viewer' }, OWNER),
    topics,
  };
}

/** Sunday 13:00–17:00 in Jerusalem, with whatever else the test gives. */
function sunday(over: Partial<NewTimeBlock> = {}): NewTimeBlock {
  return {
    layer: 'block',
    startAt: SUNDAY,
    endAt: new Date(SUNDAY.getTime() + 4 * HOUR),
    ...over,
  };
}

async function make(ws: Ws, over: Partial<NewTimeBlock> = {}): Promise<Items.TimeBlock> {
  return (await items.TimeBlock.create(ws.editor, sunday(over))).block;
}

/** The Subject select's options as stored now. */
async function subjectOptions(ws: Ws): Promise<readonly string[] | undefined> {
  const workspace = await workspaces.Workspace.load(ws.editor);
  return workspace.settings.attributes.find('subject')?.toJSON().options;
}

function exceptionsOf(block: Items.TimeBlock): readonly LocalException[] {
  return block.exceptions;
}

const week = (n: number): Date => new Date(SUNDAY.getTime() + n * 7 * 24 * HOUR);
const plus = (date: Date, hours: number): Date => new Date(date.getTime() + hours * HOUR);

describe('TimeBlock.create', () => {
  it('title defaults to the subject', async () => {
    const ws = await workspace();
    const math = await make(ws, { subject: 'Math' });
    assert.deepEqual(
      [math.title, math.subject, math.kind, math.layer],
      ['Math', 'Math', 'block', 'block'],
    );
    const titled = await make(ws, { subject: 'Math', title: 'Study: Math' });
    assert.deepEqual([titled.title, titled.subject], ['Study: Math', 'Math']);
    // The option as stored, whatever its case when typed.
    const lower = await make(ws, { subject: '  math ' });
    assert.deepEqual([lower.title, lower.subject], ['Math', 'Math']);
    await assert.rejects(make(ws), { statusCode: 400, message: /title/ });
  });

  it('subject is created on first use', async () => {
    const ws = await workspace();
    assert.equal(await subjectOptions(ws), undefined);
    await make(ws, { subject: 'Math' });
    assert.deepEqual(await subjectOptions(ws), ['Math']);
    await make(ws, { subject: 'MATH' });
    await make(ws, { subject: 'History' });
    assert.deepEqual(await subjectOptions(ws), ['Math', 'History']);
    const attribute = (await workspaces.Workspace.load(ws.editor)).settings.attributes.find(
      'subject',
    );
    assert.equal(attribute?.toJSON().type, 'select');
    assert.equal(attribute.toJSON().name, 'Subject');
  });

  it('topic: preset, else last used with the subject, else null; never the personal topic', async () => {
    const ws = await workspace();
    assert.equal((await make(ws, { subject: 'Math' })).topicId, null);
    assert.equal((await make(ws, { title: 'Free time' })).topicId, null);
    assert.equal(
      (await make(ws, { subject: 'Math', topicId: ws.topics.college })).topicId,
      ws.topics.college,
    );
    assert.equal((await make(ws, { subject: 'Math' })).topicId, ws.topics.college);
    assert.equal((await make(ws, { subject: 'math' })).topicId, ws.topics.college);
    assert.equal(await items.TimeBlock.lastTopicForSubject(ws.editor, 'Math'), ws.topics.college);
    assert.equal((await make(ws, { subject: 'History' })).topicId, null);
    // A preset null is Unsorted, and an Unsorted block is no topic to follow.
    assert.equal((await make(ws, { subject: 'Math', topicId: null })).topicId, null);
    assert.equal((await make(ws, { subject: 'Math' })).topicId, ws.topics.college);
    await assert.rejects(make(ws, { topicId: 'no-such-topic', title: 'x' }), {
      statusCode: 400,
    });
    // Another member's private block with the subject is not theirs to follow.
    await (
      await models.getItemRepository()
    ).createLocal(ws.id, {
      ownerUserId: OTHER,
      title: 'Theirs',
      topicId: ws.topics.work,
      kind: 'block',
      visibility: 'private',
      props: { layer: 'block', exceptions: [] },
    });
    assert.equal((await make(ws, { subject: 'Math' })).topicId, ws.topics.college);
  });

  it('an area needs a title', async () => {
    const ws = await workspace();
    await assert.rejects(make(ws, { layer: 'area', subject: 'Math' }), {
      statusCode: 400,
      message: /title/,
    });
    const area = await make(ws, { layer: 'area', title: 'Studying', topicId: ws.topics.college });
    assert.ok(area instanceof items.TimeArea);
    assert.deepEqual(
      [area.layer, area.toJSON().props['layer'], area.subject],
      ['area', 'area', null],
    );
    assert.deepEqual(area.toJSON().props['exceptions'], []);
  });

  it('recurrence is checked', async () => {
    const ws = await workspace();
    await assert.rejects(make(ws, { title: 'x', recurrence: ['RRULE:FREQ=HOURLY'] }), {
      statusCode: 400,
    });
    // A date-only UNTIL on a timed block (RFC 5545 wants a UTC time).
    await assert.rejects(
      make(ws, { title: 'x', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231'] }),
      { statusCode: 400, message: /UNTIL/ },
    );
    await assert.rejects(
      make(ws, { title: 'x', recurrence: ['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY'] }),
      { statusCode: 400 },
    );
    const open = await make(ws, { title: 'x', recurrence: ['RRULE:BYDAY=SU;FREQ=WEEKLY'] });
    // Stored in the fixed part order; a rule without an end never ends.
    assert.deepEqual(open.recurrenceLines, WEEKLY);
    assert.equal(open.toJSON().props['recurrenceEnd'], null);
    const three = await make(ws, { title: 'x', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] });
    assert.equal(three.toJSON().props['recurrenceEnd'], plus(week(2), 4).toISOString());
    const single = await make(ws, { title: 'x' });
    assert.equal(single.isRecurring, false);
    assert.equal('recurrenceEnd' in single.toJSON().props, false);
  });

  it('duration 1 min to 24 h', async () => {
    const ws = await workspace();
    const at = (ms: number): Partial<NewTimeBlock> => ({
      title: 'x',
      endAt: new Date(SUNDAY.getTime() + ms),
    });
    for (const ms of [59_000, 0, -HOUR, 24 * HOUR + 60_000]) {
      await assert.rejects(make(ws, at(ms)), { statusCode: 400 }, String(ms));
    }
    for (const ms of [60_000, 24 * HOUR]) {
      assert.equal((await make(ws, at(ms))).endAt?.getTime(), SUNDAY.getTime() + ms);
    }
  });

  it('the same idempotency key gives back the block; a to-do’s key is not a block’s', async () => {
    const ws = await workspace();
    const first = await items.TimeBlock.create(
      ws.editor,
      sunday({ title: 'x', idempotencyKey: 'k' }),
    );
    const again = await items.TimeBlock.create(
      ws.editor,
      sunday({ title: 'y', idempotencyKey: 'k' }),
    );
    assert.deepEqual([first.created, again.created], [true, false]);
    assert.equal(again.block.id, first.block.id);
    assert.equal(again.block.title, 'x');
    await items.Todo.create(ws.editor, { title: 'Chore', idempotencyKey: 'todo-key' });
    await assert.rejects(
      items.TimeBlock.create(ws.editor, sunday({ title: 'x', idempotencyKey: 'todo-key' })),
      { statusCode: 409 },
    );
  });

  it('viewer → 403', async () => {
    const ws = await workspace();
    await assert.rejects(items.TimeBlock.create(ws.viewer, sunday({ title: 'x' })), {
      statusCode: 403,
    });
  });
});

describe('one occurrence', () => {
  it('this-one edit stores an exception keyed by originalStart', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY });
    const moved = await block.editOccurrence(ws.editor, week(1), {
      startAt: plus(week(1), 1),
      endAt: plus(week(1), 4),
    });
    assert.deepEqual(exceptionsOf(moved), [
      {
        originalStart: week(1).toISOString(),
        startAt: plus(week(1), 1).toISOString(),
        endAt: plus(week(1), 4).toISOString(),
      },
    ]);
    // The series stays where it was.
    assert.equal(moved.startAt?.getTime(), SUNDAY.getTime());
    const occurrences = moved.occurrences(
      { from: SUNDAY, to: week(3) },
      ws.editor.settings.timezone,
    );
    assert.deepEqual(
      occurrences.map((o) => [o.start.toISOString(), o.originalStart?.toISOString()]),
      [
        [SUNDAY.toISOString(), SUNDAY.toISOString()],
        [plus(week(1), 1).toISOString(), week(1).toISOString()],
        [week(2).toISOString(), week(2).toISOString()],
      ],
    );
    // The same occurrence again: its exception is replaced, not added.
    const again = await moved.editOccurrence(ws.editor, week(1), {
      startAt: plus(week(1), -1),
      endAt: plus(week(1), 2),
    });
    assert.equal(exceptionsOf(again).length, 1);
    assert.equal(exceptionsOf(again)[0]?.startAt, plus(week(1), -1).toISOString());
    // An occurrence's own length is bounded too.
    await assert.rejects(
      again.editOccurrence(ws.editor, week(2), { startAt: week(2), endAt: plus(week(2), 25) }),
      { statusCode: 400 },
    );
  });

  it('originalStart that is not an occurrence → 400 not_an_occurrence', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] });
    const times = { startAt: week(1), endAt: plus(week(1), 1) };
    for (const when of [plus(week(1), 1), plus(week(1), 24), week(-1), week(3)]) {
      await assert.rejects(block.editOccurrence(ws.editor, when, times), {
        statusCode: 400,
        code: 'not_an_occurrence',
      });
      await assert.rejects(block.skipOccurrence(ws.editor, when), {
        statusCode: 400,
        code: 'not_an_occurrence',
      });
    }
    // A block that does not repeat has no occurrence to change.
    const single = await make(ws, { title: 'Once' });
    await assert.rejects(single.skipOccurrence(ws.editor, SUNDAY), {
      statusCode: 400,
      code: 'not_an_occurrence',
    });
  });

  it('skip stores a skipped exception and expansion leaves it out', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY });
    const moved = await block.editOccurrence(ws.editor, week(1), {
      startAt: plus(week(1), 1),
      endAt: plus(week(1), 2),
    });
    // Skipping a moved occurrence replaces its move.
    const skipped = await moved.skipOccurrence(ws.editor, week(1));
    assert.deepEqual(exceptionsOf(skipped), [
      { originalStart: week(1).toISOString(), skipped: true },
    ]);
    const starts = skipped
      .occurrences({ from: SUNDAY, to: week(3) }, ws.editor.settings.timezone)
      .map((o) => o.start.toISOString());
    assert.deepEqual(starts, [SUNDAY.toISOString(), week(2).toISOString()]);
  });

  it('two changes at once both stay (a lost update is retried)', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY });
    await Promise.all([
      block.skipOccurrence(ws.editor, week(1)),
      block.skipOccurrence(ws.editor, week(2)),
      block.skipOccurrence(ws.editor, week(3)),
    ]);
    const stored = await items.TimeBlock.find(ws.editor, block.id);
    assert.deepEqual(
      exceptionsOf(stored)
        .map((exception) => exception.originalStart)
        .sort(),
      [week(1), week(2), week(3)].map((date) => date.toISOString()),
    );
  });

  it('exceptions cap at 366', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Daily', recurrence: ['RRULE:FREQ=DAILY'] });
    const day = (n: number): Date => new Date(SUNDAY.getTime() + n * 24 * HOUR);
    const full = Array.from({ length: PLAN_LIMITS.timeBlockExceptionsMax }, (_, n) => ({
      originalStart: day(n + 1).toISOString(),
      skipped: true,
    }));
    await (
      await models.getItemRepository()
    ).updateScheduled(ws.id, block.id, 'block', {
      props: { ...block.toJSON().props, exceptions: full },
    });
    const capped = await items.TimeBlock.find(ws.editor, block.id);
    assert.equal(exceptionsOf(capped).length, 366);
    await assert.rejects(capped.skipOccurrence(ws.editor, day(400)), {
      statusCode: 400,
      message: /366/,
    });
    // A change to an occurrence already changed takes no new place.
    const moved = await capped.editOccurrence(ws.editor, day(1), {
      startAt: plus(day(1), 1),
      endAt: plus(day(1), 2),
    });
    assert.equal(exceptionsOf(moved).length, 366);
  });
});

describe('every occurrence', () => {
  it('edit all at a new time drops stale exceptions', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY, subject: 'Math' });
    let current = await block.editOccurrence(ws.editor, week(1), {
      startAt: plus(week(1), 1),
      endAt: plus(week(1), 3),
    });
    current = await current.skipOccurrence(ws.editor, week(2));
    // Title, note and topic leave the exceptions as they are; so does a new end.
    current = await current.editSeries(ws.editor, {
      title: 'Study hard',
      note: 'Chapter 3',
      topicId: ws.topics.college,
      endAt: plus(SUNDAY, 3),
    });
    assert.equal(exceptionsOf(current).length, 2);
    assert.deepEqual(
      [current.title, current.toJSON().bodyPreview, current.topicId, current.endAt?.toISOString()],
      ['Study hard', 'Chapter 3', ws.topics.college, plus(SUNDAY, 3).toISOString()],
    );
    // A second weekday keeps every Sunday: both exceptions are still occurrences.
    current = await current.editSeries(ws.editor, {
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU,TU'],
    });
    assert.equal(exceptionsOf(current).length, 2);
    // An hour later: no old slot is an occurrence any more.
    current = await current.editSeries(ws.editor, { startAt: plus(SUNDAY, 1) });
    assert.deepEqual(exceptionsOf(current), []);
    // The start moved, the length stayed.
    assert.deepEqual(
      [current.startAt?.toISOString(), current.endAt?.toISOString()],
      [plus(SUNDAY, 1).toISOString(), plus(SUNDAY, 4).toISOString()],
    );
    assert.equal(current.subject, 'Math');
  });

  it('a series saved again stores its end; one that stops repeating keeps neither', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'] });
    assert.equal(block.toJSON().props['recurrenceEnd'], plus(week(1), 4).toISOString());
    // An occurrence moved past the last one ends the series later.
    const late = await block.editOccurrence(ws.editor, week(1), {
      startAt: plus(week(1), 30),
      endAt: plus(week(1), 32),
    });
    assert.equal(late.toJSON().props['recurrenceEnd'], plus(week(1), 32).toISOString());
    const longer = await late.editSeries(ws.editor, {
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
    });
    assert.equal(longer.toJSON().props['recurrenceEnd'], plus(week(3), 4).toISOString());
    const once = await longer.editSeries(ws.editor, { recurrence: null });
    assert.equal(once.isRecurring, false);
    assert.deepEqual(once.toJSON().props['exceptions'], []);
    assert.equal('recurrence' in once.toJSON().props, false);
    assert.equal('recurrenceEnd' in once.toJSON().props, false);
    assert.equal(once.toJSON().props['layer'], 'block');
  });

  it('subject: a new one is added, null clears it; an area keeps its title', async () => {
    const ws = await workspace();
    const area = await make(ws, { layer: 'area', title: 'Studying' });
    const tagged = await area.editSeries(ws.editor, { subject: 'Physics' });
    assert.deepEqual([tagged.subject, tagged.title, tagged.layer], ['Physics', 'Studying', 'area']);
    assert.deepEqual(await subjectOptions(ws), ['Physics']);
    const cleared = await tagged.editSeries(ws.editor, { subject: null });
    assert.equal(cleared.subject, null);
    await assert.rejects(cleared.editSeries(ws.editor, { title: '   ' }), { statusCode: 400 });
    await assert.rejects(cleared.editSeries(ws.editor, { topicId: 'nope' }), { statusCode: 400 });
    await assert.rejects(
      cleared.editSeries(ws.editor, { recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231'] }),
      { statusCode: 400 },
    );
    await assert.rejects(cleared.editSeries(ws.editor, { endAt: plus(SUNDAY, 25) }), {
      statusCode: 400,
    });
    // A refused edit adds no subject.
    await assert.rejects(
      cleared.editSeries(ws.editor, { subject: 'Chemistry', endAt: plus(SUNDAY, 25) }),
      { statusCode: 400 },
    );
    assert.deepEqual(await subjectOptions(ws), ['Physics']);
  });

  it('a generic edit takes title, note, topic, start and end; anything else is 400', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY });
    const edited = await block.edit(
      ws.editor,
      items.ItemEdit.of({ title: 'Read', note: 'Ch. 1', topicId: ws.topics.work }),
    );
    assert.ok(edited instanceof items.TimeBlock);
    assert.deepEqual([edited.title, edited.topicId], ['Read', ws.topics.work]);
    for (const change of [
      { status: 'done' as const },
      { dueAt: SUNDAY },
      { priority: 2 },
      { containerId: 'c-1' },
      { allDay: true },
      { startAt: null },
      { title: null },
    ]) {
      await assert.rejects(edited.edit(ws.editor, items.ItemEdit.of(change)), {
        statusCode: 400,
      });
    }
  });
});

describe('who may change one', () => {
  it('viewer → 403, and another member’s private block → 404', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study', recurrence: WEEKLY });
    for (const write of [
      block.editSeries(ws.viewer, { title: 'x' }),
      block.editOccurrence(ws.viewer, week(1), { startAt: week(1), endAt: plus(week(1), 1) }),
      block.skipOccurrence(ws.viewer, week(1)),
    ]) {
      await assert.rejects(write, { statusCode: 403 });
    }
    const repository = await models.getItemRepository();
    const theirs = await repository.createLocal(ws.id, {
      ownerUserId: OTHER,
      title: 'Their study',
      topicId: null,
      kind: 'block',
      visibility: 'private',
      startAt: SUNDAY,
      endAt: plus(SUNDAY, 1),
      props: { layer: 'block', recurrence: WEEKLY, exceptions: [] },
    });
    await assert.rejects(items.TimeBlock.find(ws.editor, theirs.id), { statusCode: 404 });
    // A to-do is no time block.
    const todo = await items.Todo.create(ws.editor, { title: 'Chore' });
    await assert.rejects(items.TimeBlock.find(ws.editor, todo.todo.id), { statusCode: 404 });
  });

  it('the to-do path never changes a block, nor the block path a to-do', async () => {
    const ws = await workspace();
    const block = await make(ws, { title: 'Study' });
    const { todo } = await items.Todo.create(ws.editor, { title: 'Chore' });
    const repository = await models.getItemRepository();
    assert.equal(await repository.updateLocal(ws.id, block.id, { title: 'Hijacked' }), null);
    assert.equal(
      await repository.updateScheduled(ws.id, todo.id, 'block', { title: 'Hijacked' }),
      null,
    );
    assert.equal(
      await repository.updateScheduled(ws.id, block.id, 'travel', { title: 'Hijacked' }),
      null,
    );
    assert.equal((await repository.findById(ws.id, block.id))?.title, 'Study');
    assert.equal((await repository.findById(ws.id, todo.id))?.title, 'Chore');
  });
});
