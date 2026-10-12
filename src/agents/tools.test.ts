// Guard test: every entry in AGENT_TOOL_VOCABULARY is a real tool name —
// `name: "<x>"` defined in one of the builtin tool source files under
// src/harness/tool/builtin/ — checked against the SOURCE TEXT rather than
// trusted by inspection, so a future rename of a builtin tool breaks this
// test instead of silently stranding the agent vocabulary on a name that no
// longer exists.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  AGENT_TOOL_VOCABULARY,
  HOSTS_WITH_NESTED_SPAWN,
  ORCHESTRATOR_AGENT_NAMES,
  SPAWN_TOOL,
  isAgentToolName,
  isOrchestratorAgent,
  mapToolsForTarget,
  orchestratorToolProblems,
} from "./tools";

const BUILTIN_DIR = path.join(import.meta.dir, "..", "harness", "tool", "builtin");

const SOURCE_FILES = [
  "interactive-tools.ts",
  "metaproject-tools.ts",
  "apply-patch-tool.ts",
  "shell-exec-tool.ts",
  "web-fetch-tool.ts",
  "web-search-tool.ts",
  "spawn-subagent-tool.ts",
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

  test("codex has no per-tool allowlist — every tool drops from the map (sandbox_mode governs instead, see compile.ts)", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget(["read_file", "shell_exec"], "codex");
    expect(mappedTools).toEqual([]);
    expect(droppedTools).toEqual(["read_file", "shell_exec"]);
  });

  test("kiro maps every vocabulary entry onto its four coarse tags — nothing drops", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget(
      ["read_file", "list_dir", "get_cwd", "search_code", "graph_affected", "memory_search", "apply_patch", "shell_exec", "web_fetch", "web_search"],
      "kiro",
    );
    expect([...mappedTools].sort()).toEqual(["read", "shell", "web", "write"]);
    expect(droppedTools).toEqual([]);
  });

  test("opencode now maps web_search onto websearch (T7 docs check correction)", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget(["web_search"], "opencode");
    expect(mappedTools).toEqual(["websearch"]);
    expect(droppedTools).toEqual([]);
  });

  test("an empty tools[] maps to no tools and no drops", () => {
    const { mappedTools, droppedTools } = mapToolsForTarget([], "claude");
    expect(mappedTools).toEqual([]);
    expect(droppedTools).toEqual([]);
  });
});

describe("spawn tool in the agent vocabulary (flow 417 AC4)", () => {
  test("the vocabulary can express the spawn tool, and it is the real tool name", () => {
    expect(SPAWN_TOOL).toBe("spawn_subagent");
    expect(isAgentToolName(SPAWN_TOOL)).toBe(true);
  });

  test("hosts have no spawn analogue to map onto: it is reported dropped, never silently lost", () => {
    for (const host of ["claude", "opencode", "codex", "kiro"] as const) {
      const { mappedTools, droppedTools } = mapToolsForTarget([SPAWN_TOOL], host);
      expect(mappedTools).toEqual([]);
      expect(droppedTools).toEqual([SPAWN_TOOL]);
    }
  });

  test("an orchestrator that keeps spawn_subagent in tools passes on the harness", () => {
    expect(orchestratorToolProblems({ name: "review-orchestrator", tools: ["read_file", SPAWN_TOOL] })).toEqual([]);
  });

  test("an orchestrating agent file that lacks spawn_subagent fails", () => {
    const problems = orchestratorToolProblems({ name: "review-orchestrator", tools: ["read_file", "search_code"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("review-orchestrator");
    expect(problems[0]).toContain(SPAWN_TOOL);
  });

  test("an agent naming spawn_subagent where the host has no nested spawn fails", () => {
    for (const host of ["claude", "opencode", "codex", "kiro"] as const) {
      expect(HOSTS_WITH_NESTED_SPAWN.includes(host)).toBe(false);
      const problems = orchestratorToolProblems({ name: "review-orchestrator", tools: [SPAWN_TOOL] }, host);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(host);
    }
  });

  test("a plain agent with no spawn tool is clean on every host", () => {
    for (const host of ["keryx-shell", "claude", "opencode", "codex", "kiro"] as const) {
      expect(orchestratorToolProblems({ name: "codebase-navigator", tools: ["read_file"] }, host)).toEqual([]);
    }
  });

  test("orchestrators are declared by name", () => {
    expect([...ORCHESTRATOR_AGENT_NAMES]).toEqual(["review-orchestrator", "flow-orchestrator", "job-orchestrator"]);
    expect(isOrchestratorAgent("job-orchestrator")).toBe(true);
    expect(isOrchestratorAgent("codebase-navigator")).toBe(false);
  });

  test("every bundled agent file passes the orchestrator check", () => {
    const dir = path.join(import.meta.dir, "..", "gdskills", "bundled", "agents");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(path.join(dir, file), "utf8");
      const name = /^name:\s*"?([\w-]+)"?\s*$/m.exec(text)?.[1] ?? file.replace(/\.md$/, "");
      const toolsBlock = /^tools:\s*\n((?:\s+-\s+.*\n)+)/m.exec(text)?.[1] ?? "";
      const tools = [...toolsBlock.matchAll(/-\s+"?([\w]+)"?/g)].map((m) => m[1] as string);
      expect(orchestratorToolProblems({ name, tools })).toEqual([]);
    }
  });
});
