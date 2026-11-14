/**
 * Stable ids for what the demo seed makes (RFC 4122 version 5: SHA-1 over a namespace and a
 * name), so running the seed again finds what it made before instead of making it twice.
 */
import { createHash } from 'node:crypto';

/** The namespace of every name the seed uses, e.g. `todo/passport`. */
export const SEED_NAMESPACE = 'd3160945-6dbc-40b4-a926-acd8e8e1c297';

/** RFC 4122 §4.3: the name-based UUID (version 5, SHA-1) of `name` in `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const space = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (!/^[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}$/i.test(namespace) || space.length !== 16) {
    throw new Error('uuidV5: the namespace must be a UUID');
  }
  const bytes = createHash('sha1').update(space).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The seed's id for one of its names: the same name always gives the same id. */
export function seedId(name: string): string {
  return uuidV5(name, SEED_NAMESPACE);
}
