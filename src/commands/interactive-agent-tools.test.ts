import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { buildInteractiveAgentTools, interactiveAgentToolNames } from "./interactive-agent-tools";

const stubSpawn: InteractiveTool = {
  definition: {
    name: "spawn_subagent",
    description: "stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  invoke: async () => ({ output: "ok", isError: false }),
};

test("TUI and readline share one factory that includes web_fetch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
  });
  const names = interactiveAgentToolNames(tools);
  expect(names).toEqual([
    "ask_user",
    "flow_status",
    "get_cwd",
    "graph_affected",
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
    "slate_read",
    "slate_write_seed",
    "spawn_subagent",
    "test_related",
    "web_fetch",
    "web_search",
    "wiki_ask",
    "wiki_backlinks",
    "workspace_create",
    "workspace_list",
    "workspace_overview",
    "workspace_propose",
    "workspace_read",
    "workspace_show",
  ]);
});

// --- SLATE-3a: slate_read / slate_write_seed wiring (flow 161, AC5) ------
//
// `buildInteractiveAgentTools` is THE single factory both `shell.ts` and
// `tui-shell.ts` call — this is the one place a new tool reaches BOTH
// surfaces at once. `getSessionDir` is a NEW optional field on
// `InteractiveAgentToolsInput`: when a caller omits it (a real call site
// that predates session-dir threading, or a test that does not care about
// slate content), the two new tools must still be REGISTERED — never
// silently dropped from the tool list — but every invocation reports "no
// active session" rather than crashing or reading a wrong/undefined dir.

test("slate_read and slate_write_seed are registered even when getSessionDir is omitted, and invoking them reports no active session (isError), never throws", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-no-session-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    // getSessionDir intentionally omitted.
  });

  const slateRead = tools.find((tool) => tool.definition.name === "slate_read");
  const slateWriteSeed = tools.find((tool) => tool.definition.name === "slate_write_seed");
  expect(slateRead).toBeDefined();
  expect(slateWriteSeed).toBeDefined();

  const readResult = await slateRead?.invoke({});
  expect(readResult?.isError).toBe(true);

  const writeResult = await slateWriteSeed?.invoke({ text: "an observation" });
  expect(writeResult?.isError).toBe(true);
});

test("slate_read and slate_write_seed resolve a REAL session dir when getSessionDir is supplied", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-with-session-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "keryx-tools-session-dir-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    getSessionDir: () => sessionDir,
  });

  const slateRead = tools.find((tool) => tool.definition.name === "slate_read");
  expect(slateRead).toBeDefined();
  // No slate.json exists in sessionDir yet — slate_read still must not throw,
  // and (per its own contract) must not report "no active session" now that
  // a real session dir IS available; readSlate resolving to `undefined` is
  // its own, separately-handled case, not a getSessionDir failure.
  const result = await slateRead?.invoke({});
  expect(result?.isError).toBe(false);
});
