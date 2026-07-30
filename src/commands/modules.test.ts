// `keryx modules --json` (flow 087, item 2).
//
// The payload exists so an agent can read module state without parsing a
// human-formatted table. That is only worth anything if it is stable: a
// consumer diffing two runs must see a change only when the state changed, not
// when authoring order in `MODULES` moved.

import { describe, expect, test } from "bun:test";
import { emitModulesJson } from "./modules";

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

  test("is byte-identical across two runs with the same state", () => {
    const enabled = new Set(["gdgraph", "tasks"]);
    expect(emitModulesJson(enabled)).toBe(emitModulesJson(new Set(["tasks", "gdgraph"])));
  });

  test("sorts modules by name so the payload is diffable", () => {
    const names = parse(new Set()).modules.map((module) => module.name);
    expect(names).toEqual([...names].sort());
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
