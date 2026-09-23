// The tools one ACP session turn is offered (flow 285 T9, flow 287, flow 288).
//
// Lifted out of `server.ts`'s prompt handler so the roster is ONE function a
// test can call and compare with `keryx shell`'s (AC1), enumerate for kinds
// (AC2) and pin against untrusted, delegation and bus tools (AC3).
//
// THE ROSTER IS EXACTLY WHAT THIS SERVER CAN RUN SAFELY:
//
//   `get_cwd`/`list_dir`/`read_file`  read-only, bound to the project root;
//                 `read_file` goes through the client's `fs/read_text_file`
//                 when — and only when — the session's client advertised it
//                 (`capability-tools.ts`).
//   project tools  keryx's own read-only metaproject operations (graph, wiki,
//                 memory, flow status, skills, repomap, test_related, health
//                 status, `search_code`) — assembled by `buildProjectTools`,
//                 the SAME function `keryx shell`'s factory calls, so the gate
//                 (`offersIndexTools`) and the definitions are shared, not
//                 copied (flow 288, AC1). All are risk `read`; none returns a
//                 result marked `untrusted`.
//   `shell_exec`  risk `shell` — every command asked through
//                 `session/request_permission`.
//   `apply_patch` risk `write` — same gate; every target path confined to the
//                 project root.
//   `search_tool`/`use_tool`  only when the CLIENT sent MCP servers for this
//                 session (flow 287). The client's own servers, every
//                 `use_tool` call asked.
//
// Deliberately NOT offered (flow 288, AC3): `web_fetch`/`web_search` and
// keryx's own configured MCP servers — their results carry `untrusted: true`,
// which activates the approve-before-announce taint path that has no live ACP
// test; `spawn_subagent` — delegation needs a spawn port this server does not
// build; `bus_*` — the agent bus is a shell surface; `ask_user`, workspace,
// Slate, execution-plan and shell-task tools — they need a host seam or a
// session store this wire does not carry.

import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { buildProjectTools } from "../commands/project-tools";
import { acpAwareReadFileTool, type AcpFsReader } from "./capability-tools";
import type { AcpClientCapabilities } from "./protocol";

/**
 * The client-MCP pair flow 287 added. The one deliberate exception to "no tool
 * whose results are untrusted": they front the CLIENT's own servers, are
 * offered only when the client sent some, and every `use_tool` call is asked.
 */
export const ACP_CLIENT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(["search_tool", "use_tool"]);

export interface AcpRosterInput {
  /** The session's resolved project root. Every tool is bound to it. */
  readonly root: string;
  readonly clientCapabilities: AcpClientCapabilities | undefined;
  /** `fs/read_text_file` through the client; used only when the client advertised it. */
  readonly readViaClient: AcpFsReader;
  /** The session's client-MCP tools (`search_tool`/`use_tool`), or none. */
  readonly clientMcpTools?: readonly InteractiveTool[];
  /** Test seam; `createMetaprojectAdapter(root)` otherwise — what `keryx shell` builds. */
  readonly metaprojectPort?: MetaprojectPort;
}

export function buildAcpSessionTools(input: AcpRosterInput): InteractiveTool[] {
  const { root } = input;
  return [
    ...builtinReadOnlyTools(root).map((tool) =>
      tool.definition.name === "read_file"
        ? acpAwareReadFileTool(tool, root, input.clientCapabilities, input.readViaClient)
        : tool,
    ),
    ...buildProjectTools(root, input.metaprojectPort ?? createMetaprojectAdapter(root)).offered,
    shellExecTool(root),
    applyPatchTool(root),
    ...(input.clientMcpTools ?? []),
  ];
}
