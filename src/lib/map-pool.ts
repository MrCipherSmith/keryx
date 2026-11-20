/** Run async work over items with a concurrency cap and preserve input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      try {
        results[i] = await worker(items[i]!, i);
      } catch (error) {
        // Callers such as authenticated readers can stop admitting new work after a fatal error.
        if (options.stopOnError) next = items.length;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
