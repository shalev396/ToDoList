/**
 * The item filters as plain functions, delegating to ItemPolicy (classes/policies/ItemPolicy.ts),
 * where the rules live. Only the builder's tests still call them by these names; code asks
 * ItemPolicy. The types stay importable from here too.
 */
import { ItemPolicy, type ItemAccess, type ItemNarrowing } from '../classes/policies/ItemPolicy.js';

export type { WorkspaceContext } from '../classes/base/Caller.js';
export type { ItemAccess, VisibleIntegration } from '../classes/policies/ItemPolicy.js';

/** ItemPolicy#itemFilter. */
export function baseItemFilter(ws: ItemNarrowing, access: ItemAccess): Record<string, unknown> {
  return ItemPolicy.of(access).itemFilter(ws);
}

/** ItemPolicy#containerFilter. */
export function baseContainerFilter(
  ws: ItemNarrowing,
  access: ItemAccess,
): Record<string, unknown> {
  return ItemPolicy.of(access).containerFilter(ws);
}

/** ItemPolicy#itemFilterUnabsorbed. */
export function baseItemFilterUnabsorbed(
  ws: ItemNarrowing,
  access: ItemAccess,
): Record<string, unknown> {
  return ItemPolicy.of(access).itemFilterUnabsorbed(ws);
}
