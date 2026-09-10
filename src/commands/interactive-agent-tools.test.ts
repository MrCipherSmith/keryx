import { expect, test, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import {
  assertDeniableTools,
  buildInteractiveAgentTools,
  denyInteractiveTools,
  interactiveAgentToolNames,
} from "./interactive-agent-tools";

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
    // AFC (flow 240): the explainable graph seed search, previously CLI-only.
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
    // AFC (flow 240): the AFC-W04 evidence envelope, previously reachable only
    // from its own test.
    "wiki_evidence",
    "wiki_freshness",
    // Flow 242 (forgetting) lane C / AC5: the same named-outcome vocabulary
    // `keryx wiki sections resolve` answers on, now reachable from the
    // interactive agent (see `metaproject-operations.test.ts` EXPECTED_NAMES).
    "wiki_resolve",
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

describe("--deny-tools withholds a capability rather than gating it", () => {
  async function build(denyTools?: readonly string[]) {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-deny-"));
    return buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
      jobRegistry: stubJobRegistry(),
      ...(denyTools === undefined ? {} : { denyTools }),
    });
  }

  test("a denied tool is absent from the roster, not merely unapproved", async () => {
    // Distinct from `--permission-mode`, which decides whether a call is allowed.
    // A denied tool is never offered, so it cannot be attempted, reasoned about,
    // or approved by mistake.
    const names = interactiveAgentToolNames(await build(["web_search", "web_fetch"]));
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
  });

  test("everything else survives, so a denial is not a blunt instrument", async () => {
    const full = interactiveAgentToolNames(await build());
    const narrowed = interactiveAgentToolNames(await build(["web_search", "web_fetch"]));
    expect(narrowed).toEqual(full.filter((name) => name !== "web_search" && name !== "web_fetch"));
  });

  test("no denial leaves the roster exactly as it was", async () => {
    expect(interactiveAgentToolNames(await build([]))).toEqual(interactiveAgentToolNames(await build()));
  });

  test("a misspelled name is REFUSED, not ignored", async () => {
    // `--deny-tools web_serch` must not leave the session with web search and a
    // clear conscience: the operator believes a capability is gone and it is not.
    await expect(build(["web_serch"])).rejects.toThrow(/unknown tool name/);
  });

  test("the refusal lists what is deniable, so the name can be looked up", async () => {
    await expect(build(["nope"])).rejects.toThrow(/deniable tools are: .*web_search/);
  });

  test("the roster reported afterwards is the one the turn actually ran with", async () => {
    // `interactiveAgentToolNames` is what a consumer reads back; if the filter ran
    // anywhere later, it would report a capability the session did not have.
    const tools = await build(["web_fetch"]);
    expect(tools.some((tool) => tool.definition.name === "web_fetch")).toBe(false);
  });
});

describe("denyInteractiveTools", () => {
  const tool = (name: string) => ({
    definition: { name, description: "", inputSchema: { type: "object" as const, properties: {} }, risk: "read" as const },
    invoke: async () => ({ output: "", isError: false }),
  });

  test("removes only the names given", () => {
    const kept = denyInteractiveTools([tool("a"), tool("b"), tool("c")], ["b"]);
    expect(kept.map((t) => t.definition.name)).toEqual(["a", "c"]);
  });

  test("an empty denial is a copy, not the same array", () => {
    const original = [tool("a")];
    const kept = denyInteractiveTools(original, []);
    expect(kept).toEqual(original);
    expect(kept).not.toBe(original);
  });

  test("assertDeniableTools passes a known name and refuses an unknown one", () => {
    expect(() => assertDeniableTools([tool("a")], ["a"])).not.toThrow();
    expect(() => assertDeniableTools([tool("a")], ["z"])).toThrow(/z/);
  });
});
