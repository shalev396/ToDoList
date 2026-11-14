/** How the item sheet renders one entry of `item.props`. */
export type FieldType = 'date' | 'user' | 'status' | 'url' | 'number' | 'text';

export interface ItemField {
  key: string;
  type: FieldType;
  value: string | number;
}

const USER_KEYS = new Set([
  'assignee',
  'assignees',
  'reporter',
  'creator',
  'author',
  'owner',
  'instructor',
  'teacher',
  'organizer',
]);
const STATUS_KEYS = new Set(['status', 'statusRaw', 'state', 'resolution']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

/** The field type of a prop: by its name (people, status), then by its value. */
export function fieldType(key: string, value: string | number): FieldType {
  if (typeof value === 'number') {
    return 'number';
  }
  if (USER_KEYS.has(key)) {
    return 'user';
  }
  if (STATUS_KEYS.has(key)) {
    return 'status';
  }
  if (HTTP_URL.test(value)) {
    return 'url';
  }
  if (ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))) {
    return 'date';
  }
  return 'text';
}

function scalar(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
    return value.join(', ');
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Props the sheet shows elsewhere (names), or that are the app's own bookkeeping. */
const SHOWN_ELSEWHERE: ReadonlySet<string> = new Set(['assigneeNames', 'idempotencyKey']);

/**
 * Who the item is assigned to, as names: the source's `props.assigneeNames` (or `assignee`), else
 * `assignees` entries that are not bare ids (a provider's account id is no name).
 */
export function assigneeNames(item: {
  assignees: readonly string[];
  props: Readonly<Record<string, unknown>>;
}): string[] {
  for (const key of ['assigneeNames', 'assignee']) {
    const value = item.props[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return [value];
    }
    if (Array.isArray(value)) {
      const names = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (names.length > 0) {
        return names;
      }
    }
  }
  return item.assignees.filter((entry) => entry.trim() !== '' && !UUID.test(entry));
}

/** The props the sheet shows, sorted by name. Objects, empty values and nulls are skipped. */
export function describeProps(props: Readonly<Record<string, unknown>>): ItemField[] {
  const fields: ItemField[] = [];
  for (const key of Object.keys(props).sort()) {
    if (SHOWN_ELSEWHERE.has(key)) {
      continue;
    }
    const value = scalar(props[key]);
    if (value !== null) {
      fields.push({ key, type: fieldType(key, value), value });
    }
  }
  return fields;
}
