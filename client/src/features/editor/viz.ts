/**
 * The viz options of a block type, read from the catalog's JSON Schema (`vizSchema`) so the editor
 * never hard-codes them: a new option on the server shows up here.
 */
export type VizOption =
  | { name: string; input: 'boolean' }
  | { name: string; input: 'integer'; min: number; max: number }
  | { name: string; input: 'enum'; options: string[] }
  | { name: string; input: 'strings'; max: number }
  | { name: string; input: 'string' };

interface SchemaProp {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: { type?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function option(name: string, prop: SchemaProp): VizOption | null {
  if (Array.isArray(prop.enum)) {
    return { name, input: 'enum', options: prop.enum.map(String) };
  }
  if (prop.type === 'boolean') {
    return { name, input: 'boolean' };
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    return { name, input: 'integer', min: prop.minimum ?? 1, max: prop.maximum ?? 1000 };
  }
  if (prop.type === 'array') {
    return prop.items?.type === 'string'
      ? { name, input: 'strings', max: prop.maxItems ?? 20 }
      : null;
  }
  return prop.type === 'string' ? { name, input: 'string' } : null;
}

/** The tunable options of a viz schema, in schema order, without `kind`. */
export function vizOptions(schema: Record<string, unknown>): VizOption[] {
  const properties = schema['properties'];
  if (!isRecord(properties)) {
    return [];
  }
  return Object.entries(properties)
    .filter(([name]) => name !== 'kind')
    .flatMap(([name, prop]) => {
      const found = isRecord(prop) ? option(name, prop) : null;
      return found === null ? [] : [found];
    });
}

/** The `kind` values a viz schema allows: one (a constant) or several (an enum). */
export function vizKinds(schema: Record<string, unknown>): string[] {
  const properties = schema['properties'];
  const kind = isRecord(properties) && isRecord(properties['kind']) ? properties['kind'] : {};
  const prop = kind as SchemaProp;
  if (Array.isArray(prop.enum)) {
    return prop.enum.map(String);
  }
  return typeof prop.const === 'string' ? [prop.const] : [];
}

/** A viz object with one option set, or removed when `value` is undefined. */
export function withVizOption(
  viz: Record<string, unknown>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...viz };
  if (value === undefined) {
    Reflect.deleteProperty(next, name);
  } else {
    next[name] = value;
  }
  return next;
}
