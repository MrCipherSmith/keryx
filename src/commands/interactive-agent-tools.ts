// Single factory for the interactive agent tool set (TUI + readline).
// Adding a tool here is the only way either surface gets it.

import { randomUUID } from "node:crypto";
import { buildBusTools } from "../bus/agent-tools";
import type { BusClient } from "../bus/client";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import {
  shellJobKillTool,
  shellJobOutputTool,
  shellTaskKillTool,
  shellTaskOutputTool,
  shellTaskWaitTool,
  type JobRegistry,
} from "../harness/tool/builtin/background-job-registry";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { executionPlanTools } from "../harness/tool/builtin/execution-plan-tool";
import { slateReadTool, slateWriteSeedTool } from "../harness/tool/builtin/slate-tool";
import { webFetchTool } from "../harness/tool/builtin/web-fetch-tool";
import { webSearchTool } from "../harness/tool/builtin/web-search-tool";
import { workspaceOverviewTool, workspaceReadTool } from "../harness/tool/builtin/workspace-context-tool";
import { workspaceCreateTool, workspaceListTool, workspaceProposeTool, workspaceShowTool } from "../harness/tool/builtin/workspace-lifecycle-tool";
import type { SearchProviderController } from "../harness/search";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { ServerCatalog } from "../mcp-servers/catalog";
import type { ServerState } from "../mcp-servers/manager";
import { createMcpInteractiveTools } from "../mcp-servers/tools";
import { invokeAskUserHost } from "../tui/ask-user-bridge";
import { buildProjectTools } from "./project-tools";

export type InteractiveAgentToolsInput = {
  cwd: string;
  metaprojectPort: MetaprojectPort;
  searchController: SearchProviderController;
  spawnTool: InteractiveTool;
  /**
   * SLATE-3a (flow 161, AC5): a LAZY getter for the running session's Slate
   * dir, threaded down into `slate_read`/`slate_write_seed`. Lazy, not a
   * static dir, because in `tui-shell.ts` `deps = await opts.makeAgentDeps(sel)`
   * runs before that surface's own `slateSession` variable is ever assigned —
   * a snapshot taken at tool-build time would freeze on `undefined` forever.
   * Every real call site now passes a closure reading its own session-tracking
   * variable BY REFERENCE (see `shell.ts`/`tui-shell.ts`); omitted here only by
   * call sites that predate session-dir threading (and by tests that do not
   * care about Slate content) — the two Slate tools still get REGISTERED in
   * that case, they just report "no active session" on every invocation
   * rather than being silently dropped from the tool list.
   */
  getSessionDir?: () => string | undefined;
  /** Injected id source for `slate_write_seed` — defaults to `randomUUID`. */
  idSeq?: () => string;
  /** Injected clock for `slate_write_seed` — defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /**
   * The session's shell-task supervisor: since flow 263 it backs EVERY
   * `shell_exec` call (each command is a supervised task that yields a handle
   * when it outlives `KERYX_SHELL_YIELD_MS`), not just the `background:true`
   * path it was introduced for in flow 173, plus `shell_job_output`/
   * `shell_job_kill`. A caller that wants tasks to survive across
   * turns/`makeAgentDeps` rebuilds MUST create this ONCE at session scope
   * (mirrors `getSessionDir`'s own session-lived closure) and pass the SAME
   * instance on every call — a registry created fresh inside this function
   * would lose every task the moment the tool list is rebuilt.
   *
   * Omitted (flow 173 review finding F-010): NO fallback registry is minted
   * here. A silently-created, orphaned registry is unreachable by any
   * session-exit sweep and worse than simply not offering the capability — so
   * `shell_job_output`/`shell_job_kill` are OMITTED from the returned tool
   * list entirely and `shell_exec` falls back to its synchronous runner
   * (flow 263 D-17: no supervision, no yield, the pre-flow-173 behaviour),
   * rather than silently using a registry nothing else can see or clean up.
   * Both production call sites in `shell.ts` pass one; the fallback exists for
   * tests and direct callers (pinned by `shell-task-registry-wiring.test.ts`).
   */
  jobRegistry?: JobRegistry;
  /**
   * The session's MCP runtime, if the surface built one.
   *
   * Session-scoped for the same measured reason as `jobRegistry`: this
   * function is called again on every tool-list rebuild, and a runtime
   * created inside it would spawn a fresh set of server processes each time
   * and orphan the previous ones. It is created once by the surface that
   * owns the session and closed when that session ends.
   *
   * Omitted → `search_tool` and `use_tool` are NOT registered at all, on the
   * same principle `jobRegistry` established: advertising a tool backed by
   * nothing is worse than not offering the capability.
   */
  mcp?: McpToolBinding;
  /**
   * Tool names this session must not have, by exact name.
   *
   * Exists because there was no way to say "this session does not need the web".
   * Both other agent CLIs offer one — `claude --disallowedTools`,
   * `grok --disable-web-search` — and keryx already treats egress as a product
   * concern elsewhere (`keryx harness exec --allowed-domains`, `sandbox.json`),
   * so a session-level roster it cannot narrow was the inconsistent part.
   *
   * Two uses it was written for: running against a sensitive checkout where a tool
   * that fetches from outside it is a liability, and any comparison that needs the
   * roster to be the same as another tool's.
   */
  denyTools?: readonly string[];
  /**
   * Flow 274 T6 (specification §7.1); review r1 F2: when `client()` resolves
   * to a live `BusClient` AT THE MOMENT this factory runs, `bus_list` and
   * `bus_send` are added to the roster, and `client` (the live getter, not a
   * snapshot) is threaded into `buildBusTools` so a later disconnect within
   * the SAME already-joined roster still reports `bus-disabled` at
   * invoke-time rather than the tool vanishing mid-session.
   *
   * review r1 F2 (AC9): inclusion itself is gated on `client() !== undefined`
   * at THIS call, not merely on `bus` being supplied — a session that has
   * never joined (KERYX_BUS=off, sessions off, or a join still in flight)
   * must not see `bus_*` in its tool roster at all. This means a caller whose
   * bus join settles AFTER its first tool-list build (every real call site:
   * `commands/shell.ts`'s `makeAgentDeps`, and the readline `agentDepsBase`)
   * gets no `bus_*` tools from that first build — it must rebuild the roster
   * once the join actually succeeds, the same way it already rebuilds
   * `AgentInstructionContext.busJoined`'s conduct block.
   *
   * Omitted entirely (every subagent/child tool-build path, any surface that
   * never joins the bus, and a side worker — review r1 F9) → no `bus_*` tool
   * is offered at all, matching specification §7.1: "None of these tools is
   * offered to subagents or external children in v1."
   */
  bus?: { client: () => BusClient | undefined };
};

/**
 * What the MCP pair needs from the session, and nothing more.
 *
 * Declared here rather than importing `McpRuntime` so this factory does not
 * depend on how the runtime is built — a test can bind a catalog directly.
 *
 * There is no approval hook, on purpose. `use_tool` is declared
 * `risk: "destructive"`, so every call already goes through the agent's own
 * gate; a hook here would be the fourth decision layer D-05 rules out.
 */
export type McpToolBinding = {
  readonly catalog: () => ServerCatalog;
  readonly servers: () => readonly ServerState[];
  readonly toolTimeoutSec?: ((server: string, rawName: string) => number | undefined) | undefined;
};

/**
 * Remove tools a caller asked this session not to have.
 *
 * Filtered after the list is built rather than threaded through every factory:
 * the factories are the place where a tool's construction lives, and a denial is
 * a property of the SESSION, not of any one tool. Built once and filtered once
 * also means `interactiveAgentToolNames` reports what the turn actually ran with
 * rather than what it would have run with.
 *
 * An unknown name is not silently ignored — see `assertDeniableTools`. A typo in a
 * denial is the failure mode that matters here: the operator believes a capability
 * is gone and it is not.
 */
export function denyInteractiveTools(
  tools: readonly InteractiveTool[],
  denied: readonly string[],
): InteractiveTool[] {
  if (denied.length === 0) return [...tools];
  const deny = new Set(denied);
  return tools.filter((tool) => !deny.has(tool.definition.name));
}

/**
 * Refuse a denial naming a tool that does not exist.
 *
 * `--deny-tools web_serch` must not leave the session with web search and a clear
 * conscience. The error lists what is deniable, because a name the operator cannot
 * look up is a name they will get wrong again.
 */
export function assertDeniableTools(tools: readonly InteractiveTool[], denied: readonly string[]): void {
  const known = new Set(tools.map((tool) => tool.definition.name));
  const unknown = denied.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown tool name(s) in --deny-tools: ${unknown.sort().join(", ")} — ` +
        `deniable tools are: ${[...known].sort().join(", ")}`,
    );
  }
}

// Re-exported: the set moved to `./project-tools.ts` with the gate it belongs to.
export { METAPROJECT_FREE_TOOLS } from "./project-tools";

export function buildInteractiveAgentTools(input: InteractiveAgentToolsInput): InteractiveTool[] {
  const getSessionDir = input.getSessionDir ?? (() => undefined);
  const idSeq = input.idSeq ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  const jobRegistry = input.jobRegistry;
  // The project tools and their gate (K-009), assembled by the one function
  // `keryx acp` also calls — so the two rosters cannot drift (flow 288, AC1).
  const project = buildProjectTools(input.cwd, input.metaprojectPort);
  const metaprojectTools = project.all;
  const built: InteractiveTool[] = [
    ...builtinReadOnlyTools(input.cwd),
    ...metaprojectTools,
    webFetchTool(),
    webSearchTool(input.searchController),
    shellExecTool(input.cwd, undefined, jobRegistry),
    // Flow 266: the task tools proper, plus the two old names kept as
    // deprecated aliases for one release. `observer` is what decides whether a
    // read counts as delivery — this roster is the MAIN session's, so its copy
    // marks a finished task observed; the side-worker roster is built
    // separately and never does (D-16).
    ...(jobRegistry !== undefined
      ? [
          shellTaskOutputTool(jobRegistry, { observer: "main" }),
          shellTaskWaitTool(jobRegistry),
          shellTaskKillTool(jobRegistry),
          shellJobOutputTool(jobRegistry),
          shellJobKillTool(jobRegistry),
        ]
      : []),
    applyPatchTool(input.cwd),
    workspaceOverviewTool(input.cwd),
    workspaceReadTool(input.cwd),
    workspaceCreateTool(input.cwd, getSessionDir),
    workspaceListTool(input.cwd),
    workspaceShowTool(input.cwd),
    workspaceProposeTool(input.cwd, getSessionDir),
    createAskUserTool(invokeAskUserHost),
    slateReadTool(input.cwd, getSessionDir),
    slateWriteSeedTool(getSessionDir, idSeq, clock),
    ...executionPlanTools(getSessionDir),
    // Flow 274 T6: main-agent-only bus tools (specification §7.1). Never
    // reached by a subagent or external child — neither tool-build path calls
    // this factory (see `spawn-subagent-tool.ts`, which builds its own child
    // roster from `builtinReadOnlyTools`/`builtinMetaprojectTools` only).
    //
    // review r1 F2 (AC9): gated on `client() !== undefined` AT THIS CALL, not
    // merely on `input.bus` being present — see that field's own doc comment.
    ...(input.bus?.client() === undefined ? [] : buildBusTools(input.bus.client)),
    // Two tools of fixed cost, whatever the operator has connected — never
    // one registered tool per MCP tool. That refusal is the package's whole
    // shape, and `mcp-tool-surface.test.ts` is what keeps it true from here.
    ...(input.mcp === undefined
      ? []
      : createMcpInteractiveTools({
          catalog: input.mcp.catalog,
          servers: input.mcp.servers,
          ...(input.mcp.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: input.mcp.toolTimeoutSec }),
        })),
    input.spawnTool,
  ];
  const denied = input.denyTools ?? [];
  // Checked against the FULL set, before the project filter: `--deny-tools graph_find`
  // names a real tool whether or not this project can run it, and refusing it as
  // "unknown" in a plain repository would make the same command line fail in one
  // directory and pass in the next.
  assertDeniableTools(built, denied);
  const offered = built.filter((tool) => !metaprojectTools.includes(tool) || project.offered.includes(tool));
  return denyInteractiveTools(offered, denied);
}

export function interactiveAgentToolNames(tools: readonly InteractiveTool[]): string[] {
  return tools.map((tool) => tool.definition.name).sort();
}
