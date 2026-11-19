/**
 * Dragging across free time in the week view (time-blocks design, "Creating and filling the
 * week"): the New sheet opens on a time block with that time filled in. Dragged inside an area,
 * the block starts on the area's page ("Areas": nothing links the two records; the area only lends
 * its topic). Pure.
 */
import { fromWallString } from '@api-types/recurrence/zoned.ts';
import type { Occurrence } from '@api-types/recurrence/occurrences.ts';
import { layerOf } from '@api-types/scheduled.ts';
import type { NewItemPreset } from '../create/timeBlockDraft.ts';

/** A dragged span on FullCalendar's grid: wall-clock times (`2026-11-22T13:00:00`) in the zone. */
export interface WallSelection {
  startWall: string;
  endWall: string;
}

/** What a calendar row may carry besides the time fields: its page, and one moved to by hand. */
interface PagedRow {
  topicId?: string | null;
  overlay?: { topicOverride?: string | null };
}

function topicOfRow(row: Occurrence['row']): string | null {
  const paged = row as Occurrence['row'] & PagedRow;
  return paged.overlay?.topicOverride ?? paged.topicId ?? null;
}

/**
 * The New sheet's preset for a dragged span: a time block at that time, on the topic of the
 * earliest area that overlaps it (touching at an edge is not overlapping), else on no page.
 */
export function presetFromSelection(
  selection: WallSelection,
  shown: readonly Occurrence[],
  timeZone: string,
): NewItemPreset {
  const start = fromWallString(selection.startWall, timeZone);
  const end = fromWallString(selection.endWall, timeZone);
  const area = shown
    .filter(
      (occurrence) =>
        layerOf(occurrence.row) === 'area' &&
        occurrence.start.getTime() < end.getTime() &&
        (occurrence.end ?? occurrence.start).getTime() > start.getTime(),
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key))[0];
  const topicId = area === undefined ? null : topicOfRow(area.row);
  return { kind: 'block', start, end, ...(topicId === null ? {} : { topicId }) };
}
