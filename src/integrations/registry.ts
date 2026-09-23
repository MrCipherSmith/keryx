// Flow 305 (W5-a): the one harness adapter registry. `HARNESS_ADAPTERS` is the
// single source of truth `src/ctx/runtimes.ts`, `src/ctx/orient-runtimes.ts`
// and `src/security/agent-hooks/runtimes.ts` derive their exported views from.

import {
  CTX_GUARD_ANTIGRAVITY,
  CTX_GUARD_CLAUDE,
  CTX_GUARD_CODEX,
  CTX_GUARD_CURSOR,
  CTX_GUARD_OPENCODE,
  CTX_GUARD_WINDSURF,
  ORIENT_CLAUDE,
  ORIENT_CODEX,
  ORIENT_CURSOR,
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_INPUT_CURSOR,
  SECURITY_CHECK_INPUT_GENERIC_MCP,
  SECURITY_CHECK_INPUT_WINDSURF,
  SECURITY_CHECK_OUTPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CURSOR,
  SECURITY_CHECK_OUTPUT_GENERIC_MCP,
  SECURITY_CHECK_OUTPUT_WINDSURF,
  UNSUPPORTED_CTX_GUARD,
  UNSUPPORTED_ORIENT,
} from "./surfaces";
import type { HarnessAdapter, SettingsFileOwner, SurfaceAdapter, SurfaceFlag } from "./types";
import { createSettingsFileOwner } from "./settings-file";

// Facts carried over verbatim from the pre-refactor registries; the code
// itself did not change, only where it lives, so `lastVerified` records that
// the confidences/reasons are as-of the last time those modules were checked
// against first-party docs, not a fresh check performed by this refactor.
const LAST_VERIFIED = "2026-09-23";

export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
  {
    id: "claude",
    label: "Claude Code",
    confidence: "verified",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_CLAUDE, ORIENT_CLAUDE, SECURITY_CHECK_INPUT_CLAUDE, SECURITY_CHECK_OUTPUT_CLAUDE],
    unsupported: {},
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts", "src/security/agent-hooks/runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "codex",
    label: "Codex",
    confidence: "verified",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_CODEX, ORIENT_CODEX],
    unsupported: {},
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts", "docs/docs/harness.md"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "cursor",
    label: "Cursor",
    confidence: "verified",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_CURSOR, ORIENT_CURSOR, SECURITY_CHECK_INPUT_CURSOR, SECURITY_CHECK_OUTPUT_CURSOR],
    unsupported: {},
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts", "src/security/agent-hooks/runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    confidence: "verified",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_WINDSURF, SECURITY_CHECK_INPUT_WINDSURF, SECURITY_CHECK_OUTPUT_WINDSURF],
    unsupported: { "inject-context": UNSUPPORTED_ORIENT.windsurf! },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts", "src/security/agent-hooks/runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_ANTIGRAVITY],
    unsupported: { "inject-context": UNSUPPORTED_ORIENT.antigravity! },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "opencode",
    label: "OpenCode",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_OPENCODE],
    unsupported: { "inject-context": UNSUPPORTED_ORIENT.opencode! },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "zed",
    label: "Zed",
    confidence: "experimental",
    // Zed has no scriptable host hook today, so it is registered with NO
    // surfaces at all — only the unsupported reasons. W5-b is expected to
    // turn this into `policy-travels-with-agent` once Zed ships its
    // agent-carried policy mechanism; left as `instruction-only` until then,
    // matching today's fallback guidance (static tool_permissions).
    adapterKind: "instruction-only",
    surfaces: [],
    unsupported: {
      block: UNSUPPORTED_CTX_GUARD.zed!,
      "inject-context": UNSUPPORTED_ORIENT.zed!,
    },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
  {
    id: "generic-mcp",
    label: "Generic MCP host",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [SECURITY_CHECK_INPUT_GENERIC_MCP, SECURITY_CHECK_OUTPUT_GENERIC_MCP],
    unsupported: {},
    sourceDocs: ["src/security/agent-hooks/runtimes.ts"],
    lastVerified: LAST_VERIFIED,
  },
];

export function getHarnessAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((a) => a.id === id);
}

export function harnessAdapterIds(): string[] {
  return HARNESS_ADAPTERS.map((a) => a.id);
}

export function surfacesOf(
  adapter: HarnessAdapter,
  query: { flag?: SurfaceFlag; subsystem?: SurfaceAdapter["subsystem"] } = {},
): readonly SurfaceAdapter[] {
  return adapter.surfaces.filter(
    (s) => (query.flag === undefined || s.flag === query.flag) && (query.subsystem === undefined || s.subsystem === query.subsystem),
  );
}

/**
 * One `SettingsFileOwner` per distinct relative settings path, aggregating
 * every surface (across every adapter) that targets it. This is what makes
 * `.claude/settings.json` (ctx-guard + orient + both security surfaces) and
 * `.cursor/hooks.json` / `.windsurf/hooks.json` (ctx-guard + both security
 * surfaces) single-owner files instead of two installers racing.
 */
export const SETTINGS_FILE_OWNERS: readonly SettingsFileOwner[] = (() => {
  const byPath = new Map<string, SurfaceAdapter[]>();
  for (const adapter of HARNESS_ADAPTERS) {
    for (const surface of adapter.surfaces) {
      if (!surface.relativePath || !surface.merge || !surface.strip) continue; // non-JSON artifacts own themselves
      const list = byPath.get(surface.relativePath) ?? [];
      list.push(surface);
      byPath.set(surface.relativePath, list);
    }
  }
  return [...byPath.entries()].map(([relativePath, surfaces]) => createSettingsFileOwner(relativePath, surfaces));
})();

export function settingsFileOwnerFor(relativePath: string): SettingsFileOwner | undefined {
  return SETTINGS_FILE_OWNERS.find((o) => o.relativePath === relativePath);
}

/**
 * Fails the build/tests the moment two surfaces on one settings file declare
 * different JSON types for the same top-level key (the `hooks: object` vs
 * `hooks: array` collision, OQ-3's class of bug) or reuse a surface id within
 * one adapter. Takes an optional adapter list so a negative-control test can
 * prove it actually fires, without mutating the real registry.
 */
export function assertRegistryCoherent(adapters: readonly HarnessAdapter[] = HARNESS_ADAPTERS): void {
  for (const adapter of adapters) {
    const seenIds = new Set<string>();
    for (const surface of adapter.surfaces) {
      if (seenIds.has(surface.id)) {
        throw new Error(`integrations registry: duplicate surface id "${surface.id}" on adapter "${adapter.id}"`);
      }
      seenIds.add(surface.id);
    }
  }
  const slotTypesByFile = new Map<string, Map<string, string>>();
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (!surface.relativePath) continue;
      let slotTypes = slotTypesByFile.get(surface.relativePath);
      if (!slotTypes) {
        slotTypes = new Map();
        slotTypesByFile.set(surface.relativePath, slotTypes);
      }
      for (const slot of surface.slots) {
        const prior = slotTypes.get(slot.key);
        if (prior !== undefined && prior !== slot.type) {
          throw new Error(
            `integrations registry: "${surface.relativePath}" has two surfaces declaring "${slot.key}" as both ` +
              `"${prior}" and "${slot.type}" (${adapter.id}/${surface.id})`,
          );
        }
        slotTypes.set(slot.key, slot.type);
      }
    }
  }
}

assertRegistryCoherent();
