/**
 * A memo that lives for one request (an HTTP request, so one MCP call too): a value that several
 * parts of the same request need, such as what the caller may see (itemAccess.ts), is computed
 * once. Never across requests: each request starts empty, so what one request changes ("Stop
 * sharing", a new connector) is what the next one reads, and no Lambda container has anything to
 * invalidate. Outside a request (jobs, the sync worker, tests calling a service) nothing is kept.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Runs `fn` (the rest of a request) with a fresh, empty memo. */
export function runWithRequestMemo<T>(fn: () => T): T {
  return store.run(new Map(), fn);
}

/**
 * `compute()` once per request and key. A failure is not kept: a later call in the same request
 * computes again.
 */
export function memoForRequest<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (memo === undefined) return compute();
  const kept = memo.get(key) as Promise<T> | undefined;
  if (kept !== undefined) return kept;
  const value = compute();
  memo.set(key, value);
  void value.catch(() => {
    memo.delete(key);
  });
  return value;
}

/** Drops this request's memoized values whose key starts with `prefix`: a write changed them. */
export function forgetForRequest(prefix: string): void {
  const memo = store.getStore();
  if (memo === undefined) return;
  for (const key of [...memo.keys()]) {
    if (key.startsWith(prefix)) memo.delete(key);
  }
}
