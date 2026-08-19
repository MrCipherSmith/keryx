// Single factory for the interactive agent tool set (TUI + readline).
// Adding a tool here is the only way either surface gets it.

import { randomUUID } from "node:crypto";
import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import { backgroundJobTools } from "../harness/tool/builtin/background-job-tool";
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
};

export function buildInteractiveAgentTools(input: InteractiveAgentToolsInput): InteractiveTool[] {
  const getSessionDir = input.getSessionDir ?? (() => undefined);
  const idSeq = input.idSeq ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  return [
    ...builtinReadOnlyTools(input.cwd),
    ...builtinMetaprojectTools(input.cwd, makeKeryxRunner(input.cwd), input.metaprojectPort),
    webFetchTool(),
    webSearchTool(input.searchController),
    shellExecTool(input.cwd),
    ...backgroundJobTools(input.cwd),
    workspaceOverviewTool(input.cwd),
    workspaceReadTool(input.cwd),
    workspaceCreateTool(input.cwd),
    workspaceListTool(input.cwd),
    workspaceShowTool(input.cwd),
    workspaceProposeTool(input.cwd, getSessionDir),
    createAskUserTool(invokeAskUserHost),
    slateReadTool(input.cwd, getSessionDir),
    slateWriteSeedTool(getSessionDir, idSeq, clock),
    input.spawnTool,
  ];
}

export function interactiveAgentToolNames(tools: readonly InteractiveTool[]): string[] {
  return tools.map((tool) => tool.definition.name).sort();
}
