// Single factory for the interactive agent tool set (TUI + readline).
// Adding a tool here is the only way either surface gets it.

import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { builtinMetaprojectTools, makeKeryxRunner } from "../harness/tool/builtin/metaproject-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { webFetchTool } from "../harness/tool/builtin/web-fetch-tool";
import { webSearchTool } from "../harness/tool/builtin/web-search-tool";
import { workspaceOverviewTool, workspaceReadTool } from "../harness/tool/builtin/workspace-context-tool";
import type { SearchProviderController } from "../harness/search";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { invokeAskUserHost } from "../tui/ask-user-bridge";

export type InteractiveAgentToolsInput = {
  cwd: string;
  metaprojectPort: MetaprojectPort;
  searchController: SearchProviderController;
  spawnTool: InteractiveTool;
};

export function buildInteractiveAgentTools(input: InteractiveAgentToolsInput): InteractiveTool[] {
  return [
    ...builtinReadOnlyTools(input.cwd),
    ...builtinMetaprojectTools(input.cwd, makeKeryxRunner(input.cwd), input.metaprojectPort),
    webFetchTool(),
    webSearchTool(input.searchController),
    shellExecTool(input.cwd),
    workspaceOverviewTool(input.cwd),
    workspaceReadTool(input.cwd),
    createAskUserTool(invokeAskUserHost),
    input.spawnTool,
  ];
}

export function interactiveAgentToolNames(tools: readonly InteractiveTool[]): string[] {
  return tools.map((tool) => tool.definition.name).sort();
}
