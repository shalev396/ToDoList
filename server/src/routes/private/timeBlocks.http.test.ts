/**
 * Time blocks over HTTP (docs/superpowers/specs/2026-11-17-time-blocks-design.md): create (201,
 * then 200 for the same idempotency key), edit this one or all, skip; the envelope, strict schemas
 * (an unknown key is 400), the role matrix, and a block the caller can't see.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { findSecrets } from '../../services/secretPatterns.js';

let api: ApiHarness;
const token = { owner: '', editor: '', viewer: '', editor2: '', stranger: '' };
let wid = '';
let privateBlockId = '';
let todoId = '';

type Who = keyof typeof token;

/** Sunday 22 November 2026, 13:00 in Jerusalem, and the Sundays after it. */
const SUNDAY = '2026-11-22T11:00:00.000Z';
const week = (n: number, hours = 0): string =>
  new Date(Date.parse(SUNDAY) + n * 7 * 24 * 3_600_000 + hours * 3_600_000).toISOString();

interface Block {
  id: string;
  kind: string;
  layer?: string;
  title: string;
  topicId: string | null;
  startAt: string;
  endAt: string;
  props: {
    layer?: string;
    recurrence?: string[];
    recurrenceEnd?: string | null;
    exceptions?: unknown[];
  };
  overlay: { attrs: Record<string, unknown> };
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  assert.deepEqual(findSecrets(res.body), [], res.text);
  return res;
}

function block(res: ApiResponse): Block {
  return res.body?.['data'] as Block;
}

async function created(body: Record<string, unknown>): Promise<Block> {
  const res = await call('editor', 'POST', '/time-blocks', body);
  assert.equal(res.status, 201, res.text);
  return block(res);
}

const weekly = {
  startAt: SUNDAY,
  endAt: week(0, 4),
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
};

before(async () => {
  api = await startApiHarness('todolist_time_blocks_http');
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`blocks-http-${who}@example.test`)).token;
  }
  const workspace = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Blocks HTTP' },
  });
  wid = (workspace.body?.['data'] as { id: string }).id;
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  await addDefaultTopics(wid, { slugIds: true });
  const models = await import('../../models/index.js');
  const users = await models.getUserRepository();
  const ids: Record<string, string> = {};
  for (const who of Object.keys(token)) {
    const user = await users.findByEmail(`blocks-http-${who}@example.test`);
    assert.ok(user);
    ids[who] = user.id;
  }
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ids['editor'] ?? '', role: 'editor' });
  await memberships.create(wid, { userId: ids['viewer'] ?? '', role: 'viewer' });
  await memberships.create(wid, { userId: ids['editor2'] ?? '', role: 'editor' });
  const items = await models.getItemRepository();
  privateBlockId = (
    await items.createLocal(wid, {
      ownerUserId: ids['editor'] ?? '',
      title: 'My own study',
      topicId: null,
      kind: 'block',
      visibility: 'private',
      startAt: new Date(SUNDAY),
      endAt: new Date(week(0, 2)),
      props: { layer: 'block', recurrence: weekly.recurrence, exceptions: [] },
    })
  ).id;
  todoId = (
    await items.createLocal(wid, {
      ownerUserId: ids['editor'] ?? '',
      title: 'Chore',
      topicId: null,
    })
  ).id;
});

after(async () => {
  await api.stop();
});

describe('POST /time-blocks', () => {
  it('201 with the block in the envelope; the same idempotency key again is 200', async () => {
    const first = await call('editor', 'POST', '/time-blocks', {
      ...weekly,
      subject: 'Math',
      topicId: 'college',
      idempotencyKey: 'math-sundays',
    });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(Object.keys(first.body ?? {}), ['data']);
    const made = block(first);
    assert.deepEqual(
      [made.kind, made.layer, made.title, made.topicId, made.overlay.attrs['subject']],
      ['block', 'block', 'Math', 'college', 'Math'],
    );
    assert.deepEqual(made.props.recurrence, weekly.recurrence);
    assert.equal(made.props.recurrenceEnd, null);
    assert.deepEqual(made.props.exceptions, []);
    const again = await call('editor', 'POST', '/time-blocks', {
      ...weekly,
      subject: 'Math',
      idempotencyKey: 'math-sundays',
    });
    assert.equal(again.status, 200, again.text);
    assert.equal(block(again).id, made.id);
    // The subject was added once.
    const attributes = (await call('editor', 'GET', '/attributes')).body?.['data'] as {
      key: string;
      options?: string[];
    }[];
    assert.deepEqual(attributes.find((def) => def.key === 'subject')?.options, ['Math']);
  });

  it('an area', async () => {
    const area = await created({ ...weekly, layer: 'area', title: 'Studying' });
    assert.deepEqual([area.layer, area.props.layer], ['area', 'area']);
    const untitled = await call('editor', 'POST', '/time-blocks', { ...weekly, layer: 'area' });
    assert.equal(untitled.status, 400, untitled.text);
  });

  it('400 for an unknown key, a bad time, a bad rule or a block too long', async () => {
    for (const body of [
      { ...weekly, title: 'x', status: 'open' },
      { ...weekly, title: 'x', kind: 'todo' },
      { title: 'x', startAt: SUNDAY },
      { title: 'x', startAt: 'Sunday', endAt: week(0, 1) },
      { ...weekly, title: 'x', recurrence: ['RRULE:FREQ=HOURLY'] },
      { ...weekly, title: 'x', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231'] },
      { title: 'x', startAt: SUNDAY, endAt: week(0, 25) },
      { ...weekly, title: 'x', layer: 'band' },
      { ...weekly, subject: 'y'.repeat(41) },
    ]) {
      const res = await call('editor', 'POST', '/time-blocks', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
  });

  it('a viewer is refused (403), a non-member does not find the workspace (404)', async () => {
    assert.equal(
      (await call('viewer', 'POST', '/time-blocks', { ...weekly, title: 'x' })).status,
      403,
    );
    assert.equal(
      (await call('stranger', 'POST', '/time-blocks', { ...weekly, title: 'x' })).status,
      404,
    );
  });
});

describe('PATCH /time-blocks/:id and POST …/skip', () => {
  it('this one: an exception keyed by its original start', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    const res = await call('editor', 'PATCH', `/time-blocks/${study.id}`, {
      scope: 'this',
      originalStart: week(1),
      startAt: week(1, 1),
      endAt: week(1, 3),
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(block(res).props.exceptions, [
      { originalStart: week(1), startAt: week(1, 1), endAt: week(1, 3) },
    ]);
    assert.equal(block(res).startAt, SUNDAY);
    const wrong = await call('editor', 'PATCH', `/time-blocks/${study.id}`, {
      scope: 'this',
      originalStart: week(1, 1),
      startAt: week(1, 2),
      endAt: week(1, 3),
    });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(wrong.body?.['code'], 'not_an_occurrence');
  });

  it('all: the series; stale exceptions are dropped', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    await call('editor', 'POST', `/time-blocks/${study.id}/skip`, { originalStart: week(1) });
    const renamed = await call('editor', 'PATCH', `/time-blocks/${study.id}`, {
      scope: 'all',
      title: 'Study hard',
      subject: 'Physics',
      note: null,
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.deepEqual(
      [block(renamed).title, block(renamed).overlay.attrs['subject']],
      ['Study hard', 'Physics'],
    );
    assert.equal(block(renamed).props.exceptions?.length, 1);
    const later = await call('editor', 'PATCH', `/time-blocks/${study.id}`, {
      scope: 'all',
      startAt: week(0, 1),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=10'],
    });
    assert.equal(later.status, 200, later.text);
    assert.deepEqual(block(later).props.exceptions, []);
    assert.equal(block(later).props.recurrenceEnd, week(9, 5));
  });

  it('skip: a skipped exception', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    const res = await call('editor', 'POST', `/time-blocks/${study.id}/skip`, {
      originalStart: week(2),
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(block(res).props.exceptions, [{ originalStart: week(2), skipped: true }]);
    const once = await created({ title: 'Once', startAt: SUNDAY, endAt: week(0, 1) });
    const notSeries = await call('editor', 'POST', `/time-blocks/${once.id}/skip`, {
      originalStart: SUNDAY,
    });
    assert.equal(notSeries.status, 400, notSeries.text);
    assert.equal(notSeries.body?.['code'], 'not_an_occurrence');
  });

  it('400 for an unknown key or fields the scope does not take', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    for (const body of [
      { scope: 'all', title: 'x', status: 'done' },
      { scope: 'all' },
      { scope: 'all', originalStart: week(1), title: 'x' },
      { scope: 'this', startAt: week(1), endAt: week(1, 1) },
      { scope: 'this', originalStart: week(1), startAt: week(1) },
      { scope: 'this', originalStart: week(1), startAt: week(1), endAt: week(1, 1), title: 'x' },
      { scope: 'some', title: 'x' },
      { title: 'x' },
    ]) {
      const res = await call('editor', 'PATCH', `/time-blocks/${study.id}`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
    for (const body of [{}, { originalStart: week(1), skipped: true }]) {
      const res = await call('editor', 'POST', `/time-blocks/${study.id}/skip`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
  });

  it('a viewer is refused; another member’s private block and a to-do are not found', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    const edit = { scope: 'all', title: 'Taken' };
    assert.equal((await call('viewer', 'PATCH', `/time-blocks/${study.id}`, edit)).status, 403);
    assert.equal(
      (await call('viewer', 'POST', `/time-blocks/${study.id}/skip`, { originalStart: week(1) }))
        .status,
      403,
    );
    // A shared block is edited by any editor; a private one is its member's only.
    assert.equal((await call('editor2', 'PATCH', `/time-blocks/${study.id}`, edit)).status, 200);
    for (const who of ['editor2', 'owner'] as const) {
      assert.equal(
        (await call(who, 'PATCH', `/time-blocks/${privateBlockId}`, edit)).status,
        404,
        who,
      );
      const skipped = await call(who, 'POST', `/time-blocks/${privateBlockId}/skip`, {
        originalStart: week(1),
      });
      assert.equal(skipped.status, 404, who);
    }
    assert.equal((await call('editor', 'PATCH', `/time-blocks/${todoId}`, edit)).status, 404);
    assert.equal(
      (await call('editor', 'PATCH', `/time-blocks/${privateBlockId}`, edit)).status,
      200,
    );
  });

  it('a generic PATCH /items/:id on a block edits the series; other fields are 400', async () => {
    const study = await created({ ...weekly, title: 'Study' });
    const renamed = await call('editor', 'PATCH', `/items/${study.id}`, { title: 'Read' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(block(renamed).title, 'Read');
    const status = await call('editor', 'PATCH', `/items/${study.id}`, { status: 'done' });
    assert.equal(status.status, 400, status.text);
    assert.match(String(status.body?.['message']), /^status: a time block takes/);
  });
});
