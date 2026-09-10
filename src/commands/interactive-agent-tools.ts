// Single factory for the interactive agent tool set (TUI + readline).
// Adding a tool here is the only way either surface gets it.

import { randomUUID } from "node:crypto";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import {
  shellJobKillTool,
  shellJobOutputTool,
  type JobRegistry,
} from "../harness/tool/builtin/background-job-registry";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { builtinMetaprojectTools, makeKeryxRunner } from "../harness/tool/builtin/metaproject-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { slateReadTool, slateWriteSeedTool } from "../harness/tool/builtin/slate-tool";
import { webFetchTool } from "../harness/tool/builtin/web-fetch-tool";
import { webSearchTool } from "../harness/tool/builtin/web-search-tool";
import { workspaceOverviewTool, workspaceReadTool } from "../harness/tool/builtin/workspace-context-tool";
import { workspaceCreateTool, workspaceListTool, workspaceProposeTool, workspaceShowTool } from "../harness/tool/builtin/workspace-lifecycle-tool";
import type { SearchProviderController } from "../harness/search";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { invokeAskUserHost } from "../tui/ask-user-bridge";

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
   * Background-job registry backing `shell_exec`'s `background:true` input
   * plus `shell_job_output`/`shell_job_kill` (flow 173, T2/T3). A caller that
   * wants jobs to survive across turns/`makeAgentDeps` rebuilds MUST create
   * this ONCE at session scope (mirrors `getSessionDir`'s own session-lived
   * closure) and pass the SAME instance on every call — a registry created
   * fresh inside this function would lose every job the moment the tool list
   * is rebuilt.
   *
   * Omitted (flow 173 review finding F-010): NO fallback registry is minted
   * here. A silently-created, orphaned `JobRegistry` (the old behavior) is
   * unreachable by any session-exit sweep and worse than simply not offering
   * the capability — so `shell_job_output`/`shell_job_kill` are OMITTED from
   * the returned tool list entirely, and `shell_exec` still gets
   * `background:true` in its schema but reports a clear "background jobs are
   * not available in this session" tool error (see `shell-exec-tool.ts`'s
   * `invoke`, which already handles `jobRegistry === undefined` this way)
   * rather than silently using a registry nothing else can see or clean up.
   */
  jobRegistry?: JobRegistry;
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

export function buildInteractiveAgentTools(input: InteractiveAgentToolsInput): InteractiveTool[] {
  const getSessionDir = input.getSessionDir ?? (() => undefined);
  const idSeq = input.idSeq ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  const jobRegistry = input.jobRegistry;
  const built: InteractiveTool[] = [
    ...builtinReadOnlyTools(input.cwd),
    ...builtinMetaprojectTools(input.cwd, makeKeryxRunner(input.cwd), input.metaprojectPort),
    webFetchTool(),
    webSearchTool(input.searchController),
    shellExecTool(input.cwd, undefined, jobRegistry),
    ...(jobRegistry !== undefined ? [shellJobOutputTool(jobRegistry), shellJobKillTool(jobRegistry)] : []),
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
    input.spawnTool,
  ];
  const denied = input.denyTools ?? [];
  assertDeniableTools(built, denied);
  return denyInteractiveTools(built, denied);
}

export function interactiveAgentToolNames(tools: readonly InteractiveTool[]): string[] {
  return tools.map((tool) => tool.definition.name).sort();
}
