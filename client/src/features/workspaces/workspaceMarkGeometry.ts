/**
 * Each workspace gets its own small 24-hour ring: the brand mark, with the needle on an hour and
 * one arc placed by the workspace's id. Ink only, because colour is reserved for data.
 */

export interface WorkspaceMarkGeometry {
  /** Needle angle in degrees, clockwise from midnight, on an hour (multiple of 15°). */
  needle: number;
  /** Arc start in degrees, on an hour. */
  arcStart: number;
  /** Arc length in degrees: 45°, 75°, 105° or 135°. */
  arcLength: number;
}

/** FNV-1a, 32 bit: small, fast and well spread for short ids. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function workspaceMarkGeometry(id: string): WorkspaceMarkGeometry {
  const value = hash(id);
  return {
    needle: (value % 24) * 15,
    arcStart: ((value >>> 5) % 24) * 15,
    arcLength: 45 + ((value >>> 10) % 4) * 30,
  };
}
