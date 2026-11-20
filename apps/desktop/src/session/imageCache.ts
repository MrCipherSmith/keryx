/** An LRU of resolved image data URLs bounded by entry count and by total characters (a data URL can be megabytes). */
export function createImageCache(maxEntries: number, maxChars: number) {
  const map = new Map<string, string>();
  let chars = 0;
  const drop = (key: string): void => {
    const value = map.get(key);
    if (value === undefined) return;
    chars -= value.length;
    map.delete(key);
  };
  return {
    get(key: string): string | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: string): void {
      drop(key);
      if (value.length > maxChars) return;
      map.set(key, value);
      chars += value.length;
      while (map.size > maxEntries || chars > maxChars) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },
    delete: drop,
    get size(): number { return map.size; },
    get chars(): number { return chars; },
  };
}
