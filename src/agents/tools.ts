// Canonical tool vocabulary an agent definition's `tools[]` may name, plus a
// per-target mapping from that vocabulary onto each host harness's own tool
// names (W2 §Design, `src/agents/tools.ts` in plan.md's module layout).
//
// The vocabulary is exactly the ten interactive tools keryx-shell's builtin
// registry defines under `src/harness/tool/builtin/` — never re-derived, and
// checked against the real `name: "..."` literals by `tools.test.ts` rather
// than trusted by inspection:
//   read_file, list_dir, get_cwd       (interactive-tools.ts)
//   search_code, graph_affected, memory_search  (metaproject-tools.ts)
//   apply_patch                        (apply-patch-tool.ts)
//   shell_exec                         (shell-exec-tool.ts)
//   web_fetch                          (web-fetch-tool.ts)
//   web_search                         (web-search-tool.ts)
//
// A tool with no mapping entry for a target is DROPPED from that target's
// export and reported in `droppedTools` — never silently. codex/kiro ship
// with empty maps: T7 fills them once a first-party docs check confirms each
// runtime's tool-permission vocabulary (plan.md "Host formats"); an empty map
// is an honest "unverified", not a guess.

export const AGENT_TOOL_VOCABULARY = [
  "read_file",
  "list_dir",
  "get_cwd",
  "search_code",
  "graph_affected",
  "memory_search",
  "apply_patch",
  "shell_exec",
  "web_fetch",
  "web_search",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_VOCABULARY)[number];

export function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_VOCABULARY as readonly string[]).includes(value);
}

/** Host export targets that carry a tool-permission vocabulary of their own. `keryx-shell` uses the vocabulary directly (no mapping). */
export type HostToolTarget = "claude" | "opencode" | "codex" | "kiro";

/**
 * Per-target tool-name mapping. Claude Code's and OpenCode's vocabularies are
 * per W2's "Per-harness exporters" table and plan.md's module layout
 * ("claude: Read/Glob/Grep/Edit/Write/Bash/WebFetch/WebSearch; opencode:
 * read/glob/grep/edit/write/bash/webfetch"); entries with no keryx-tool
 * analog (`get_cwd`, `graph_affected`, `memory_search`) are intentionally
 * absent so they surface as `droppedTools` rather than being force-mapped to
 * something that does not exist on that host.
 *
 * T7 (flow 310) update, per context.md's first-party docs check
 * (2026-09-24): OpenCode's own documented tool vocabulary DOES include a
 * `websearch` primitive ("Tool names: read, write, edit, apply_patch, glob,
 * grep, list, bash, webfetch, websearch") — T5's original comment here
 * ("whose documented vocabulary this table draws from has no web-search
 * primitive") predated that confirmed check and was wrong; `web_search` is
 * now mapped rather than dropped.
 */
const TOOL_TARGET_MAPS: Readonly<Record<HostToolTarget, ReadonlyMap<AgentToolName, string>>> = {
  claude: new Map<AgentToolName, string>([
    ["read_file", "Read"],
    ["list_dir", "Glob"],
    ["search_code", "Grep"],
    ["apply_patch", "Edit"],
    ["shell_exec", "Bash"],
    ["web_fetch", "WebFetch"],
    ["web_search", "WebSearch"],
  ]),
  opencode: new Map<AgentToolName, string>([
    ["read_file", "read"],
    ["list_dir", "glob"],
    ["search_code", "grep"],
    ["apply_patch", "edit"],
    ["shell_exec", "bash"],
    ["web_fetch", "webfetch"],
    ["web_search", "websearch"],
  ]),
  // Left empty (T7, plan.md "Host formats: Codex"): Codex's first-party docs
  // confirm NO per-tool allowlist exists at all — access is governed solely
  // by `sandbox_mode` (`policy.ts`'s `read-only`/`workspace-write`, see
  // `compile.ts`'s codex renderer). A tools[] entry is therefore never
  // "dropped" in the droppedTools sense for codex (there is nothing it could
  // have been mapped INTO); the renderer reports `droppedTools: []` and
  // documents the sandbox-governs-everything choice inline rather than
  // populating this map with an invented allowlist codex cannot enforce.
  codex: new Map<AgentToolName, string>(),
  // Kiro's documented tool vocabulary (T7, per context.md's first-party docs
  // check) is coarse category tags — `read`, `write`, `shell`, `web` — rather
  // than one-tool-per-name, so EVERY vocabulary entry maps onto one of the
  // four tags (nothing is dropped for kiro).
  kiro: new Map<AgentToolName, string>([
    ["read_file", "read"],
    ["list_dir", "read"],
    ["get_cwd", "read"],
    ["search_code", "read"],
    ["graph_affected", "read"],
    ["memory_search", "read"],
    ["apply_patch", "write"],
    ["shell_exec", "shell"],
    ["web_fetch", "web"],
    ["web_search", "web"],
  ]),
};

export interface HostToolMapping {
  /** Mapped host tool names, in the input `tools[]` order, de-duplicated. */
  readonly mappedTools: readonly string[];
  /** `tools[]` entries with no mapping for this target — unknown vocabulary entries AND unmapped known ones alike. */
  readonly droppedTools: readonly string[];
}

/** Map `tools` onto `target`'s own tool vocabulary. Every entry lands in exactly one of `mappedTools`/`droppedTools`; nothing is silently discarded. */
export function mapToolsForTarget(tools: readonly string[], target: HostToolTarget): HostToolMapping {
  const map = TOOL_TARGET_MAPS[target];
  const mapped = new Set<string>();
  const dropped: string[] = [];
  for (const tool of tools) {
    const mappedName = isAgentToolName(tool) ? map.get(tool) : undefined;
    if (mappedName !== undefined) {
      mapped.add(mappedName);
    } else {
      dropped.push(tool);
    }
  }
  return { mappedTools: [...mapped], droppedTools: dropped };
}
