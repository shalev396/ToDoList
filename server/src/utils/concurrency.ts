/**
 * Maps `items` through `fn` with at most `limit` calls in flight, and returns the results in the
 * order of `items`. A worker pool rather than fixed waves, so one slow item doesn't hold up the
 * rest. Rejects with the first error, like Promise.all.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };

  const workers = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Promise.all that waits for every task to end, so none is still running (still writing) when it
 * throws; then answers the results in order, or throws the failure of the first task in `tasks`
 * that failed (by position, not by time), so which error wins never depends on timing.
 */
export async function settleAll<T extends readonly unknown[]>(tasks: {
  readonly [K in keyof T]: PromiseLike<T[K]>;
}): Promise<T> {
  const settled = await Promise.allSettled(tasks as readonly PromiseLike<unknown>[]);
  const values: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    values.push(result.value);
  }
  return values as unknown as T;
}
