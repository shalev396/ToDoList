import type { FacetsResponseData } from '@api-types/items.ts';
import type { VarValue } from '@api-types/builder.ts';

/** One choice of a filter. A label is an i18n key, or data (a container's name). */
export type FacetOption =
  | { value: string; labelKey: string; label?: undefined }
  | { value: string; label: string; labelKey?: undefined };

/**
 * The choices of a filter block, only from `GET …/facets` (never hard-coded): the field names the
 * facet. `container.<type>` offers the containers of one type; `topic` the topics present, by name
 * and in sidebar order (`topics`: the workspace's). Anything else offers nothing.
 */
export function facetOptions(
  field: string | undefined,
  facets: FacetsResponseData,
  topics: readonly { id: string; name: string }[] = [],
): FacetOption[] {
  const keyed = (values: readonly string[], prefix: string): FacetOption[] =>
    values.map((value) => ({ value, labelKey: `${prefix}.${value}` }));
  switch (field) {
    case 'topic': {
      const present = new Set(facets.topics);
      return topics
        .filter((topic) => present.has(topic.id))
        .map((topic) => ({ value: topic.id, label: topic.name }));
    }
    case 'provider':
    case 'source.provider':
      return keyed(facets.providers, 'sources');
    case 'kind':
      return keyed(facets.kinds, 'items.kinds');
    case 'status':
      return keyed(facets.statuses, 'items.statuses');
    case 'containerId':
      return facets.containers.map((c) => ({ value: c.id, label: c.name }));
    case undefined:
    default: {
      if (field?.startsWith('container.') === true) {
        const type = field.slice('container.'.length);
        return facets.containers
          .filter((c) => c.type === type)
          .map((c) => ({ value: c.id, label: c.name }));
      }
      return [];
    }
  }
}

/** The values a variable holds, as a list (a range holds none). */
export function selectedValues(value: VarValue | null | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === 'object' ? [] : [String(value)];
}

/** The variable's value after choosing `value`; null clears it. */
export function nextSelection(
  current: VarValue | null | undefined,
  value: string,
  multi: boolean,
): VarValue | null {
  const held = selectedValues(current);
  if (!multi) {
    return held.length === 1 && held[0] === value ? null : value;
  }
  const next = held.includes(value) ? held.filter((v) => v !== value) : [...held, value];
  return next.length === 0 ? null : next;
}
