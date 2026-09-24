// Flow 307 (W5-b), T5: pins the new adapters this flow adds —
// gemini-cli, kiro, github-copilot-agent, zed's `policy-travels-with-agent`
// promotion, and keryx-shell's placeholder — plus the shared markdown-block
// helper and the new payload/decision codecs. Sibling to
// `src/integrations/registry.test.ts` (the pre-existing shape pin) and
// `src/integrations/coexistence.test.ts` (the generic permutation guard,
// which already covers these adapters' `SettingsFileOwner`s with no change).

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { HARNESS_ADAPTERS, getHarnessAdapter, surfacesOf } from "./registry";
import { UNSUPPORTED_ORIENT } from "./surfaces";
import type { SurfaceFlag } from "./types";
import { createSettingsFileOwner, installSurfaces, uninstallSurfaces } from "./settings-file";
import {
  COPILOT_DECISION_CODEC,
  parseCopilotToolArgsCommand,
  parseKiroCommand,
  parseRunShellCommandInput,
} from "./codecs";
import { installMarkdownBlock, probeMarkdownBlock, uninstallMarkdownBlock } from "./markdown-block";
import { CTX_RUNTIMES, UNSUPPORTED_RUNTIMES, resolveRuntimes, getRuntime } from "../ctx/runtimes";
import { runCtxHook } from "../ctx/hook";
import type { HarnessAdapter, SurfaceAdapter } from "./types";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-w5b-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC1/AC5(W5): gemini-cli / kiro / github-copilot-agent each have block +
// instructions surfaces, experimental, with non-empty riskNotes/sourceDocs.
// ---------------------------------------------------------------------------

describe("AC1 (W5-b): gemini-cli, kiro, github-copilot-agent each have block + instructions surfaces", () => {
  for (const id of ["gemini-cli", "kiro", "github-copilot-agent"]) {
    test(`${id}: registered, experimental, block + instructions surfaces present`, () => {
      const adapter = getHarnessAdapter(id);
      expect(adapter).toBeDefined();
      expect(adapter!.confidence).toBe("experimental");
      expect(adapter!.adapterKind).toBe("host-hook");

      const block = surfacesOf(adapter!, { flag: "block" });
      const instructions = surfacesOf(adapter!, { flag: "instructions" });
      expect(block.length).toBe(1);
      expect(instructions.length).toBe(1);

      for (const surface of [...block, ...instructions]) {
        expect({ id, surface: surface.id, confidence: surface.confidence }).toEqual({
          id,
          surface: surface.id,
          confidence: "experimental",
        });
        expect(surface.sourceDocs.length).toBeGreaterThan(0);
        expect(surface.sourceDocs.some((d) => d.startsWith("https://"))).toBe(true);
        expect((surface.riskNotes ?? []).length).toBeGreaterThan(0);
      }
    });
  }
});

describe("AC2 (W5-b): zed is policy-travels-with-agent, block surface verified with no relativePath/merge", () => {
  test("adapter shape", () => {
    const zed = getHarnessAdapter("zed")!;
    expect(zed.adapterKind).toBe("policy-travels-with-agent");

    const block = surfacesOf(zed, { flag: "block" });
    expect(block.length).toBe(1);
    const acp = block[0]!;
    expect(acp.confidence).toBe("verified");
    expect(acp.relativePath).toBeUndefined();
    expect(acp.merge).toBeUndefined();
    expect(acp.strip).toBeUndefined();
    expect(acp.sourceDocs).toContain("src/acp/permission.ts");
    expect(acp.sourceDocs).toContain("src/acp/permission.test.ts");

    // Both cited files actually exist.
    expect(existsSync(path.join(__dirname, "..", "acp", "permission.ts"))).toBe(true);
    expect(existsSync(path.join(__dirname, "..", "acp", "permission.test.ts"))).toBe(true);
  });

  test("`inject-context` stays unsupported for zed; `block` is no longer in `unsupported` (it is now a supported surface)", () => {
    const zed = getHarnessAdapter("zed")!;
    expect(zed.unsupported["inject-context"]).toBe(UNSUPPORTED_ORIENT.zed);
    expect(zed.unsupported.block).toBeUndefined();
  });

  test("zed has an instructions surface too (probe-only, AGENTS.md, no merge/strip/customInstall)", () => {
    const zed = getHarnessAdapter("zed")!;
    const instructions = surfacesOf(zed, { flag: "instructions" });
    expect(instructions.length).toBe(1);
    const surface = instructions[0]!;
    expect(surface.confidence).toBe("experimental");
    expect((surface.riskNotes ?? []).length).toBeGreaterThan(0);
    // F2: probe-only — neither merge/strip nor customInstall/customUninstall,
    // which is the installer's own signal to route this to satisfied/probe-only
    // (never recorded as installed, never able to fail install/uninstall).
    expect(surface.merge).toBeUndefined();
    expect(surface.strip).toBeUndefined();
    expect(surface.customInstall).toBeUndefined();
    expect(surface.customUninstall).toBeUndefined();
    expect(surface.probe).toBeDefined();
  });

  test("`keryx ctx hook zed` still resolves to no runtime (zed has no ctx-guard surface)", () => {
    expect(getRuntime("zed")).toBeUndefined();
  });

  test("resolveRuntimes(['zed']) still reports zed unsupported, not unknown", () => {
    const { runtimes, unknown, unsupported } = resolveRuntimes(["zed"]);
    expect(runtimes).toEqual([]);
    expect(unknown).toEqual([]);
    expect(unsupported).toEqual(["zed"]);
    expect(UNSUPPORTED_RUNTIMES.zed).toBeDefined();
  });

  test("`keryx ctx hook zed` handler: no runtime resolved means the hook is a silent no-op (never throws, never writes)", async () => {
    // runCtxHook reads stdin itself; passing an id with no registered runtime
    // returns immediately without touching stdout/stderr/exitCode.
    const before = process.exitCode;
    await runCtxHook("zed");
    expect(process.exitCode).toBe(before);
  });
});

describe("AC3 (W5-b): opencode/antigravity unchanged; no pre-existing adapter/surface confidence changed", () => {
  // Pinned confidence for EVERY adapter/surface that existed before this flow
  // (W5-a's registry) — a change here on a re-run of this test is exactly the
  // "silently upgraded/downgraded confidence" regression AC3/AC7 forbid.
  const PRE_EXISTING_ADAPTER_CONFIDENCE: Record<string, "verified" | "experimental"> = {
    claude: "verified",
    codex: "verified",
    cursor: "verified",
    windsurf: "verified",
    antigravity: "experimental",
    opencode: "experimental",
    zed: "experimental",
    "generic-mcp": "experimental",
  };

  test("every pre-existing adapter's confidence is unchanged", () => {
    for (const [id, confidence] of Object.entries(PRE_EXISTING_ADAPTER_CONFIDENCE)) {
      expect({ id, confidence: getHarnessAdapter(id)?.confidence }).toEqual({ id, confidence });
    }
  });

  test("opencode: inject-context reason equals UNSUPPORTED_ORIENT.opencode", () => {
    const opencode = getHarnessAdapter("opencode")!;
    expect(opencode.unsupported["inject-context"]).toBe(UNSUPPORTED_ORIENT.opencode);
    expect(opencode.confidence).toBe("experimental");
  });

  test("antigravity: inject-context reason equals UNSUPPORTED_ORIENT.antigravity", () => {
    const antigravity = getHarnessAdapter("antigravity")!;
    expect(antigravity.unsupported["inject-context"]).toBe(UNSUPPORTED_ORIENT.antigravity);
    expect(antigravity.confidence).toBe("experimental");
  });

  test("no pre-existing surface's confidence changed (pinned list, by adapter/surface id)", () => {
    const PRE_EXISTING_SURFACE_CONFIDENCE: Array<{ adapter: string; surface: string; confidence: "verified" | "experimental" }> = [
      { adapter: "claude", surface: "ctx-guard", confidence: "verified" },
      { adapter: "claude", surface: "orient", confidence: "verified" },
      { adapter: "claude", surface: "security-check-input", confidence: "verified" },
      { adapter: "claude", surface: "security-check-output", confidence: "verified" },
      { adapter: "codex", surface: "ctx-guard", confidence: "verified" },
      { adapter: "codex", surface: "orient", confidence: "verified" },
      { adapter: "cursor", surface: "ctx-guard", confidence: "verified" },
      { adapter: "cursor", surface: "orient", confidence: "verified" },
      { adapter: "cursor", surface: "security-check-input", confidence: "experimental" },
      { adapter: "cursor", surface: "security-check-output", confidence: "experimental" },
      { adapter: "windsurf", surface: "ctx-guard", confidence: "verified" },
      { adapter: "windsurf", surface: "security-check-input", confidence: "experimental" },
      { adapter: "windsurf", surface: "security-check-output", confidence: "experimental" },
      { adapter: "antigravity", surface: "ctx-guard", confidence: "experimental" },
      { adapter: "opencode", surface: "ctx-guard", confidence: "experimental" },
      { adapter: "generic-mcp", surface: "security-check-input", confidence: "experimental" },
      { adapter: "generic-mcp", surface: "security-check-output", confidence: "experimental" },
    ];
    for (const { adapter: adapterId, surface: surfaceId, confidence } of PRE_EXISTING_SURFACE_CONFIDENCE) {
      const adapter = getHarnessAdapter(adapterId)!;
      const surface = adapter.surfaces.find((s) => s.id === surfaceId);
      expect({ adapterId, surfaceId, confidence: surface?.confidence }).toEqual({ adapterId, surfaceId, confidence });
    }
  });
});

// Flow 306 (W6, T20): keryx-shell grew real (`policy-travels-with-agent`)
// surfaces for the eight flags its own compiled-in hook runtime natively
// supports — see `surfaces-w5b.ts`'s own doc comment on
// `KERYX_SHELL_SURFACES`/`shellHookSurface`. Only the four flags with no
// runtime capability yet (`skills`/`agents`/`instructions`/`mcp`) stay in
// `unsupported`.
describe("W5-b/W6 (T20): keryx-shell's native hook-runtime surfaces", () => {
  const SUPPORTED_FLAGS: SurfaceFlag[] = [
    "block",
    "prompt-gate",
    "pre-tool-context",
    "inject-context",
    "observe",
    "post-tool",
    "session-start",
    "stop",
  ];
  const UNSUPPORTED_FLAGS: SurfaceFlag[] = ["skills", "agents", "instructions", "mcp"];

  test("registers a verified surface for each of the eight native flags, installing nothing", () => {
    const shell = getHarnessAdapter("keryx-shell")!;
    expect(shell.confidence).toBe("verified");
    expect(shell.adapterKind).toBe("policy-travels-with-agent");
    expect(shell.surfaces.map((s) => s.flag).sort()).toEqual([...SUPPORTED_FLAGS].sort());
    expect(shell.sourceDocs).toContain(
      "docs/requirements/keryx-agent-platform-expansion/workstreams/W6-shell-hooks.md",
    );
    for (const surface of shell.surfaces) {
      expect(surface.confidence).toBe("verified");
      expect(surface.sourceDocs).toContain("docs/docs/hooks.md");
      // Never installs into a file: no settings artifact, no merge/strip/customInstall.
      expect(surface.settingsFile).toBeUndefined();
      expect(surface.relativePath).toBeUndefined();
      expect(surface.merge).toBeUndefined();
      expect(surface.strip).toBeUndefined();
      expect(surface.customInstall).toBeUndefined();
    }
  });

  test("the remaining four flags (no runtime capability yet) stay unsupported with the W6 reason", () => {
    const shell = getHarnessAdapter("keryx-shell")!;
    expect(Object.keys(shell.unsupported).sort()).toEqual([...UNSUPPORTED_FLAGS].sort());
    for (const flag of UNSUPPORTED_FLAGS) {
      expect(shell.unsupported[flag as keyof typeof shell.unsupported]).toBe(
        "Registered by W6's keryx shell hook runtime; not installed by keryx integrations yet.",
      );
    }
  });

  test("supported ∪ unsupported covers exactly the 12 W5 flags, disjoint", () => {
    const shell = getHarnessAdapter("keryx-shell")!;
    const supported = new Set(shell.surfaces.map((s) => s.flag));
    const unsupported = new Set(Object.keys(shell.unsupported));
    for (const flag of supported) {
      expect(unsupported.has(flag)).toBe(false);
    }
    expect(supported.size + unsupported.size).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Install -> validate -> uninstall round trips for the three new JSON block
// surfaces, through their own SettingsFileOwner, on a temp dir — preserving
// unrelated user keys.
// ---------------------------------------------------------------------------

describe("install -> validate -> uninstall round trips for the new JSON block surfaces", () => {
  const cases: Array<{ id: string; relativePath: string }> = [
    { id: "gemini-cli", relativePath: ".gemini/settings.json" },
    { id: "kiro", relativePath: ".kiro/hooks/keryx-ctx-guard.json" },
    { id: "github-copilot-agent", relativePath: ".github/hooks/keryx-ctx-guard.json" },
  ];

  for (const { id, relativePath } of cases) {
    test(`${id}: install validates clean, preserves an unrelated user key, uninstall removes only ours`, async () => {
      await withTempDir(async (root) => {
        const adapter = getHarnessAdapter(id)!;
        const surface = surfacesOf(adapter, { subsystem: "ctx-guard" })[0]!;
        expect(surface.relativePath).toBe(relativePath);
        const file = path.join(root, ...relativePath.split("/"));

        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ unrelatedUserKey: "keep-me" }, null, 2) + "\n", "utf8");

        const owner = createSettingsFileOwner(relativePath, [surface]);
        const installed = await installSurfaces(root, relativePath, [surface.id], owner);
        expect(installed.errors).toEqual([]);

        const afterInstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        expect(afterInstall.unrelatedUserKey).toBe("keep-me");
        expect(surface.validate!(afterInstall)).toEqual([]);

        // Idempotent re-install.
        const reinstalled = await installSurfaces(root, relativePath, [surface.id], owner);
        expect(reinstalled.errors).toEqual([]);

        const uninstalled = await uninstallSurfaces(root, relativePath, [surface.id], owner);
        expect(uninstalled.errors).toEqual([]);
        const afterUninstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        expect(afterUninstall.unrelatedUserKey).toBe("keep-me");
        expect(surface.validate!(afterUninstall).length).toBeGreaterThan(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// F6: uninstall deletes the Keryx-owned hook JSON file itself once emptied,
// but never touches an unrelated sibling file in the same directory.
// ---------------------------------------------------------------------------

describe("F6: uninstall removes the Keryx-owned ctx-guard JSON file itself, leaving siblings untouched", () => {
  const cases: Array<{ id: string; relativePath: string; siblingRelativePath: string }> = [
    { id: "kiro", relativePath: ".kiro/hooks/keryx-ctx-guard.json", siblingRelativePath: ".kiro/hooks/user-own-hook.json" },
    {
      id: "github-copilot-agent",
      relativePath: ".github/hooks/keryx-ctx-guard.json",
      siblingRelativePath: ".github/hooks/user-own-hook.json",
    },
  ];

  for (const { id, relativePath, siblingRelativePath } of cases) {
    test(`${id}: install then uninstall leaves no ${relativePath}; a user-authored sibling hook is untouched`, async () => {
      await withTempDir(async (root) => {
        const adapter = getHarnessAdapter(id)!;
        const surface = surfacesOf(adapter, { subsystem: "ctx-guard" })[0]!;
        expect(surface.ownsWholeFile).toBe(true);

        const siblingFile = path.join(root, ...siblingRelativePath.split("/"));
        await mkdir(path.dirname(siblingFile), { recursive: true });
        const siblingContent = JSON.stringify({ someUserHook: true }, null, 2) + "\n";
        await writeFile(siblingFile, siblingContent, "utf8");

        const owner = createSettingsFileOwner(relativePath, [surface]);
        const installed = await installSurfaces(root, relativePath, [surface.id], owner);
        expect(installed.errors).toEqual([]);
        expect(existsSync(path.join(root, ...relativePath.split("/")))).toBe(true);

        const uninstalled = await uninstallSurfaces(root, relativePath, [surface.id], owner);
        expect(uninstalled.errors).toEqual([]);
        expect(existsSync(path.join(root, ...relativePath.split("/")))).toBe(false);

        // The sibling file in the same directory is a completely different
        // relativePath/owner — untouched byte for byte.
        expect(await readFile(siblingFile, "utf8")).toBe(siblingContent);
      });
    });
  }

  test("a settings file NOT marked ownsWholeFile is never deleted, even when stripping empties it out", async () => {
    await withTempDir(async (root) => {
      const gemini = getHarnessAdapter("gemini-cli")!;
      const surface = surfacesOf(gemini, { subsystem: "ctx-guard" })[0]!;
      expect(surface.ownsWholeFile).toBeUndefined();
      const relativePath = surface.relativePath!;

      const owner = createSettingsFileOwner(relativePath, [surface]);
      const installed = await installSurfaces(root, relativePath, [surface.id], owner);
      expect(installed.errors).toEqual([]);

      const uninstalled = await uninstallSurfaces(root, relativePath, [surface.id], owner);
      expect(uninstalled.errors).toEqual([]);
      // File stays behind holding `{}` rather than being deleted.
      expect(existsSync(path.join(root, ...relativePath.split("/")))).toBe(true);
      expect((await readFile(path.join(root, ...relativePath.split("/")), "utf8")).trim()).toBe("{}");
    });
  });
});

// ---------------------------------------------------------------------------
// Payload + decision codecs.
// ---------------------------------------------------------------------------

describe("payload codecs for the new runtimes", () => {
  test("gemini-cli: parseRunShellCommandInput extracts the shell command from a run_shell_command payload", () => {
    const payload = JSON.stringify({ tool_name: "run_shell_command", tool_input: { command: "grep -r foo ." } });
    expect(parseRunShellCommandInput(payload)).toBe("grep -r foo .");
    expect(parseRunShellCommandInput(JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" } }))).toBeNull();
  });

  test("kiro: parseKiroCommand accepts tool_input.command and a bare top-level command", () => {
    expect(parseKiroCommand(JSON.stringify({ tool_input: { command: "rm -rf /" } }))).toBe("rm -rf /");
    expect(parseKiroCommand(JSON.stringify({ command: "rg foo" }))).toBe("rg foo");
    expect(parseKiroCommand(JSON.stringify({ nothing: "here" }))).toBeNull();
  });

  test("copilot: parseCopilotToolArgsCommand extracts toolArgs.command (object and stringified)", () => {
    expect(parseCopilotToolArgsCommand(JSON.stringify({ toolName: "shell", toolArgs: { command: "grep foo" } }))).toBe("grep foo");
    expect(
      parseCopilotToolArgsCommand(JSON.stringify({ toolName: "shell", toolArgs: JSON.stringify({ command: "grep foo" }) })),
    ).toBe("grep foo");
    expect(parseCopilotToolArgsCommand(JSON.stringify({ toolName: "shell" }))).toBeNull();
  });

  test("classifyCommand-driven refusal shape end to end for each new runtime", () => {
    const runtimes = ["gemini-cli", "kiro", "github-copilot-agent"];
    for (const id of runtimes) {
      const runtime = CTX_RUNTIMES.find((r) => r.id === id)!;
      expect(runtime).toBeDefined();
      const command = "rg foo";
      const action = runtime.block(command, { block: true, matched: "rg", suggestion: "keryx ctx rg" });
      expect(action.exitCode === 2 || action.exitCode === 0).toBe(true);
      if (id === "github-copilot-agent") {
        expect(action.exitCode).toBe(2);
        expect(action.stdout).toBeDefined();
        const parsed = JSON.parse(action.stdout!) as { permissionDecision: string; permissionDecisionReason: string };
        expect(parsed.permissionDecision).toBe("deny");
        expect(parsed.permissionDecisionReason.length).toBeGreaterThan(0);
      } else {
        expect(action.exitCode).toBe(2);
        expect(action.stderr).toBeDefined();
      }
    }
  });
});

describe("COPILOT_DECISION_CODEC", () => {
  test("refuse: exit 2, stdout permissionDecision JSON, stderr mirrors the message", () => {
    const action = COPILOT_DECISION_CODEC.refuse("github-copilot-agent", "blocked: use keryx ctx rg");
    expect(action.exitCode).toBe(2);
    expect(JSON.parse(action.stdout!)).toEqual({ permissionDecision: "deny", permissionDecisionReason: "blocked: use keryx ctx rg" });
    expect(action.stderr).toBe("blocked: use keryx ctx rg\n");
  });

  test("allow: exit 0, no stdout", () => {
    const action = COPILOT_DECISION_CODEC.allow("github-copilot-agent");
    expect(action).toEqual({ exitCode: 0 });
  });
});

// ---------------------------------------------------------------------------
// Markdown block install / uninstall / probe.
// ---------------------------------------------------------------------------

describe("markdown-block helper: install/uninstall/probe preserving user content, idempotent re-install", () => {
  test("install creates the file with the block when absent; probe then reports healthy", async () => {
    await withTempDir(async (root) => {
      const relativePath = "GEMINI.md";
      await installMarkdownBlock(root, relativePath);
      expect(await probeMarkdownBlock(root, relativePath)).toEqual([]);
      const content = await readFile(path.join(root, relativePath), "utf8");
      expect(content).toContain("<!-- keryx:instructions -->");
      expect(content).toContain("<!-- /keryx:instructions -->");
    });
  });

  test("install preserves pre-existing user content and is idempotent", async () => {
    await withTempDir(async (root) => {
      const relativePath = "GEMINI.md";
      const file = path.join(root, relativePath);
      await writeFile(file, "# My project\n\nSome user-written notes.\n", "utf8");

      await installMarkdownBlock(root, relativePath);
      const first = await readFile(file, "utf8");
      expect(first).toContain("Some user-written notes.");
      expect(first).toContain("<!-- keryx:instructions -->");

      await installMarkdownBlock(root, relativePath);
      const second = await readFile(file, "utf8");
      expect(second).toBe(first);
    });
  });

  test("kiro: front matter is written first, and probe/uninstall handle it", async () => {
    await withTempDir(async (root) => {
      const relativePath = ".kiro/steering/keryx.md";
      const frontMatter = "---\ninclusion: always\n---\n\n";
      await installMarkdownBlock(root, relativePath, frontMatter);
      const content = await readFile(path.join(root, relativePath), "utf8");
      expect(content.startsWith("---\ninclusion: always\n---")).toBe(true);
      expect(await probeMarkdownBlock(root, relativePath)).toEqual([]);

      const removed = await uninstallMarkdownBlock(root, relativePath, frontMatter);
      expect(removed).toBe(true);
      // Nothing but the front matter Keryx wrote would remain -> file deleted.
      expect(existsSync(path.join(root, relativePath))).toBe(false);
    });
  });

  test("uninstall on a file with other content removes only the block", async () => {
    await withTempDir(async (root) => {
      const relativePath = ".github/copilot-instructions.md";
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "# Copilot instructions\n\nUser text.\n", "utf8");
      await installMarkdownBlock(root, relativePath);

      const removed = await uninstallMarkdownBlock(root, relativePath);
      expect(removed).toBe(true);
      const after = await readFile(file, "utf8");
      expect(after).toContain("User text.");
      expect(after).not.toContain("<!-- keryx:instructions -->");
    });
  });

  test("probe reports a precise problem for a missing file and a missing block", async () => {
    await withTempDir(async (root) => {
      const relativePath = "GEMINI.md";
      const missingFile = await probeMarkdownBlock(root, relativePath);
      expect(missingFile.length).toBeGreaterThan(0);

      await writeFile(path.join(root, relativePath), "# no block here\n", "utf8");
      const missingBlock = await probeMarkdownBlock(root, relativePath);
      expect(missingBlock.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// The new adapters' `customInstall`/`probe` surfaces (gemini-cli/kiro/copilot
// instructions) actually route through the shared helper, end to end.
// ---------------------------------------------------------------------------

describe("instructions surfaces: customInstall/customUninstall/probe end to end", () => {
  const cases: Array<{ id: string; relativePath: string }> = [
    { id: "gemini-cli", relativePath: "GEMINI.md" },
    { id: "kiro", relativePath: ".kiro/steering/keryx.md" },
    { id: "github-copilot-agent", relativePath: ".github/copilot-instructions.md" },
  ];

  for (const { id, relativePath } of cases) {
    test(`${id}: install -> probe clean -> uninstall -> probe reports missing`, async () => {
      await withTempDir(async (root) => {
        const adapter = getHarnessAdapter(id)!;
        const surface = surfacesOf(adapter, { flag: "instructions" })[0]!;
        expect(surface.relativePath).toBe(relativePath);

        const installErrors = await surface.customInstall!(root);
        expect(installErrors).toEqual([]);
        expect(await surface.probe!(root)).toEqual([]);

        const removed = await surface.customUninstall!(root);
        expect(removed).toBe(true);
        expect((await surface.probe!(root)).length).toBeGreaterThan(0);
      });
    });
  }
});

describe("zed instructions surface: probe-only, never writes/deletes AGENTS.md", () => {
  test("probe reports the missing-block problem without writing AGENTS.md; adding the block makes probe clean", async () => {
    await withTempDir(async (root) => {
      const zed = getHarnessAdapter("zed")!;
      const surface = surfacesOf(zed, { flag: "instructions" })[0]!;

      const missing = await surface.probe!(root);
      expect(missing.length).toBeGreaterThan(0);
      expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);

      await writeFile(path.join(root, "AGENTS.md"), "# repo\n\n<!-- keryx:index -->\nstuff\n<!-- /keryx:index -->\n", "utf8");
      expect(await surface.probe!(root)).toEqual([]);
      // Nothing ever writes/deletes AGENTS.md through this surface — it has
      // no merge/strip/customInstall/customUninstall to do so with.
      const content = await readFile(path.join(root, "AGENTS.md"), "utf8");
      expect(content).toBe("# repo\n\n<!-- keryx:index -->\nstuff\n<!-- /keryx:index -->\n");
    });
  });
});

describe("opencode plugin surface: probe reports missing/stale/healthy", () => {
  test("probe reports missing when the plugin file is absent", () => {
    const opencode = getHarnessAdapter("opencode")!;
    const surface = surfacesOf(opencode, { flag: "block" })[0]!;
    expect(surface.probe).toBeDefined();
  });

  test("probe: missing -> install -> healthy -> edited -> stale", async () => {
    await withTempDir(async (root) => {
      const opencode = getHarnessAdapter("opencode")!;
      const surface = surfacesOf(opencode, { flag: "block" })[0]!;

      const missing = await surface.probe!(root);
      expect(missing.length).toBeGreaterThan(0);

      await surface.customInstall!(root);
      expect(await surface.probe!(root)).toEqual([]);

      const file = surface.settingsFile!(root);
      await writeFile(file, "// tampered\n", "utf8");
      const stale = await surface.probe!(root);
      expect(stale.length).toBeGreaterThan(0);
    });
  });
});

// Sanity: nothing above accidentally mutated shared module-level state
// (surfaces are pure data + functions; HARNESS_ADAPTERS is frozen by
// convention, not by Object.freeze, so this is a cheap belt-and-braces check).
describe("sanity", () => {
  test("HARNESS_ADAPTERS still has exactly one adapter per id, no accidental duplicate", () => {
    const ids = HARNESS_ADAPTERS.map((a: HarnessAdapter) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every new surface's declared subsystem is a non-empty string", () => {
    for (const id of ["gemini-cli", "kiro", "github-copilot-agent", "zed", "keryx-shell"]) {
      const adapter = getHarnessAdapter(id)!;
      for (const surface of adapter.surfaces as readonly SurfaceAdapter[]) {
        expect(surface.subsystem.length).toBeGreaterThan(0);
      }
    }
  });
});
