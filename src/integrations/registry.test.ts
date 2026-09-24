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
  allowAction,
  assertRegistryCoherent,
  getHarnessAdapter,
  refusalAction,
  surfacesOf,
} from "./registry";
import type { HarnessAdapter, HookAction, SurfaceAdapter, SurfaceFlag } from "./types";
import { CTX_RUNTIMES, UNSUPPORTED_RUNTIMES, buildBlockMessage, type HookClassification } from "../ctx/runtimes";
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

describe("AC1: HARNESS_ADAPTERS names the 8 W5-a harnesses plus the W5-b (flow 307) additions, in order", () => {
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
      "gemini-cli",
      "kiro",
      "github-copilot-agent",
      "keryx-shell",
    ]);
  });

  test("the `keryx integrations` CLI command is registered (flow 307, T8)", () => {
    // `CLI_ROUTES` (src/cli.ts) is the dispatch table's own source of truth —
    // see its doc comment: "the only honest source for what commands this CLI
    // actually has". Asserting against it, rather than a hand-written list of
    // verbs, means this test cannot itself drift from the dispatcher.
    //
    // This test used to pin the OPPOSITE fact ("no such command exists yet"),
    // as a marker that T6 (installer core) and T7 (capability matrix) landed
    // before the CLI surface did. T8 is that CLI surface — flipped here to a
    // positive pin rather than deleted, so the command module and its
    // registration in `CLI_ROUTES` stay proven present together.
    expect(Object.keys(CLI_ROUTES)).toContain("integrations");
    let integrationsCommandExists = true;
    try {
      readFileSync(path.join(__dirname, "..", "commands", "integrations.ts"), "utf8");
    } catch {
      integrationsCommandExists = false;
    }
    expect(integrationsCommandExists).toBe(true);
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
    // Non-vacuous: W5-a wired up block/prompt-gate/inject-context; W5-b
    // (flow 307) adds the `instructions` surfaces for
    // gemini-cli/kiro/github-copilot-agent/zed; W6 (flow 306, T20) adds
    // keryx-shell's native `pre-tool-context`/`observe`/`post-tool`/
    // `session-start`/`stop` surfaces; flow 310 (W2) adds the opt-in
    // `agents` surfaces for claude/codex/kiro/opencode — still a proper
    // subset of the 12, never all of them (skills/mcp have no surface yet).
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(
      [
        "agents",
        "block",
        "inject-context",
        "instructions",
        "observe",
        "post-tool",
        "pre-tool-context",
        "prompt-gate",
        "session-start",
        "stop",
      ].sort(),
    );
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
      // W5-b (flow 307): gemini-cli/kiro/github-copilot-agent each register a
      // ctx-guard surface too (subsystem "ctx-guard"), so `keryx ctx hook <id>`
      // works for them with no change to the handler. zed and generic-mcp
      // have none, so they do not appear here.
      { id: "gemini-cli", confidence: "experimental" },
      { id: "kiro", confidence: "experimental" },
      { id: "github-copilot-agent", confidence: "experimental" },
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
      "gemini-cli": path.join(root, ".gemini", "settings.json"),
      kiro: path.join(root, ".kiro", "hooks", "keryx-ctx-guard.json"),
      "github-copilot-agent": path.join(root, ".github", "hooks", "keryx-ctx-guard.json"),
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

    // >= 2, not >= 1: this block's own claim is about files with more than one
    // surface racing for ownership — a file with exactly one surface needs no
    // owner to arbitrate between surfaces at all, so a filter of >= 1 would
    // pass even if every file had only ever had a single surface.
    const multiTarget = [...byPath.entries()].filter(([, ids]) => ids.size >= 2);
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
      // real cursor ctx-guard surface on the same file declares it "object" —
      // both "owns", so this must still throw.
      slots: [{ key: "hooks", type: "array", access: "owns" }],
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

describe("F3: every surface's declared slots cover every top-level key its merge/strip actually touches", () => {
  // Runs every JSON surface's merge AND strip over `{}` and over legacy /
  // pre-populated fixtures (a raw `hooks` array from before any surface owned
  // that key, with and without a managed security entry inside it; a
  // pre-existing `hooks` object; a pre-populated `securityHooks` array; a
  // pre-populated antigravity container), then asserts every top-level key
  // whose value actually changed is declared in that surface's `slots` with
  // a matching JSON type. This is what makes the coherence invariant
  // non-vacuous: a surface could declare only its "obvious" key and still
  // pass `assertRegistryCoherent()` while silently writing an undeclared
  // `_keryxManaged`/`unmigratedHooks` key nothing checks (the gap fixed in
  // this review round).
  type JsonType = "object" | "array" | "number" | "string" | "boolean" | "null" | "undefined";

  function jsonTypeOf(value: unknown): JsonType {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value as JsonType;
  }

  const MANAGED_SECURITY_ENTRY = {
    on: "input",
    command: "keryx security check-input --source untrusted-external --runtime cursor",
    _keryxManaged: "security-agent-hooks",
  };

  const FIXTURES: Record<string, Record<string, unknown>> = {
    empty: {},
    "hooks as a legacy flat array": { hooks: [{ on: "input", command: "user-entry" }] },
    "hooks as a legacy flat array with a managed security entry": { hooks: [MANAGED_SECURITY_ENTRY] },
    "hooks as an object (nested shape)": { hooks: {} },
    "securityHooks pre-populated": { securityHooks: [{ on: "input", command: "user-entry" }] },
    "antigravity container pre-populated": { "keryx-ctx-guard": {} },
  };

  test("non-vacuous and exhaustive over every JSON surface x fixture x op", () => {
    let checkedKeys = 0;
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of adapter.surfaces) {
        if (!surface.merge || !surface.strip) continue; // non-JSON artifacts (opencode) own themselves
        for (const [fixtureLabel, fixture] of Object.entries(FIXTURES)) {
          for (const op of ["merge", "strip"] as const) {
            const before = structuredClone(fixture);
            const after = (op === "merge" ? surface.merge! : surface.strip!)(structuredClone(fixture)) as Record<
              string,
              unknown
            >;
            const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
            for (const key of keys) {
              if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue; // untouched by this op
              checkedKeys += 1;
              const scenario = { adapter: adapter.id, surface: surface.id, op, fixture: fixtureLabel, key };
              const declared = surface.slots.find((s) => s.key === key);
              expect({ ...scenario, declared: declared !== undefined }).toEqual({ ...scenario, declared: true });
              if (after[key] !== undefined) {
                expect({ ...scenario, typeMatches: jsonTypeOf(after[key]) === declared?.type }).toEqual({
                  ...scenario,
                  typeMatches: true,
                });
              }
            }
          }
        }
      }
    }
    expect(checkedKeys).toBeGreaterThan(0);
  });
});

describe("F4: the legacy views are BUILT from the registry, not a second hand-written list", () => {
  // Function identity, not just equal behaviour: `CTX_RUNTIMES`/`ORIENT_RUNTIMES`/
  // `RUNTIME_HOOKS` must carry the SAME merge/strip/validate function objects
  // the registry's surfaces expose, so a mutation of the registry (e.g. a
  // fixed bug in a surface's `merge`) is visible through the view without
  // anyone remembering to also patch the view — the property a hand-copied
  // second list cannot have.
  test("CTX_RUNTIMES: confidence and merge/strip/validate are the registry surface's own functions", () => {
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of surfacesOf(adapter, { subsystem: "ctx-guard" })) {
        const runtime = CTX_RUNTIMES.find((r) => r.id === adapter.id)!;
        expect({ adapter: adapter.id, confidence: runtime.confidence }).toEqual({
          adapter: adapter.id,
          confidence: surface.confidence,
        });
        if (surface.merge) expect({ adapter: adapter.id, mergeIsSurfaceMerge: runtime.merge === surface.merge }).toEqual({
          adapter: adapter.id,
          mergeIsSurfaceMerge: true,
        });
        if (surface.strip) expect({ adapter: adapter.id, stripIsSurfaceStrip: runtime.strip === surface.strip }).toEqual({
          adapter: adapter.id,
          stripIsSurfaceStrip: true,
        });
        if (surface.validate) expect({
          adapter: adapter.id,
          validateIsSurfaceValidate: runtime.validate === surface.validate,
        }).toEqual({ adapter: adapter.id, validateIsSurfaceValidate: true });
      }
    }
  });

  test("ORIENT_RUNTIMES: confidence and relativePath match the registry surface", () => {
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of surfacesOf(adapter, { subsystem: "orient" })) {
        const runtime = ORIENT_RUNTIMES.find((r) => r.id === adapter.id)!;
        expect({ adapter: adapter.id, confidence: runtime.confidence, relativePath: runtime.relativePath }).toEqual({
          adapter: adapter.id,
          confidence: surface.confidence,
          relativePath: surface.relativePath!,
        });
      }
    }
  });

  test("RUNTIME_HOOKS: validate delegates to the registry's own input/output surfaces (behavioural — the RuntimeHook shape composes two surfaces, so there is no single function to compare by identity)", () => {
    for (const adapter of HARNESS_ADAPTERS) {
      const input = surfacesOf(adapter, { subsystem: "security", flag: "prompt-gate" })[0];
      const output = surfacesOf(adapter, { subsystem: "security", flag: "block" })[0];
      if (!input || !output) continue;
      const runtime = RUNTIME_HOOKS.find((r) => r.id === adapter.id)!;
      const rendered = runtime.merge({});
      expect({ adapter: adapter.id, inputValid: input.validate!(rendered) }).toEqual({ adapter: adapter.id, inputValid: [] });
      expect({ adapter: adapter.id, outputValid: output.validate!(rendered) }).toEqual({ adapter: adapter.id, outputValid: [] });
    }
  });
});

describe("F6: two deliberately-kept behaviour changes (decision recorded by the orchestrator)", () => {
  test("(a) orient preserves a pre-existing legacy `hooks` array under `unmigratedHooks` instead of discarding it", () => {
    const claude = getHarnessAdapter("claude")!;
    const orient = surfacesOf(claude, { subsystem: "orient" })[0]!;
    const legacy = { hooks: [{ command: "the operator's own hook" }] };
    const after = orient.merge!(legacy) as Record<string, unknown>;
    expect(after.unmigratedHooks).toEqual([{ command: "the operator's own hook" }]);
    expect(orient.validate!(after)).toEqual([]);
  });

  test("(b) claude security check-input/check-output validate now require the `_keryxManaged` sentinel on the matched group", () => {
    const claude = getHarnessAdapter("claude")!;
    const input = surfacesOf(claude, { subsystem: "security", flag: "prompt-gate" })[0]!;
    const output = surfacesOf(claude, { subsystem: "security", flag: "block" })[0]!;
    // Shaped exactly like a real managed entry (event key, matcher, command),
    // but with NO `_keryxManaged` sentinel — an unmanaged/hostile entry that
    // merely has the right command string.
    const unmanaged = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "keryx security check-input --source untrusted-external" }] }],
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "keryx security check-output" }] }],
      },
    };
    expect(input.validate!(unmanaged).length).toBeGreaterThan(0);
    expect(output.validate!(unmanaged).length).toBeGreaterThan(0);
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

describe("R3-F1: refusalAction/allowAction/CTX_RUNTIMES agree with the pre-refactor hard-coded shape per adapter id", () => {
  // Literals copied from the pre-refactor `refusalAction`/`allowAction` in
  // `src/ctx/runtimes.ts` (`git show 90e90931:src/ctx/runtimes.ts`), NOT
  // derived from `HarnessAdapter.decisionCodec` or anything else the registry
  // computes. The R2-F1 version of this test compared `refusalAction` against
  // `adapter.decisionCodec` — exactly the value `decisionCodecFor` reads — so
  // a bug shared by both sides (e.g. cursor's `HarnessAdapter.decisionCodec`
  // silently set to the exit-code codec) would still pass. Hard-coding the
  // expected shape here means a real behaviour change is what this test
  // actually watches for.
  function expectedRefuse(id: string, message: string): HookAction {
    switch (id) {
      case "cursor":
        return { exitCode: 0, stdout: `${JSON.stringify({ permission: "deny", agent_message: message })}\n` };
      case "antigravity":
        return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: false, deny_reason: message })}\n` };
      case "github-copilot-agent":
        return {
          exitCode: 2,
          stdout: `${JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message })}\n`,
          stderr: `${message}\n`,
        };
      default:
        return { exitCode: 2, stderr: `${message}\n` };
    }
  }
  function expectedAllow(id: string): HookAction {
    switch (id) {
      case "cursor":
        return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n` };
      case "antigravity":
        return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: true })}\n` };
      default:
        return { exitCode: 0 };
    }
  }

  test("every adapter id: refusalAction/allowAction equal the hard-coded pre-refactor shape", () => {
    for (const adapter of HARNESS_ADAPTERS) {
      const message = `refusal message for ${adapter.id}`;
      expect({ id: adapter.id, refusal: refusalAction(adapter.id, message) }).toEqual({
        id: adapter.id,
        refusal: expectedRefuse(adapter.id, message),
      });
      expect({ id: adapter.id, allow: allowAction(adapter.id) }).toEqual({
        id: adapter.id,
        allow: expectedAllow(adapter.id),
      });
    }
  });

  test("an unknown id yields the exit-code form: refuse {exitCode:2, stderr}, allow {exitCode:0}", () => {
    const message = "unknown-runtime message";
    expect(refusalAction("some-future-runtime", message)).toEqual({ exitCode: 2, stderr: `${message}\n` });
    expect(allowAction("some-future-runtime")).toEqual({ exitCode: 0 });
  });

  test("CTX_RUNTIMES[i].block/.allow actually emit the hard-coded shape (behavioural, not just decisionCodecFor)", () => {
    const classification: HookClassification = { block: true, matched: "rg", suggestion: "keryx ctx rg" };
    for (const runtime of CTX_RUNTIMES) {
      const command = "rg foo";
      const message = buildBlockMessage(command, classification);
      expect({ id: runtime.id, action: runtime.block(command, classification) }).toEqual({
        id: runtime.id,
        action: expectedRefuse(runtime.id, message),
      });
      const allowed = runtime.allow({ block: false });
      const expectedAllowed = expectedAllow(runtime.id);
      // `allow` with no `escapeReason` never adds the stderr note (see
      // `runtimeFromSurface`'s comment) — so it matches `expectedAllow` as-is.
      expect({ id: runtime.id, action: allowed }).toEqual({ id: runtime.id, action: expectedAllowed });
    }
  });
});

describe("R2-F2: a `migrates-legacy` slot never creates its key and never retypes a pre-existing one", () => {
  // Runs merge AND strip over every fixture that LACKS the key (must never
  // create it) and every fixture that HAS it (must never change its JSON
  // type) — factored so the negative control below can run the exact same
  // check against a deliberately-broken fake surface and prove it is caught.
  function assertNeverCreatesOrRetypes(surface: SurfaceAdapter): void {
    for (const slot of surface.slots) {
      if (slot.access !== "migrates-legacy") continue;
      if (!surface.merge || !surface.strip) continue;
      const merge = surface.merge;
      const strip = surface.strip;

      for (const op of [merge, strip]) {
        // Fixture LACKING the key: op must never create it.
        const withoutKey = op({});
        expect({
          surface: surface.id,
          key: slot.key,
          createdWhenAbsent: Object.prototype.hasOwnProperty.call(withoutKey, slot.key),
        }).toEqual({ surface: surface.id, key: slot.key, createdWhenAbsent: false });

        // Fixture WITH the key already present: op must never change its type.
        const seedValue = slot.type === "array" ? ([{ seed: true }] as unknown) : ({ seed: true } as unknown);
        const withKey = op({ [slot.key]: structuredClone(seedValue) });
        if (Object.prototype.hasOwnProperty.call(withKey, slot.key)) {
          const after = (withKey as Record<string, unknown>)[slot.key];
          const afterType = Array.isArray(after) ? "array" : typeof after;
          expect({ surface: surface.id, key: slot.key, afterType }).toEqual({
            surface: surface.id,
            key: slot.key,
            afterType: slot.type,
          });
        }
      }
    }
  }

  test("non-vacuous and exhaustive over every registered migrates-legacy slot", () => {
    let checked = 0;
    for (const adapter of HARNESS_ADAPTERS) {
      for (const surface of adapter.surfaces) {
        if (surface.slots.some((s) => s.access === "migrates-legacy")) {
          checked += 1;
          assertNeverCreatesOrRetypes(surface);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("negative control: a fake surface that creates the key from `{}` is caught", () => {
    const fakeSurface: SurfaceAdapter = {
      id: "fake-migrates-legacy-surface",
      flag: "block",
      subsystem: "security",
      sentinel: "fake-sentinel",
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath: ".fake/hooks.json",
      slots: [{ key: "hooks", type: "array", access: "migrates-legacy" }],
      // The bug this check exists to catch: declares `access: "migrates-legacy"`
      // (implying it only ever touches a PRE-EXISTING `hooks`) while its merge
      // actually CREATES `hooks: []` from an empty settings object.
      merge: (s) => ({ ...s, hooks: Array.isArray(s.hooks) ? s.hooks : [] }),
      strip: (s) => s,
      validate: () => [],
    };

    expect(() => assertNeverCreatesOrRetypes(fakeSurface)).toThrow();
  });
});

describe("R2-F3: assertRegistryCoherent rejects duplicate surface ids per relativePath across adapters", () => {
  test("negative control: two different adapters sharing a relativePath with the same surface id throws", () => {
    // Two brand-new fake adapters (not derived from any real one), each with
    // exactly one surface, so neither has an intra-adapter duplicate id of
    // its own — the ONLY collision here is the shared id on the shared file
    // across the two DIFFERENT adapters, which is what R2-F3 is about.
    const sharedSurface = (adapterLabel: string): SurfaceAdapter => ({
      id: "shared-surface-id",
      flag: "block",
      subsystem: "security",
      sentinel: `fake-sentinel-${adapterLabel}`,
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath: ".fake-shared/file.json",
      slots: [],
    });
    const fakeAdapterA: HarnessAdapter = {
      id: "fake-adapter-a",
      label: "Fake Adapter A",
      confidence: "experimental",
      adapterKind: "host-hook",
      surfaces: [sharedSurface("a")],
      unsupported: {},
      sourceDocs: ["test"],
      lastVerified: "2026-09-23",
      decisionCodec: getHarnessAdapter("claude")!.decisionCodec,
    };
    const fakeAdapterB: HarnessAdapter = { ...fakeAdapterA, id: "fake-adapter-b", label: "Fake Adapter B", surfaces: [sharedSurface("b")] };
    const adapters = [...HARNESS_ADAPTERS, fakeAdapterA, fakeAdapterB];

    expect(() => assertRegistryCoherent(adapters)).toThrow(/surface id "shared-surface-id".*registered by both/);
    // The real registry is untouched by building this copy.
    expect(() => assertRegistryCoherent()).not.toThrow();
  });
});

describe("the old view modules define no independent walker (no drifted second copy)", () => {
  // Cheap and robust: a plain substring check on the source text, not an AST
  // walk — brittle only if someone reintroduces a function with this EXACT
  // name for an unrelated reason, which the failure message makes obvious.
  test("src/ctx/runtimes.ts, src/ctx/orient-runtimes.ts and src/security/agent-hooks/runtimes.ts have no `function stripManaged`/`function addSentinel`/`function hooksObject`", () => {
    const files = [
      path.join(__dirname, "..", "ctx", "runtimes.ts"),
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
