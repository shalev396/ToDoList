import { sourceColourVar } from '../../../../components/items/sources.ts';
import { colourVar } from '../../../colours/palette.ts';
import type { ColourFamily } from '@api-types/colours.ts';
import type { Segment } from './chartData.ts';

const SLOT_COUNT = 7;

/**
 * A chart segment's colour. Grouped by topic: the topic family's Scheduled (base) step, gray for
 * Unsorted. Grouped by source: the source's colour. Anything else takes the chart slots in order.
 */
export function segmentColor(
  segment: Segment,
  index: number,
  topicFamily: (topicId: string | null) => ColourFamily,
): string {
  if (segment.field === 'topic') {
    return colourVar(topicFamily(segment.key === '' ? null : segment.key), 'scheduled');
  }
  if (segment.provider !== undefined) {
    return sourceColourVar(segment.provider);
  }
  return `var(--chart-${String((index % SLOT_COUNT) + 1)})`;
}
