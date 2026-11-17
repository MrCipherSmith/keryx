// The tools one `keryx acp --profile shell` session turn is offered
// (Keryx Desktop Client M1, specification §3.3).
//
// Built by `buildInteractiveAgentTools` — the factory `keryx shell` uses — with
// session-scoped inputs, never a fork of it. Like `keryx shell`, a session
// builds it once and reuses it across turns: `server.ts` caches it per session
// and rebuilds only when an input below changes (the session's root, or its
// client MCP servers after a `session/load`).
//
//   cwd / metaprojectPort   the session's resolved root, one `createMetaprojectAdapter(root)`
//                           per root per connection (`server.ts`)
//   searchController        `createDefaultSearchProviderController()`, as `keryx shell` builds it
//   jobRegistry             one per ACP session (`server.ts`), swept when the client switches
//                           to another session or the connection ends
//   getSessionDir           the session's own directory in the keryx session store
//   askUser                 `_keryx/ask_user` to the client (`ask-user.ts`) — or, when the
//                           client did not advertise it, the tool is denied
//   mcp                     keryx's configured servers merged with the client's `mcpServers`
//   spawnTool               M2: a placeholder, denied by name below
//   bus, schedules,         M2: omitted, so the factory never builds them
//   operatorConfirm, reviewAgents
//
// `read_file` keeps the client-`fs` routing the editor profile has
// (`acpAwareReadFileTool`).
//
// Untrusted results (`web_fetch`, `web_search`, MCP `search_tool`/`use_tool`)
// ARE offered: `shell-profile.test.ts` (AC7) drives an untrusted result and the
// gated call after it over the real pipe, and proves the approve-before-announce
// path asks once, under the id the client was shown, and runs nothing on deny.

import { buildInteractiveAgentTools, type McpToolBinding } from "../commands/interactive-agent-tools";
import type { SearchProviderController } from "../harness/search";
import type { AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { acpAwareReadFileTool, type AcpFsReader } from "./capability-tools";
import type { AcpClientCapabilities } from "./protocol";

/** Tools the factory builds that the shell profile does not offer in M1, whatever the client advertised. */
export const ACP_SHELL_M2_DENIED_TOOLS: readonly string[] = ["spawn_subagent"];

/**
 * The factory requires a spawn tool. M1 has no spawn port over this wire, so it
 * gets this placeholder, which the denial above removes before any turn sees
 * it. Its invoke refuses too, so a future change that dropped the denial would
 * fail loudly instead of delegating.
 */
const M2_SPAWN_PLACEHOLDER: InteractiveTool = {
  definition: {
    name: "spawn_subagent",
    description: "Not available over keryx acp in this release.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "delegate",
  },
  invoke: async () => ({ output: "spawn_subagent is not available over keryx acp in this release", isError: true }),
};

export interface AcpShellRosterInput {
  readonly root: string;
  readonly clientCapabilities: AcpClientCapabilities | undefined;
  readonly readViaClient: AcpFsReader;
  readonly searchController: SearchProviderController;
  readonly jobRegistry: JobRegistry;
  readonly getSessionDir: () => string | undefined;
  /** Present only when the client advertised `_meta.keryx.askUser`; absent → `ask_user` is denied. */
  readonly askUser?: AskUserFn;
  /** keryx's configured servers merged with the client's, or none at all. */
  readonly mcp?: McpToolBinding;
  /** The root's adapter, shared by every build for that root; `createMetaprojectAdapter(root)` when absent. */
  readonly metaprojectPort?: MetaprojectPort;
}

/** The names the shell profile denies for this input — M2 tools, and `ask_user` without a client to ask. */
export function acpShellDeniedTools(askUserOffered: boolean): string[] {
  return [...ACP_SHELL_M2_DENIED_TOOLS, ...(askUserOffered ? [] : ["ask_user"])];
}

export function buildAcpShellSessionTools(input: AcpShellRosterInput): InteractiveTool[] {
  const { root } = input;
  const tools = buildInteractiveAgentTools({
    cwd: root,
    metaprojectPort: input.metaprojectPort ?? createMetaprojectAdapter(root),
    searchController: input.searchController,
    spawnTool: M2_SPAWN_PLACEHOLDER,
    getSessionDir: input.getSessionDir,
    jobRegistry: input.jobRegistry,
    ...(input.askUser !== undefined ? { askUser: input.askUser } : {}),
    ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
    denyTools: acpShellDeniedTools(input.askUser !== undefined),
  });
  return tools.map((tool) =>
    tool.definition.name === "read_file"
      ? acpAwareReadFileTool(tool, root, input.clientCapabilities, input.readViaClient)
      : tool,
  );
}
