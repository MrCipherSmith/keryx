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
import { ANTIGRAVITY_DECISION_CODEC, CURSOR_DECISION_CODEC, EXIT_CODE_DECISION_CODEC } from "./codecs";
import type { DecisionCodec, HarnessAdapter, HookAction, SettingsFileOwner, SurfaceAdapter, SurfaceFlag } from "./types";
import { createSettingsFileOwner } from "./settings-file";

// F11: `lastVerified` is the date this record was reconciled with its
// `sourceDocs` during the flow-305 refactor — moving/re-deriving the facts
// and checking them against the (already-cited) source docs still on file —
// NOT the date any first-party documentation was re-fetched or re-read. No
// doc lookup happened as part of carrying these facts over.
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
    decisionCodec: EXIT_CODE_DECISION_CODEC,
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
    decisionCodec: EXIT_CODE_DECISION_CODEC,
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
    decisionCodec: CURSOR_DECISION_CODEC,
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
    decisionCodec: EXIT_CODE_DECISION_CODEC,
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
    decisionCodec: ANTIGRAVITY_DECISION_CODEC,
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
    decisionCodec: EXIT_CODE_DECISION_CODEC,
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
    // No scriptable host hook at all (see the surfaces:[] note above), so this
    // is never actually invoked — the exit-code form is the harmless default.
    decisionCodec: EXIT_CODE_DECISION_CODEC,
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
    decisionCodec: EXIT_CODE_DECISION_CODEC,
  },
];

export function getHarnessAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((a) => a.id === id);
}

/**
 * R2-F1: the single answer to "how does runtime `id` signal a decision",
 * read off `HarnessAdapter.decisionCodec` rather than a second id-keyed
 * switch. An unknown id falls back to the exit-code form — the majority
 * shape, and the one that fails toward refusing when a caller has no
 * registered adapter to consult at all.
 */
export function decisionCodecFor(id: string): DecisionCodec {
  return getHarnessAdapter(id)?.decisionCodec ?? EXIT_CODE_DECISION_CODEC;
}

/**
 * How a runtime says NO, given the message, resolved by runtime id — for
 * callers with only a bare id in hand and no `SurfaceAdapter` (the ctx
 * native-search refusal in `src/ctx/hook.ts`, and the security CLI's
 * `--runtime <id>` argument path). A ctx-guard `SurfaceAdapter` should still
 * prefer its own `decisionCodec` directly when it has one; this delegates to
 * the exact same registry-held constant either way; a NEW adapter (say, a
 * future stdout-JSON one) is covered automatically the moment it is added to
 * `HARNESS_ADAPTERS` with its own `decisionCodec` — nothing here needs to
 * grow a case for it.
 */
export function refusalAction(runtimeId: string, message: string): HookAction {
  return decisionCodecFor(runtimeId).refuse(runtimeId, message);
}

/** How a runtime says YES. The other half of the same fact. */
export function allowAction(runtimeId: string): HookAction {
  return decisionCodecFor(runtimeId).allow(runtimeId);
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

interface SlotRecord {
  readonly owner: string;
  readonly type: string;
  readonly access: "owns" | "migrates-legacy";
}

/**
 * Fails the build/tests the moment two surfaces on one settings file declare
 * incompatible JSON types for the same top-level key (the `hooks: object` vs
 * `hooks: array` collision, OQ-3's class of bug) or reuse a surface id within
 * one adapter. Takes an optional adapter list so a negative-control test can
 * prove it actually fires, without mutating the real registry.
 *
 * Only two `"owns"` slots disagreeing on `type` are a collision. An `"owns"`
 * slot never conflicts with a `"migrates-legacy"` slot on the same key,
 * whatever type the latter declares — see `SurfaceSlot.access` for why that
 * pairing can never actually clobber anything.
 *
 * R2-F3: surface ids are unique WITHIN one adapter (checked below), but a
 * `SettingsFileOwner` (see `SETTINGS_FILE_OWNERS` above) keys its surfaces by
 * id PER FILE, aggregated ACROSS every adapter that targets that file — so
 * two different adapters each registering a surface with the same id on the
 * same `relativePath` would silently collide in that owner's map (one
 * clobbering the other), even though neither adapter alone has a duplicate.
 * That collision is latent today (no two adapters share a `relativePath` with
 * matching surface ids yet) but becomes reachable the moment two adapters
 * share a settings file (W5-b/W8) — so it is asserted here rather than left
 * for a future owner-map bug report.
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
  const surfaceOwnerByFile = new Map<string, Map<string, string>>();
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (!surface.relativePath) continue;
      let owningAdapterById = surfaceOwnerByFile.get(surface.relativePath);
      if (!owningAdapterById) {
        owningAdapterById = new Map();
        surfaceOwnerByFile.set(surface.relativePath, owningAdapterById);
      }
      const existingOwner = owningAdapterById.get(surface.id);
      if (existingOwner !== undefined && existingOwner !== adapter.id) {
        throw new Error(
          `integrations registry: "${surface.relativePath}" has surface id "${surface.id}" registered by both ` +
            `"${existingOwner}" and "${adapter.id}" — a SettingsFileOwner keys its surfaces by id per file, so this ` +
            `would clobber one adapter's surface with the other's`,
        );
      }
      owningAdapterById.set(surface.id, adapter.id);
    }
  }
  const slotsByFile = new Map<string, Map<string, SlotRecord[]>>();
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (!surface.relativePath) continue;
      let byKey = slotsByFile.get(surface.relativePath);
      if (!byKey) {
        byKey = new Map();
        slotsByFile.set(surface.relativePath, byKey);
      }
      for (const slot of surface.slots) {
        const records = byKey.get(slot.key) ?? [];
        records.push({ owner: `${adapter.id}/${surface.id}`, type: slot.type, access: slot.access });
        byKey.set(slot.key, records);
      }
    }
  }
  for (const [file, byKey] of slotsByFile) {
    for (const [key, records] of byKey) {
      const owns = records.filter((r) => r.access === "owns");
      for (let i = 1; i < owns.length; i++) {
        if (owns[i]!.type !== owns[0]!.type) {
          throw new Error(
            `integrations registry: "${file}" has two surfaces declaring "${key}" as both ` +
              `"${owns[0]!.type}" (${owns[0]!.owner}) and "${owns[i]!.type}" (${owns[i]!.owner})`,
          );
        }
      }
    }
  }
}

assertRegistryCoherent();
