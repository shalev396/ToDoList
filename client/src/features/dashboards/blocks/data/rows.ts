import { SOURCE_STYLES } from '../../../../components/items/sources.ts';
import type { Provider } from '../../../../components/items/types.ts';
import type { ContainerQueryRow, ItemQueryRow, QueryResult, QueryRow } from '@api-types/builder.ts';

/**
 * Where a row holds a builder field: its name, except `topic`, which rows carry as `topicId` (the
 * field is stored there, server builder/catalog.ts).
 */
export function rowPath(field: string): string {
  return field === 'topic' ? 'topicId' : field;
}

/** A query row that is an item (container rows have `name` and `type`, not `title`/`kind`). */
export function isItemRow(row: QueryRow): row is ItemQueryRow {
  return 'title' in row && 'kind' in row;
}

export function isContainerRow(row: QueryRow): row is ContainerQueryRow {
  return !isItemRow(row);
}

/** The result's item rows (an empty list while loading or for a grouped result). */
export function itemRowsOf(result: QueryResult | undefined): ItemQueryRow[] {
  return (result?.rows ?? []).filter(isItemRow);
}

/**
 * A date from a row. JSON turns the server's Dates into ISO strings, so the typed `Date` is a
 * string at run time; an invalid or missing value is undefined.
 */
export function dateOf(value: unknown): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : NaN);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A group-by-count result's single number: the one group of an ungrouped aggregate, else the total. */
export function counterValue(result: QueryResult | undefined): number | undefined {
  if (result === undefined) {
    return undefined;
  }
  const groups = result.groups;
  if (groups?.length === 1 && typeof groups[0]?.value === 'number') {
    return groups[0].value;
  }
  return groups === undefined || groups.length === 0 ? result.total : undefined;
}

/** The number of days in a preset such as `upcoming_14d` (undefined for any other range). */
export function presetDays(range: unknown): number | undefined {
  if (typeof range !== 'string') {
    return undefined;
  }
  const match = /_(\d+)d$/.exec(range);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The provider a row component draws. The components know the seven integrations plus local; the
 * reserved `slack` and `notion` values have no colour slot yet and draw as local (muted).
 */
export function displayProvider(provider: string): Provider {
  return provider in SOURCE_STYLES ? (provider as Provider) : 'local';
}
