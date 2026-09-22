// The ACP session roster against `keryx shell`'s (flow 288, AC1–AC3).
//
// AC1: the project tools an ACP session offers are the ones `keryx shell`
//      offers in the same project — same gate, same definitions — in a project
//      that has a usable metaproject and in one that does not.
// AC2: every roster tool renders with a real ACP `kind`, not `other`.
// AC3: the roster is pinned. No tool whose results are untrusted, no
//      delegation, no bus — so widening it is a visible edit to this file.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusClient } from "../bus/client";
import { buildInteractiveAgentTools } from "../commands/interactive-agent-tools";
import { createDefaultSearchProviderController } from "../harness/search";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import { ACP_TOOL_KIND_OTHER_EXCEPTIONS, toolKindFor } from "./agent-io";
import { ACP_CLIENT_MCP_TOOL_NAMES, buildAcpSessionTools } from "./roster";

const stubSpawn: InteractiveTool = {
  definition: {
    name: "spawn_subagent",
    description: "stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  invoke: async () => ({ output: "ok", isError: false }),
};

/** Stand-ins for the client-MCP pair flow 287 adds when a client sends MCP servers. */
function stubClientMcpTools(): InteractiveTool[] {
  return [...ACP_CLIENT_MCP_TOOL_NAMES].map((name) => ({
    definition: {
      name,
      description: "stub",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: name === "use_tool" ? "destructive" : "read",
    },
    invoke: async () => ({ output: "ok", isError: false }),
  }));
}

/** Every project tool name, from the operation table itself — not from either roster under test. */
const PROJECT_TOOL_NAMES = new Set(METAPROJECT_OPERATIONS.map((op) => op.name));

async function projectWithMetaproject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-acp-roster-meta-"));
  await mkdir(join(dir, ".metaproject"));
  await writeFile(join(dir, ".metaproject", "metaproject.json"), "{}", "utf8");
  return dir;
}

async function bareProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keryx-acp-roster-bare-"));
}

function shellRoster(cwd: string): InteractiveTool[] {
  return buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    // The widest shell roster: a joined bus too, so AC3's exclusions are
    // exclusions of tools the shell really has.
    bus: { client: () => ({}) as BusClient },
  });
}

function acpRoster(cwd: string, clientMcpTools: InteractiveTool[] = []): InteractiveTool[] {
  return buildAcpSessionTools({
    root: cwd,
    clientCapabilities: undefined,
    readViaClient: async () => undefined,
    clientMcpTools,
  });
}

const projectOnly = (tools: readonly InteractiveTool[]): InteractiveTool[] =>
  tools.filter((tool) => PROJECT_TOOL_NAMES.has(tool.definition.name));

describe("AC1 — ACP offers the shell's project tools, by the same gate and definitions", () => {
  for (const [label, make] of [
    ["a project with a usable metaproject", projectWithMetaproject],
    ["a project without one", bareProject],
  ] as const) {
    test(`${label}: the two rosters carry the same project tools, with identical definitions`, async () => {
      const cwd = await make();
      const shell = projectOnly(shellRoster(cwd));
      const acp = projectOnly(acpRoster(cwd));
      const byName = (tools: InteractiveTool[]) =>
        Object.fromEntries(tools.map((tool) => [tool.definition.name, tool.definition]));
      expect(acp.map((tool) => tool.definition.name).sort()).toEqual(shell.map((tool) => tool.definition.name).sort());
      expect(byName(acp)).toEqual(byName(shell));
    });
  }

  test("the gate decides: every project tool with a metaproject, only search_code without", async () => {
    const withMeta = projectOnly(acpRoster(await projectWithMetaproject())).map((tool) => tool.definition.name);
    const without = projectOnly(acpRoster(await bareProject())).map((tool) => tool.definition.name);
    expect(withMeta.sort()).toEqual([...PROJECT_TOOL_NAMES].sort());
    // `search_code` follows the shell's exception (`METAPROJECT_FREE_TOOLS`).
    expect(without).toEqual(["search_code"]);
  });
});

describe("AC2 — every roster tool has a meaningful ACP kind", () => {
  test("no tool in either project state, client MCP pair included, falls back to `other`", async () => {
    for (const cwd of [await projectWithMetaproject(), await bareProject()]) {
      const unmapped = acpRoster(cwd, stubClientMcpTools())
        .map((tool) => tool.definition.name)
        .filter((name) => toolKindFor(name) === "other" && !ACP_TOOL_KIND_OTHER_EXCEPTIONS.has(name));
      expect(unmapped).toEqual([]);
    }
  });

  test("search tools render as search, read tools as read", () => {
    expect(toolKindFor("search_code")).toBe("search");
    expect(toolKindFor("graph_find")).toBe("search");
    expect(toolKindFor("memory_search")).toBe("search");
    expect(toolKindFor("read_wiki")).toBe("read");
    expect(toolKindFor("flow_status")).toBe("read");
    expect(toolKindFor("shell_exec")).toBe("execute");
    expect(toolKindFor("apply_patch")).toBe("edit");
  });
});

describe("AC3 — the roster is pinned", () => {
  /**
   * keryx's OWN roster, in a project with a metaproject — a LITERAL list, not
   * derived from `METAPROJECT_OPERATIONS` (T14): a new metaproject operation
   * would otherwise join the ACP roster silently. Adding a tool to ACP means
   * editing this list, and deciding here that it is safe over this wire.
   *
   * Why a list rather than a property check: "untrusted" is a property of a
   * tool's RESULT (`InteractiveToolResult.untrusted`), set per call by
   * `web_fetch` and the MCP bridge; no tool DEFINITION or registry entry
   * declares it, so there is nothing static to assert against. The check
   * below pins what can be pinned: every read-risk tool here is a known
   * read-only builtin or metaproject operation, and the two others are the
   * gated `shell_exec`/`apply_patch`.
   */
  const PINNED = [
    "apply_patch",
    "flow_status",
    "get_cwd",
    "graph_affected",
    "graph_find",
    "graph_path",
    "graph_query",
    "graph_symbol",
    "health_status",
    "list_dir",
    "memory_search",
    "read_file",
    "read_wiki",
    "repomap",
    "search_code",
    "shell_exec",
    "skill_load",
    "skills_catalog",
    "test_related",
    "wiki_ask",
    "wiki_backlinks",
    "wiki_evidence",
    "wiki_freshness",
    "wiki_resolve",
  ];

  test("every pinned tool is a known read-only builtin or metaproject operation, or one of the two gated tools", async () => {
    const cwd = await projectWithMetaproject();
    const readOnly = new Set([
      ...builtinReadOnlyTools(cwd).map((tool) => tool.definition.name),
      ...METAPROJECT_OPERATIONS.filter((op) => op.risk === "read").map((op) => op.name),
    ]);
    const gated: Record<string, string> = { shell_exec: "shell", apply_patch: "write" };
    for (const tool of acpRoster(cwd)) {
      const name = tool.definition.name;
      if (name in gated) {
        expect({ name, risk: tool.definition.risk }).toEqual({ name, risk: gated[name] });
      } else {
        expect({ name, known: readOnly.has(name), risk: tool.definition.risk }).toEqual({ name, known: true, risk: "read" });
      }
    }
  });

  test("keryx's own roster is exactly the pinned set", async () => {
    expect(acpRoster(await projectWithMetaproject()).map((tool) => tool.definition.name).sort()).toEqual(PINNED);
  });

  test("no untrusted-result, delegation or bus tool — all of which the shell has", async () => {
    const cwd = await projectWithMetaproject();
    const shell = shellRoster(cwd).map((tool) => tool.definition.name);
    const acp = acpRoster(cwd).map((tool) => tool.definition.name);
    // Results marked `untrusted: true`: the web pair. Delegation: spawn_subagent.
    // Bus: bus_*. Each is in the shell roster, so its absence here is a choice.
    const excluded = ["web_fetch", "web_search", "spawn_subagent", ...shell.filter((name) => name.startsWith("bus_"))];
    expect(excluded.filter((name) => !shell.includes(name))).toEqual([]);
    expect(shell.some((name) => name.startsWith("bus_"))).toBe(true);
    expect(acp.filter((name) => excluded.includes(name) || name.startsWith("bus_"))).toEqual([]);
    // keryx's own MCP pair is not in the roster either: `search_tool`/`use_tool`
    // appear only as the client's.
    expect(acp.filter((name) => ACP_CLIENT_MCP_TOOL_NAMES.has(name))).toEqual([]);
  });

  test("the one exception: the CLIENT's MCP pair, and only when the client sent servers", async () => {
    // Flow 287 put these here on purpose: they front the client's own servers,
    // and every `use_tool` call is asked through session/request_permission.
    // Their results are untrusted, so this is the documented exception to AC3,
    // not a gap in it.
    const cwd = await projectWithMetaproject();
    const names = acpRoster(cwd, stubClientMcpTools()).map((tool) => tool.definition.name);
    expect(names.filter((name) => !PINNED.includes(name)).sort()).toEqual([...ACP_CLIENT_MCP_TOOL_NAMES].sort());
  });
});
