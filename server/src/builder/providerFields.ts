/**
 * Provider fields (H4): the custom fields a workspace's providers synced into `props`, found from
 * the data itself and served in the field picker with an inferred type and a human label.
 *
 * - Two shapes are found: the namespaced `props.<provider>.<key>` (the adapters' stable keys for
 *   custom fields) and a flat `props.<key>` (older, cross-provider props such as `storyPoints`).
 * - Only scalar values count (string, number, boolean, ISO date-time). Lists and nested objects
 *   (beyond one level under the provider) are not fields; neither is any key that could hold a
 *   credential (catalog.isRestrictedName) or does not match the strict path pattern.
 * - The registry is what the compiler checks `props.*` fields against, so a path that was never
 *   synced cannot reach a query. It is read from a recent sample of the caller's visible items
 *   (classes/item/ProviderFields.ts: the base access filter applies) and cached briefly.
 *
 * Pure: this module only discovers fields from a sample it is given.
 */
import { redactString } from '../services/secretPatterns.js';
import type { FieldType, ProviderField } from '../types/builder.js';
import { PROVIDERS } from '../types/domain.js';
import { PROVIDER_FIELD_PATTERN, PROPS_PATH_PATTERN, isRestrictedName } from './catalog.js';

const MAX_FIELDS = 200;
const MAX_ENUM_VALUES = 10;
const MIN_ENUM_SAMPLES = 3;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_VALUE_LENGTH = 200;

type Kind = 'string' | 'number' | 'boolean' | 'date';

interface Seen {
  provider: string;
  kinds: Set<Kind>;
  values: Set<string>;
  samples: number;
  /** A value looked like a secret: no enum values are offered for this field. */
  tainted: boolean;
}

function kindOf(value: unknown): Kind | null {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && value !== '' && value.length <= MAX_VALUE_LENGTH) {
    return ISO_DATE_TIME.test(value) ? 'date' : 'string';
  }
  return null;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** `storyPoints` → "Story points"; `customfield_10016` → "Customfield 10016". */
export function humanLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every scalar `props` path of one item's props, with its provider. */
function* scalarPaths(props: Record<string, unknown>): Generator<[string, unknown]> {
  for (const [key, value] of Object.entries(props)) {
    if (isRestrictedName(key)) continue;
    const namespaced = (PROVIDERS as readonly string[]).includes(key) && isPlain(value);
    if (namespaced) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (isRestrictedName(inner)) continue;
        if (isPlain(innerValue)) {
          for (const [sub, subValue] of Object.entries(innerValue)) {
            if (!isRestrictedName(sub)) yield [`props.${key}.${inner}.${sub}`, subValue];
          }
        } else {
          yield [`props.${key}.${inner}`, innerValue];
        }
      }
      continue;
    }
    yield [`props.${key}`, value];
  }
}

function accepted(path: string): boolean {
  if (!PROPS_PATH_PATTERN.test(path)) return false;
  const [, first] = path.split('.');
  const namespaced = (PROVIDERS as readonly string[]).includes(first ?? '');
  return !namespaced || PROVIDER_FIELD_PATTERN.test(path);
}

/** The registry of a sample of items' props: pure, so it is testable without a database. */
export function discoverFields(
  sample: readonly { provider: string; props: Record<string, unknown> }[],
): ProviderField[] {
  const seen = new Map<string, Seen>();
  for (const { provider, props } of sample) {
    for (const [path, value] of scalarPaths(props)) {
      const kind = kindOf(value);
      if (kind === null || !accepted(path)) continue;
      let entry = seen.get(path);
      if (entry === undefined) {
        if (seen.size >= MAX_FIELDS) continue;
        entry = {
          provider: namespaceOf(path) ?? provider,
          kinds: new Set(),
          values: new Set(),
          samples: 0,
          tainted: false,
        };
        seen.set(path, entry);
      }
      entry.kinds.add(kind);
      entry.samples += 1;
      if (kind === 'string' && typeof value === 'string') {
        // A value that reads like a secret is never offered as a choice: the field stays free text.
        if (redactString(value) !== value) entry.tainted = true;
        else if (entry.values.size <= MAX_ENUM_VALUES) entry.values.add(value);
      }
    }
  }
  return [...seen.entries()]
    .map(([path, entry]): ProviderField => {
      const key = path.split('.').slice(1).join('.');
      const label = humanLabel(path.split('.').at(-1) ?? key);
      const only = entry.kinds.size === 1 ? [...entry.kinds][0] : 'string';
      const enumLike =
        only === 'string' &&
        !entry.tainted &&
        entry.samples >= MIN_ENUM_SAMPLES &&
        entry.values.size <= MAX_ENUM_VALUES &&
        entry.values.size < entry.samples;
      return {
        path,
        provider: entry.provider,
        label,
        type: enumLike ? 'enum' : (only ?? 'string'),
        ...(enumLike ? { values: [...entry.values].sort() } : {}),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

function namespaceOf(path: string): string | null {
  const [, first] = path.split('.');
  return (PROVIDERS as readonly string[]).includes(first ?? '') ? (first ?? null) : null;
}

/** The paths the compiler accepts for `props.*` fields, with their inferred types. */
export function registryOf(fields: readonly ProviderField[]): ReadonlyMap<string, FieldType> {
  return new Map(fields.map((field): [string, FieldType] => [field.path, field.type]));
}
