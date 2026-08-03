// `keryx modules --json` (flow 087, item 2).
//
// The payload exists so an agent can read module state without parsing a
// human-formatted table. That is only worth anything if it is stable: a
// consumer diffing two runs must see a change only when the state changed, not
// when authoring order in `MODULES` moved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInitFlags, emitModulesJson, modulesForTest, modulesCommand } from "./modules";

type ModulesPayload = {
  schemaVersion: number;
  modules: Array<{ name: string; enabled: boolean; description: string }>;
};

function parse(enabled: Set<string>): ModulesPayload {
  return JSON.parse(emitModulesJson(enabled)) as ModulesPayload;
}

describe("keryx modules --json", () => {
  test("emits valid JSON with a schema version", () => {
    const payload = parse(new Set(["gdgraph"]));
    expect(payload.schemaVersion).toBe(1);
    expect(Array.isArray(payload.modules)).toBe(true);
  });

  test("describes every module, not only the enabled ones", () => {
    const payload = parse(new Set(["gdgraph"]));
    const names = payload.modules.map((module) => module.name);
    expect(names).toContain("gdgraph");
    expect(names).toContain("gdctx");
    expect(names).toContain("gdwiki");
    expect(names).toContain("gdskills");
    expect(names).toContain("health");
    expect(names).toContain("testing");
    expect(names).toContain("memory");
    expect(names).toContain("tasks");
  });

  test("reports enablement per module", () => {
    const payload = parse(new Set(["gdgraph", "memory"]));
    const byName = new Map(payload.modules.map((module) => [module.name, module.enabled]));
    expect(byName.get("gdgraph")).toBe(true);
    expect(byName.get("memory")).toBe(true);
    expect(byName.get("health")).toBe(false);
  });

  test("sorts modules by name so the payload is diffable", () => {
    // This is the assertion that carries the byte-stability guarantee: MODULES
    // is authored in a non-alphabetical order, so deleting the sort makes this
    // fail. Comparing two calls of a pure function would not — it passes with
    // or without the sort, and would have read as proof while proving nothing.
    const names = parse(new Set()).modules.map((module) => module.name);
    expect(names).toEqual([...names].sort());
    expect(names).not.toEqual([]);
  });

  test("an empty enabled set still describes every module", () => {
    const payload = parse(new Set());
    expect(payload.modules.length).toBeGreaterThan(0);
    expect(payload.modules.every((module) => module.enabled === false)).toBe(true);
  });

  test("carries a description for each module", () => {
    for (const module of parse(new Set()).modules) {
      expect(module.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("modulesCommand --json wiring", () => {
  let root = "";
  let cwd = "";
  let logged: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-modules-"));
    cwd = process.cwd();
    process.chdir(root);
    logged = [];
    originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    // Assigning `undefined` does NOT clear it in Bun: the process still exits
    // non-zero, so a green suite reports failure. `modulesCommand` sets the
    // real `process.exitCode`, so the test must reset it to 0 explicitly.
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    process.chdir(cwd);
    // Assigning `undefined` does NOT clear it in Bun: the process still exits
    // non-zero, so a green suite reports failure. `modulesCommand` sets the
    // real `process.exitCode`, so the test must reset it to 0 explicitly.
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  async function writeManifest(enabled: string[]): Promise<void> {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const modules = Object.fromEntries(enabled.map((name) => [name, { enabled: true }]));
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules }), "utf8");
  }

  test("emits a structured error, not prose, on an uninitialized workspace", async () => {
    await modulesCommand(["--json"]);
    // A harness invoking the descriptor's advertised --json contract must get
    // JSON even for the failure; prose reaches it as a parse error.
    const payload = JSON.parse(logged.join("\n")) as { error?: string };
    expect(payload.error).toBe("not-initialized");
    expect(process.exitCode).toBe(1);
  });

  test("status --json emits module state", async () => {
    await writeManifest(["gdgraph"]);
    await modulesCommand(["status", "--json"]);
    const payload = JSON.parse(logged.join("\n")) as { modules: Array<{ name: string; enabled: boolean }> };
    const byName = new Map(payload.modules.map((module) => [module.name, module.enabled]));
    expect(byName.get("gdgraph")).toBe(true);
    expect(byName.get("memory")).toBe(false);
  });

  test("--json never stands in for a mutating subcommand", async () => {
    await writeManifest(["gdgraph"]);
    // The first version took the JSON branch before dispatch, so this printed
    // the UNCHANGED state and exited 0 — indistinguishable from a successful
    // enable. Whatever it does now, it must not silently report success.
    await modulesCommand(["enable", "memory", "--json"]);
    const printedOnlyState = logged.length === 1 && logged[0]!.trimStart().startsWith("{");
    expect(printedOnlyState).toBe(false);
  });

  test("--json does not swallow the unknown-subcommand error", async () => {
    await writeManifest(["gdgraph"]);
    await modulesCommand(["bogus", "--json"]);
    expect(process.exitCode).toBe(1);
  });
});

// D1. `keryx modules` knew 8 of the 10 modules, and a toggle re-invokes `init`
// with flags derived from that list — so the two it did not know were decided by
// the absence of a flag rather than by the operator.
//
// The two absences behaved differently, which is why one number could not
// describe both. `security` is default-ON: no `--no-security` meant it survived,
// but it could never be turned off through this command and never appeared in
// `status`. `mcp` is default-OFF: `init` adds its manifest entry ONLY when
// `--mcp` is passed (`init.ts:595`), so a project with MCP enabled lost it on
// any unrelated toggle. Silent manifest loss, from switching some other module.
//
// The fix writes the domain down: every module declares whether `init` scaffolds
// it by default, and a default-off module carries the enable flag that must be
// re-sent to preserve it.
describe("D1 — modules must know every module, in both directions", () => {
  test("the module list covers every module the manifest can hold", () => {
    const names = new Set(modulesForTest().map((m) => m.name));
    for (const expected of [
      "gdgraph",
      "gdctx",
      "gdwiki",
      "gdskills",
      "health",
      "testing",
      "memory",
      "tasks",
      "security",
      "mcp",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("a default-OFF module that is enabled re-sends its enable flag", () => {
    // The regression. Toggling anything at all used to drop `mcp` here.
    const flags = buildInitFlags(new Set(["gdgraph", "mcp"]), "recommended");
    expect(flags).toContain("--mcp");
  });

  test("a default-OFF module that is disabled is not re-enabled", () => {
    const flags = buildInitFlags(new Set(["gdgraph"]), "recommended");
    expect(flags).not.toContain("--mcp");
  });

  test("a default-ON module that is disabled sends its --no- flag", () => {
    const flags = buildInitFlags(new Set(["gdgraph"]), "recommended");
    expect(flags).toContain("--no-security");
    expect(flags).toContain("--no-memory");
  });

  test("a default-ON module that is enabled sends no flag for itself", () => {
    const flags = buildInitFlags(new Set(["security"]), "recommended");
    expect(flags).not.toContain("--no-security");
  });
});
