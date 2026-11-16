/**
 * Deep freezing, shared by every immutable class (Entity's data, the value objects, a push plan,
 * a block's JSON) and the builder's catalog defaults. Pure.
 */

function freezeAll(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value)) freezeAll(inner, seen);
}

/**
 * Freezes a value and everything reachable from it, at every depth: objects, arrays, and a Date's
 * own fields (its time is an internal slot, which freezing leaves alone). An object that was
 * already frozen shallowly is still walked, so nothing under it stays writable, and each object is
 * visited once, so a cycle ends. Returns the value: `this.#data = deepFreeze(structuredClone(data))`.
 */
export function deepFreeze<T>(value: T): T {
  freezeAll(value, new WeakSet());
  return value;
}
