/**
 * Request shapes of the travel routes (zod 4; types/travel.ts holds the request and response
 * types). Strict: an unknown key is a 400. These check the shape only; what a value means (a name
 * of 1–80 characters, an address of at most 300, a where-group the dashboards' compiler takes, a
 * place of the caller's, a span of more than 0 and at most a day) is the travel classes' to check,
 * so REST and MCP refuse the same things.
 */
import { z } from 'zod';

import { RuleGroupSchema } from '../types/builder.js';
import {
  LEG_MODE_SCOPES,
  RULE_DIRECTIONS,
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
} from '../types/travel.js';

const Iso = z.iso.datetime({ offset: true });
const Id = z.string().min(1).max(200);
const Mode = z.enum(TRAVEL_MODES);
const Direction = z.enum(RULE_DIRECTIONS);
/** A trip's length in minutes: more than none, at most a day. */
const Minutes = z.number().positive().max(TRIP_MINUTES_MAX);
/** `YYYY-MM-DD` (a real date: the class checks). */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');

const atLeastOne = (body: object): boolean => Object.keys(body).length > 0;
const AT_LEAST_ONE = 'At least one change is required';

// ─── Places ─────────────────────────────────────────────────────────────────

const PlaceFields = z.strictObject({
  name: z.string().max(200),
  /** Free text for map links, never looked up. */
  address: z.string().max(1000).optional(),
  aliases: z.array(z.string().max(200)).max(20).optional(),
  home: z.boolean().optional(),
});

export const CreatePlaceBody = PlaceFields;

export const UpdatePlaceBody = PlaceFields.partial().refine(atLeastOne, AT_LEAST_ONE);

// ─── Rules ──────────────────────────────────────────────────────────────────

const Scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('where'), where: RuleGroupSchema }),
  z.strictObject({ kind: z.literal('series'), itemId: Id }),
  /** `occurrence`: the occurrence's original start (ISO), or `single`. */
  z.strictObject({
    kind: z.literal('item'),
    itemId: Id,
    occurrence: z.union([z.literal('single'), Iso]),
  }),
  /** The repeats of an event that doesn't repeat (TravelRule checks it whole). */
  z.strictObject({
    kind: z.literal('repeats'),
    containerId: Id,
    title: z.string().min(1).max(500),
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    from: Iso,
  }),
]);

const RuleFields = z.strictObject({
  scope: Scope,
  mode: Mode,
  direction: Direction,
  placeId: Id.nullable().optional(),
});

export const CreateRuleBody = RuleFields;

export const UpdateRuleBody = RuleFields.partial().refine(atLeastOne, AT_LEAST_ONE);

// ─── Settings, default places and pins ──────────────────────────────────────

export const UpdateSettingsBody = z
  .strictObject({
    goHome: z
      .strictObject({
        enabled: z.boolean(),
        minWindowMinutes: z.number(),
        minAtHomeMinutes: z.number(),
      })
      .partial()
      .optional(),
    defaultMode: Mode.optional(),
  })
  .refine(atLeastOne, AT_LEAST_ONE);

/** A container's default place, or an item's: one of the caller's places; null removes it. */
export const PlacePinBody = z.strictObject({ placeId: Id.nullable() });

// ─── Marking an item ────────────────────────────────────────────────────────

/**
 * A leg as typed: its trip's length (`minutes`, every time), times that move this leg, and where he
 * starts from.
 */
const Span = z.strictObject({
  startAt: Iso.optional(),
  endAt: Iso.optional(),
  minutes: Minutes.optional(),
  fromPlaceId: Id.nullable().optional(),
});

export const MarkItemBody = z.strictObject({
  /** One occurrence of a repeating item: its original start. */
  occurrence: Iso.optional(),
  /** Every occurrence of a repeating item. */
  every: z.boolean().optional(),
  mode: Mode,
  direction: Direction,
  placeId: Id.nullable().optional(),
  there: Span.optional(),
  back: Span.optional(),
});

/** `DELETE …/travel/items/:itemId?occurrence=&every=`. */
export const UnmarkItemQuery = z.strictObject({
  occurrence: Iso.optional(),
  every: z.enum(['true', 'false']).optional(),
});

// ─── The preview, legs and days ─────────────────────────────────────────────

export const PreviewBody = z
  .strictObject({
    mode: Mode,
    fromPlaceId: Id.optional(),
    toPlaceId: Id.optional(),
    arriveBy: Iso.optional(),
    departAt: Iso.optional(),
  })
  .refine((body) => body.arriveBy === undefined || body.departAt === undefined, {
    path: ['departAt'],
    message: 'give arriveBy or departAt, not both',
  });

/** The trip's length (`minutes`, every time), this leg's times, or both (TravelLeg checks). */
export const LegEditBody = z.strictObject({
  startAt: Iso.optional(),
  endAt: Iso.optional(),
  minutes: Minutes.optional(),
});

/** How he goes on a leg's event, for this day or every repeat (LegModeRequest). */
export const LegModeBody = z.strictObject({
  mode: Mode,
  scope: z.enum(LEG_MODE_SCOPES),
});

/** Skip and reset take no body. */
export const EmptyBody = z.strictObject({});

export const DaysQuery = z.strictObject({ from: Day, to: Day });
