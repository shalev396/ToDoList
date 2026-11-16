/**
 * Per-record validation: every record an adapter maps is checked before it is stored, so one bad
 * record is skipped as an `invalid_record` failure (with its id) instead of failing the whole run
 * (a value Mongoose cannot cast was `invalid_data`) or being written as it is (an unknown enum,
 * where no `$jsonSchema` validator runs).
 *
 * The checks follow the stored model: its enums (DATA.md §3.6, §3.7), dates that are valid
 * `Date`s, the 0–4 priority scale of local items, and lengths no real provider value reaches.
 * Omitted and null optional fields pass: the engine writes them as their defaults. The source's id
 * and link are checked first, by the engine (`missing_id`, `missing_url`).
 */
import { CONTAINER_TYPES, ITEM_KINDS, ITEM_STATUSES } from '../types/domain.js';
import type { DeletedRecord, MappedContainer, MappedItem } from './types.js';

/** Longest item title or container name. */
export const TITLE_MAX = 1000;
/** Longest short text: statusRaw, source.key, source.etag, a label or an assignee. */
export const TEXT_MAX = 500;
/** Longest external id (`source.externalId`, `containerExternalId`); Google event ids reach 1024. */
export const ID_MAX = 2048;
/** Longest `source.url`. */
export const URL_MAX = 4096;
/** Most entries in `labels`, `assignees` or `path`. */
export const LIST_MAX = 500;
/** Largest `props`, as UTF-8 JSON. */
export const PROPS_MAX_BYTES = 64 * 1024;
/** The priority scale (0 lowest … 4 most urgent), as for local items. */
const PRIORITY_MAX = 4;

type Check = (value: unknown) => boolean;

const oneOf =
  (values: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);

/** Omitted or null passes: the engine writes the field's default. */
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || value === null || check(value);

const text =
  (max: number): Check =>
  (value) =>
    typeof value === 'string' && value.length <= max;

const name: Check = (value) => text(TITLE_MAX)(value) && (value as string).trim() !== '';

const date: Check = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const list =
  (entry: Check): Check =>
  (value) =>
    Array.isArray(value) && value.length <= LIST_MAX && (value as unknown[]).every(entry);

const priority: Check = (value) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= PRIORITY_MAX;

/** A plain object whose JSON fits PROPS_MAX_BYTES (JSON.stringify refuses BigInt and cycles). */
const props: Check = (value) => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= PROPS_MAX_BYTES;
  } catch {
    return false;
  }
};

const ITEM_CHECKS: Readonly<Record<string, Check>> = {
  kind: oneOf(ITEM_KINDS),
  status: oneOf(ITEM_STATUSES),
  topicId: optional(text(ID_MAX)),
  title: name,
  bodyPreview: optional((value) => typeof value === 'string'),
  statusRaw: optional(text(TEXT_MAX)),
  priority: optional(priority),
  startAt: optional(date),
  dueAt: optional(date),
  endAt: optional(date),
  closedAt: optional(date),
  deletedAt: optional(date),
  allDay: optional((value) => typeof value === 'boolean'),
  assignees: optional(list(text(TEXT_MAX))),
  labels: optional(list(text(TEXT_MAX))),
  props: optional(props),
  containerExternalId: optional(text(ID_MAX)),
};

const CONTAINER_CHECKS: Readonly<Record<string, Check>> = {
  type: oneOf(CONTAINER_TYPES),
  topicId: optional(text(ID_MAX)),
  name,
  matchKey: optional(text(TITLE_MAX)),
  path: optional(list(text(TITLE_MAX))),
  props: optional(props),
  deletedAt: optional(date),
};

/** `source` beyond its id and link being there (the engine's own check). */
const SOURCE_CHECKS: Readonly<Record<string, Check>> = {
  externalId: text(ID_MAX),
  url: text(URL_MAX),
  key: optional(text(TEXT_MAX)),
  etag: optional(text(TEXT_MAX)),
  updatedAtSource: optional(date),
};

/** The first field of `record` that fails its check, prefixed (`source.key`), or null. */
function firstProblem(
  record: unknown,
  checks: Readonly<Record<string, Check>>,
  prefix = '',
): string | null {
  const fields = record as Record<string, unknown>;
  for (const [field, check] of Object.entries(checks)) {
    if (!check(fields[field])) return `${prefix}${field}`;
  }
  return null;
}

/** The first invalid field of a mapped item (e.g. `dueAt`, `source.key`), or null. */
export function itemProblem(item: MappedItem): string | null {
  return firstProblem(item, ITEM_CHECKS) ?? firstProblem(item.source, SOURCE_CHECKS, 'source.');
}

/** The first invalid field of a mapped container, or null. */
export function containerProblem(container: MappedContainer): string | null {
  return (
    firstProblem(container, CONTAINER_CHECKS) ??
    firstProblem(container.source, SOURCE_CHECKS, 'source.')
  );
}

const DELETED_RECORD_CHECKS: Readonly<Record<string, Check>> = {
  externalId: text(ID_MAX),
  deleted: (value) => value === true,
};

/** The first invalid field of a delete-only record, or null (its id being there is checked first). */
export function deletedRecordProblem(record: DeletedRecord): string | null {
  return firstProblem(record, DELETED_RECORD_CHECKS);
}
