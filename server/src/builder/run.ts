/**
 * Runs a compiled query (BACKEND.md §4): one aggregation per query, through the workspace-scoped
 * repository `aggregate()` (which also prepends `$match {workspaceId}` and refuses stages that leave
 * the collection), with a server-side time limit.
 */
import type { AggregateOptions } from '../models/definitions/common.js';
import {
  CAPS,
  type ContainerQueryRow,
  type ItemQueryRow,
  type Query,
  type QueryGroup,
  type QueryResult,
  type QueryRow,
} from '../types/builder.js';
import type { ContainerType, ItemKind, ItemStatus, Provider } from '../types/domain.js';
import { redactString } from '../services/secretPatterns.js';
import { scrub } from '../services/scrub.js';
import { compileQuery, type CompileContext, type CompiledQuery } from './compile.js';

/** A repository's `aggregate(workspaceId, stages, options)`. */
export type AggregateFn = (
  workspaceId: string,
  stages: readonly Record<string, unknown>[],
  options: AggregateOptions,
) => Promise<Record<string, unknown>[]>;

export interface RunQueryDeps {
  items: AggregateFn;
  containers: AggregateFn;
}

/** Time limit of a full (non-preview) query. */
export const QUERY_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function date(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string');
}

function redact(value: string | null): string | null {
  return value === null ? null : redactString(value);
}

function source(doc: Record<string, unknown>): QueryRow['source'] {
  const raw = record(doc['source']);
  return {
    provider: raw['provider'] as Provider,
    key: text(raw['key']),
    url: text(raw['url']) ?? '',
    externalId: text(raw['externalId']) ?? '',
  };
}

function toItemRow(doc: Record<string, unknown>): ItemQueryRow {
  const overlay = record(doc['overlay']);
  return {
    id: String(doc['_id']),
    kind: doc['kind'] as ItemKind,
    topicId: text(doc['topicId']),
    title: redactString(text(doc['title']) ?? ''),
    ...(typeof doc['sourceTitle'] === 'string'
      ? { sourceTitle: redactString(doc['sourceTitle']) }
      : {}),
    status: doc['status'] as ItemStatus,
    statusRaw: text(doc['statusRaw']),
    priority: typeof doc['priority'] === 'number' ? doc['priority'] : null,
    startAt: date(doc['startAt']),
    dueAt: date(doc['dueAt']),
    endAt: date(doc['endAt']),
    allDay: doc['allDay'] === true,
    containerId: text(doc['containerId']),
    labels: strings(doc['labels']),
    assignees: strings(doc['assignees']),
    source: source(doc),
    props: record(scrub(record(doc['props']))),
    overlay: {
      pinned: flag(overlay['pinned']),
      note: redact(text(overlay['note'])),
      hidden: flag(overlay['hidden']),
      topicOverride: text(overlay['topicOverride']),
      calendarSync: flag(overlay['calendarSync']),
      plannedAt: text(overlay['plannedAt']),
      editedAt: date(overlay['editedAt']),
      attrs: record(scrub(record(overlay['attrs']))),
      disabled: flag(overlay['disabled']),
      disabledOccurrences: strings(overlay['disabledOccurrences']),
    },
    closedAt: date(doc['closedAt']),
    ...(typeof doc['importance'] === 'number' ? { importance: doc['importance'] } : {}),
  };
}

function toContainerRow(doc: Record<string, unknown>): ContainerQueryRow {
  return {
    id: String(doc['_id']),
    type: doc['type'] as ContainerType,
    topicId: text(doc['topicId']),
    name: text(doc['name']) ?? '',
    parentId: text(doc['parentId']),
    path: strings(doc['path']),
    hidden: doc['hidden'] === true,
    source: source(doc),
    props: record(scrub(record(doc['props']))),
  };
}

/** `{_id: {k0, k1}, value}` → `{key: {<field>: …}, value}`. */
function toGroup(doc: Record<string, unknown>, groupBy: readonly string[]): QueryGroup {
  const id = record(doc['_id']);
  const value = doc['value'];
  return {
    key: Object.fromEntries(
      groupBy.map((field, index) => [field, scrub(id[`k${String(index)}`] ?? null)]),
    ),
    value:
      typeof value === 'number' ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      value instanceof Date
        ? value
        : null,
  };
}

function toResult(facet: Record<string, unknown>, compiled: CompiledQuery): QueryResult {
  const [count] = list(facet['total']);
  const total = record(count)['count'];
  const result: QueryResult = {
    total: typeof total === 'number' ? total : 0,
    appliedVars: compiled.appliedVars,
    warnings: compiled.warnings,
  };
  if ('rows' in facet) {
    const toRow = compiled.collection === 'Items' ? toItemRow : toContainerRow;
    result.rows = list(facet['rows']).map((doc) => toRow(record(doc)));
  }
  if ('groups' in facet) {
    result.groups = list(facet['groups']).map((doc) => toGroup(record(doc), compiled.groupBy));
  }
  return result;
}

/**
 * Compiles and runs a query: rows (`_id` → `id`, every row with `source.url`) and/or groups, the
 * total over the same match, the variables used and the warnings. Preview runs get 2 s, others 10 s.
 */
export async function runQuery(
  query: Query,
  ctx: CompileContext,
  deps: RunQueryDeps,
): Promise<QueryResult> {
  const compiled = compileQuery(query, ctx);
  const aggregate = compiled.collection === 'Items' ? deps.items : deps.containers;
  const [facet] = await aggregate(ctx.ws.id, compiled.pipeline, {
    maxTimeMS: ctx.preview ? CAPS.previewTimeoutMs : QUERY_TIMEOUT_MS,
  });
  return toResult(record(facet), compiled);
}
