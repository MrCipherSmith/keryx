import type { NormalizedUsage } from "../harness/provider/types";

/** Cache counters are input subsets, not extra tokens or a price. */
export function formatUsageLine(usage: NormalizedUsage): string | undefined {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`↑${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`↓${usage.outputTokens}`);
  if (parts.length === 0) return undefined;
  const cache: string[] = [];
  if (usage.cacheReadTokens !== undefined) cache.push(`cache-read ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens !== undefined) cache.push(`cache-write ${usage.cacheWriteTokens}`);
  // Absence is unknown, not a fabricated zero. Only derive a full breakdown.
  if (usage.inputTokens !== undefined && usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined) {
    const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
    if (uncached >= 0) cache.push(`uncached ${uncached}`);
  }
  return `${parts.join(" ")} tokens${cache.length > 0 ? ` · ${cache.join(" · ")}` : " · cache not reported"}`;
}
