// The tools one `keryx acp --profile shell` session turn is offered
// (Keryx Desktop Client M1, specification §3.3).
//
// Built by `buildInteractiveAgentTools` — the factory `keryx shell` uses — with
// session-scoped inputs, never a fork of it. Like `keryx shell`, a session
// builds it once and reuses it across turns: `server.ts` caches it per session
// and rebuilds only when an input below changes (the session's root, or its
// client MCP servers after a `session/load`). What the factory reads from the
// project at build time — whether the metaproject tools are offered
// (`offersIndexTools`) — is therefore read once per session too, exactly as
// `keryx shell` reads it once per session: a `keryx init` run while the
// session is open shows up in the next session, not the next turn.
//
// `mcp` is `merged-mcp.ts`'s one binding over keryx's servers and the
// client's; a client server named like a keryx one is dropped and reported.
//
//   cwd / metaprojectPort   the session's resolved root, one `createMetaprojectAdapter(root)`
//                           per root per connection (`server.ts`)
//   searchController        `createDefaultSearchProviderController()`, as `keryx shell` builds it
//   jobRegistry             one per ACP session (`server.ts`), swept when the client switches
//                           to another session (after its running turn) or the connection ends
//   getSessionDir           the session's own directory in the keryx session store
//   askUser                 `_keryx/ask_user` to the client (`ask-user.ts`) — or, when the
//                           client did not advertise it, the tool is denied
//   mcp                     keryx's configured servers merged with the client's `mcpServers`
//   spawnTool               `spawn_subagent` over `buildSessionSpawnDeps` — the wiring `keryx shell`
//                           uses — with native children only (`nativeOnly`) unless the client runs terminals (`runExternal`); the session's own
//                           fleet-event closure, hook runtime and live parent model (`spawn`)
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
import { createSpawnSubagentTool, type SpawnSubagentToolDeps } from "../harness/tool/builtin/spawn-subagent-tool";
import { buildSessionSpawnDeps, type SessionSpawnDepsInput } from "../commands/spawn-deps";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { acpAwareReadFileTool, type AcpFsReader } from "./capability-tools";
import { prepareReviewTool, type RequestReviewDraft } from "./prepare-review";
import type { AcpClientCapabilities } from "./protocol";

/**
 * What `spawn_subagent` needs from the ACP host, per session. `nativeOnly` and `runExternal` are not here: a
 * model-chosen external runtime is `AcpShellRosterInput.runExternal` (the desktop's terminal run, D-14).
 */
export type AcpShellSpawnInput = Omit<SessionSpawnDepsInput, "cwd" | "nativeOnly" | "runExternal">;

export interface AcpShellRosterInput {
  readonly root: string;
  readonly clientCapabilities: AcpClientCapabilities | undefined;
  readonly readViaClient: AcpFsReader;
  readonly searchController: SearchProviderController;
  readonly jobRegistry: JobRegistry;
  readonly spawn: AcpShellSpawnInput;
  readonly getSessionDir: () => string | undefined;
  /** Present only when the client advertised `_meta.keryx.askUser`; absent → `ask_user` is denied. */
  readonly askUser?: AskUserFn;
  readonly requestReviewDraft?: RequestReviewDraft;
  /** keryx's configured servers merged with the client's, or none at all. */
  readonly mcp?: McpToolBinding;
  /** The root's adapter, shared by every build for that root; `createMetaprojectAdapter(root)` when absent. */
  readonly metaprojectPort?: MetaprojectPort;
  /** The session's `spawn_subagent`. Absent → the tool is denied. */
  readonly spawnTool?: InteractiveTool;
  /**
   * The model-started external run (trust/auto only, in the client's terminal). Absent → `spawn_subagent`
   * offers native children only and refuses `runtime.kind: "external"` by name.
   */
  readonly runExternal?: SpawnSubagentToolDeps["runExternal"];
}

/** The names the shell profile denies for this input: `ask_user` without a client to ask. */
export function acpShellDeniedTools(askUserOffered: boolean): string[] {
  return askUserOffered ? [] : ["ask_user"];
}

export function buildAcpShellSessionTools(input: AcpShellRosterInput): InteractiveTool[] {
  const { root } = input;
  const tools = buildInteractiveAgentTools({
    cwd: root,
    metaprojectPort: input.metaprojectPort ?? createMetaprojectAdapter(root),
    searchController: input.searchController,
    spawnTool: createSpawnSubagentTool(buildSessionSpawnDeps({ ...input.spawn, cwd: root, ...(input.runExternal !== undefined ? { runExternal: input.runExternal } : { nativeOnly: true }) })),
    getSessionDir: input.getSessionDir,
    jobRegistry: input.jobRegistry,
    ...(input.askUser !== undefined ? { askUser: input.askUser } : {}),
    ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
    denyTools: acpShellDeniedTools(input.askUser !== undefined),
  });
  if (input.requestReviewDraft) tools.push(prepareReviewTool(input.requestReviewDraft));
  return tools.map((tool) =>
    tool.definition.name === "read_file"
      ? acpAwareReadFileTool(tool, root, input.clientCapabilities, input.readViaClient)
      : tool,
  );
}

/**
 * `tool` with the host's id for each call passed as `InteractiveToolContext.toolCallId`. `idFor` is read
 * at invoke time, from the turn's own `AgentIO` (`AcpAgentIo.toolCallIdFor`): the id the client was
 * shown is minted there, not by the model.
 */
export function withHostToolCallId(
  tool: InteractiveTool,
  idFor: (name: string, input: Record<string, unknown>) => string | undefined,
): InteractiveTool {
  return {
    ...tool,
    invoke: (input, ctx) => {
      const toolCallId = idFor(tool.definition.name, input);
      return tool.invoke(input, toolCallId === undefined ? ctx : { ...ctx, toolCallId });
    },
  };
}
