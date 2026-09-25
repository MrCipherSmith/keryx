// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC6/AC7.

import type { MemoryEntry } from "./types";

export type HandoffSelection = { from: string; target: string };

/**
 * Selects entries a handoff from `from` may hand to `target`: the entry's
 * `sourceHarness` must equal `from`, and its `targetHarnesses` must either be
 * null/absent (back-compatible "all") or include `target`. Pure filter —
 * callers (CLI `keryx memory handoff`, the `memory.handoff` MCP tool) are
 * responsible for the strict/incomplete-scan status this selection runs over.
 */
export function selectHandoffEntries(
  entries: MemoryEntry[],
  { from, target }: HandoffSelection,
): MemoryEntry[] {
  return entries.filter((entry) => {
    if (entry.sourceHarness !== from) {
      return false;
    }
    const targets = entry.targetHarnesses;
    return !targets || targets.length === 0 || targets.includes(target);
  });
}
