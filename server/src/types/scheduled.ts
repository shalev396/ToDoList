/**
 * Scheduled items (docs/superpowers/specs/2026-11-17-time-blocks-design.md): time TodoList keeps
 * for the member, not markable to-dos. Shared with the client (`@api-types/scheduled`). Pure.
 *
 * - A time block is a local item of kind `block`. A block with `props.layer: 'area'` is an area,
 *   time painted for a part of life ("Studying"); without it (or with `'block'`) it is a plain
 *   block ("Study: Math").
 * - A travel leg is a local item of kind `travel` (travel.ts holds what makes a leg).
 */
import { SCHEDULED_KINDS, type ScheduledKind } from './domain.js';

export const BLOCK_LAYERS = ['block', 'area'] as const;
export type BlockLayer = (typeof BLOCK_LAYERS)[number];

/** A time block's layer (`area` when its props say so, else `block`); null for any other kind. */
export function layerOf(row: {
  kind: string;
  props: Readonly<Record<string, unknown>>;
}): BlockLayer | null {
  if (row.kind !== 'block') return null;
  return row.props['layer'] === 'area' ? 'area' : 'block';
}

/** True for a kind that is reserved time (a block, an area or a travel leg), not a to-do. */
export function isScheduledKind(kind: string): kind is ScheduledKind {
  return (SCHEDULED_KINDS as readonly string[]).includes(kind);
}
