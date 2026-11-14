/**
 * Secret hygiene (FRONTEND.md §8). A secret lives in an uncontrolled input until submit, is read
 * once, and the field is emptied in the same tick, before the request goes out. It is never put in
 * Redux, the query or mutation cache, the URL, storage, a toast or the console.
 */

/** The only props a secret input has: write-only, no reveal, no autofill. */
export const SECRET_INPUT_PROPS = {
  type: 'password',
  autoComplete: 'off',
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

interface FieldLike {
  value: string;
}

/**
 * Reads the named fields and empties each one in the same tick: what is returned is the only
 * copy left. The form's other fields (a site URL) are kept for a retry.
 */
export function takeFormValues(
  lookup: (name: string) => FieldLike | null,
  names: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const field = lookup(name);
    values[name] = field?.value ?? '';
    if (field !== null) {
      field.value = '';
    }
  }
  return values;
}
