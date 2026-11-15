/**
 * Editing a mirrored item in the item sheet, as pure functions over the server's `item.editing`:
 * which fields show, which go to the provider and which are kept in TodoList only, why the
 * provider's are locked, the form's draft, the one PATCH a save sends, and what "Use <provider>'s
 * value" sends. The server decides who may write (this only mirrors it, so nothing is offered that
 * it would refuse).
 */
import { ITEM_STATUSES, type ItemStatus } from '@api-types/domain.ts';
import type {
  ItemDetail,
  ItemEditingView,
  OverridableField,
  UpdateItemRequestBody,
} from '@api-types/items.ts';
import { dateInZone, instantInZone, timeInZone } from '../zonedDate.ts';

/** The fields the sheet edits, in the order it shows them. */
export const EDIT_FIELDS = ['title', 'status', 'dueAt', 'startAt', 'endAt', 'priority'] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

/** Why the provider's fields can't be changed by this member now. */
export type ProviderLock =
  /** Its owner keeps the connection read-only (and could switch it). */
  | 'read_only'
  /** Someone else connected it: only they write to the provider. */
  | 'not_owner'
  /** Its grant predates writes: its owner connects it again with Read & write. */
  | 'reconnect'
  /** Writes can't be turned on for it (demo data, or writes off on this server). */
  | 'writes_off';

/** One field of the form. */
export interface FieldPlan {
  field: EditField;
  /** Written back to the provider, or kept in TodoList only (an override). */
  origin: 'provider' | 'override';
  /** This member can change it now. */
  editable: boolean;
  /** A value only in TodoList is set (an override). */
  overridden: boolean;
}

export interface EditPlan {
  fields: FieldPlan[];
  /** Why the provider fields are locked; null when they're writable (or there are none). */
  lock: ProviderLock | null;
  /** Some field can be changed now. */
  anyEditable: boolean;
}

/** What the owner's own integration list says of the item's integration. */
export interface OwnIntegration {
  mode: 'read' | 'read_write';
  canSwitchMode: boolean;
}

const isOverridable = (field: EditField): field is OverridableField => field !== 'endAt';

/** Why `editing.providerFields` are locked for this member, or null. */
export function providerLock(
  editing: ItemEditingView,
  own: OwnIntegration | undefined,
): ProviderLock | null {
  if (editing.origin !== 'provider' || editing.providerFields.length === 0) {
    return null;
  }
  if (editing.canWriteProvider) {
    return null;
  }
  if (!editing.ownsIntegration) {
    return 'not_owner';
  }
  if (editing.needsReconnect) {
    return 'reconnect';
  }
  if (editing.mode === 'read') {
    return own?.canSwitchMode === false ? 'writes_off' : 'read_only';
  }
  // Read & write, yet no writes: this server keeps writes off for it.
  return 'writes_off';
}

/** The form of a mirrored item for a member who may edit the workspace (`canEdit`). */
export function editPlan(
  item: Pick<ItemDetail, 'editing' | 'overlay'>,
  canEdit: boolean,
  own?: OwnIntegration,
): EditPlan {
  const { editing } = item;
  const lock = providerLock(editing, own);
  const fields = EDIT_FIELDS.flatMap((field): FieldPlan[] => {
    if ((editing.providerFields as readonly string[]).includes(field)) {
      return [
        {
          field,
          origin: 'provider',
          editable: canEdit && editing.canWriteProvider,
          overridden: false,
        },
      ];
    }
    if (isOverridable(field) && editing.overridableFields.includes(field)) {
      return [
        {
          field,
          origin: 'override',
          editable: canEdit,
          overridden: item.overlay.overrides[field] !== null,
        },
      ];
    }
    return [];
  });
  return { fields, lock, anyEditable: fields.some((field) => field.editable) };
}

/**
 * The status choices: the provider's reachable ones when the status is written back (the current
 * one first when it isn't among them, so the control shows it), every status for an override.
 */
export function statusChoices(
  editing: ItemEditingView,
  origin: FieldPlan['origin'],
  current: ItemStatus,
): ItemStatus[] {
  if (origin === 'override') {
    return [...ITEM_STATUSES];
  }
  const reachable = ITEM_STATUSES.filter((status) => editing.reachableStatuses.includes(status));
  return reachable.includes(current) ? reachable : [current, ...reachable];
}

/** The form's draft: dates and times as the inputs hold them, in the workspace's zone. */
export interface EditDraft {
  title: string;
  status: ItemStatus;
  /** `YYYY-MM-DD`, or '' for none. */
  dueDate: string;
  /** `YYYY-MM-DD`, or '' for none. */
  startDate: string;
  /** `HH:MM`, or '' (an all-day event, or a task's start, has none). */
  startTime: string;
  endDate: string;
  endTime: string;
  /** '' for none, else '0'…'4'. */
  priority: string;
}

type Datable = Pick<
  ItemDetail,
  'kind' | 'title' | 'status' | 'dueAt' | 'startAt' | 'endAt' | 'allDay' | 'priority'
>;

/** An event with a time of day (start and end are edited as dates and times). */
export function isTimedEvent(item: Pick<ItemDetail, 'kind' | 'allDay'>): boolean {
  return item.kind === 'event' && !item.allDay;
}

const dateOf = (value: Date | string | null, timeZone: string): string =>
  value === null ? '' : dateInZone(value, timeZone);
const timeOf = (value: Date | string | null, timeZone: string): string =>
  value === null ? '' : timeInZone(value, timeZone);

export function draftOf(item: Datable, timeZone: string): EditDraft {
  const timed = isTimedEvent(item);
  return {
    title: item.title,
    status: item.status,
    dueDate: dateOf(item.dueAt, timeZone),
    startDate: dateOf(item.startAt, timeZone),
    startTime: timed ? timeOf(item.startAt, timeZone) : '',
    endDate: dateOf(item.endAt, timeZone),
    endTime: timed ? timeOf(item.endAt, timeZone) : '',
    priority: item.priority === null ? '' : String(item.priority),
  };
}

/**
 * A new start for a timed event moves its end with it (Google keeps the duration): the draft's end
 * after the start changed, as the form shows it.
 */
export function withStart(
  item: Datable,
  draft: EditDraft,
  start: { date: string; time: string },
  timeZone: string,
): EditDraft {
  const next = { ...draft, startDate: start.date, startTime: start.time };
  if (!isTimedEvent(item) || draft.startDate === '' || draft.endDate === '' || start.date === '') {
    return next;
  }
  const before = Date.parse(instantInZone(draft.startDate, draft.startTime || '00:00', timeZone));
  const after = Date.parse(instantInZone(start.date, start.time || '00:00', timeZone));
  const end = Date.parse(instantInZone(draft.endDate, draft.endTime || '00:00', timeZone));
  if (Number.isNaN(before) || Number.isNaN(after) || Number.isNaN(end)) {
    return next;
  }
  const moved = new Date(end + (after - before));
  return { ...next, endDate: dateInZone(moved, timeZone), endTime: timeInZone(moved, timeZone) };
}

/**
 * A date as an instant: the time of day the field had (so moving a ClickUp due date keeps its
 * hour), else noon, which is never inside a DST gap.
 */
function instantFor(date: string, previous: Date | string | null, keepTime: boolean, zone: string) {
  const time = keepTime && previous !== null ? timeInZone(previous, zone) : '12:00';
  return instantInZone(date, time, zone);
}

const same = (a: Date | string | null, b: string | null): boolean =>
  (a === null ? null : new Date(a).toISOString()) === b;

/**
 * The PATCH a save sends: the editable fields the draft changed, nothing else (so a locked or
 * unchanged provider field is never sent). An event's time: the start alone keeps the duration;
 * the end goes too only when the member changed it. Null when nothing changed.
 */
export function patchOf(
  item: Datable,
  plan: EditPlan,
  draft: EditDraft,
  timeZone: string,
): UpdateItemRequestBody | null {
  const before = draftOf(item, timeZone);
  const editable = new Map(
    plan.fields.filter((field) => field.editable).map((field) => [field.field, field]),
  );
  const body: UpdateItemRequestBody = {};
  const title = draft.title.trim();
  if (editable.has('title') && title !== '' && title !== item.title) {
    body.title = title;
  }
  if (editable.has('status') && draft.status !== item.status) {
    body.status = draft.status;
  }
  const due = editable.get('dueAt');
  if (due !== undefined && draft.dueDate !== before.dueDate) {
    if (draft.dueDate === '') {
      body.dueAt = null;
    } else {
      body.dueAt = instantFor(draft.dueDate, item.dueAt, !item.allDay, timeZone);
      // A due date kept in TodoList is a day (no time), for an item without a start of its own.
      if (due.origin === 'override' && item.kind !== 'event' && item.startAt === null) {
        body.allDay = true;
      }
    }
  }
  if (editable.has('startAt')) {
    addStart(item, draft, before, timeZone, body, editable.has('endAt'));
  }
  if (editable.has('priority') && draft.priority !== before.priority) {
    body.priority = draft.priority === '' ? null : Number(draft.priority);
  }
  return Object.keys(body).length === 0 ? null : body;
}

/** The start (and an event's end) of a save, into `body`. */
function addStart(
  item: Datable,
  draft: EditDraft,
  before: EditDraft,
  timeZone: string,
  body: UpdateItemRequestBody,
  endEditable: boolean,
): void {
  if (item.kind !== 'event') {
    if (draft.startDate !== before.startDate) {
      body.startAt =
        draft.startDate === '' ? null : instantFor(draft.startDate, item.startAt, true, timeZone);
    }
    return;
  }
  // An event keeps a start: an emptied date is not a change.
  if (draft.startDate === '') {
    return;
  }
  const timed = isTimedEvent(item);
  // An all-day event is stored at midnight of its day in the workspace's zone.
  const start = instantInZone(
    draft.startDate,
    timed ? draft.startTime || '00:00' : '00:00',
    timeZone,
  );
  if (!same(item.startAt, start)) {
    body.startAt = start;
  }
  if (!timed || !endEditable || draft.endDate === '') {
    return;
  }
  const end = instantInZone(draft.endDate, draft.endTime || '00:00', timeZone);
  const shift = item.startAt === null ? 0 : Date.parse(start) - new Date(item.startAt).getTime();
  const keptDuration =
    item.endAt === null ? null : new Date(new Date(item.endAt).getTime() + shift).toISOString();
  // An end alone keeps the start; with a new start, both are taken as given.
  if (end !== keptDuration) {
    body.endAt = end;
  }
}

/**
 * "Use <provider>'s value": the PATCH that clears one override. A title or status goes back by
 * sending the provider's own value; a date or the priority by null. Null when the provider's
 * value isn't known (or the title came back redacted, so sending it would keep a wrong value).
 */
export function clearOverrideBody(
  field: OverridableField,
  sourceValues: ItemDetail['sourceValues'],
): UpdateItemRequestBody | null {
  switch (field) {
    case 'title':
      return sourceValues === null || sourceValues.title.includes('[REDACTED:')
        ? null
        : { title: sourceValues.title };
    case 'status':
      return sourceValues === null ? null : { status: sourceValues.status };
    case 'dueAt':
      return { dueAt: null };
    case 'startAt':
      return { startAt: null };
    case 'priority':
      return { priority: null };
  }
}
