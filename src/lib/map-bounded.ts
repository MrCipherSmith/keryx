/** `map` over `items` with at most `limit` calls in flight; the results keep the input order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) results[at] = await map(items[at]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
