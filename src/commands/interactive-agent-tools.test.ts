import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import { buildInteractiveAgentTools, interactiveAgentToolNames } from "./interactive-agent-tools";

/**
 * A minimal, fully injectable fake `JobRegistry` — no real subprocess, no
 * real registry construction. Used only to prove the tool-list SHAPE when a
 * registry IS supplied; its own behavior is covered by
 * `background-job-registry.test.ts`.
 */
function stubJobRegistry(): JobRegistry {
  return {
    start: async () => ({ ok: true, jobId: "job-stub-1", pid: 1, output: "" }),
    get: () => undefined,
    list: () => [],
    readOutput: () => ({ ok: false, error: "unknown job_id" }),
    kill: async () => ({ ok: false, error: "unknown job_id" }),
    sweepAll: async () => {},
  };
}

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
    // Real call sites (shell.ts, tui-shell.ts) always pass a session-scoped
    // jobRegistry — mirror that here so this "full tool list" assertion
    // reflects a real session, not the F-010-fixed no-registry case (that
    // has its own dedicated test below).
    jobRegistry: stubJobRegistry(),
  });
  const names = interactiveAgentToolNames(tools);
  expect(names).toEqual([
    "apply_patch",
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
    "shell_job_kill",
    "shell_job_output",
    "skill_load",
    "skills_catalog",
    "slate_read",
    "slate_write_seed",
    "spawn_subagent",
    "test_related",
    "web_fetch",
    "web_search",
    "wiki_ask",
    "wiki_backlinks",
    "wiki_freshness",
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

// --- flow 173 review finding F-010: no silent, orphaned fallback JobRegistry ---
//
// `buildInteractiveAgentTools` used to mint `createJobRegistry({cwd})` when a
// caller forgot to pass one — a fully real, functional registry that no
// session-exit sweep could ever reach. The fix: omit `jobRegistry` entirely
// and the two background-job tools are OMITTED from the tool list (never a
// silently-created orphan), while `shell_exec` stays registered but reports
// a clear error for `background:true`.

test("F-010: without jobRegistry, shell_job_output/shell_job_kill are NOT registered, and shell_exec background:true fails clearly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-no-jobregistry-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    // jobRegistry intentionally omitted.
  });

  const names = interactiveAgentToolNames(tools);
  expect(names).not.toContain("shell_job_output");
  expect(names).not.toContain("shell_job_kill");
  expect(names).toContain("shell_exec"); // shell_exec itself is still registered

  const shellExec = tools.find((tool) => tool.definition.name === "shell_exec");
  expect(shellExec).toBeDefined();
  const result = await shellExec?.invoke({ command: "sleep 999", background: true });
  expect(result?.isError).toBe(true);
  expect(result?.output).toMatch(/background jobs are not available in this session/);
});

test("F-010: WITH jobRegistry, shell_job_output/shell_job_kill ARE registered", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-with-jobregistry-"));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    jobRegistry: stubJobRegistry(),
  });

  const names = interactiveAgentToolNames(tools);
  expect(names).toContain("shell_job_output");
  expect(names).toContain("shell_job_kill");
});
