/** JSON with sorted keys, shared by the sync hash and the dashboard value objects. */

function normalize(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((child: unknown) => normalize(child) ?? null);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = normalize((value as Record<string, unknown>)[key]);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

/** JSON with object keys sorted at every depth; dates as ISO strings; undefined dropped. */
export function stableStringify(value: unknown): string {
  const normalized = normalize(value);
  return normalized === undefined ? 'null' : JSON.stringify(normalized);
}
