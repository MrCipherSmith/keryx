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
  UNSUPPORTED_ORIENT,
} from "./surfaces";
import {
  ACP_PERMISSION_ZED,
  CTX_GUARD_GEMINI_CLI,
  CTX_GUARD_GITHUB_COPILOT_AGENT,
  CTX_GUARD_KIRO,
  INSTRUCTIONS_GEMINI_CLI,
  INSTRUCTIONS_GITHUB_COPILOT_AGENT,
  INSTRUCTIONS_KIRO,
  INSTRUCTIONS_ZED,
  KERYX_SHELL_SURFACES,
  KERYX_SHELL_UNSUPPORTED,
  LAST_VERIFIED_W5B,
} from "./surfaces-w5b";
import { AGENTS_CLAUDE, AGENTS_CODEX, AGENTS_KIRO, AGENTS_OPENCODE } from "./surfaces-agents";
import { ANTIGRAVITY_DECISION_CODEC, COPILOT_DECISION_CODEC, CURSOR_DECISION_CODEC, EXIT_CODE_DECISION_CODEC } from "./codecs";
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
    surfaces: [CTX_GUARD_CLAUDE, ORIENT_CLAUDE, SECURITY_CHECK_INPUT_CLAUDE, SECURITY_CHECK_OUTPUT_CLAUDE, AGENTS_CLAUDE],
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
    surfaces: [CTX_GUARD_CODEX, ORIENT_CODEX, AGENTS_CODEX],
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
    surfaces: [CTX_GUARD_OPENCODE, AGENTS_OPENCODE],
    unsupported: { "inject-context": UNSUPPORTED_ORIENT.opencode! },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts"],
    lastVerified: LAST_VERIFIED,
    decisionCodec: EXIT_CODE_DECISION_CODEC,
  },
  {
    id: "zed",
    label: "Zed",
    confidence: "experimental",
    // W5-b (flow 307): Zed still has no scriptable HOST hook (no settings
    // file to write into — `UNSUPPORTED_CTX_GUARD.zed` stays accurate and is
    // still what `keryx ctx install-hook --runtime zed` reports, since the
    // ctx-guard SUBSYSTEM has no zed surface here), but keryx running AS the
    // ACP agent inside Zed already implements the `block` surface's safety
    // property by construction (`src/acp/permission.ts`) — see
    // `ACP_PERMISSION_ZED` in `surfaces-w5b.ts`. That makes the adapter kind
    // `policy-travels-with-agent`, not `instruction-only`: the policy travels
    // with the agent binary rather than living in a Zed-owned config file.
    adapterKind: "policy-travels-with-agent",
    surfaces: [ACP_PERMISSION_ZED, INSTRUCTIONS_ZED],
    // `block` is deliberately absent here now — the harness DOES support it,
    // via the acp-permission surface above, not the ctx-guard subsystem.
    unsupported: {
      "inject-context": UNSUPPORTED_ORIENT.zed!,
    },
    sourceDocs: ["src/ctx/runtimes.ts", "src/ctx/orient-runtimes.ts", "src/acp/permission.ts", "src/acp/permission.test.ts"],
    lastVerified: LAST_VERIFIED,
    // Still no scriptable HOST hook (see above), so this is never actually
    // invoked for zed — the exit-code form is the harmless default.
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
  // --- W5-b (flow 307): new adapters -----------------------------------------
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_GEMINI_CLI, INSTRUCTIONS_GEMINI_CLI],
    unsupported: {},
    riskNotes: [
      "Gemini CLI's hooks default-enabled flag and the version it was introduced in are not confirmed in first-party docs; verify on a live install.",
    ],
    sourceDocs: [
      "https://geminicli.com/docs/hooks/",
      "https://geminicli.com/docs/hooks/reference/",
      "https://geminicli.com/docs/hooks/writing-hooks/",
      "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md",
    ],
    lastVerified: LAST_VERIFIED_W5B,
    decisionCodec: EXIT_CODE_DECISION_CODEC,
  },
  {
    id: "kiro",
    label: "Kiro",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_KIRO, INSTRUCTIONS_KIRO, AGENTS_KIRO],
    unsupported: {},
    riskNotes: [
      "Kiro's hook stdin field names and its shell tool's name are third-party-reported only, not confirmed by first-party docs.",
      "Open Kiro issues report that steering file `inclusion` modes are not always honoured.",
    ],
    sourceDocs: [
      "https://kiro.dev/docs/hooks/",
      "https://kiro.dev/docs/hooks/types/",
      "https://kiro.dev/docs/hooks/actions/",
      "https://kiro.dev/docs/cli/v3/hooks-migration/",
      "https://kiro.dev/docs/steering/",
    ],
    lastVerified: LAST_VERIFIED_W5B,
    decisionCodec: EXIT_CODE_DECISION_CODEC,
  },
  {
    id: "github-copilot-agent",
    label: "GitHub Copilot agent",
    confidence: "experimental",
    adapterKind: "host-hook",
    surfaces: [CTX_GUARD_GITHUB_COPILOT_AGENT, INSTRUCTIONS_GITHUB_COPILOT_AGENT],
    unsupported: {},
    riskNotes: [
      "The shell tool name Copilot's hook payload carries is not documented; the guard parses any tool call carrying `toolArgs.command`.",
    ],
    sourceDocs: [
      "https://docs.github.com/en/copilot/reference/hooks-reference",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks",
      "https://docs.github.com/en/copilot/concepts/agents/hooks",
      "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide",
      "https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/",
    ],
    lastVerified: LAST_VERIFIED_W5B,
    decisionCodec: COPILOT_DECISION_CODEC,
  },
  {
    id: "keryx-shell",
    label: "Keryx shell",
    // Flow 306 (W6, T20): the runtime (`src/harness/hooks/`) and every
    // surface below are in-repo code pinned by their own test suite, the same
    // basis `claude`/`codex`/`cursor`/`windsurf` are rated `verified` on —
    // not a third-party doc guess, which is what `experimental` means
    // elsewhere in this file.
    confidence: "verified",
    // `policy-travels-with-agent`, the same shape as `zed` above: the eight
    // surfaces below are satisfied entirely by keryx's own compiled-in hook
    // runtime — there is no harness-owned settings file to install into (the
    // runtime is configured only via `.metaproject/hooks.json`/
    // `~/.keryx/hooks.json`, owned by `keryx hooks`, not `keryx
    // integrations`). The remaining four flags (`skills`/`agents`/
    // `instructions`/`mcp`) have no runtime capability yet — see
    // `KERYX_SHELL_UNSUPPORTED`'s own doc comment in `surfaces-w5b.ts`.
    adapterKind: "policy-travels-with-agent",
    surfaces: KERYX_SHELL_SURFACES,
    unsupported: KERYX_SHELL_UNSUPPORTED,
    sourceDocs: ["docs/requirements/keryx-agent-platform-expansion/workstreams/W6-shell-hooks.md"],
    lastVerified: LAST_VERIFIED_W5B,
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
