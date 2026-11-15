import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemDetail, ItemEditingView } from '@api-types/items.ts';
import {
  clearOverrideBody,
  draftOf,
  editPlan,
  patchOf,
  providerLock,
  statusChoices,
  withStart,
} from './editPlan.ts';
import { saveProblemOf } from './saveProblem.ts';

const ZONE = 'Asia/Jerusalem';

const editing = (patch: Partial<ItemEditingView> = {}): ItemEditingView => ({
  origin: 'provider',
  providerFields: ['title', 'status', 'dueAt', 'priority'],
  overridableFields: ['startAt'],
  reachableStatuses: ['open', 'done'],
  ownsIntegration: true,
  mode: 'read_write',
  canWriteProvider: true,
  needsReconnect: false,
  needsGuestNotice: false,
  ...patch,
});

const noOverrides = {
  title: null,
  status: null,
  dueAt: null,
  allDay: null,
  startAt: null,
  priority: null,
};

type Item = Pick<
  ItemDetail,
  | 'kind'
  | 'title'
  | 'status'
  | 'dueAt'
  | 'startAt'
  | 'endAt'
  | 'allDay'
  | 'priority'
  | 'editing'
  | 'overlay'
>;

const item = (patch: Partial<Item> = {}): Item => ({
  kind: 'issue',
  title: 'Write the report',
  status: 'open',
  // Noon on 20 Nov in Jerusalem.
  dueAt: new Date('2026-11-20T10:00:00.000Z'),
  startAt: null,
  endAt: null,
  allDay: true,
  priority: 2,
  editing: editing(),
  overlay: {
    pinned: null,
    note: null,
    hidden: null,
    topicOverride: null,
    calendarSync: null,
    plannedAt: null,
    editedAt: null,
    attrs: {},
    overrides: noOverrides,
  },
  ...patch,
});

describe('providerLock: one reason, the first that applies', () => {
  it('is none when the member can write, or nothing goes to the provider', () => {
    assert.equal(providerLock(editing(), undefined), null);
    assert.equal(
      providerLock(editing({ providerFields: [], canWriteProvider: false }), undefined),
      null,
    );
    assert.equal(
      providerLock(editing({ origin: 'local', canWriteProvider: false }), undefined),
      null,
    );
  });

  it('names who may, then the grant, then the mode', () => {
    const locked = { canWriteProvider: false };
    assert.equal(
      providerLock(editing({ ...locked, ownsIntegration: false, mode: null }), undefined),
      'not_owner',
    );
    assert.equal(
      providerLock(editing({ ...locked, needsReconnect: true }), undefined),
      'reconnect',
    );
    assert.equal(providerLock(editing({ ...locked, mode: 'read' }), undefined), 'read_only');
    assert.equal(
      providerLock(editing({ ...locked, mode: 'read' }), { mode: 'read', canSwitchMode: true }),
      'read_only',
    );
    // Demo data can't be switched: it never says "switch it".
    assert.equal(
      providerLock(editing({ ...locked, mode: 'read' }), { mode: 'read', canSwitchMode: false }),
      'writes_off',
    );
    assert.equal(providerLock(editing({ ...locked, mode: 'read_write' }), undefined), 'writes_off');
  });
});

describe('editPlan', () => {
  it('provider fields follow canWriteProvider; overrides are any editor’s', () => {
    const plan = editPlan(
      item({ editing: editing({ canWriteProvider: false, mode: 'read' }) }),
      true,
    );
    assert.deepEqual(
      plan.fields.map((field) => [field.field, field.origin, field.editable]),
      [
        ['title', 'provider', false],
        ['status', 'provider', false],
        ['dueAt', 'provider', false],
        ['startAt', 'override', true],
        ['priority', 'provider', false],
      ],
    );
    assert.equal(plan.lock, 'read_only');
    assert.equal(plan.anyEditable, true);
  });

  it('a viewer edits nothing', () => {
    const plan = editPlan(item(), false);
    assert.equal(plan.anyEditable, false);
  });

  it('marks the overrides that are set', () => {
    const plan = editPlan(
      item({
        overlay: {
          ...item().overlay,
          overrides: { ...noOverrides, startAt: new Date('2026-11-18T10:00:00Z') },
        },
      }),
      true,
    );
    assert.equal(plan.fields.find((field) => field.field === 'startAt')?.overridden, true);
  });

  it('shows an event’s end only when its provider takes it', () => {
    const event = item({
      kind: 'event',
      editing: editing({
        providerFields: ['title', 'startAt', 'endAt'],
        overridableFields: ['status', 'dueAt', 'priority'],
        reachableStatuses: [],
      }),
    });
    assert.deepEqual(
      editPlan(event, true).fields.map((field) => field.field),
      ['title', 'status', 'dueAt', 'startAt', 'endAt', 'priority'],
    );
  });
});

describe('statusChoices', () => {
  it('a written-back status offers the reachable ones, and keeps the current one', () => {
    assert.deepEqual(statusChoices(editing(), 'provider', 'open'), ['open', 'done']);
    assert.deepEqual(statusChoices(editing(), 'provider', 'in_progress'), [
      'in_progress',
      'open',
      'done',
    ]);
  });

  it('an override offers every status', () => {
    assert.deepEqual(statusChoices(editing(), 'override', 'open'), [
      'open',
      'in_progress',
      'done',
      'cancelled',
    ]);
  });
});

describe('patchOf', () => {
  const plan = (subject: Item) => editPlan(subject, true);

  it('sends nothing when nothing changed', () => {
    const subject = item();
    assert.equal(patchOf(subject, plan(subject), draftOf(subject, ZONE), ZONE), null);
  });

  it('sends only the changed fields, title trimmed', () => {
    const subject = item();
    const draft = { ...draftOf(subject, ZONE), title: '  Write the final report ', priority: '' };
    assert.deepEqual(patchOf(subject, plan(subject), draft, ZONE), {
      title: 'Write the final report',
      priority: null,
    });
  });

  it('never sends a locked provider field', () => {
    const subject = item({ editing: editing({ canWriteProvider: false, ownsIntegration: false }) });
    const draft = { ...draftOf(subject, ZONE), title: 'Renamed', startDate: '2026-11-18' };
    assert.deepEqual(patchOf(subject, plan(subject), draft, ZONE), {
      startAt: '2026-11-18T10:00:00.000Z',
    });
  });

  it('a due date at the provider: noon (or its own time); none clears it', () => {
    const subject = item();
    assert.deepEqual(
      patchOf(subject, plan(subject), { ...draftOf(subject, ZONE), dueDate: '2026-11-25' }, ZONE),
      {
        dueAt: '2026-11-25T10:00:00.000Z',
      },
    );
    assert.deepEqual(
      patchOf(subject, plan(subject), { ...draftOf(subject, ZONE), dueDate: '' }, ZONE),
      {
        dueAt: null,
      },
    );
    // A ClickUp due date at 17:30 keeps its hour.
    const timed = item({ dueAt: new Date('2026-11-20T15:30:00.000Z'), allDay: false });
    assert.deepEqual(
      patchOf(timed, plan(timed), { ...draftOf(timed, ZONE), dueDate: '2026-11-21' }, ZONE),
      { dueAt: '2026-11-21T15:30:00.000Z' },
    );
  });

  it('a due date kept in TodoList is a day, unless the item has a start', () => {
    const github = item({
      dueAt: null,
      editing: editing({
        providerFields: ['title', 'status'],
        overridableFields: ['dueAt', 'startAt', 'priority'],
      }),
    });
    assert.deepEqual(
      patchOf(github, plan(github), { ...draftOf(github, ZONE), dueDate: '2026-12-01' }, ZONE),
      { dueAt: '2026-12-01T10:00:00.000Z', allDay: true },
    );
    const started = { ...github, startAt: new Date('2026-11-18T10:00:00Z') };
    assert.deepEqual(
      patchOf(started, plan(started), { ...draftOf(started, ZONE), dueDate: '2026-12-01' }, ZONE),
      { dueAt: '2026-12-01T10:00:00.000Z' },
    );
  });

  describe('an event’s time', () => {
    const event = item({
      kind: 'event',
      allDay: false,
      dueAt: null,
      priority: null,
      // 09:00–10:30 in Jerusalem (UTC+2).
      startAt: new Date('2026-11-20T07:00:00.000Z'),
      endAt: new Date('2026-11-20T08:30:00.000Z'),
      editing: editing({
        providerFields: ['title', 'startAt', 'endAt'],
        overridableFields: ['status', 'dueAt', 'priority'],
        reachableStatuses: [],
      }),
    });

    it('reads as dates and times in the zone', () => {
      const draft = draftOf(event, ZONE);
      assert.deepEqual(
        [draft.startDate, draft.startTime, draft.endDate, draft.endTime],
        ['2026-11-20', '09:00', '2026-11-20', '10:30'],
      );
    });

    it('a new start moves the end with it and sends the start alone', () => {
      const draft = withStart(
        event,
        draftOf(event, ZONE),
        { date: '2026-11-21', time: '14:00' },
        ZONE,
      );
      assert.deepEqual([draft.endDate, draft.endTime], ['2026-11-21', '15:30']);
      assert.deepEqual(patchOf(event, plan(event), draft, ZONE), {
        startAt: '2026-11-21T12:00:00.000Z',
      });
    });

    it('a new end alone keeps the start; both go when both changed', () => {
      const longer = { ...draftOf(event, ZONE), endTime: '11:00' };
      assert.deepEqual(patchOf(event, plan(event), longer, ZONE), {
        endAt: '2026-11-20T09:00:00.000Z',
      });
      const moved = withStart(
        event,
        draftOf(event, ZONE),
        { date: '2026-11-20', time: '10:00' },
        ZONE,
      );
      assert.deepEqual(patchOf(event, plan(event), { ...moved, endTime: '12:00' }, ZONE), {
        startAt: '2026-11-20T08:00:00.000Z',
        endAt: '2026-11-20T10:00:00.000Z',
      });
    });

    it('an all-day event moves to midnight of its new day; an emptied date is no change', () => {
      const allDay = {
        ...event,
        allDay: true,
        startAt: new Date('2026-11-19T22:00:00.000Z'),
        endAt: new Date('2026-11-20T22:00:00.000Z'),
      };
      const draft = draftOf(allDay, ZONE);
      assert.equal(draft.startTime, '');
      assert.deepEqual(patchOf(allDay, plan(allDay), { ...draft, startDate: '2026-11-23' }, ZONE), {
        startAt: '2026-11-22T22:00:00.000Z',
      });
      assert.equal(patchOf(allDay, plan(allDay), { ...draft, startDate: '' }, ZONE), null);
    });
  });
});

describe('clearOverrideBody', () => {
  const source = {
    title: 'Fix the crash',
    status: 'open' as const,
    dueAt: null,
    allDay: false,
    startAt: null,
    priority: null,
  };

  it('sends the provider’s own title or status; null for a date or the priority', () => {
    assert.deepEqual(clearOverrideBody('title', source), { title: 'Fix the crash' });
    assert.deepEqual(clearOverrideBody('status', source), { status: 'open' });
    assert.deepEqual(clearOverrideBody('dueAt', source), { dueAt: null });
    assert.deepEqual(clearOverrideBody('startAt', null), { startAt: null });
    assert.deepEqual(clearOverrideBody('priority', null), { priority: null });
  });

  it('offers nothing when the provider’s title is unknown or redacted', () => {
    assert.equal(clearOverrideBody('title', null), null);
    assert.equal(clearOverrideBody('status', null), null);
    assert.equal(clearOverrideBody('title', { ...source, title: 'Key [REDACTED:jira]' }), null);
  });
});

describe('saveProblemOf', () => {
  const failed = (status: number, data: unknown) => ({ response: { status, data } });

  it('asks about guests', () => {
    assert.deepEqual(saveProblemOf(failed(409, { code: 'event_has_guests' })), { kind: 'guests' });
  });

  it('lists what reached the provider and what didn’t', () => {
    assert.deepEqual(
      saveProblemOf(
        failed(409, {
          code: 'provider_partial_write',
          details: { written: ['title'], refused: ['status'], uncertain: ['dueAt'] },
        }),
      ),
      { kind: 'partial', written: ['title'], refused: ['status'], uncertain: ['dueAt'] },
    );
    assert.deepEqual(saveProblemOf(failed(409, { code: 'provider_partial_write' })), {
      kind: 'partial',
      written: [],
      refused: [],
      uncertain: [],
    });
  });

  it('names the provider for each of the split edit’s codes', () => {
    const cases: [string, number, string][] = [
      ['integration_not_owner', 403, 'items.edit.errors.notOwner'],
      ['integration_read_only', 409, 'items.edit.errors.readOnly'],
      ['scope_missing', 409, 'items.edit.errors.reconnect'],
      ['provider_writes_off', 409, 'items.edit.errors.writesOff'],
      ['status_not_available', 422, 'items.edit.errors.statusNotAvailable'],
      ['provider_item_missing', 409, 'items.edit.errors.itemMissing'],
    ];
    for (const [code, status, key] of cases) {
      const problem = saveProblemOf(failed(status, { code }));
      assert.equal(problem.kind === 'message' ? problem.key : problem.kind, key, code);
    }
  });

  it('a field the provider won’t take carries its fields and the link', () => {
    assert.deepEqual(
      saveProblemOf(
        failed(422, {
          code: 'field_not_writable',
          details: { fields: ['dueAt'], openIn: { provider: 'jira', url: 'https://j/1' } },
        }),
      ),
      {
        kind: 'message',
        key: 'items.edit.errors.fieldNotWritable',
        fields: ['dueAt'],
        openIn: { provider: 'jira', url: 'https://j/1' },
      },
    );
  });

  it('a field edited at its source only, and anything else', () => {
    assert.deepEqual(
      saveProblemOf(
        failed(409, { message: 'x', openIn: { provider: 'jira', url: 'https://j/1' } }),
      ),
      {
        kind: 'message',
        key: 'items.edit.errors.atSource',
        fields: [],
        openIn: { provider: 'jira', url: 'https://j/1' },
      },
    );
    assert.deepEqual(saveProblemOf(failed(500, {})), {
      kind: 'message',
      key: 'items.sheet.saveError',
      fields: [],
      openIn: null,
    });
    assert.deepEqual(saveProblemOf(failed(429, { code: 'create_rate_limited' })), {
      kind: 'message',
      key: 'errors.codes.createRateLimited',
      fields: [],
      openIn: null,
    });
  });
});
