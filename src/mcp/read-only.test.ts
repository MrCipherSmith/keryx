// `keryx serve-mcp --read-only` (flow 292, AC6).
//
// keryx hands this server to a FOREIGN agent it drives over ACP. That agent's
// MCP calls go straight here and never pass keryx's permission bridge, so the
// read-only server must not list — or dispatch — any tool that changes state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMcpContext, dispatchCallTool, dispatchListTools, registryFor } from "./dispatch";
import { buildToolRegistry } from "./tools";

let project = "";

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "keryx-mcp-ro-"));
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  const modules = Object.fromEntries(
    ["mcp", "gdgraph", "security", "tasks", "memory", "health", "gdwiki"].map((name) => [name, { enabled: true }]),
  );
  writeFileSync(path.join(project, ".metaproject", "metaproject.json"), JSON.stringify({ modules }));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("serve-mcp --read-only", () => {
  test("the full registry does carry mutating tools — the filter below is not vacuous", () => {
    expect(buildToolRegistry().filter((tool) => tool.mutating).length).toBeGreaterThan(0);
  });

  test("the read-only registry holds no tool marked mutating, and every read-only tool survives", () => {
    const readOnly = registryFor({ readOnly: true });
    expect(readOnly.some((tool) => tool.mutating)).toBe(false);
    expect(readOnly.map((tool) => tool.name)).toEqual(
      buildToolRegistry()
        .filter((tool) => !tool.mutating)
        .map((tool) => tool.name),
    );
  });

  test("tools/list on a read-only server names no mutating tool; the default server still does", async () => {
    const mutating = new Set(buildToolRegistry().filter((tool) => tool.mutating).map((tool) => tool.name));
    const readOnly = dispatchListTools(await buildMcpContext(project, "stdio", { readOnly: true }));
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.filter((tool) => mutating.has(tool.name))).toEqual([]);
    const full = dispatchListTools(await buildMcpContext(project, "stdio"));
    expect(full.some((tool) => mutating.has(tool.name))).toBe(true);
  });

  test("a mutating tool called by name on a read-only server is unknown, not run", async () => {
    const name = buildToolRegistry().find((tool) => tool.mutating)?.name ?? "";
    const result = await dispatchCallTool(await buildMcpContext(project, "stdio", { readOnly: true }), name, {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Unknown or unavailable tool.");
  });
});
