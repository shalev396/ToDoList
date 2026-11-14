import { bySlot } from '../../../../components/items/sources.ts';
import type { Provider } from '../../../../components/items/types.ts';

export interface Segment {
  /** The field the groups are by (`source.provider`, `status` ...). */
  field: string;
  /** The group's key value, as text (a provider, a status, an area ...). */
  key: string;
  value: number;
  /** Set when the group is a source, for its colour. */
  provider: Provider | undefined;
}

interface GroupLike {
  key: Record<string, unknown>;
  value: unknown;
}

const PROVIDERS: ReadonlySet<string> = new Set([
  'google_calendar',
  'jira',
  'clickup',
  'linear',
  'moodle',
  'github',
  'local',
]);

function isProvider(value: string): value is Provider {
  return PROVIDERS.has(value);
}

/**
 * The chart's segments from a groupBy + count result: one per group with a positive numeric
 * value. Sources come in the fixed slot order (colour follows the source, never its rank); other
 * groups by value, largest first.
 */
export function toSegments(groups: readonly GroupLike[]): Segment[] {
  const segments = groups.flatMap((group): Segment[] => {
    const value = group.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return [];
    }
    const [field = '', raw] = Object.entries(group.key)[0] ?? [];
    const key =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : '';
    return [{ field, key, value, provider: isProvider(key) ? key : undefined }];
  });
  if (segments.length > 0 && segments.every((segment) => segment.provider !== undefined)) {
    return segments.sort((a, b) => bySlot(a.provider ?? 'local', b.provider ?? 'local'));
  }
  return segments.sort((a, b) => b.value - a.value);
}

/** The donut's total: always the sum of its segments, so the centre never disagrees with the ring. */
export function segmentsTotal(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.value, 0);
}
