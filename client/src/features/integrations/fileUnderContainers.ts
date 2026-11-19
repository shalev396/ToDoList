/**
 * File under (the Manage panel): the calendars and projects of one connection, in the order the
 * panel lists them. A container's own rule is `exactRuleFor(settings.topicRules, c.matchKey)`
 * (`@api-types/topicRules`, the lookup the server uses too).
 */
import type { FacetContainer } from '@api-types/items.ts';

export function containersOf(
  containers: readonly FacetContainer[],
  integrationId: string,
): FacetContainer[] {
  return containers
    .filter((container) => container.integrationId === integrationId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
