/**
 * What value each filter operator takes, shared by the sentence editor and the advanced rule tree:
 * the shape (none, a list, a pair, a relative `[n, unit]`, a date, a preset or one value), the
 * default when the operator or the field changes, and the date helpers the inputs use.
 */
import type { Operator, RuleValue } from '@api-types/builder.ts';

export type ValueKind = 'none' | 'list' | 'pair' | 'relative' | 'date' | 'preset' | 'single';

const KINDS: Readonly<Record<Operator, ValueKind>> = {
  '=': 'single',
  '!=': 'single',
  '<': 'single',
  '<=': 'single',
  '>': 'single',
  '>=': 'single',
  in: 'list',
  notIn: 'list',
  allOf: 'list',
  noneOf: 'list',
  contains: 'single',
  notContains: 'single',
  beginsWith: 'single',
  endsWith: 'single',
  null: 'none',
  notNull: 'none',
  within: 'preset',
  between: 'pair',
  notBetween: 'pair',
  on: 'date',
  notOn: 'date',
  inLast: 'relative',
  notInLast: 'relative',
  inNext: 'relative',
  notInNext: 'relative',
  moreThanAgo: 'relative',
};

export function valueKind(operator: string): ValueKind {
  return operator in KINDS ? KINDS[operator as Operator] : 'single';
}

export const RELATIVE_UNITS = ['days', 'weeks', 'months'] as const;
export type RelativeUnit = (typeof RELATIVE_UNITS)[number];

/** The value a rule starts with after its operator (or field) changed; undefined: none. */
export function defaultValue(
  operator: string,
  type: string,
  values: readonly string[] = [],
): RuleValue | undefined {
  switch (valueKind(operator)) {
    case 'none':
      return undefined;
    case 'list':
      return [];
    case 'pair':
      return type === 'date' ? ['@today', '@today'] : [0, 10];
    case 'relative':
      return [7, 'days'];
    case 'date':
      return '@today';
    case 'preset':
      return 'next_7d';
    case 'single':
      if (type === 'number') {
        return 0;
      }
      if (type === 'boolean') {
        return true;
      }
      if (type === 'date') {
        return '@today';
      }
      return values[0] ?? '';
  }
}

/** True when `value` has the shape the operator needs (not that it is complete). */
export function fitsOperator(operator: string, value: unknown): boolean {
  switch (valueKind(operator)) {
    case 'none':
      return value === undefined;
    case 'list':
      return Array.isArray(value);
    case 'pair':
      return Array.isArray(value) && value.length === 2;
    case 'relative':
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'number' &&
        typeof value[1] === 'string'
      );
    case 'date':
    case 'preset':
      return typeof value === 'string';
    case 'single':
      return value !== undefined && !Array.isArray(value);
  }
}

/**
 * The value after switching operator: kept when it still fits (and the kind did not change), else
 * the new operator's default.
 */
export function valueAfterOperatorChange(
  from: string,
  to: string,
  value: RuleValue | undefined,
  type: string,
  values: readonly string[] = [],
): RuleValue | undefined {
  if (valueKind(from) === valueKind(to) && fitsOperator(to, value)) {
    return value;
  }
  return defaultValue(to, type, values);
}

/** `2026-11-12` (a date input) as an ISO date-time at noon UTC: inside that day in any zone. */
export function isoFromDateInput(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : day;
}

/** The date input's `YYYY-MM-DD` of a stored date-time, or '' for `@today` and the like. */
export function dateInputOf(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : '';
}
