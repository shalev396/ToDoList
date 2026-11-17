/**
 * Page-variable names, as server/src/types/builder.ts defines them (urlVars.test.ts keeps the two
 * equal). Copied rather than imported: that module builds the zod schemas when it loads, and the
 * app would ship zod for three constants.
 */

/** A page variable reference, e.g. `$page.provider`. */
export const VAR_REF_PATTERN = /^\$page\.[a-zA-Z][a-zA-Z0-9]*$/;
export const VAR_REF_PREFIX = '$page.';
/** A page variable name as stored in `Dashboards.vars`, e.g. `provider`. */
export const VAR_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

/** `$page.provider` → `provider`; null when it is not a variable reference. */
export function varNameOf(ref: string): string | null {
  return VAR_REF_PATTERN.test(ref) ? ref.slice(VAR_REF_PREFIX.length) : null;
}

/** `provider` → `$page.provider`. */
export function varRef(name: string): string {
  return `${VAR_REF_PREFIX}${name}`;
}
