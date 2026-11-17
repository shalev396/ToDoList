/**
 * Importance per page (H4): a 0-100 score computed for every item, by one of four presets a page
 * chooses. The score is the computed field `importance`, usable in filters and sorts. The page
 * stores `{preset, params}` in its dashboard document; a page with none uses Weighted with the
 * defaults. The formulas are in builder/importance.ts.
 *
 * Pure zod, shared with the client (`@api-types/importance`).
 */
import { z } from 'zod';

export const IMPORTANCE_PRESETS = ['weighted', 'deadline', 'shortest', 'fair'] as const;
export type ImportancePreset = (typeof IMPORTANCE_PRESETS)[number];

/** The built-in weighted factors, in display order. */
export const WEIGHT_FACTORS = ['priority', 'dueSoon', 'importance', 'pinned'] as const;
export type WeightFactor = (typeof WEIGHT_FACTORS)[number];

export const DEFAULT_WEIGHTS: Readonly<Record<WeightFactor, number>> = {
  priority: 3,
  dueSoon: 4,
  importance: 3,
  pinned: 1,
};

export const MAX_WEIGHT = 10;
export const MAX_WEIGHTS = 30;

/** Due soon ramps from 0 (this many days before due) to 1 (at due). */
export const DUE_RAMP_DAYS = 14;
/** It stays 1 while overdue for this many days, then decays to DUE_OVERDUE_FLOOR. */
export const DUE_OVERDUE_GRACE_DAYS = 7;
export const DUE_OVERDUE_FLOOR = 0.5;
/** The decay from 1 to the floor takes this many further days. */
export const DUE_DECAY_DAYS = 7;

/** Size when an item has none (story points). */
export const UNKNOWN_SIZE = 3;
/** One estimated hour counts as 1 / HOURS_PER_POINT story points: hours / 4. */
export const HOURS_PER_POINT = 4;
/** Sizes below this count as it, so a size of 0 never divides by zero. */
export const MIN_SIZE = 0.25;

/** A weight key: a built-in factor, or `attr.<key>` for a number or rating attribute. */
export const WEIGHT_KEY_PATTERN =
  /^(priority|dueSoon|importance|pinned|attr\.[a-z][a-z0-9_]{0,31})$/;

export const WeightsSchema = z
  .record(
    z.string().regex(WEIGHT_KEY_PATTERN, 'a factor or attr.<key>'),
    z.number().min(0).max(MAX_WEIGHT),
  )
  .refine((weights) => Object.keys(weights).length <= MAX_WEIGHTS, 'too many weights');
export type Weights = z.infer<typeof WeightsSchema>;

const NO_PARAMS = z.strictObject({});

export const ImportanceConfigSchema = z.discriminatedUnion('preset', [
  z.strictObject({
    preset: z.literal('weighted'),
    params: z.strictObject({ weights: WeightsSchema.optional() }),
  }),
  z.strictObject({ preset: z.literal('deadline'), params: NO_PARAMS }),
  z.strictObject({ preset: z.literal('shortest'), params: NO_PARAMS }),
  z.strictObject({ preset: z.literal('fair'), params: NO_PARAMS }),
]);
export type ImportanceConfig = z.infer<typeof ImportanceConfigSchema>;

export const DEFAULT_IMPORTANCE: ImportanceConfig = { preset: 'weighted', params: {} };
