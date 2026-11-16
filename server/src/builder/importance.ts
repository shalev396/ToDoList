/**
 * Importance scoring (H4): the computed field `importance`, an integer 0-100 per item.
 *
 * Each page picks a preset (types/importance.ts). This module has two halves that must agree:
 * - the Mongo half (`importanceFields`) builds the `$addFields` expression the compiler puts before
 *   the query's `$match`. It is generated here from the stored config and the workspace's
 *   attribute definitions; no user input ever becomes an operator, a key or a path (weight keys
 *   are matched against the definitions, never used as paths);
 * - the reference half (`scoreItem`) is plain TypeScript, used by tests and as the spec.
 *
 * Presets, exactly:
 *
 * WEIGHTED  score = round(100 * sum(w_i * f_i) / sum(w_i)), each factor f_i in 0..1.
 *   priority   = priority / 4 (priority is 0-4; none = 0)
 *   dueSoon    = none: 0. d = days until due. d >= 14: 0. 0 <= d < 14: 1 - d/14.
 *                overdue by o days: o <= 7: 1; 7 < o < 14: 1 - 0.5 * (o - 7) / 7; o >= 14: 0.5
 *   importance = (Importance attribute - 1) / 4; unset = 3, so 0.5
 *   pinned     = 1 when pinned, else 0
 *   attr.<key> = a rating: (v - 1) / 4; a number: clamp((v - min) / (max - min)); unset = 0
 *   Default weights: priority 3, dueSoon 4, importance 3, pinned 1, custom attributes 0.
 *   All weights 0: the score is 0.
 *
 * DEADLINE (earliest deadline first)
 *   no due date: 0. Overdue by o days: 90 + 10 * min(o, 30) / 30 (the longer overdue, the higher).
 *   Due in d days: 89 / (1 + d / 7) (due now is 89, in a week 44.5, in 2 months about 9).
 *
 * SHORTEST (shortest job first)
 *   score = round(100 * 3 / (size + 3)); size in story points; smaller is higher.
 *
 * FAIR (highest response ratio next, the OS scheduler that never starves a job)
 *   ratio = (waiting + size) / size, waiting in days since startAt (else createdAt), never
 *   negative. The ratio is mapped onto 0-100 with a saturating curve:
 *   score = round(100 * (1 - 1 / ratio)) = round(100 * waiting / (waiting + size)).
 *   A task that just arrived scores 0 and every day of waiting raises it, the faster the smaller it
 *   is (so small tasks win early); it reaches 50 when it has waited as many days as it has points
 *   and approaches 100 without end, so a big task that keeps waiting always overtakes new work.
 *
 * SIZE (shortest, fair): in story points, the first of the Size attribute (`attr.size`, a number),
 *   `props.jira.storyPoints`, `props.linear.estimate`, `props.storyPoints`, an estimate in hours
 *   (`props.estimateHours`) counted as hours / 4, a ClickUp `props.clickup.timeEstimateMs` the same
 *   way; unknown = 3. Never below 0.25.
 */
import {
  BUILTIN_IMPORTANCE_DEFAULT,
  BUILTIN_IMPORTANCE_KEY,
  numberRange,
  type AttributeDef,
} from '../types/attributes.js';
import {
  DEFAULT_IMPORTANCE,
  DEFAULT_WEIGHTS,
  DUE_DECAY_DAYS,
  DUE_OVERDUE_FLOOR,
  DUE_OVERDUE_GRACE_DAYS,
  DUE_RAMP_DAYS,
  HOURS_PER_POINT,
  MIN_SIZE,
  UNKNOWN_SIZE,
  WEIGHT_FACTORS,
  type ImportanceConfig,
} from '../types/importance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const EDF_OVERDUE_BASE = 90;
const EDF_OVERDUE_SPAN = 10;
const EDF_OVERDUE_DAYS = 30;
const EDF_FUTURE_MAX = 89;
const EDF_FUTURE_HALF_LIFE_DAYS = 7;
const SJF_REFERENCE = 3;

type Expr = Record<string, unknown> | string | number | boolean | Date | null;

// ─── Weights ────────────────────────────────────────────────────────────────

/** One factor with its weight: a built-in, or a rating or number attribute. */
interface Term {
  factor: string;
  weight: number;
  attribute?: AttributeDef;
}

/**
 * The weighted terms of a config: the built-in factors (default weights unless set), then each
 * `attr.<key>` weight that names a number or rating attribute of the workspace. Weights naming
 * anything else are returned in `skipped`, never compiled.
 */
export function weightedTerms(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
): { terms: Term[]; skipped: string[] } {
  const weights = config.preset === 'weighted' ? (config.params.weights ?? {}) : {};
  const terms: Term[] = WEIGHT_FACTORS.map((factor) => ({
    factor,
    weight: weights[factor] ?? DEFAULT_WEIGHTS[factor],
  }));
  const skipped: string[] = [];
  for (const [name, weight] of Object.entries(weights)) {
    if (!name.startsWith('attr.')) continue;
    const key = name.slice('attr.'.length);
    const attribute = attributes.find((def) => def.key === key);
    if (attribute === undefined || (attribute.type !== 'rating' && attribute.type !== 'number')) {
      skipped.push(name);
    } else if (weight > 0) {
      terms.push({ factor: name, weight, attribute });
    }
  }
  return { terms: terms.filter((term) => term.weight > 0), skipped };
}

// ─── Reference scoring (plain TypeScript) ───────────────────────────────────

/** What the reference scorer reads of an item. */
export interface ScoredItem {
  priority: number | null;
  dueAt: Date | null;
  startAt: Date | null;
  createdAt: Date;
  pinned: boolean;
  attrs: Record<string, unknown>;
  props: Record<string, unknown>;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function at(source: Record<string, unknown>, ...path: string[]): unknown {
  let node: unknown = source;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** The due-soon factor, 0..1. */
export function dueSoon(dueAt: Date | null, now: Date): number {
  if (dueAt === null) return 0;
  const days = (dueAt.getTime() - now.getTime()) / DAY_MS;
  if (days >= DUE_RAMP_DAYS) return 0;
  if (days >= 0) return 1 - days / DUE_RAMP_DAYS;
  const overdue = -days;
  if (overdue <= DUE_OVERDUE_GRACE_DAYS) return 1;
  const decayed = (overdue - DUE_OVERDUE_GRACE_DAYS) / DUE_DECAY_DAYS;
  return Math.max(DUE_OVERDUE_FLOOR, 1 - (1 - DUE_OVERDUE_FLOOR) * decayed);
}

/** The item's size in story points (see the header). */
export function sizeOf(item: Pick<ScoredItem, 'attrs' | 'props'>): number {
  const hours = (path: string[], perHour: number): number | null => {
    const value = num(at(item.props, ...path));
    return value === null ? null : value / perHour / HOURS_PER_POINT;
  };
  const size =
    num(item.attrs['size']) ??
    num(at(item.props, 'jira', 'storyPoints')) ??
    num(at(item.props, 'linear', 'estimate')) ??
    num(at(item.props, 'storyPoints')) ??
    hours(['estimateHours'], 1) ??
    hours(['clickup', 'timeEstimateMs'], HOUR_MS) ??
    UNKNOWN_SIZE;
  return Math.max(MIN_SIZE, size);
}

function attributeFactor(def: AttributeDef, value: unknown): number {
  const v = num(value);
  if (def.type === 'rating') {
    const rating = v ?? (def.key === BUILTIN_IMPORTANCE_KEY ? BUILTIN_IMPORTANCE_DEFAULT : null);
    return rating === null ? 0 : clamp01((rating - 1) / 4);
  }
  if (v === null) return 0;
  const { min, max } = numberRange(def);
  // A range of zero or less (stored before it was refused) scores 0 instead of dividing by it.
  return max <= min ? 0 : clamp01((v - min) / (max - min));
}

/** The 0-100 integer importance of one item (the spec the Mongo expression follows). */
export function scoreItem(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
  item: ScoredItem,
  now: Date,
): number {
  switch (config.preset) {
    case 'weighted': {
      const { terms } = weightedTerms(config, attributes);
      const total = terms.reduce((sum, term) => sum + term.weight, 0);
      if (total === 0) return 0;
      const builtIn = attributes.find((def) => def.key === BUILTIN_IMPORTANCE_KEY);
      const factor = (term: Term): number => {
        switch (term.factor) {
          case 'priority':
            return clamp01((item.priority ?? 0) / 4);
          case 'dueSoon':
            return dueSoon(item.dueAt, now);
          case 'importance':
            return builtIn === undefined
              ? 0
              : attributeFactor(builtIn, item.attrs[BUILTIN_IMPORTANCE_KEY]);
          case 'pinned':
            return item.pinned ? 1 : 0;
          default:
            return term.attribute === undefined
              ? 0
              : attributeFactor(term.attribute, item.attrs[term.attribute.key]);
        }
      };
      const sum = terms.reduce((acc, term) => acc + term.weight * factor(term), 0);
      return Math.round((100 * sum) / total);
    }
    case 'deadline': {
      if (item.dueAt === null) return 0;
      const days = (item.dueAt.getTime() - now.getTime()) / DAY_MS;
      if (days < 0) {
        return Math.round(
          EDF_OVERDUE_BASE +
            (EDF_OVERDUE_SPAN * Math.min(-days, EDF_OVERDUE_DAYS)) / EDF_OVERDUE_DAYS,
        );
      }
      return Math.round(EDF_FUTURE_MAX / (1 + days / EDF_FUTURE_HALF_LIFE_DAYS));
    }
    case 'shortest':
      return Math.round((100 * SJF_REFERENCE) / (sizeOf(item) + SJF_REFERENCE));
    case 'fair':
      return Math.round(100 * (1 - 1 / responseRatio(item, now)));
  }
}

/** HRRN: (waiting + size) / size, waiting in days since startAt, else createdAt, never negative. */
export function responseRatio(
  item: Pick<ScoredItem, 'startAt' | 'createdAt' | 'attrs' | 'props'>,
  now: Date,
): number {
  const since = item.startAt ?? item.createdAt;
  const waiting = Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
  const size = sizeOf(item);
  return (waiting + size) / size;
}

// ─── The Mongo half ─────────────────────────────────────────────────────────

const isNull = (path: string): Expr => ({ $eq: [{ $ifNull: [path, null] }, null] });
const clamp = (expr: Expr): Expr => ({ $min: [1, { $max: [0, expr] }] });

/** `path` when it holds a number, else null (props are free-form: never divide a string). */
const numberAt = (path: string): Expr => ({ $cond: [{ $isNumber: path }, path, null] });

/** Days from `now` to a date field; negative when it is past. */
const daysUntil = (path: string, now: Date): Expr => ({
  $divide: [{ $subtract: [path, now] }, DAY_MS],
});

function dueSoonExpr(now: Date): Expr {
  return {
    $cond: [
      isNull('$dueAt'),
      0,
      {
        $let: {
          vars: { d: daysUntil('$dueAt', now) },
          in: {
            $switch: {
              branches: [
                { case: { $gte: ['$$d', DUE_RAMP_DAYS] }, then: 0 },
                {
                  case: { $gte: ['$$d', 0] },
                  then: { $subtract: [1, { $divide: ['$$d', DUE_RAMP_DAYS] }] },
                },
                { case: { $gte: ['$$d', -DUE_OVERDUE_GRACE_DAYS] }, then: 1 },
              ],
              default: {
                $max: [
                  DUE_OVERDUE_FLOOR,
                  {
                    $subtract: [
                      1,
                      {
                        $multiply: [
                          1 - DUE_OVERDUE_FLOOR,
                          {
                            $divide: [
                              { $subtract: [-DUE_OVERDUE_GRACE_DAYS, '$$d'] },
                              DUE_DECAY_DAYS,
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ],
  };
}

/** The attribute's stored value, by its (slug-checked) key. */
const attrPath = (def: AttributeDef): string => `$overlay.attrs.${def.key}`;

function attributeExpr(def: AttributeDef): Expr {
  const value = numberAt(attrPath(def));
  if (def.type === 'rating') {
    const fallback = def.key === BUILTIN_IMPORTANCE_KEY ? BUILTIN_IMPORTANCE_DEFAULT : null;
    return fallback === null
      ? {
          $cond: [
            { $isNumber: attrPath(def) },
            clamp({ $divide: [{ $subtract: [attrPath(def), 1] }, 4] }),
            0,
          ],
        }
      : clamp({ $divide: [{ $subtract: [{ $ifNull: [value, fallback] }, 1] }, 4] });
  }
  const { min, max } = numberRange(def);
  if (max <= min) return 0;
  return {
    $cond: [
      { $isNumber: attrPath(def) },
      clamp({ $divide: [{ $subtract: [attrPath(def), min] }, max - min] }),
      0,
    ],
  };
}

function sizeExpr(): Expr {
  const hoursAt = (path: string, perHour: number): Expr => ({
    $cond: [{ $isNumber: path }, { $divide: [path, perHour * HOURS_PER_POINT] }, null],
  });
  const chain: Expr[] = [
    numberAt('$overlay.attrs.size'),
    numberAt('$props.jira.storyPoints'),
    numberAt('$props.linear.estimate'),
    numberAt('$props.storyPoints'),
    hoursAt('$props.estimateHours', 1),
    hoursAt('$props.clickup.timeEstimateMs', HOUR_MS),
  ];
  const first = chain.reduceRight<Expr>((rest, expr) => ({ $ifNull: [expr, rest] }), UNKNOWN_SIZE);
  return { $max: [MIN_SIZE, first] };
}

function weightedExpr(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
  now: Date,
): Expr {
  const { terms } = weightedTerms(config, attributes);
  const total = terms.reduce((sum, term) => sum + term.weight, 0);
  if (total === 0) return 0;
  const builtIn = attributes.find((def) => def.key === BUILTIN_IMPORTANCE_KEY);
  const factor = (term: Term): Expr => {
    switch (term.factor) {
      case 'priority':
        return clamp({ $divide: [{ $ifNull: ['$priority', 0] }, 4] });
      case 'dueSoon':
        return dueSoonExpr(now);
      case 'importance':
        return builtIn === undefined ? 0 : attributeExpr(builtIn);
      case 'pinned':
        return { $cond: [{ $eq: ['$overlay.pinned', true] }, 1, 0] };
      default:
        return term.attribute === undefined ? 0 : attributeExpr(term.attribute);
    }
  };
  return {
    $round: [
      {
        $multiply: [
          100,
          {
            $divide: [
              { $add: terms.map((term) => ({ $multiply: [term.weight, factor(term)] })) },
              total,
            ],
          },
        ],
      },
      0,
    ],
  };
}

function deadlineExpr(now: Date): Expr {
  return {
    $cond: [
      isNull('$dueAt'),
      0,
      {
        $let: {
          vars: { d: daysUntil('$dueAt', now) },
          in: {
            $round: [
              {
                $cond: [
                  { $lt: ['$$d', 0] },
                  {
                    $add: [
                      EDF_OVERDUE_BASE,
                      {
                        $multiply: [
                          EDF_OVERDUE_SPAN / EDF_OVERDUE_DAYS,
                          { $min: [{ $subtract: [0, '$$d'] }, EDF_OVERDUE_DAYS] },
                        ],
                      },
                    ],
                  },
                  {
                    $divide: [
                      EDF_FUTURE_MAX,
                      { $add: [1, { $divide: ['$$d', EDF_FUTURE_HALF_LIFE_DAYS] }] },
                    ],
                  },
                ],
              },
              0,
            ],
          },
        },
      },
    ],
  };
}

function fairExpr(now: Date): Expr {
  return {
    $let: {
      vars: {
        size: sizeExpr(),
        waiting: {
          $max: [
            0,
            { $divide: [{ $subtract: [now, { $ifNull: ['$startAt', '$createdAt'] }] }, DAY_MS] },
          ],
        },
      },
      in: {
        $round: [
          { $multiply: [100, { $divide: ['$$waiting', { $add: ['$$waiting', '$$size'] }] }] },
          0,
        ],
      },
    },
  };
}

/**
 * The `$addFields` document that computes `importance` for a page's config. `now` is a literal
 * date, so one run scores every item at the same instant.
 */
export function importanceFields(
  config: ImportanceConfig | undefined,
  attributes: readonly AttributeDef[],
  now: Date,
): Record<string, Expr> {
  const chosen = config ?? DEFAULT_IMPORTANCE;
  switch (chosen.preset) {
    case 'weighted':
      return { importance: weightedExpr(chosen, attributes, now) };
    case 'deadline':
      return { importance: deadlineExpr(now) };
    case 'shortest':
      return {
        importance: {
          $round: [
            {
              $multiply: [100, { $divide: [SJF_REFERENCE, { $add: [sizeExpr(), SJF_REFERENCE] }] }],
            },
            0,
          ],
        },
      };
    case 'fair':
      return { importance: fairExpr(now) };
  }
}
