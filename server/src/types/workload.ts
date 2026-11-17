/**
 * How long an item is estimated to take, for the Workload view (H3): hours, or null when nothing
 * on the item says. It reads the same sources importance reads its size from
 * (builder/importance.ts sizeOf), but an item with no estimate is unknown here, not a default:
 * the Workload view counts it as nothing and lists it as unestimated.
 *
 * Story points count HOURS_PER_POINT hours each (1 point = 4 hours, as importance does).
 *
 * Shared with the client (`@api-types/workload`): pure TypeScript.
 */
import { HOURS_PER_POINT } from './importance.js';

const HOUR_MS = 60 * 60 * 1000;

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A finite number above zero, or null. */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** What an item row carries: its provider props and the viewer's overlay attributes. */
export interface EstimateSource {
  props: Record<string, unknown>;
  overlay?: { attrs?: Record<string, unknown> } | undefined;
}

/** Estimated hours, or null when unknown. First source that has one wins. */
export function estimateHours(item: EstimateSource): number | null {
  const points =
    positive(item.overlay?.attrs?.['size']) ??
    positive(at(item.props, 'jira', 'storyPoints')) ??
    positive(at(item.props, 'linear', 'estimate')) ??
    positive(at(item.props, 'storyPoints'));
  if (points !== null) return points * HOURS_PER_POINT;
  const hours = positive(at(item.props, 'estimateHours'));
  if (hours !== null) return hours;
  const clickupMs = positive(at(item.props, 'clickup', 'timeEstimateMs'));
  return clickupMs === null ? null : clickupMs / HOUR_MS;
}
