/**
 * Keeps a decrypted secret inside the credential vault (DATA.md §0, §7). decryptForSync runs its
 * callback's result through carriesSecret (a hit is refused) and what the callback throws through
 * redactSecrets. Pure functions over the secret's values: nothing here decrypts or keeps anything.
 * The identity fields stored beside a secret are labels, and are neither looked for nor redacted.
 */

/** Shorter values are too common in ordinary text to look for or to redact. */
export const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[REDACTED]';

/**
 * Fields of a secret JSON that name the account instead of proving access to it: Jira's `email`,
 * a Google service account's `clientEmail`, and the key ids `kid` and `kidNext`.
 * They are labels, not secrets (controller ruling, T1.3 fix round 2). "Test connection" returns
 * the account email legitimately (Drive's `about.user.emailAddress` is the service account's
 * `clientEmail`), so the vault must neither refuse a result that carries one nor redact it.
 */
export const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'email',
  'clientEmail',
  'kid',
  'kidNext',
]);

/** How far redactSecrets follows a cause chain when it has to rebuild an error. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The secret JSON's values worth looking for: the identity fields left out, then the distinct
 * values of MIN_SECRET_LENGTH or more, longest first.
 */
export function secretValuesOf(secret: Readonly<Record<string, string>>): string[] {
  const values = Object.entries(secret)
    .filter(([field]) => !IDENTITY_FIELDS.has(field))
    .map(([, value]) => value);
  return [...new Set(values)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

function containsAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

/** Longest values first (secretValuesOf's order), so no part of a longer value survives. */
function redactText(text: string, values: readonly string[]): string {
  return values.reduce((out, value) => out.split(value).join(REDACTED), text);
}

/** A getter's value, or undefined when the getter throws. */
function readGetter(target: object, getter: () => unknown): unknown {
  try {
    return getter.call(target);
  } catch {
    return undefined;
  }
}

function bytesAsText(bytes: ArrayBufferView | ArrayBuffer): string {
  return ArrayBuffer.isView(bytes)
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
    : Buffer.from(bytes).toString('utf8');
}

/**
 * Whether `value` holds one of `values` anywhere: in a string or an object key, an own property
 * (non-enumerable ones and own getters too), an array item, a Map or Set entry, bytes read as
 * UTF-8, or an error's message, stack and cause. Each object is visited once, so cycles are fine.
 * A value that can't be read (a Proxy that throws) counts as carrying one: the check fails closed.
 */
export function carriesSecret(value: unknown, values: readonly string[]): boolean {
  if (values.length === 0) return false;
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'string') {
        if (containsAny(current, values)) return true;
        continue;
      }
      if (typeof current !== 'object' && typeof current !== 'function') continue;
      if (current === null || seen.has(current)) continue;
      seen.add(current);
      if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
        if (containsAny(bytesAsText(current), values)) return true;
        continue;
      }
      if (current instanceof Map) {
        for (const [key, item] of current as Map<unknown, unknown>) pending.push(key, item);
      } else if (current instanceof Set) {
        for (const item of current as Set<unknown>) pending.push(item);
      }
      if (current instanceof Error) pending.push(current.message, current.stack, current.cause);
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === 'string') pending.push(key);
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined) continue;
        if ('value' in descriptor) pending.push(descriptor.value as unknown);
        else if (descriptor.get !== undefined) pending.push(readGetter(current, descriptor.get));
      }
    }
  } catch {
    return true;
  }
  return false;
}

function defineText(target: object, key: string, text: string, enumerable: boolean): void {
  Object.defineProperty(target, key, {
    value: text,
    writable: true,
    configurable: true,
    enumerable,
  });
}

/**
 * Redacts, in place, every own text field (message, stack, ...) of the error, of its causes and
 * of an AggregateError's errors. Throws when an object can't be changed (frozen).
 */
function redactInPlace(root: Error, values: readonly string[]): void {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined) continue;
      const field: unknown =
        'value' in descriptor
          ? descriptor.value
          : descriptor.get === undefined
            ? undefined
            : readGetter(node, descriptor.get);
      if (typeof field === 'string') {
        if (containsAny(field, values)) {
          defineText(node, key, redactText(field, values), descriptor.enumerable === true);
        }
      } else if (key === 'cause') {
        pending.push(field);
      } else if (key === 'errors' && Array.isArray(field)) {
        const errors = field as unknown[];
        errors.forEach((item, index) => {
          if (typeof item !== 'string') pending.push(item);
          else if (containsAny(item, values)) errors[index] = redactText(item, values);
        });
      }
    }
    // A message inherited from the prototype (DOMException) is shadowed by a redacted own one.
    if (node instanceof Error && !Object.hasOwn(node, 'message')) {
      const { message } = node;
      if (containsAny(message, values))
        defineText(node, 'message', redactText(message, values), false);
    }
  }
}

/** Reads a field that may throw; undefined then. */
function safely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A plain Error made only of redacted text: the name, code, message and cause chain. */
function rebuilt(error: Error, values: readonly string[], depth = 0): Error {
  const text = (read: () => unknown): string => {
    const field = safely(read);
    return typeof field === 'string' ? redactText(field, values) : '';
  };
  const plain = new Error(text(() => error.message));
  const name = text(() => error.name);
  if (name !== '') plain.name = name;
  const code = safely(() => (error as { code?: unknown }).code);
  if (typeof code === 'string' || typeof code === 'number') {
    const kept = typeof code === 'string' ? redactText(code, values) : code;
    Object.defineProperty(plain, 'code', { value: kept, writable: true, configurable: true });
  }
  const cause = safely(() => error.cause);
  if (cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    plain.cause = rebuilt(cause, values, depth + 1);
  } else if (typeof cause === 'string') {
    plain.cause = redactText(cause, values);
  }
  return plain;
}

/**
 * What an error thrown inside decryptForSync becomes before it leaves the vault: every secret
 * value in its message, stack, other text fields and cause chain (and an AggregateError's errors)
 * replaced with [REDACTED]. It stays the same object, so its class, name, code and other fields
 * still say what failed (the sync engine classifies ProviderHttpError by class and code). An
 * error that can't be changed (frozen), or still holds a secret value somewhere else, is replaced
 * by a plain Error with the same name and code and the redacted message and causes. A thrown
 * non-error becomes an Error.
 */
export function redactSecrets(thrown: unknown, values: readonly string[]): Error {
  if (!(thrown instanceof Error)) {
    return new Error(
      typeof thrown === 'string'
        ? redactText(thrown, values)
        : 'The vault callback threw a non-error value',
    );
  }
  if (!carriesSecret(thrown, values)) return thrown;
  try {
    redactInPlace(thrown, values);
    if (!carriesSecret(thrown, values)) return thrown;
  } catch {
    // Frozen or otherwise unchangeable: rebuilt below.
  }
  return rebuilt(thrown, values);
}
