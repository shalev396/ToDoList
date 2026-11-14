/**
 * Custom attributes (H4): workspace-defined fields every item can carry, e.g. the built-in
 * Importance (1-5). Definitions live in the workspace settings; values live in the item overlay
 * (`overlay.attrs.<key>`), so they work for mirrored and local items alike and are never written
 * to a provider.
 *
 * Pure zod, shared with the client (`@api-types/attributes`).
 */
import { z } from 'zod';

export const ATTRIBUTE_TYPES = [
  'rating',
  'number',
  'select',
  'multiSelect',
  'text',
  'date',
  'checkbox',
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** A slug: starts with a letter; letters, digits and underscores; lower case. */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export const BUILTIN_IMPORTANCE_KEY = 'importance';
/** What an item without an Importance value counts as: the middle of 1-5. */
export const BUILTIN_IMPORTANCE_DEFAULT = 3;
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const MAX_ATTRIBUTE_OPTIONS = 30;
const MAX_TEXT = 500;
const DEFAULT_NUMBER_MIN = 0;
const DEFAULT_NUMBER_MAX = 100;

const NameSchema = z.string().trim().min(1).max(40);
const OptionsSchema = z.array(z.string().trim().min(1).max(40)).max(MAX_ATTRIBUTE_OPTIONS);

export const AttributeKeySchema = z
  .string()
  .regex(ATTRIBUTE_KEY_PATTERN, 'a lower-case slug: a letter, then letters, digits or _');

/** What a workspace stores for one attribute. */
export const AttributeDefSchema = z.strictObject({
  key: AttributeKeySchema,
  name: NameSchema,
  type: z.enum(ATTRIBUTE_TYPES),
  /** select and multiSelect: the allowed values. */
  options: OptionsSchema.optional(),
  /** number: the range the importance formula normalises against (default 0-100). */
  min: z.number().optional(),
  max: z.number().optional(),
  builtIn: z.boolean(),
});
export type AttributeDef = z.infer<typeof AttributeDefSchema>;

interface Shape {
  type: AttributeType;
  options?: string[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
}

function refineShape(def: Shape, ctx: z.RefinementCtx): void {
  const listed = def.type === 'select' || def.type === 'multiSelect';
  if (listed && (def.options === undefined || def.options.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'a select needs options' });
  }
  if (!listed && def.options !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'only a select has options' });
  }
  if (def.type !== 'number' && (def.min !== undefined || def.max !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['min'], message: 'only a number has a range' });
  }
  if (def.type === 'number') {
    // The effective range, defaults included: {min: 100} alone would be 100 to 100.
    const { min, max } = numberRange({ ...def, key: 'x', name: 'x', builtIn: false });
    if (max <= min) {
      ctx.addIssue({ code: 'custom', path: ['max'], message: 'max must be above min' });
    }
  }
}

/** `POST …/attributes`: a custom attribute (never built-in). */
export const NewAttributeSchema = z
  .strictObject({
    key: AttributeKeySchema,
    name: NameSchema,
    type: z.enum(ATTRIBUTE_TYPES),
    options: OptionsSchema.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine(refineShape);
export type NewAttribute = z.infer<typeof NewAttributeSchema>;

/** `PATCH …/attributes/:key`: rename, and edit options or range. The type never changes. */
export const AttributePatchSchema = z
  .strictObject({
    name: NameSchema.optional(),
    options: OptionsSchema.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'the patch changes nothing');
export type AttributePatch = z.infer<typeof AttributePatchSchema>;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar day (`YYYY-MM-DD`) of a date attribute value, or null when it is neither a day nor
 * an ISO date-time. The day is the one written, in the value's own offset.
 */
export function dayOf(value: string): string | null {
  const day = DAY_PATTERN.test(value)
    ? value
    : z.iso.datetime({ offset: true }).safeParse(value).success
      ? value.slice(0, 10)
      : null;
  if (day === null) return null;
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

/**
 * A date attribute is a day, stored at noon UTC (`YYYY-MM-DDT12:00:00Z`): inside that day in every
 * zone, so `on`, `inLast` and `inNext` (whole local days) never miss it at an edge.
 */
export function noonOf(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** The built-in Importance: every workspace has it; it can be renamed, never deleted. */
export const BUILTIN_IMPORTANCE: AttributeDef = {
  key: BUILTIN_IMPORTANCE_KEY,
  name: 'Importance',
  type: 'rating',
  builtIn: true,
};

/** The range a number attribute is normalised against. */
export function numberRange(def: AttributeDef): { min: number; max: number } {
  return { min: def.min ?? DEFAULT_NUMBER_MIN, max: def.max ?? DEFAULT_NUMBER_MAX };
}

function isRating(value: unknown): boolean {
  return (
    Number.isInteger(value) && (value as number) >= RATING_MIN && (value as number) <= RATING_MAX
  );
}

/**
 * A reason a value does not fit the definition, or null when it does. `null` always fits (it
 * clears the value). Dates are ISO date-times.
 */
export function attributeValueError(def: AttributeDef, value: unknown): string | null {
  if (value === null) return null;
  const options = def.options ?? [];
  switch (def.type) {
    case 'rating':
      return isRating(value)
        ? null
        : `${def.key} is a rating from ${String(RATING_MIN)} to ${String(RATING_MAX)}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${def.key} is a number`;
    case 'text':
      return typeof value === 'string' && value.length <= MAX_TEXT
        ? null
        : `${def.key} is text of at most ${String(MAX_TEXT)} characters`;
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${def.key} is true or false`;
    case 'date':
      return typeof value === 'string' && dayOf(value) !== null
        ? null
        : `${def.key} is a date (YYYY-MM-DD or an ISO date-time)`;
    case 'select':
      return typeof value === 'string' && options.includes(value)
        ? null
        : `${def.key} is one of its options`;
    case 'multiSelect':
      return Array.isArray(value) &&
        value.length <= MAX_ATTRIBUTE_OPTIONS &&
        value.every((entry) => typeof entry === 'string' && options.includes(entry))
        ? null
        : `${def.key} is a list of its options`;
  }
}
