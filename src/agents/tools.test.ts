// Guard test: every entry in AGENT_TOOL_VOCABULARY is a real tool name —
// `name: "<x>"` defined in one of the builtin tool source files under
// src/harness/tool/builtin/ — checked against the SOURCE TEXT rather than
// trusted by inspection, so a future rename of a builtin tool breaks this
// test instead of silently stranding the agent vocabulary on a name that no
// longer exists.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_VOCABULARY, isAgentToolName, mapToolsForTarget } from "./tools";

const BUILTIN_DIR = path.join(import.meta.dir, "..", "harness", "tool", "builtin");

const SOURCE_FILES = [
  "interactive-tools.ts",
  "metaproject-tools.ts",
  "apply-patch-tool.ts",
  "shell-exec-tool.ts",
  "web-fetch-tool.ts",
  "web-search-tool.ts",
];

function realBuiltinToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of SOURCE_FILES) {
    const text = readFileSync(path.join(BUILTIN_DIR, file), "utf8");
    for (const match of text.matchAll(/name:\s*"([a-z_]+)"/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

describe("AGENT_TOOL_VOCABULARY", () => {
  test("every vocabulary entry is a real builtin tool name", () => {
    const real = realBuiltinToolNames();
    for (const tool of AGENT_TOOL_VOCABULARY) {
      expect(real.has(tool)).toBe(true);
    }
  });

  test("isAgentToolName agrees with the vocabulary list", () => {
    for (const tool of AGENT_TOOL_VOCABULARY) {
      expect(isAgentToolName(tool)).toBe(true);
    }
    expect(isAgentToolName("not_a_real_tool")).toBe(false);
  });
});

describe("mapToolsForTarget", () => {
  test("claude maps known tools and drops unmapped/unknown ones, honestly", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget(
      ["read_file", "search_code", "get_cwd", "not_a_real_tool"],
      "claude",
    );
    expect([...mappedTools].sort()).toEqual(["Grep", "Read"].sort());
    expect([...droppedTools].sort()).toEqual(["get_cwd", "not_a_real_tool"].sort());
  });

  test("codex and kiro drop everything (no verified mapping yet) without throwing", () => {
    for (const target of ["codex", "kiro"] as const) {
      const { mappedTools, droppedTools } = mapToolsForTarget(["read_file", "shell_exec"], target);
      expect(mappedTools).toEqual([]);
      expect(droppedTools).toEqual(["read_file", "shell_exec"]);
    }
  });

  test("an empty tools[] maps to no tools and no drops", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget([], "claude");
    expect(mappedTools).toEqual([]);
    expect(droppedTools).toEqual([]);
  });
});
