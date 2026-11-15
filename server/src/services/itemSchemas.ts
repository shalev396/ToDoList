/** Request shapes of the item routes (zod 4). Strict: an unknown key is a 400. */
import { z } from 'zod';

import { AttributeKeySchema } from '../types/attributes.js';
import { ITEM_KINDS, ITEM_STATUSES, PROVIDERS } from '../types/domain.js';

const Iso = z.iso.datetime({ offset: true });
const Title = z.string().trim().min(1).max(300);
const Note = z.string().max(5000);
const Priority = z.number().int().min(0).max(4);
const Id = z.string().min(1).max(100);

export const ListItemsQuerySchema = z.strictObject({
  kind: z.enum(ITEM_KINDS).optional(),
  provider: z.enum(PROVIDERS).optional(),
  topicId: Id.optional(),
  containerId: Id.optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  dueFrom: Iso.optional(),
  dueTo: Iso.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const CreateItemBody = z.strictObject({
  title: Title,
  note: Note.optional(),
  dueAt: Iso.nullable().optional(),
  /** The due date has no time of day (H5: a calendar copy is then an all-day event). */
  allDay: z.boolean().optional(),
  topicId: Id.nullable().optional(),
  containerId: Id.nullable().optional(),
  priority: Priority.nullable().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * A recurring to-do (plan Addendum A3): one `RRULE:` line, checked by RecurrenceRule. It is
   * created in the workspace's primary calendar only.
   */
  recurrence: z.array(z.string().max(500)).min(1).max(5).optional(),
});

export const UpdateItemBody = z
  .strictObject({
    title: Title.nullable().optional(),
    note: Note.nullable().optional(),
    dueAt: Iso.nullable().optional(),
    /** With dueAt (or an event's startAt and endAt): no time of day. */
    allDay: z.boolean().optional(),
    startAt: Iso.nullable().optional(),
    endAt: Iso.nullable().optional(),
    topicId: Id.nullable().optional(),
    containerId: Id.nullable().optional(),
    priority: Priority.nullable().optional(),
    status: z.enum(ITEM_STATUSES).nullable().optional(),
    /** A calendar event with other guests: whether Google tells them about the change. */
    notifyGuests: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one change is required');

/** key → a value of any attribute type, or null; the service checks each against its definition. */
export const AttrValues = z
  .record(
    AttributeKeySchema,
    z.union([
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.array(z.string().max(40)).max(30),
      z.null(),
    ]),
  )
  .refine((values) => Object.keys(values).length <= 20, 'at most 20 attributes at once');

export const UpdateOverlayBody = z
  .strictObject({
    pinned: z.boolean().nullable().optional(),
    note: Note.nullable().optional(),
    hidden: z.boolean().nullable().optional(),
    topicOverride: Id.nullable().optional(),
    calendarSync: z.boolean().nullable().optional(),
    /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (local); checked as a real date by PlannedAt. */
    plannedAt: z.string().max(16).nullable().optional(),
    /** Custom attribute values by key; null clears one (types/attributes.ts). */
    attrs: AttrValues.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one change is required');

export const CompleteItemBody = z.strictObject({ done: z.boolean() });

/** `GET …/facets?connectors=a,b,local`: a filter block's listening blocks' sources. */
export const FacetsQuery = z.strictObject({
  connectors: z
    .string()
    .max(4000)
    .regex(/^[A-Za-z0-9_:-]*(,[A-Za-z0-9_:-]+)*$/, 'connectors: comma-separated ids')
    .optional(),
});
