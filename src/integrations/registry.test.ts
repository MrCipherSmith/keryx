// Flow 305 (W5-a), T3: the registry test — proves AC1, AC2, AC4.
//
// `src/integrations` collapsed three independently-drifting runtime lists
// (`CTX_RUNTIMES`, `ORIENT_RUNTIMES`, `RUNTIME_HOOKS`) into one
// `HARNESS_ADAPTERS` registry that the three legacy modules now derive their
// exports from. This file is the shape pin: it proves the registry names
// exactly the 8 W5 harnesses and the 12 W5 surface flags, that every derived
// legacy view still carries the pre-refactor facts byte-for-byte (ids,
// confidences, paths, commands, reason strings), and that the coherence
// invariant (`assertRegistryCoherent`) actually fires on the OQ-3 collision
// class it exists to prevent — proven with a negative control that mutates a
// COPY of the registry, never the real one.
//
// Style: drives the REAL registries (never a hand-built stand-in for the
// parity checks), and uses `expect({...}).toEqual({...})` shape objects so a
// failure names which id/field disagreed rather than just "false !== true" —
// see `src/security/agent-hooks.coexistence.test.ts`, the sibling pin this
// follows.

import { describe, expect, test } from "bun:test";
import {
  HARNESS_ADAPTERS,
  SETTINGS_FILE_OWNERS,
  assertRegistryCoherent,
  getHarnessAdapter,
  surfacesOf,
} from "./registry";
import type { HarnessAdapter, SurfaceAdapter, SurfaceFlag } from "./types";
import { CTX_RUNTIMES, UNSUPPORTED_RUNTIMES } from "../ctx/runtimes";
import { ORIENT_RUNTIMES, UNSUPPORTED_ORIENT } from "../ctx/orient-runtimes";
import { RUNTIME_HOOKS } from "../security/agent-hooks/runtimes";
import { CLI_ROUTES } from "../cli";
import { readFileSync } from "node:fs";
import path from "node:path";

// The 12 W5 integration points, as a literal — not imported from `types.ts`
// (a type has no runtime existence to assert against), so a change to the
// `SurfaceFlag` union that this test does not also touch fails loudly rather
// than silently agreeing with itself.
const THE_12_W5_FLAGS: readonly SurfaceFlag[] = [
  "block",
  "prompt-gate",
  "pre-tool-context",
  "inject-context",
  "observe",
  "post-tool",
  "session-start",
  "stop",
  "skills",
  "agents",
  "instructions",
  "mcp",
];

describe("AC1: HARNESS_ADAPTERS names exactly the 8 W5 harnesses, in order", () => {
  test("ids, in order", () => {
    expect(HARNESS_ADAPTERS.map((a) => a.id)).toEqual([
      "claude",
      "codex",
      "cursor",
      "windsurf",
      "antigravity",
      "opencode",
      "zed",
      "generic-mcp",
    ]);
  });

  test("no harness outside the W5 set is registered", () => {
    const excluded = ["gemini-cli", "kiro", "github-copilot-agent", "keryx-shell"];
    for (const id of excluded) {
      expect({ id, adapter: getHarnessAdapter(id) }).toEqual({ id, adapter: undefined });
    }
  });

  test("no `keryx integrations` CLI command exists yet", () => {
    // `CLI_ROUTES` (src/cli.ts) is the dispatch table's own source of truth —
    // see its doc comment: "the only honest source for what commands this CLI
    // actually has". Asserting against it, rather than a hand-written list of
    // verbs, means this test cannot itself drift from the dispatcher.
    expect(Object.keys(CLI_ROUTES)).not.toContain("integrations");
    // And no command MODULE for it exists either, so a future `integrations`
    // route wired up without registering it in CLI_ROUTES still fails this.
    let integrationsCommandExists = true;
    try {
      readFileSync(path.join(__dirname, "..", "commands", "integrations.ts"), "utf8");
    } catch {
      integrationsCommandExists = false;
    }
    expect(integrationsCommandExists).toBe(false);
  });
});

describe("AC1: the SurfaceFlag vocabulary is exactly the 12 W5 flags", () => {
  test("THE_12_W5_FLAGS has no duplicates and 12 entries (sanity on the literal itself)", () => {
    expect(THE_12_W5_FLAGS.length).toBe(12);
    expect(new Set(THE_12_W5_FLAGS).size).toBe(12);
  });

  test("every registered surface's flag is one of the 12", () => {
    const seen = new Set<string>();
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of adapter.surfaces) {
        seen.add(surface.flag);
        expect({ adapter: adapter.id, surface: surface.id, flag: surface.flag, known: THE_12_W5_FLAGS.includes(surface.flag) }).toEqual({
          adapter: adapter.id,
          surface: surface.id,
          flag: surface.flag,
          known: true,
        });
      }
    }
    // Non-vacuous: W5-a actually wires up a proper subset (block, prompt-gate,
    // inject-context), never the full 12 — the rest are named for W5-b to grow
    // into (plan.md, types.ts doc comment).
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(["block", "inject-context", "prompt-gate"]);
  });

  test("every unsupported reason's key is one of the 12 flags", () => {
    let checked = 0;
    for (const adapter of HARNESS_ADAPTERS) {
      for (const flag of Object.keys(adapter.unsupported) as SurfaceFlag[]) {
        expect({ adapter: adapter.id, flag, known: THE_12_W5_FLAGS.includes(flag) }).toEqual({
          adapter: adapter.id,
          flag,
          known: true,
        });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("AC2: CTX_RUNTIMES is derived, with parity against the pre-refactor values", () => {
  test("ids and confidence, in order", () => {
    expect(CTX_RUNTIMES.map((r) => ({ id: r.id, confidence: r.confidence }))).toEqual([
      { id: "claude", confidence: "verified" },
      { id: "codex", confidence: "verified" },
      { id: "cursor", confidence: "verified" },
      { id: "windsurf", confidence: "verified" },
      { id: "antigravity", confidence: "experimental" },
      { id: "opencode", confidence: "experimental" },
    ]);
  });

  test("locate() paths are byte-identical to the pre-refactor literals", () => {
    const root = "/proj";
    const expected: Record<string, string> = {
      claude: path.join(root, ".claude", "settings.json"),
      codex: path.join(root, ".codex", "hooks.json"),
      cursor: path.join(root, ".cursor", "hooks.json"),
      windsurf: path.join(root, ".windsurf", "hooks.json"),
      antigravity: path.join(root, ".agents", "hooks.json"),
      opencode: path.join(root, ".opencode", "plugin", "keryx-ctx-guard.js"),
    };
    for (const runtime of CTX_RUNTIMES) {
      expect({ id: runtime.id, locate: runtime.locate(root) }).toEqual({ id: runtime.id, locate: expected[runtime.id]! });
    }
  });

  test("ctx hook commands are `keryx ctx hook <id>`", () => {
    // Exercised indirectly: the merged PreToolUse group's command is the one
    // observable surface of `hookCommand`/`ctxHookCommand` for JSON runtimes.
    const s = CTX_RUNTIMES.find((r) => r.id === "claude")!.merge!({}) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(s.hooks.PreToolUse.at(-1)!.hooks[0]!.command).toBe("keryx ctx hook claude");

    const cursorRuntime = CTX_RUNTIMES.find((r) => r.id === "cursor")!;
    const cs = cursorRuntime.merge!({}) as { beforeShellExecution: never } & Record<string, unknown>;
    const hooks = (cs.hooks as { beforeShellExecution: Array<{ command: string }> }).beforeShellExecution;
    expect(hooks.at(-1)!.command).toBe("keryx ctx hook cursor");
  });

  test("UNSUPPORTED_RUNTIMES is exactly { zed: <pre-refactor string> }", () => {
    expect(UNSUPPORTED_RUNTIMES).toEqual({
      zed: "Zed has no scriptable pre-exec hook yet (tracking: zed-industries/zed#57943). Use its static agent tool_permissions (always_allow/always_deny) instead.",
    });
  });
});

describe("AC2: ORIENT_RUNTIMES is derived, with parity against the pre-refactor values", () => {
  test("ids, all verified, in order", () => {
    expect(ORIENT_RUNTIMES.map((r) => ({ id: r.id, confidence: r.confidence }))).toEqual([
      { id: "claude", confidence: "verified" },
      { id: "codex", confidence: "verified" },
      { id: "cursor", confidence: "verified" },
    ]);
  });

  test("UNSUPPORTED_ORIENT keys and strings are byte-identical for windsurf/zed/opencode/antigravity", () => {
    expect(UNSUPPORTED_ORIENT).toEqual({
      windsurf:
        "Windsurf hooks are exit-code only (block/allow); no documented field injects context. Use its rules/memories for standing context.",
      zed: "Zed has no scriptable session/prompt hook. Use static agent settings.",
      opencode:
        "OpenCode's chat.message / experimental.chat.system.transform can inject context in theory, but propagation is undocumented and known-buggy (sst/opencode#17100, oh-my-openagent#885). Left out until stable — use AGENTS.md for standing context.",
      antigravity:
        "Antigravity's context-injection hook is unverified (no first-party docs). Its pre-exec block hook IS supported — see `keryx ctx install-hook --runtime antigravity`.",
    });
  });
});

describe("AC2: RUNTIME_HOOKS is derived, with parity against the pre-refactor values", () => {
  test("ids and settings paths, in order", () => {
    const root = "/proj";
    expect(RUNTIME_HOOKS.map((r) => ({ id: r.id, path: r.settingsPath(root) }))).toEqual([
      { id: "claude", path: path.join(root, ".claude", "settings.json") },
      { id: "cursor", path: path.join(root, ".cursor", "hooks.json") },
      { id: "windsurf", path: path.join(root, ".windsurf", "hooks.json") },
      { id: "generic-mcp", path: path.join(root, ".mcp", "security-hooks.json") },
    ]);
  });
});

describe("AC7 (W5): opencode and antigravity adapters stay experimental", () => {
  test("adapter-level confidence", () => {
    expect({
      opencode: getHarnessAdapter("opencode")?.confidence,
      antigravity: getHarnessAdapter("antigravity")?.confidence,
    }).toEqual({ opencode: "experimental", antigravity: "experimental" });
  });
});

describe("every experimental surface has risk notes; every surface has source docs", () => {
  test("non-vacuous and exhaustive over the registry", () => {
    let experimentalCount = 0;
    let surfaceCount = 0;
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of adapter.surfaces) {
        surfaceCount += 1;
        expect({ adapter: adapter.id, surface: surface.id, sourceDocs: surface.sourceDocs.length > 0 }).toEqual({
          adapter: adapter.id,
          surface: surface.id,
          sourceDocs: true,
        });
        if (surface.confidence === "experimental") {
          experimentalCount += 1;
          expect({
            adapter: adapter.id,
            surface: surface.id,
            riskNotes: (surface.riskNotes ?? []).length > 0,
          }).toEqual({ adapter: adapter.id, surface: surface.id, riskNotes: true });
        }
      }
    }
    expect(surfaceCount).toBeGreaterThan(0);
    expect(experimentalCount).toBeGreaterThan(0);
  });
});

describe("every adapter's `unsupported` carries a non-empty reason for each flag it names", () => {
  test("non-vacuous and exhaustive over the registry", () => {
    let checked = 0;
    for (const adapter of HARNESS_ADAPTERS) {
      for (const [flag, reason] of Object.entries(adapter.unsupported)) {
        checked += 1;
        expect({ adapter: adapter.id, flag, nonEmpty: typeof reason === "string" && reason.length > 0 }).toEqual({
          adapter: adapter.id,
          flag,
          nonEmpty: true,
        });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("AC3: every settings file targeted by 2+ surfaces has exactly one SettingsFileOwner listing all of them", () => {
  test("owners derived independently from HARNESS_ADAPTERS match SETTINGS_FILE_OWNERS", () => {
    // Independent derivation: walk the adapters myself rather than reusing
    // `registry.ts`'s own aggregation, so this does not just re-check the
    // implementation against itself.
    const byPath = new Map<string, Set<string>>();
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of adapter.surfaces) {
        if (!surface.relativePath || !surface.merge || !surface.strip) continue;
        const set = byPath.get(surface.relativePath) ?? new Set<string>();
        set.add(surface.id);
        byPath.set(surface.relativePath, set);
      }
    }

    const multiTarget = [...byPath.entries()].filter(([, ids]) => ids.size >= 1);
    expect(multiTarget.length).toBeGreaterThan(0);

    const atLeastFour = [".claude/settings.json", ".cursor/hooks.json", ".windsurf/hooks.json", ".codex/hooks.json"];
    for (const file of atLeastFour) {
      const owners = SETTINGS_FILE_OWNERS.filter((o) => o.relativePath === file);
      expect({ file, ownerCount: owners.length }).toEqual({ file, ownerCount: 1 });
      const owner = owners[0]!;
      const expectedIds = [...(byPath.get(file) ?? new Set())].sort();
      const actualIds = owner
        .surfaces()
        .map((s) => s.id)
        .sort();
      expect({ file, actualIds }).toEqual({ file, actualIds: expectedIds });
    }

    // Every distinct relative path across the whole registry gets exactly one
    // owner — no file is split across two SettingsFileOwner instances.
    for (const [file, ids] of byPath) {
      const owners = SETTINGS_FILE_OWNERS.filter((o) => o.relativePath === file);
      expect({ file, ownerCount: owners.length }).toEqual({ file, ownerCount: 1 });
      expect({
        file,
        owned: owners[0]!
          .surfaces()
          .map((s) => s.id)
          .sort(),
      }).toEqual({ file, owned: [...ids].sort() });
    }
  });
});

describe("AC4: assertRegistryCoherent()", () => {
  test("passes on the real registry", () => {
    expect(() => assertRegistryCoherent()).not.toThrow();
  });

  test("negative control: two surfaces on one file disagreeing on a slot's JSON type throws (the OQ-3 class)", () => {
    const real = getHarnessAdapter("cursor")!;
    const fakeSurface: SurfaceAdapter = {
      id: "fake-oq3-surface",
      flag: "block",
      subsystem: "security",
      sentinel: "fake-sentinel",
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath: ".cursor/hooks.json",
      // The pre-fix OQ-3 shape: `hooks` declared as an array here, while the
      // real cursor ctx-guard surface on the same file declares it "object".
      slots: [{ key: "hooks", type: "array" }],
      merge: (s) => s,
      strip: (s) => s,
      validate: () => [],
    };
    const mutated: HarnessAdapter = { ...real, surfaces: [...real.surfaces, fakeSurface] };
    const adapters = HARNESS_ADAPTERS.map((a) => (a.id === "cursor" ? mutated : a));

    expect(() => assertRegistryCoherent(adapters)).toThrow(/hooks.*object.*array|array.*object/);
    // And the REAL registry is untouched by building this copy.
    expect(() => assertRegistryCoherent()).not.toThrow();
  });

  test("negative control: a duplicate surface id within one adapter throws", () => {
    const real = getHarnessAdapter("claude")!;
    const dupe: SurfaceAdapter = { ...real.surfaces[0]! };
    const mutated: HarnessAdapter = { ...real, surfaces: [...real.surfaces, dupe] };
    const adapters = HARNESS_ADAPTERS.map((a) => (a.id === "claude" ? mutated : a));

    expect(() => assertRegistryCoherent(adapters)).toThrow(/duplicate surface id/);
    expect(() => assertRegistryCoherent()).not.toThrow();
  });
});

describe("surfacesOf query helper", () => {
  test("filters by flag and subsystem, non-vacuously", () => {
    const claude = getHarnessAdapter("claude")!;
    const blocks = surfacesOf(claude, { flag: "block" });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((s) => s.flag === "block")).toBe(true);

    const ctxGuards = surfacesOf(claude, { subsystem: "ctx-guard" });
    expect(ctxGuards.length).toBeGreaterThan(0);
    expect(ctxGuards.every((s) => s.subsystem === "ctx-guard")).toBe(true);
  });
});

describe("the old view modules define no independent walker (no drifted second copy)", () => {
  // Cheap and robust: a plain substring check on the source text, not an AST
  // walk — brittle only if someone reintroduces a function with this EXACT
  // name for an unrelated reason, which the failure message makes obvious.
  test("src/ctx/orient-runtimes.ts and src/security/agent-hooks/runtimes.ts have no `function stripManaged`/`function addSentinel`/`function hooksObject`", () => {
    const files = [
      path.join(__dirname, "..", "ctx", "orient-runtimes.ts"),
      path.join(__dirname, "..", "security", "agent-hooks", "runtimes.ts"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const banned of ["function stripManaged", "function addSentinel", "function hooksObject"]) {
        expect({ file: path.basename(file), banned, present: text.includes(banned) }).toEqual({
          file: path.basename(file),
          banned,
          present: false,
        });
      }
    }
  });
});
