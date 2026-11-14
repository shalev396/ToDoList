/**
 * Display rules (BUILDER.md §3 "If/then"): `if <condition> then <tone | badge | hide>`, evaluated
 * per row on the client. They only format rows; nothing is executed.
 *
 * Every operator the server allows on row fields is evaluated here with the server's meaning
 * (server/src/builder/compile.ts): `OPERATOR_EVALUATORS` is keyed by the server's `Operator`
 * type, so a new server operator fails the client build until it is handled here.
 * - `@now` is the instant, `@today` local midnight in the workspace's time zone, `@me` the
 *   signed-in user; `$page.<name>` reads a page variable, and a rule on an unset one does nothing.
 * - A missing boolean reads as false; a missing value is never `<` or `>` anything; a list field
 *   matches `=`, `in` and `contains` by any of its items; text matches ignore case.
 * - Effects: the first matching tone wins, badges collect in rule order (each once), and any
 *   matching `hide` hides the row.
 *
 * The row is returned as it is, beside its effects: container rows have a `hidden` field of
 * their own that a merged result would overwrite.
 */
import type {
  DatePreset,
  DisplayRule,
  RelativeUnit,
  Operator,
  Rule,
  RuleValue,
  VarValue,
} from '@api-types/builder.ts';
import { varNameOf } from '../variables/names.ts';
import type { PageVars } from '../variables/urlVars.ts';
import { isDateRange } from '../variables/urlVars.ts';
import {
  localDayBounds,
  resolveDatePreset,
  resolveRelative,
  startOfToday,
  type DateBounds,
  type WeekStart,
} from './datePresets.ts';

export type Tone = Extract<DisplayRule['then'], { tone: unknown }>['tone'];

export interface DisplayContext {
  now: Date;
  /** The workspace's IANA time zone (settings.timezone). */
  timeZone: string;
  /** The signed-in user's id, for `@me`. */
  userId: string;
  /** The workspace's week start, for `within this_week`. Default: Sunday. */
  weekStart?: WeekStart | undefined;
  /** The page's variables, for `$page.<name>` values. */
  vars?: PageVars | undefined;
}

export interface RowDisplay {
  tone?: Tone;
  badges: string[];
  hidden: boolean;
}

export type DisplayedRow<R> = RowDisplay & { row: R };

type Evaluator = (value: unknown, operand: unknown, ctx: DisplayContext) => boolean;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Keyed by the server's `DatePreset`, so the build fails when a preset is added there. */
const DATE_PRESETS: Readonly<Record<DatePreset, true>> = {
  today: true,
  tomorrow: true,
  this_week: true,
  next_7d: true,
  next_14d: true,
  overdue: true,
  this_month: true,
  this_semester: true,
  upcoming_7d: true,
  upcoming_14d: true,
};
/** Field path segments that are never data. */
const RESTRICTED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const UNSET = Symbol('unset');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * `source.provider`, `props.points`: own fields only, never through a prototype. `attr.<key>` is
 * the item's attribute value (the built-in Importance reads 3 when unset, as the server does).
 */
function fieldValue(row: unknown, path: string): unknown {
  if (/^attr\.[a-z][a-z0-9_]{0,31}$/.test(path)) {
    const key = path.slice('attr.'.length);
    const value = fieldValue(row, `overlay.attrs.${key}`);
    return isNullish(value) && key === 'importance' ? 3 : value;
  }
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (
      RESTRICTED_SEGMENTS.has(segment) ||
      !isRecord(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isDateLike(value: unknown): boolean {
  return (
    value === '@now' ||
    value === '@today' ||
    value instanceof Date ||
    (typeof value === 'string' && ISO_DATE_TIME.test(value))
  );
}

/** Milliseconds of a date value (a Date, an ISO string as rows carry them, `@now`, `@today`). */
function timeOf(value: unknown, ctx: DisplayContext): number | null {
  if (value === '@now') {
    return ctx.now.getTime();
  }
  if (value === '@today') {
    return startOfToday(ctx.now, ctx.timeZone).getTime();
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === 'string' && ISO_DATE_TIME.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function scalarEquals(value: unknown, operand: unknown, ctx: DisplayContext): boolean {
  if (typeof operand === 'boolean') {
    // As the server compiles it: a missing boolean reads as false.
    return operand ? value === true : value !== true;
  }
  if (operand === null) {
    return isNullish(value);
  }
  if (isDateLike(operand) && (isDateLike(value) || value instanceof Date)) {
    const left = timeOf(value, ctx);
    return left !== null && left === timeOf(operand, ctx);
  }
  return value === operand;
}

/** `=` on a list field matches by any item (MongoDB's equality on arrays). */
function equals(value: unknown, operand: unknown, ctx: DisplayContext): boolean {
  if (Array.isArray(value) && typeof operand !== 'boolean' && operand !== null) {
    return value.some((item) => scalarEquals(item, operand, ctx));
  }
  return scalarEquals(value, operand, ctx);
}

/** Sign of value − operand, or null when they don't compare (missing, mixed types). */
function compare(value: unknown, operand: unknown, ctx: DisplayContext): number | null {
  if (isNullish(value)) {
    return null;
  }
  if (isDateLike(operand)) {
    const left = timeOf(value, ctx);
    const right = timeOf(operand, ctx);
    return left === null || right === null ? null : Math.sign(left - right);
  }
  if (typeof value === 'number' && typeof operand === 'number') {
    return Math.sign(value - operand);
  }
  if (typeof value === 'string' && typeof operand === 'string') {
    return value < operand ? -1 : value > operand ? 1 : 0;
  }
  return null;
}

function comparison(test: (sign: number) => boolean): Evaluator {
  return (value, operand, ctx) => {
    const sign = compare(value, operand, ctx);
    return sign !== null && test(sign);
  };
}

function isIn(value: unknown, operand: unknown, ctx: DisplayContext): boolean {
  const list = Array.isArray(operand) ? (operand as unknown[]) : [operand];
  const candidates = Array.isArray(value) ? (value as unknown[]) : [value];
  return candidates.some((item) => list.some((entry) => scalarEquals(item, entry, ctx)));
}

function isEmpty(value: unknown): boolean {
  return isNullish(value) || (Array.isArray(value) && value.length === 0);
}

function lowerText(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function isDatePreset(value: unknown): value is DatePreset {
  return typeof value === 'string' && Object.hasOwn(DATE_PRESETS, value);
}

function boundsOf(operand: unknown, ctx: DisplayContext): DateBounds | null {
  if (isDatePreset(operand)) {
    return resolveDatePreset(operand, ctx.now, ctx.timeZone, ctx.weekStart ?? 'sun');
  }
  if (isDateRange(operand)) {
    const from = timeOf(operand.from, ctx);
    const to = timeOf(operand.to, ctx);
    return from === null || to === null ? null : { from: new Date(from), to: new Date(to) };
  }
  return null;
}

function between(value: unknown, operand: unknown, ctx: DisplayContext): boolean {
  if (!Array.isArray(operand) || operand.length !== 2) {
    return false;
  }
  const from = timeOf(operand[0], ctx);
  const to = timeOf(operand[1], ctx);
  if (from !== null && to !== null) {
    const time = timeOf(value, ctx);
    return time !== null && time >= from && time <= to;
  }
  // Two numbers (a number field).
  const [low, high] = operand as unknown[];
  return typeof value === 'number' && typeof low === 'number' && typeof high === 'number'
    ? value >= low && value <= high
    : false;
}

/** The whole local day (workspace zone) of the operand date contains the value. */
function onDay(value: unknown, operand: unknown, ctx: DisplayContext): boolean {
  const day = timeOf(operand, ctx);
  const time = timeOf(value, ctx);
  if (day === null || time === null) {
    return false;
  }
  const bounds = localDayBounds(new Date(day), ctx.timeZone);
  return time >= bounds.from.getTime() && time < bounds.to.getTime();
}

const RELATIVE_UNIT_NAMES: readonly string[] = ['days', 'weeks', 'months'];

function relative(operator: 'inLast' | 'inNext' | 'moreThanAgo'): Evaluator {
  return (value, operand, ctx) => {
    const [n, unit] = Array.isArray(operand) ? (operand as unknown[]) : [];
    const time = timeOf(value, ctx);
    if (time === null || typeof n !== 'number' || typeof unit !== 'string') {
      return false;
    }
    if (!RELATIVE_UNIT_NAMES.includes(unit)) {
      return false;
    }
    const bounds = resolveRelative(operator, n, unit as RelativeUnit, ctx.now, ctx.timeZone);
    return operator === 'moreThanAgo'
      ? time < bounds.to.getTime()
      : time >= bounds.from.getTime() && time < bounds.to.getTime();
  };
}

export const OPERATOR_EVALUATORS: Readonly<Record<Operator, Evaluator>> = {
  '=': equals,
  '!=': (value, operand, ctx) => !equals(value, operand, ctx),
  '<': comparison((sign) => sign < 0),
  '<=': comparison((sign) => sign <= 0),
  '>': comparison((sign) => sign > 0),
  '>=': comparison((sign) => sign >= 0),
  in: (value, operand, ctx) =>
    !(Array.isArray(operand) && operand.length === 0) && isIn(value, operand, ctx),
  notIn: (value, operand, ctx) => !isIn(value, operand, ctx),
  contains: (value, operand, ctx) => {
    if (Array.isArray(value)) {
      return value.some((item) => scalarEquals(item, operand, ctx));
    }
    const text = lowerText(value);
    const part = lowerText(operand);
    return text !== null && part !== null && text.includes(part);
  },
  notContains: (value, operand, ctx) => {
    if (Array.isArray(value)) {
      return !value.some((item) => scalarEquals(item, operand, ctx));
    }
    const text = lowerText(value);
    const part = lowerText(operand);
    return !(text !== null && part !== null && text.includes(part));
  },
  endsWith: (value, operand) => {
    const text = lowerText(value);
    const end = lowerText(operand);
    return text !== null && end !== null && text.endsWith(end);
  },
  allOf: (value, operand, ctx) => {
    const list = Array.isArray(operand) ? (operand as unknown[]) : [operand];
    const have = Array.isArray(value) ? (value as unknown[]) : [];
    return (
      list.length > 0 && list.every((entry) => have.some((item) => scalarEquals(item, entry, ctx)))
    );
  },
  noneOf: (value, operand, ctx) => {
    const list = Array.isArray(operand) ? (operand as unknown[]) : [operand];
    const have = Array.isArray(value) ? (value as unknown[]) : [];
    return (
      list.length > 0 && !have.some((item) => list.some((entry) => scalarEquals(item, entry, ctx)))
    );
  },
  beginsWith: (value, operand) => {
    const text = lowerText(value);
    const start = lowerText(operand);
    return text !== null && start !== null && text.startsWith(start);
  },
  null: (value) => isEmpty(value),
  notNull: (value) => !isEmpty(value),
  within: (value, operand, ctx) => {
    const bounds = boundsOf(operand, ctx);
    const time = timeOf(value, ctx);
    return (
      bounds !== null &&
      time !== null &&
      time >= bounds.from.getTime() &&
      time < bounds.to.getTime()
    );
  },
  notBetween: (value, operand, ctx) => !between(value, operand, ctx),
  between,
  on: (value, operand, ctx) => onDay(value, operand, ctx),
  notOn: (value, operand, ctx) => !onDay(value, operand, ctx),
  inLast: relative('inLast'),
  notInLast: (value, operand, ctx) => !relative('inLast')(value, operand, ctx),
  inNext: relative('inNext'),
  notInNext: (value, operand, ctx) => !relative('inNext')(value, operand, ctx),
  moreThanAgo: relative('moreThanAgo'),
};

/** `@me` becomes the user; a `$page` reference becomes its value (UNSET when it has none). */
function resolveOperand(value: RuleValue | undefined, ctx: DisplayContext): unknown {
  if (typeof value === 'string') {
    const name = varNameOf(value);
    if (name !== null) {
      const vars = ctx.vars;
      const bound: VarValue | undefined =
        vars !== undefined && Object.hasOwn(vars, name) ? vars[name] : undefined;
      return bound === undefined || isEmpty(bound) ? UNSET : bound;
    }
    return value === '@me' ? ctx.userId : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === '@me' ? ctx.userId : item));
  }
  return value;
}

/** Whether one rule's condition holds for a row. */
export function ruleMatches(row: unknown, rule: Rule, ctx: DisplayContext): boolean {
  const operand = resolveOperand(rule.value, ctx);
  if (operand === UNSET) {
    return false;
  }
  return OPERATOR_EVALUATORS[rule.operator](fieldValue(row, rule.field), operand, ctx);
}

/** One row's tone, badges and visibility. */
export function displayRow(
  row: unknown,
  rules: readonly DisplayRule[] | undefined,
  ctx: DisplayContext,
): RowDisplay {
  let tone: Tone | undefined;
  const badges: string[] = [];
  let hidden = false;
  for (const rule of rules ?? []) {
    if (!ruleMatches(row, rule.if, ctx)) {
      continue;
    }
    const effect = rule.then;
    if ('tone' in effect) {
      tone ??= effect.tone;
    } else if ('hide' in effect) {
      hidden = true;
    } else if (!badges.includes(effect.badge)) {
      badges.push(effect.badge);
    }
  }
  return tone === undefined ? { badges, hidden } : { tone, badges, hidden };
}

/** Every row with its tone, badges and visibility (the rows themselves are not copied). */
export function applyDisplayRules<R>(
  rows: readonly R[],
  rules: readonly DisplayRule[] | undefined,
  ctx: DisplayContext,
): DisplayedRow<R>[] {
  return rows.map((row) => ({ row, ...displayRow(row, rules, ctx) }));
}
