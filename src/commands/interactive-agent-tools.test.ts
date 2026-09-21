import { expect, test, describe } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSlate } from "../session/slate";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { BusClient } from "../bus/client";
import {
  assertDeniableTools,
  buildInteractiveAgentTools,
  denyInteractiveTools,
  interactiveAgentToolNames,
} from "./interactive-agent-tools";

/** A stub `BusClient` — only enough shape for `buildBusTools` to build tool definitions; never invoked in these tests. */
const stubBusClient = {} as BusClient;

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
    waitForExit: async () => "unknown",
    promote: () => ({ ok: true }),
    kill: async () => ({ ok: false, error: "unknown job_id" }),
    sweepAll: async () => {},
    // flow 265: delivery bookkeeping. This stub proves the tool-list SHAPE
    // only, so both are inert — the behaviour lives in the registry's own tests.
    drainUndelivered: () => [],
    onCompletion: () => () => {},
    // flow 266: the explicit-cursor read and the delivery mark it deliberately
    // does NOT perform. Inert for the same reason as the two above — what this
    // stub is asked is which tools exist, never what they return.
    readOutputSince: () => ({ ok: false, error: "unknown job_id" }),
    markObserved: () => {},
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

/** Every metaproject operation that reads `.metaproject/`, pinned so the set cannot drift quietly. */
const METAPROJECT_BOUND = [
  "flow_status",
  "graph_affected",
  "graph_find",
  "graph_path",
  "graph_query",
  "graph_symbol",
  "health_status",
  "memory_search",
  "read_wiki",
  "repomap",
  "skill_load",
  "skills_catalog",
  "test_related",
  "wiki_ask",
  "wiki_backlinks",
  "wiki_evidence",
  "wiki_freshness",
  "wiki_resolve",
];

async function rosterIn(cwd: string, denyTools: string[] = []): Promise<string[]> {
  return interactiveAgentToolNames(
    buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
      jobRegistry: stubJobRegistry(),
      denyTools,
    }),
  );
}

describe("K-009: the roster follows the project it is in", () => {
  test("without .metaproject/, exactly the metaproject-bound tools are withheld and search_code stays", async () => {
    // The arena's control arm was offered all of these, called graph_find, and got
    // `index-incomplete … never built here`.
    const bare = await mkdtemp(join(tmpdir(), "keryx-tools-bare-"));
    const withMeta = await mkdtemp(join(tmpdir(), "keryx-tools-meta-"));
    await mkdir(join(withMeta, ".metaproject"));
    const full = await rosterIn(withMeta);
    const reduced = await rosterIn(bare);
    expect(full.filter((name) => !reduced.includes(name))).toEqual(METAPROJECT_BOUND);
    expect(reduced.filter((name) => !full.includes(name))).toEqual([]);
    expect(reduced).toContain("search_code");
  });

  test("denying a metaproject tool is accepted in a project that cannot run it", async () => {
    // The denial is checked against the full set, so one command line does not
    // pass in one directory and fail as "unknown tool" in the next.
    const bare = await mkdtemp(join(tmpdir(), "keryx-tools-bare-"));
    expect(await rosterIn(bare, ["graph_find"])).not.toContain("graph_find");
    await expect(rosterIn(bare, ["graph_fnid"])).rejects.toThrow(/unknown tool name/);
  });
});

test("TUI and readline share one factory that includes web_fetch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-"));
  // The full roster is a project WITH a metaproject; without one, K-009 withholds
  // the tools that could only fail there (pinned in the describe block above).
  await mkdir(join(cwd, ".metaproject"));
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
    "plan_get",
    "plan_set",
    "plan_update",
    "read_file",
    "read_wiki",
    "repomap",
    "search_code",
    "shell_exec",
    "shell_job_kill",
    "shell_job_output",
    // Flow 266: the task tools proper. The two `shell_job_*` names above stay
    // for one release as deprecated aliases, so a session offers both spellings.
    "shell_task_kill",
    "shell_task_output",
    "shell_task_wait",
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

test("plan metadata tools are typed, main-factory scoped, and preserve /plan read-only safety", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-plan-tools-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "keryx-plan-session-"));
  await writeSlate(sessionDir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    getSessionDir: () => sessionDir,
  });

  const planTools = tools.filter((tool) => tool.definition.name.startsWith("plan_"));
  expect(planTools.map((tool) => tool.definition.name).sort()).toEqual(["plan_get", "plan_set", "plan_update"]);
  expect(planTools.every((tool) => tool.definition.risk === "read")).toBe(true);
  expect(planTools.every((tool) => tool.definition.inputSchema.additionalProperties === false)).toBe(true);

  const set = planTools.find((tool) => tool.definition.name === "plan_set");
  const update = planTools.find((tool) => tool.definition.name === "plan_update");
  const get = planTools.find((tool) => tool.definition.name === "plan_get");
  expect((await set?.invoke({ expectedRevision: 0, items: [{ id: "one", title: "One", status: "in_progress" }] }))?.isError).toBe(false);
  expect((await update?.invoke({ expectedRevision: 1, itemId: "one", status: "completed" }))?.isError).toBe(false);
  const result = await get?.invoke({});
  expect(result?.isError).toBe(false);
  expect(JSON.parse(result?.output ?? "null").items[0].status).toBe("completed");
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

test("AC7: the registry is actually threaded into shell_exec — a long command yields a task handle", async () => {
  // The registry reaching `shellExecTool`'s third argument is the whole
  // supervision path. Drop that argument and every `shell_exec` silently falls
  // back to the blocking synchronous runner — the release-watch incident — with
  // every other suite still green, because nothing else observes it. Asserting
  // the tool NAMES (the test above) does not catch that; asserting the tool's
  // BEHAVIOUR through the built roster does.
  const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-wired-"));
  const startedCommands: string[] = [];
  const runningRegistry: JobRegistry = {
    ...stubJobRegistry(),
    start: async (command) => {
      startedCommands.push(command);
      return { ok: true, jobId: "task-7-4242", pid: 4242, output: "" };
    },
    readOutput: () => ({ ok: true, output: "" }),
    waitForExit: async () => "timeout",
    promote: () => ({ ok: true }),
    get: () => ({
      jobId: "task-7-4242",
      pid: 4242,
      command: "sleep 999",
      status: "running",
      phase: "background",
      idleTimeoutMs: 120_000,
      observed: false,
      startedAt: "2026-09-16T00:00:00.000Z",
    }),
  };

  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
    jobRegistry: runningRegistry,
  });

  const shellExec = tools.find((tool) => tool.definition.name === "shell_exec");
  expect(shellExec).toBeDefined();
  const result = await shellExec?.invoke({ command: "sleep 999" });

  expect(startedCommands).toEqual(["sleep 999"]); // it went through the SESSION registry
  expect(result?.isError).toBe(false);
  const parsed = JSON.parse(result?.output ?? "{}") as { task_id?: string; status?: string };
  expect(parsed.task_id).toBe("task-7-4242");
  expect(parsed.status).toBe("running");
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

// --- flow 274 T6: bus_list/bus_send are offered only with the `bus` option ---
// review r1 F2 (AC9): and only once that option's `client()` actually
// resolves AT BUILD TIME — a session that has not joined (yet, or ever) must
// not see `bus_*` in its tool roster at all, not merely see it refuse.
//
// AC9: bus_* tools reach the main interactive agent only when the bus is
// joined, never a subagent or external child. Neither of THOSE build paths
// calls `buildInteractiveAgentTools` at all (see
// `spawn-subagent-isolation.test.ts`), so the property this suite pins is
// narrower and complementary: the factory itself must not hand out `bus_*`
// unless a caller explicitly opts in with `bus` AND that bus is actually
// joined.

describe("K-flow-274: the bus option", () => {
  test("without `bus`, no bus_* tool is offered", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-no-bus-"));
    const tools = buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
    });
    const names = interactiveAgentToolNames(tools);
    expect(names.some((name) => name.startsWith("bus_"))).toBe(false);
  });

  // review r1 F2: this used to pass `bus: { client: () => undefined }` and
  // still expect the tools to be offered — exactly the AC9 regression. A
  // joined bus is now required for inclusion at all.
  //
  // flow 275 T6 (AC7): `bus_pause` joins `bus_list`/`bus_send` here — same
  // inclusion rule, same gate.
  test("with `bus` and a live client (joined), bus_list, bus_send and bus_pause are offered", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-with-bus-"));
    const tools = buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
      bus: { client: () => stubBusClient },
    });
    const names = interactiveAgentToolNames(tools);
    expect(names).toContain("bus_list");
    expect(names).toContain("bus_send");
    expect(names).toContain("bus_pause");
  });

  // review r1 F2: previously asserted the OPPOSITE — that the tools were
  // present but refused with `bus-disabled`. AC9 requires the model to see no
  // `bus_*` tool at all until the bus is actually joined; a caller whose join
  // succeeds LATER must rebuild the roster (the fix at every real call site).
  test("with `bus` but no live client (not yet joined / left), the tools are absent, not present-and-refusing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-bus-no-client-"));
    const tools = buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
      bus: { client: () => undefined },
    });
    const names = interactiveAgentToolNames(tools);
    expect(names.some((name) => name.startsWith("bus_"))).toBe(false);
  });

  test("bus_list still refuses with bus-disabled if the client later disconnects within an already-joined roster", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-tools-bus-drops-"));
    let client: BusClient | undefined = stubBusClient;
    const tools = buildInteractiveAgentTools({
      cwd,
      metaprojectPort: createMetaprojectAdapter(cwd),
      searchController: createDefaultSearchProviderController(),
      spawnTool: stubSpawn,
      // A LIVE getter, per the field's own contract — included because
      // `client()` resolved at build time, but still read fresh at invoke
      // time so a later drop is reported, not silently ignored.
      bus: { client: () => client },
    });
    client = undefined;
    const busList = tools.find((tool) => tool.definition.name === "bus_list");
    const result = await busList?.invoke({});
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("bus-disabled");
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
