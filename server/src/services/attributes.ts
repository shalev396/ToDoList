/**
 * Custom attributes (H4): the workspace's definitions (CRUD for editors) and the values an item
 * carries in its overlay. Everyone in the workspace reads the definitions; editors and owners
 * define, rename, change and delete them. The built-in Importance cannot be deleted (it can be
 * renamed). Values are local data: never written to a provider.
 */
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { WorkspacePolicy } from '../classes/policies/WorkspacePolicy.js';
import { AppError } from '../errors/AppError.js';
import { getItemRepository, getWorkspaceRepository } from '../models/index.js';
import {
  BUILTIN_IMPORTANCE,
  attributeValueError,
  dayOf,
  noonOf,
  numberRange,
  type AttributeDef,
  type AttributePatch,
  type NewAttribute,
} from '../types/attributes.js';
import { PLAN_LIMITS } from '../types/limits.js';
import type { WorkspaceContext } from './accessFilter.js';

export interface AttributeActor {
  userId: string;
  agentId: string | null;
}

/** Editors and owners change the workspace's content (WorkspacePolicy). */
function assertEditor(ws: WorkspaceContext, action: string): void {
  WorkspacePolicy.requireRole(ws.role, 'edit', action);
}

/** The definitions of the workspace, the built-in first (implied for a workspace not yet migrated). */
export function attributesOf(ws: Pick<WorkspaceContext, 'settings'>): AttributeDef[] {
  const stored = ws.settings.attributes ?? [];
  return stored.some((def) => def.key === BUILTIN_IMPORTANCE.key)
    ? stored
    : [{ ...BUILTIN_IMPORTANCE }, ...stored];
}

export function listAttributes(ws: WorkspaceContext): AttributeDef[] {
  return attributesOf(ws);
}

export async function createAttribute(
  ws: WorkspaceContext,
  actor: AttributeActor,
  input: NewAttribute,
): Promise<AttributeDef> {
  assertEditor(ws, 'add an attribute');
  const def: AttributeDef = {
    key: input.key,
    name: input.name,
    type: input.type,
    ...(input.options === undefined ? {} : { options: [...new Set(input.options)] }),
    ...(input.min === undefined ? {} : { min: input.min }),
    ...(input.max === undefined ? {} : { max: input.max }),
    builtIn: false,
  };
  const workspaces = await getWorkspaceRepository();
  const result = await workspaces.appendAttribute(ws.id, def, PLAN_LIMITS.attributesPerWorkspace);
  if (result === 'exists')
    throw new AppError(409, 'An attribute with this key exists', { code: 'attribute_exists' });
  if (result === 'full') {
    throw new AppError(
      409,
      `A workspace has at most ${String(PLAN_LIMITS.attributesPerWorkspace)} attributes`,
      { code: 'attribute_limit' },
    );
  }
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'attribute.create',
    AuditTarget.of('attribute', def.key),
  );
  return def;
}

export async function updateAttribute(
  ws: WorkspaceContext,
  actor: AttributeActor,
  key: string,
  patch: AttributePatch,
): Promise<AttributeDef> {
  assertEditor(ws, 'change an attribute');
  const current = attributesOf(ws).find((def) => def.key === key);
  if (current === undefined) throw new AppError(404, 'Not found');
  const wantsShape =
    patch.options !== undefined || patch.min !== undefined || patch.max !== undefined;
  if (wantsShape) {
    const listed = current.type === 'select' || current.type === 'multiSelect';
    if (patch.options !== undefined && !listed) {
      throw new AppError(400, 'Only a select has options');
    }
    if ((patch.min !== undefined || patch.max !== undefined) && current.type !== 'number') {
      throw new AppError(400, 'Only a number has a range');
    }
    if (patch.options?.length === 0) {
      throw new AppError(400, 'A select needs options');
    }
    if (current.type === 'number') {
      const { min, max } = numberRange({
        ...current,
        ...(patch.min === undefined ? {} : { min: patch.min }),
        ...(patch.max === undefined ? {} : { max: patch.max }),
      });
      if (max <= min) throw new AppError(400, 'max must be above min');
    }
  }
  const workspaces = await getWorkspaceRepository();
  const updated = await workspaces.updateAttribute(ws.id, key, {
    ...patch,
    ...(patch.options === undefined ? {} : { options: [...new Set(patch.options)] }),
  });
  if (updated === null) throw new AppError(404, 'Not found');
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'attribute.update',
    AuditTarget.of('attribute', key),
  );
  return updated;
}

/** Removes a custom attribute and the values items hold for it. The built-in is a 409. */
export async function deleteAttribute(
  ws: WorkspaceContext,
  actor: AttributeActor,
  key: string,
): Promise<{ items: number }> {
  assertEditor(ws, 'delete an attribute');
  const current = attributesOf(ws).find((def) => def.key === key);
  if (current === undefined) throw new AppError(404, 'Not found');
  if (current.builtIn) {
    throw new AppError(409, 'The built-in attribute cannot be deleted', {
      code: 'attribute_builtin',
    });
  }
  const workspaces = await getWorkspaceRepository();
  if (!(await workspaces.removeAttribute(ws.id, key))) throw new AppError(404, 'Not found');
  const items = await (await getItemRepository()).clearAttribute(ws.id, key);
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'attribute.delete',
    AuditTarget.of('attribute', key),
  );
  return { items };
}

/** An attribute value as stored: a date is its day at noon UTC, as a Date (it filters and sorts as one). */
function stored(def: AttributeDef, value: unknown): unknown {
  if (def.type !== 'date' || typeof value !== 'string') return value;
  const day = dayOf(value);
  return day === null ? value : noonOf(day);
}

/**
 * Checks `values` (key → value, null clears) against the workspace's definitions and returns what
 * the overlay stores. An unknown key or a value that does not fit is a 400 naming the key.
 */
export function prepareAttributeValues(
  ws: Pick<WorkspaceContext, 'settings'>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const defs = attributesOf(ws);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const def = defs.find((entry) => entry.key === key);
    if (def === undefined) throw new AppError(400, `Unknown attribute: ${key}`);
    const problem = attributeValueError(def, value);
    if (problem !== null) throw new AppError(400, problem);
    out[key] = value === null ? null : stored(def, value);
  }
  return out;
}
