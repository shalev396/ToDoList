import type { Block, DashboardScope } from '@api-types/builder.ts';
import type { Role } from '@api-types/domain.ts';

/**
 * Whether a list shows "+ Add" (H5's New to-do sheet), and the page it starts on: null for no
 * button, else the topic id ('' when the page has none). Only editors and owners create to-dos
 * (the server refuses the rest), and only a list of items has to-dos to add; a list of containers
 * (courses, projects) does not.
 */
export function listAddTopic(
  block: Pick<Block, 'type' | 'query'>,
  scope: Pick<DashboardScope, 'topicId'>,
  role: Role | null,
): string | null {
  if (block.type !== 'list' || block.query?.source === 'containers') {
    return null;
  }
  if (role !== 'editor' && role !== 'owner') {
    return null;
  }
  return scope.topicId ?? '';
}
