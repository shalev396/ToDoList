import type { BlockType, DashboardScope } from '@api-types/builder.ts';

export interface MiniBlock {
  type: BlockType;
  x: number;
  y: number;
  w: number;
  h: number;
}

const COLUMNS = 12;

/**
 * A template's block types laid out on the 12-column grid in block order, each at its default
 * size, wrapping like the dashboard's auto-placement: a row is filled left to right, and the next
 * block starts under the tallest one when it doesn't fit. A thumbnail, not the real layout.
 */
export function miniLayout(
  types: readonly BlockType[],
  sizeOf: (type: BlockType) => { w: number; h: number },
): MiniBlock[] {
  const placed: MiniBlock[] = [];
  let x = 0;
  let rowTop = 0;
  let rowHeight = 0;
  for (const type of types) {
    const { w, h } = sizeOf(type);
    const width = Math.min(w, COLUMNS);
    if (x + width > COLUMNS) {
      rowTop += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    placed.push({ type, x, y: rowTop, w: width, h });
    x += width;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

/** Rows the thumbnail spans. */
export function miniRows(blocks: readonly MiniBlock[]): number {
  return blocks.reduce((rows, block) => Math.max(rows, block.y + block.h), 0);
}

/**
 * The page a new dashboard of this scope shows on: its topic's (by slug), or the main dashboard.
 * A group page has no route of its own yet.
 */
export function pathForScope(
  scope: DashboardScope,
  topics: readonly { id: string; slug: string }[],
): string {
  const slug = topics.find((topic) => topic.id === scope.topicId)?.slug;
  return slug === undefined ? 'dashboard' : `t/${encodeURIComponent(slug)}`;
}

function templateName(key: string): string {
  return key.split('@')[0] ?? key;
}

/** Every template but the main dashboard's makes a page of some topic: the user picks which. */
export function needsTopic(templateKey: string): boolean {
  return templateName(templateKey) !== 'dashboard';
}

/**
 * The topic a template suggests: the workspace's topic named like it (`work@1` → work; a course
 * page → college), as an id; '' when there is none.
 */
export function suggestedTopicId(
  templateKey: string,
  topics: readonly { id: string; slug: string }[],
): string {
  const name = templateName(templateKey);
  const slug = name === 'college-course' ? 'college' : name;
  return topics.find((topic) => topic.slug === slug)?.id ?? '';
}
