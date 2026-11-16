import { isRestrictedName } from '../builder/catalog.js';
import { redactString } from './secretPatterns.js';

/** Props are provider data: they nest, but never this deep. */
const MAX_PROPS_DEPTH = 16;

/**
 * Provider data without credential-shaped keys (`token`, `secret`, `enc`, …) at any depth, and with
 * token-shaped text in string values redacted. Providers never put secrets there; this keeps one
 * odd key or pasted token from tripping the response secret guard.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_PROPS_DEPTH) return null;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry: unknown) => scrub(entry, depth + 1));
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isRestrictedName(key))
      .map(([key, entry]) => [key, scrub(entry, depth + 1)]),
  );
}
