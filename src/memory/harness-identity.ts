// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff".
//
// The closed set of harness identities a memory entry's `Source-Harness` /
// `Target-Harnesses` header fields (and the MCP server's bound
// `--harness`/`KERYX_HARNESS` identity) may name. Mirrors, verbatim, the
// `harnessId` enum in
// docs/requirements/keryx-agent-platform-expansion/schemas/portable-bundle.schema.json
// `$defs.harnessId` — a test asserts the two stay equal.

export const MEMORY_HARNESS_IDS = [
  "claude",
  "codex",
  "cursor",
  "windsurf",
  "gemini-cli",
  "kiro",
  "github-copilot-agent",
  "zed",
  "antigravity",
  "opencode",
  "generic-mcp",
  "keryx-shell",
] as const;

export type MemoryHarnessId = (typeof MEMORY_HARNESS_IDS)[number];

const HARNESS_ID_SET: ReadonlySet<string> = new Set(MEMORY_HARNESS_IDS);

export function isMemoryHarnessId(value: string): value is MemoryHarnessId {
  return HARNESS_ID_SET.has(value);
}

/**
 * Parses a `Target-Harnesses: <id>, <id>` header value into a validated list.
 * Tolerant: an empty/whitespace-only value or a list containing any unknown
 * id returns `null` (matching this file's "invalid -> null" convention used
 * throughout `store.ts#parseEntry`), never a partially-valid list.
 */
export function parseHarnessList(value: string | null | undefined): MemoryHarnessId[] | null {
  if (!value) {
    return null;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const result: MemoryHarnessId[] = [];
  for (const part of parts) {
    if (!isMemoryHarnessId(part)) {
      return null;
    }
    result.push(part);
  }
  return result;
}
