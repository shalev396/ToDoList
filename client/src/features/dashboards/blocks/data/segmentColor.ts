import { sourceColourVar } from '../../../../components/items/sources.ts';
import { colourVar } from '../../../colours/palette.ts';
import type { ColourFamily } from '@api-types/colours.ts';
import type { Segment } from './chartData.ts';

const SLOT_COUNT = 7;
const RESERVED_SOURCE_COLOUR = 'var(--color-source-reserved)';

/**
 * A chart segment's colour. Grouped by topic: the topic family's Scheduled (base) step, gray for
 * Unsorted. Grouped by source: the source's colour (a reserved provider with no slot is muted). Anything else takes the chart slots in order.
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
  if (segment.field === 'source.provider') {
    // A reserved provider (slack, notion) has no slot of its own: the muted ink, not a chart slot.
    return RESERVED_SOURCE_COLOUR;
  }
  return `var(--chart-${String((index % SLOT_COUNT) + 1)})`;
}
