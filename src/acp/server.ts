import { readProcessIdentity } from "../lib/hub-machine/process-identity";
// The ACP agent server loop (flow 285, T7/T8): wires the framer + dispatcher
// + keryx session/turn handlers over one stdio connection.
//
// Nothing but protocol frames reaches `options.write` — every diagnostic goes
// through `options.logError` instead, per the transport's own MUST NOT
// (`context.md` §0: "a stray console.log corrupts the stream").
//
// One call to `runAcpServer` is one connection, matching how a real ACP
// client launches the agent: a fresh subprocess per session. `initialized`
// and `clientCapabilities` are therefore connection-scoped local state, never
// module-level globals — two connections in the same test process (or two
// launches of the CLI) never see each other's state.

import { randomBytes, randomUUID } from "node:crypto";
import { RemoteClient } from "../remote/client";
import { ChannelsClient } from "../remote/channels-client";
import { raceTelegramApproval } from "./telegram-approval";
import { ProjectedDecision } from "./telegram-decision";
import { redactSensitiveText } from "../security/service";
import { ACP_TELEGRAM_SESSION_METHOD, TelegramSessionBindings, parseTelegramSessionRequest, unavailableTelegramSession, type TelegramBindingDependencies } from "./telegram-session";
import {
  agentContextWindow,
  buildAgentSystemInstruction,
  generateControlNonce,
  isReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
  runAgentTurn,
  type AgentDeps,
  type AgentFinishReason,
  type ReasoningEffortLevel,
} from "../commands/agent";
import { buildShellHookRuntime, type ShellHookContext } from "../commands/agent-hooks";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import { isInjectedUserMessage, listedTitle, listSessions, persistHistory, renameSession, resolveProjectRoot, titleFromPrompt } from "../session";
import { describeLeaseHolder, describeLeaseLoss, SessionLeasedError } from "../session/lease";
import {
  readSessionFlags,
  setSessionFlagsAsync,
  trashSession,
  type FlagsLockTiming,
  type SessionFlags,
  type SessionFlagsChange,
  type TrashOptions,
} from "../session/organize";
import { sessionDir } from "../session/paths";

/** Titles a session carries before anything has named it. */
const UNNAMED_SESSION_TITLES = new Set(["New session", "Untitled session", "Untitled", ""]);
import { selfAnsweredLine } from "../lib/terminal-safe";
import { createAcpAgentIo, toolKindFor, tryParseJson, type AcpPermissionAsker } from "./agent-io";
import type { AcpFsReader } from "./capability-tools";
import {
  ACP_SHELL_SLASH_COMMANDS,
  ACP_SLASH_COMMANDS,
  acpAvailableCommands,
  acpCommandHelpText,
  acpCommandInputProblem,
  parseAcpSlashPrompt,
  unknownAcpCommandText,
} from "./commands";
import {
  ACP_MODEL_CONFIG_ID,
  acpModelChoice,
  acpModelConfigOption,
  acpModelValue,
  findAcpModelChoice,
  type AcpModelBinding,
  type AcpModelChoice,
  type AcpModelSource,
  type AcpTurnSettings,
} from "./models";
import { buildAcpSessionTools } from "./roster";
import { AcpClientRequests } from "./client-requests";
import { AcpDispatcher, type AcpDispatchOutcome } from "./dispatch";
import { AcpLineFramer, encodeAcpMessage } from "./framing";
import {
  AcpError,
  JSON_RPC_ERROR_CODES,
  invalidParams,
  invalidRequest,
  notificationMessage,
  type JsonRpcErrorObject,
  type JsonRpcNotificationMessage,
  type JsonRpcResponseMessage,
} from "./jsonrpc";
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  KERYX_AGENT_CAPABILITIES,
  KERYX_AUTH_METHODS,
  negotiateProtocolVersion,
  requireObjectParams,
  requireStringField,
  SYSTEM_NOTE_META,
  textBlock,
  type AcpClientCapabilities,
  type AcpImplementation,
  type AcpInitializeResponse,
  type AcpListSessionsResponse,
  type AcpLoadSessionResponse,
  type AcpNewSessionResponse,
  type AcpPlanEntry,
  type AcpPromptResponse,
  type AcpReadTextFileRequest,
  type AcpReadTextFileResponse,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionInfo,
  type AcpSessionNotification,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
  type AcpSetSessionConfigOptionResponse,
  type AcpStopReason,
} from "./protocol";
import { acceptIssueTurn, startIssueSessionActivity, answerIssueQuestion, issueContextForSession, issueQuestionsToRestore, finishIssueQuestionRecovery, rememberIssueQuestion, settleIssueTurn } from "../session/issues/runtime";
import { renderAcpPrompt } from "./prompt-content";
import { AcpSessionRegistry, AcpSessionTranscriptUnreadableError, syncAcpArchive, type AcpSessionState } from "./session";
import { SessionMcpGrants } from "./mcp-grants";
import { catalogDestructiveResolver, catalogFingerprintResolver } from "../mcp-servers/approval-render";
import {
  acpMcpSetKey,
  firstPartyFloorExempt,
  parseAcpMcpServers,
  startAcpSessionMcp,
  type AcpMcpServerProblem,
  type AcpSessionMcp,
  type ParsedAcpMcpServers,
} from "./session-mcp";
import type { ConnectFn } from "../mcp-servers/manager";
import type { JsonRpcId } from "./jsonrpc";
import type { McpToolBinding } from "../commands/interactive-agent-tools";
import { DEFAULT_PERMISSION_MODE, isPermissionMode, type PermissionMode } from "../commands/permission-mode";
import { createDefaultSearchProviderController, type SearchProviderController } from "../harness/search";
import { ASK_USER_CANCEL, type AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import { createJobRegistry, type JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { NormalizedUsage } from "../harness/provider/types";
import { getProjectPermissionMode } from "../lib/permission-mode-config";
import { mergeCatalogs } from "../mcp-servers/catalog";
import { createMcpRuntime, within, type McpRuntime } from "../mcp-servers/runtime";
import { acpMcpBinds, mergeAcpMcp } from "./merged-mcp";
import { getExecutionPlan, subscribeExecutionPlans, type ExecutionPlan } from "../session/execution-plan";
import { askUserAnswerFromResult, askUserParams, clientAnswersAskUser } from "./ask-user";
import {
  acpModeState,
  DEFAULT_ACP_PROFILE,
  KERYX_ACP_EXTENSION_METHODS,
  keryxAcpInfo,
  keryxAcpProfileMeta,
  type AcpProfile,
} from "./profile";
import { buildAcpShellSessionTools, clientShowsOperatorCards, withHostToolCallId, type AcpShellRosterInput } from "./shell-roster";
import type { ShellConfirmAction, ShellView } from "./shell-views";
import type { FlatPickerProvider } from "../harness/routing/table";
import { ROUTING_AVAILABILITY_TTL_MS } from "../harness/routing/snapshot-adapter";
import { withSessionProvider } from "../commands/spawn-deps";
import { createProvidersHandlers, type AcpProvidersSeams } from "./providers";
import { createTasksHandlers, taskEventSink } from "./shell-tasks";
import { clientPreparesReview, type RequestReviewDraft } from "./prepare-review";
import { PREPARE_REVIEW_METHOD } from "./review-draft";
import { SESSION_REVIEW_REQUEST_METHOD, SESSION_REVIEWS_METHOD } from "./session-reviews-contract";
import { settleSessionReviews } from "../review/session/service";
import { recordSessionReviewRequest, readVisibleSessionReviews, sessionReviewSummaries, sessionReviewsTool } from "./session-reviews";
import { clientRunsTerminal, createSessionExternalRuns, type DelegateTerminalLaunch, type DelegateTurnResult, type SessionExternalRuns } from "./shell-delegate";
import { capResultText, delegateResultNote, parseDelegateNote } from "./delegate-turn-hook";
import {
  clientTakesTerminalResults,
  isStoredTerminalResult,
  parseTerminalResultNote,
  parseTerminalResults,
  storedTerminalRuns,
  TERMINAL_RESULTS_PROMPT,
  trailingNotesAwaitingTurn,
  terminalResultNote,
  terminalResultsMeta,
  terminalResultText,
  type TerminalResult,
} from "./terminal-result";
import type { RunExternalFn, CreateRunExternalOptions } from "../harness/run-external-factory";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import { busyRefusalText, findShellCommand, shellAvailableCommands, viewNotServedText } from "./shell-commands";
import {
  createAcpSessionRewind,
  runShellTextCommand,
  type AcpSessionRewind,
  type ShellCommandEffect,
  type ShellCommandHost,
  type ShellCommandOutcome,
} from "./shell-command-runners";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";

export interface AcpServerOptions {
  /** Test-only binding seam. Production keeps Telegram session control disabled. */
  readonly telegramBindingTestOnly?: { create?: TelegramBindingDependencies["create"] };
  /** Trusted host composition gate; absent by default, never set from an ACP request. */
  readonly telegramSessionEnabled?: boolean;
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (chunk: string) => void;
  readonly logError: (line: string) => void;
  /**
   * The provider every turn runs against. Absent only together with
   * `providerUnavailable` (flow 287, AC2): the connection still initialises,
   * and every `session/new`/`session/load` is refused with that message —
   * never answered by a stand-in.
   */
  readonly provider?: ProviderPort;
  /** Why there is no provider, naming what to configure and how. Sent as the refusal. */
  readonly providerUnavailable?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly agentInfo?: AcpImplementation;
  readonly dataDir?: string;
  /** Test seam for `_keryx/session_trash`: where the trash is (default: the user's real one). */
  readonly trash?: Pick<TrashOptions, "home" | "platform" | "env">;
  /** Test seam for `_keryx/session_flags`: how long a write waits for another process's flags lock (default: the store's). */
  readonly sessionFlagsLock?: FlagsLockTiming;
  readonly idSeq?: () => string;
  /** Test seam: how a client-supplied MCP server is dialled. The shared dial procedure otherwise. */
  readonly mcpConnect?: ConnectFn;
  /** Parent environment for client-supplied MCP servers (secrets stripped). `process.env` otherwise. */
  readonly mcpEnv?: Record<string, string | undefined>;
  /**
   * The per-turn settings `keryx shell` would apply to this provider
   * (`resolveAcpTurnSettings` in `../commands/acp.ts`). Empty = the agent's
   * own defaults.
   */
  readonly turnSettings?: AcpTurnSettings;
  /**
   * Where the models a session can switch to come from, and how one is built
   * (flow 288, AC5/AC6) — `shellModelSource` in `../commands/acp.ts`, which is
   * `keryx shell`'s picker source and provider factory. Absent: the launch
   * model is the only choice.
   */
  readonly models?: AcpModelSource;
  /** Live routing evidence, distinct from cached picker choices. */
  readonly routingProviders?: (force: boolean) => Promise<readonly FlatPickerProvider[]>;
  /**
   * Called after an EXPLICIT model switch (`session/set_config_option` or
   * `/model`) took effect: never per turn, never on a load's restore. The CLI
   * saves it as `keryx shell`'s saved provider/model, so the terminal and the
   * desktop agree on the default. Best-effort: a throw is logged, not raised.
   */
  readonly rememberModel?: (choice: AcpModelChoice) => void;
  /**
   * The longest a `session/new`/`session/load` waits for the model list
   * (flow 288, T14). `DEFAULT_MODEL_LIST_TIMEOUT_MS` otherwise.
   */
  readonly modelListTimeoutMs?: number;
  /**
   * Environment `buildShellHookRuntime` (flow 306, W6, T15) reads
   * `KERYX_HOOKS`/config-dir overrides from, for each ACP session's hook
   * runtime — `process.env` by default, matching every other real entry
   * point. Exists as its own seam (rather than reusing `mcpEnv`, which is
   * about a DIFFERENT concern — the parent env client-supplied MCP servers
   * inherit) so an in-process test harness can force `KERYX_HOOKS: "off"`:
   * `resolveKeryxArgv`'s `[execPath, scriptPath, ...rest]` fallback resolves
   * `scriptPath` from `process.argv[1]`, which for `bun test` running
   * `runAcpServer` in-process is the TEST RUNNER's own entry, not `keryx`'s
   * — a real subprocess launch of `keryx acp` (`AcpProcessClient`'s
   * `*.process.test.ts` suites) has no such problem and leaves this unset.
   */
  readonly hooksEnv?: NodeJS.ProcessEnv;
  /**
   * Aborted to stop the connection now (SIGTERM/SIGINT in the CLI): input is
   * no longer awaited, running turns are aborted, and every client MCP server
   * is stopped before `runAcpServer` resolves.
   */
  readonly shutdown?: AbortSignal;
  /**
   * `keryx acp --profile` (Keryx Desktop Client M1, specification §3). `editor`
   * (the default) is the narrowed editor agent, unchanged; `shell` adds the
   * `keryx shell` roster, permission modes, `ask_user`, and plan/usage/title
   * updates.
   */
  readonly profile?: AcpProfile;
  /** Shell profile: a project's stored default mode. `getProjectPermissionMode` otherwise. */
  readonly permissionModeDefault?: (projectRoot: string) => PermissionMode | undefined;
  /**
   * Shell profile: keryx's own configured MCP servers for a project root, built
   * the way `keryx shell` builds them (`createMcpRuntime`). One per root per
   * connection, started lazily by the first turn and closed when the
   * connection ends. `configured` answers whether `start` would give a
   * runtime WITHOUT starting one (`/status` asks it). `KERYX_MCP_RUNTIME`
   * otherwise: every root gets a runtime. Test seam.
   */
  readonly keryxMcp?: AcpKeryxMcpSource;
  /** Shell profile: `web_search`/`web_fetch`'s controller. `createDefaultSearchProviderController()` otherwise. */
  readonly searchController?: SearchProviderController;
  /**
   * Shell profile: builds the provider a `spawn_subagent` child runs on, the way `keryx shell`'s
   * factory does (`realMakeProvider`). Absent: a child can run only on its parent's own model.
   */
  readonly makeProvider?: (providerId: string, modelId: string, baseUrl?: string) => ProviderPort;
  /** Shell profile test seam: builds a session's roster. `buildAcpShellSessionTools` otherwise. */
  readonly buildShellRoster?: (input: AcpShellRosterInput) => InteractiveTool[];
  /** Shell profile: the user-global config directory `_keryx/command`'s settings commands read and write. The default one otherwise. Test seam. */
  readonly shellConfigDir?: string;
  /** Shell profile test seam for `/delegate`: the external-run port. `createLazyRunExternal` otherwise. */
  /** Test seam: the environment the external-agent gate reads for `/delegate` in a terminal (transport, CI markers). */
  readonly externalGateEnv?: Readonly<Record<string, string | undefined>>;
  readonly makeRunExternal?: (options: CreateRunExternalOptions) => RunExternalFn;
  /** Shell profile test seams for `_keryx/providers/*`: the config directory, environment and network it uses. */
  readonly providers?: AcpProvidersSeams;
}

export type { AcpTurnSettings } from "./models";

/** Where the shell profile gets keryx's own MCP runtime for a project root. */
export interface AcpKeryxMcpSource {
  /** Whether `start(root)` would give a runtime. Starts nothing. */
  readonly configured: (projectRoot: string) => boolean;
  readonly start: (projectRoot: string) => McpRuntime | undefined;
}

/** The production source: `keryx shell`'s runtime, which every root has (it may list no servers). */
const KERYX_MCP_RUNTIME: AcpKeryxMcpSource = {
  configured: () => true,
  start: (cwd) => createMcpRuntime({ cwd, gitRoot: cwd }),
};

/**
 * How long a shutdown waits for the turns it aborted to unwind and persist
 * before the sessions are released (PR #1213 review logic-w8 LOGIC-W8-001). A
 * turn still running past it loses its persist, as the process is exiting.
 */
const SHUTDOWN_TURN_GRACE_MS = 2_000;

/**
 * Shell profile: the most sessions one connection holds before an idle one is
 * released (PR #1213 r04, live sessions). Only a session with no running turn,
 * no running shell task and no request working on it is released; when every
 * held session is busy, all stay held and the new one is still opened.
 */
export const MAX_HELD_SESSIONS = 8;

/** The reason, and `SessionEnd` reason, of a session the idle cap released. */
export const IDLE_CAP_RELEASE_REASON = "idle-cap";

/** The `SessionEnd` reason of a session whose shell-profile `session/new`/`session/load` failed. */
const OPEN_FAILED_END_REASON = "session-open-failed";

/** The `SessionEnd` reason of a held session the client moved to the trash. */
const TRASHED_END_REASON = "session-trashed";

/** The ACP plan status for one keryx execution-plan status. */
function acpPlanStatus(status: string): AcpPlanEntry["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "completed" || status === "skipped") return "completed";
  return "pending";
}

/** A keryx execution plan as ACP `plan` entries; the keryx status rides in `_meta.keryx`. */
export function acpPlanEntries(plan: ExecutionPlan): AcpPlanEntry[] {
  return plan.items.map((item) => ({
    content: item.title,
    priority: "medium",
    status: acpPlanStatus(item.status),
    _meta: { keryx: { id: item.id, status: item.status } },
  }));
}

interface TokenTally {
  inputTokens: number;
  outputTokens: number;
}

const addUsage = (tally: TokenTally, usage: NormalizedUsage): TokenTally => ({
  inputTokens: tally.inputTokens + (usage.inputTokens ?? 0),
  outputTokens: tally.outputTokens + (usage.outputTokens ?? 0),
});

const DEFAULT_AGENT_INFO: AcpImplementation = { name: "keryx", version: "0" };

/** How long a new or loaded session waits for the model list before answering with the launch model only. */
export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 8_000;

function finishReasonToStopReason(finishReason: AgentFinishReason | undefined): AcpStopReason {
  switch (finishReason) {
    case "budget":
      return "max_tokens";
    case "tool-call-budget":
      return "max_turn_requests";
    case "interrupted":
      return "cancelled";
    case "no-progress":
    case undefined:
      return "end_turn";
  }
}

function refuse(error: JsonRpcErrorObject): never {
  throw new AcpError(error.code, error.message, error.data);
}

/** Runs one ACP agent-server connection to completion (until `input` ends). */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  let initialized = false;
  let clientCapabilities: AcpClientCapabilities | undefined;
  const profile: AcpProfile = options.profile ?? DEFAULT_ACP_PROFILE;
  const shellProfile = profile === "shell";
  const slashCommands = shellProfile ? ACP_SHELL_SLASH_COMMANDS : ACP_SLASH_COMMANDS;
  const idSeq = options.idSeq ?? (() => randomUUID());
  const registry = new AcpSessionRegistry({
    providerId: options.providerId,
    modelId: options.modelId,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
  });

  const writeMessage = (message: JsonRpcResponseMessage | JsonRpcNotificationMessage): void => {
    options.write(encodeAcpMessage(message));
  };

  const telegramQuestions = new Map<string, { sessionId: string; project: () => boolean; revoke: () => void }>();

  // This integration is not advertised and defaults closed until delegated turns,
  // permissions and question projection have their own trusted execution boundary.
  const telegramBindings = new TelegramSessionBindings({
    incarnation: randomUUID(),
    generation: () => randomUUID(),
    held: (sessionId) => {
      const state = registry.get(sessionId);
      return state === undefined ? undefined : { project: state.resolvedRoot, lease: state.lease };
    },
    owns: (sessionId, lease) => registry.get(sessionId)?.lease === lease && registry.canPersist(sessionId),
    create: options.telegramBindingTestOnly?.create ?? ((input) => new RemoteClient({
      sessionId: input.sessionId, project: input.project, owner: input.owner,
      ...(input.topicName === undefined ? {} : { name: input.topicName }),
      ...(options.shellConfigDir === undefined ? {} : { dir: options.shellConfigDir }),
      onLine: input.onLine, onStatus: input.onStatus, onChannelRevoked: input.onChannelRevoked,
    })),
    onStop: (sessionId, generation) => stopTelegramTurn(sessionId, generation),
    isBusy: (sessionId) => activeTurns.has(sessionId),
    onInput: async (input) => {
      if (activeTurns.has(input.sessionId) || opening.has(input.sessionId)) return "busy";
      if (stopping || !registry.canPersist(input.sessionId)) return "refused";
      const task = handleSessionPrompt({ sessionId: input.sessionId, prompt: [{ type: "text", text: input.text }] }, input);
      void task.catch(() => telegramBindings.send(input.sessionId, input.generation, "The Telegram turn failed.").catch(() => false));
      return "accepted";
    },
    onState: (state) => {
      if (state.state !== "active" && state.state !== "attaching") for (const pending of telegramQuestions.values()) if (pending.sessionId === state.sessionId) pending.revoke();
      writeMessage(notificationMessage(ACP_CLIENT_METHODS.sessionUpdate, { sessionId: state.sessionId, update: { sessionUpdate: "_keryx/telegram/session", telegram: state } }));
    },
  });

  function desktopTelegramOptedIn(): boolean {
    const keryx = clientCapabilities?._meta?.["keryx"];
    return typeof keryx === "object" && keryx !== null && (keryx as Record<string, unknown>).telegramSession === true;
  }

  function telegramControlEnabled(): boolean {
    return shellProfile && (options.telegramBindingTestOnly !== undefined || (options.telegramSessionEnabled === true && desktopTelegramOptedIn()));
  }

  async function handleTelegramSession(params: unknown): Promise<import("./telegram-session").TelegramSessionState> {
    requireInitialized(ACP_TELEGRAM_SESSION_METHOD);
    refuseIfStopping(ACP_TELEGRAM_SESSION_METHOD);
    const request = parseTelegramSessionRequest(params);
    if (request === undefined) refuse(invalidParams(`${ACP_TELEGRAM_SESSION_METHOD}: invalid request`));
    const state = registry.get(request.sessionId);
    if (state === undefined || !registry.canPersist(request.sessionId)) {
      return { sessionId: request.sessionId, state: "unavailable", reason: "lease-lost" };
    }
    if (!telegramControlEnabled()) return unavailableTelegramSession(request.sessionId);
    if (request.operation === "attach" && options.telegramBindingTestOnly === undefined) {
      const status = await new ChannelsClient({ dir: options.shellConfigDir }).status();
      if (!status.ok) return { sessionId: request.sessionId, state: "unavailable", reason: "serve-unavailable" };
      const capability = (status.value as unknown as { capabilities?: { desktopTelegram?: unknown } }).capabilities?.desktopTelegram;
      if (capability !== 1) return unavailableTelegramSession(request.sessionId);
      if (status.value.telegram.state !== "connected") return { sessionId: request.sessionId, state: "unavailable", reason: "pairing-required" };
      if (registry.get(request.sessionId) !== state || !registry.canPersist(request.sessionId)) return { sessionId: request.sessionId, state: "unavailable", reason: "lease-lost" };
    }
    if (request.operation === "status") return telegramBindings.status(request.sessionId);
    if (request.operation === "detach") return telegramBindings.detach(request.sessionId);
    return telegramBindings.attach(request.sessionId, request.topicName);
  }

  /**
   * Work to run right AFTER the reply to one request id has been written.
   *
   * A `session/update` for a session is only meaningful to a client that has
   * been told the session exists, i.e. after `session/new`'s response. The
   * MCP start-up report below is the one notification keryx emits outside a
   * turn, so it is ordered by this hook rather than by a timer.
   */
  const afterReply = new Map<string, (() => void)[]>();
  const replyKey = (id: JsonRpcId): string => JSON.stringify(id);
  const onReplied = (id: JsonRpcId, work: () => void): void => {
    const key = replyKey(id);
    afterReply.set(key, [...(afterReply.get(key) ?? []), work]);
  };

  /**
   * Client-supplied MCP servers (flow 287, AC3), SHARED per connection.
   *
   * Zed keeps one agent process and sends its whole `mcpServers` list with
   * every `session/new` — every new thread. Starting a set per session would
   * hold N threads × M servers child processes until stdin closed. So a
   * running set is keyed by the CONTENT of the list it was started from
   * (`acpMcpSetKey`: every entry's name, command, args, env and working
   * directory, hashed), and every session that sends the same list binds to
   * the one set.
   *
   * Reference-counted by binding rather than kept for the whole connection:
   * ACP gives a session no end (keryx advertises no `session/close`), so the
   * unbinds are an editor-profile `session/load` rebinding a session to a
   * different list and, in the shell profile, the idle cap releasing a session
   * (`teardownSession`) — and when that leaves a set with no session, it is
   * stopped then instead of lingering. Everything still running is stopped when
   * the connection ends.
   */
  interface SharedMcpSet {
    readonly key: string;
    readonly mcp: AcpSessionMcp;
    readonly sessions: Set<string>;
  }
  const mcpSets = new Map<string, SharedMcpSet>();
  const sessionMcp = new Map<string, SharedMcpSet>();
  /** Closes started by an unbind, awaited at connection close with the rest. */
  const retiring: Promise<void>[] = [];

  const sendUpdate = (sessionId: string, update: AcpSessionUpdate): void => {
    const notification: AcpSessionNotification = { sessionId, update };
    writeMessage(notificationMessage(ACP_CLIENT_METHODS.sessionUpdate, notification));
  };

  const clientRequests = new AcpClientRequests({
    send: (message) => {
      options.write(encodeAcpMessage(message));
    },
    idSeq,
  });

  /**
   * Set false the first time this client proves it cannot answer a permission
   * request (it refused the method, or answered something that is not an
   * answer).
   *
   * ACP v1 has NO client capability for permissions — `ClientCapabilities` is
   * `fs`, `terminal`, `session`, `auth`, `elicitation` and nothing else, and
   * the spec simply requires every client to implement
   * `session/request_permission`. So "this client cannot be asked" is not
   * something keryx can read off `initialize`; it is something it DISCOVERS,
   * once, from the first answer. After that every gated call is denied
   * locally: asking again would flood a client that already said it has no
   * such method, and — the part that matters for AC3 — a call nobody can
   * authorise must not run. Denied, never approved-by-default.
   */
  let clientAnswersPermissions = true;

  /**
   * One `session/prompt` in flight for one session (flow 285, T10 — AC4).
   *
   * `controller` is the `AbortSignal` source `runAgentTurn` runs with — the
   * SAME mechanism a local UI hard-stop uses (`RunAgentTurnOptions.signal`,
   * `context.md` §"the mapping"). `cancelled` is what makes the outcome
   * distinguishable from an ordinary finish: F-5 of context.md is that
   * `RunAgentTurnResult.finishReason` is `undefined` on most abort paths,
   * identical to a clean toolless finish at the return-value level (only an
   * abort during a subagent's `submit_result` wrap-up reports `"interrupted"`,
   * flow 347 R2-4) — the adapter has to remember the abort itself rather than
   * read it off the result. `permissionRequestIds` is the live set of this turn's own
   * `session/request_permission` requests (usually 0 or 1; never another
   * session's) — F-14's seam for settling only THIS turn's pending ask on
   * cancel, not every question on the connection (`AcpClientRequests.close`
   * would do that, and is reserved for stdin actually ending).
   */
  interface AcpActiveTurn {
    readonly controller: AbortController;
    cancelled: boolean;
    readonly permissionRequestIds: Set<string>;
    readonly telegramGeneration?: string;
  }
  const activeTurns = new Map<string, AcpActiveTurn>();

  /**
   * Flow 306 (W6, T15): one `keryx shell` lifecycle hook runtime per ACP
   * session, bound to the session's `resolvedRoot` and built `interactive:
   * true` — ACP has a permission-requesting client on the other end of this
   * connection (`session/request_permission`, `permission.ts`), the same
   * "an operator is present, just over a different transport" reasoning
   * `handleSessionPrompt` already gives for leaving `AgentDeps.unattended`
   * unset. `monitored-trusted-local` mirrors `keryx shell`'s own fixed
   * construction-time profile (`commands/shell.ts`'s `getShellHooks`) rather
   * than tracking a live `/plan`-style toggle — ACP has no such toggle today.
   *
   * Built once per session (`session/new` or `session/load`), not per turn:
   * a fresh `HookRuntime` per turn would re-read both config files and reset
   * `inheritedHookIds()`'s dedup/first-edit-in-session state for no reason,
   * exactly like the interactive shell's own reasoning. `session/load`
   * REPLACES the registry entry for its `sessionId` (same hazard as
   * `AcpSessionState.history`, see `AcpActiveTurn`'s doc above), so it also
   * replaces this session's hook runtime, keyed by the same id.
   */
  const shellHooksBySession = new Map<string, ShellHookContext>();
  /**
   * Flow 347 T17: one control-nudge nonce per ACP session, created on its first
   * prompt and reused by every later turn, so nudges already in its history
   * keep matching the marker its instruction states. Never pruned per session:
   * ACP gives a session no end (keryx advertises no `session/close`, see the
   * `SharedMcpSet` doc above), so like `shellHooksBySession` the map lives for
   * the connection and goes with `runAcpServer`'s scope.
   */
  const controlNonceBySession = new Map<string, string>();
  const controlNonceFor = (sessionId: string): string => {
    let nonce = controlNonceBySession.get(sessionId);
    if (nonce === undefined) {
      nonce = generateControlNonce();
      controlNonceBySession.set(sessionId, nonce);
    }
    return nonce;
  };

  // -------------------------------------------------------------------------
  // Shell profile state (Keryx Desktop Client M1, specification §3.3–§3.6).
  // Every map below stays empty in the editor profile.
  // -------------------------------------------------------------------------

  /** Each session's permission mode — read fresh on every gated call (`AgentIO.permissionMode`). */
  const sessionModes = new Map<string, PermissionMode>();
  const permissionModeDefault = options.permissionModeDefault ?? ((root: string) => getProjectPermissionMode(root));
  const initialModeFor = (root: string): PermissionMode => {
    try {
      return permissionModeDefault(root) ?? DEFAULT_PERMISSION_MODE;
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
  };
  const modeOf = (sessionId: string): PermissionMode => sessionModes.get(sessionId) ?? DEFAULT_PERMISSION_MODE;

  /**
   * One shell-task supervisor per ACP session, kept across `session/load` of the
   * same id (a load replaces the history, not the tasks it started), and swept —
   * every task killed — only when the session is released: by the idle cap,
   * which never picks a session with a running task, or when the connection
   * ends (`teardownSession`). Opening or loading another session leaves it running.
   */
  const sessionJobs = new Map<string, JobRegistry>();
  const jobsFor = (sessionId: string, root: string): JobRegistry => {
    let jobs = sessionJobs.get(sessionId);
    if (jobs === undefined) {
      // Shell profile: the Tasks panel hears of a task starting, going to the background and
      // exiting (`_keryx/tasks/event`, specification §3.9.5). The editor profile has no panel.
      const created: { registry?: JobRegistry } = {};
      jobs = createJobRegistry({
        cwd: root,
        childEnv: { KERYX_REVIEW_SESSION_ID: sessionId, KERYX_REVIEW_SESSION_OWNER: JSON.stringify(readProcessIdentity(process.pid)),
          KERYX_REVIEW_SESSION_DATA_DIR: options.dataDir ?? "", KERYX_REVIEW_SESSION_PROJECT_ROOT: root },
        ...(shellProfile
          ? {
              onEvent: taskEventSink(
                sessionId,
                () => created.registry,
                (method, params) => {
                  if (!stopping) writeMessage(notificationMessage(method, params));
                },
              ),
            }
          : {}),
      });
      created.registry = jobs;
      jobs.onCompletion(() => {
        if (activeTurns.has(sessionId)) return;
        settleSessionReviews(root, sessionId, jobs?.activeTaskTokens?.());
      });
      sessionJobs.set(sessionId, jobs);
    }
    return jobs;
  };

  /** `/plan`: each session's read-only flag, read fresh by every gated call (`AgentIO.readOnly`). */
  const sessionReadOnly = new Map<string, boolean>();
  /** `/rewind`: one snapshot recorder and readline state machine per session, built on first use. */
  const sessionRewinds = new Map<string, AcpSessionRewind>();
  /** `/delegate`: each session's external runs (§3.9.4), built on first use; stopped by a cancel or a release. */
  const sessionExternalRuns = new Map<string, SessionExternalRuns>();
  /** Delegate-result notes that arrived while the session's turn was running; they join the history when it ends. */
  const pendingDelegateNotes = new Map<string, string[]>();
  /**
   * `/goal`: each session's slate ref, as the shells keep one per session (`opened: false` until the
   * goal opens it) and the goal turn text a turn must carry to skip the close-phrase check once.
   */
  const sessionSlates = new Map<string, { ref: SlateSessionRef; goalPrompt?: string }>();

  let searchController: SearchProviderController | undefined = options.searchController;
  const searchControllerFor = (): SearchProviderController => (searchController ??= createDefaultSearchProviderController());

  /** Where keryx's own MCP runtime comes from: the test seam, else `KERYX_MCP_RUNTIME`. */
  const keryxMcpSource = options.keryxMcp ?? KERYX_MCP_RUNTIME;
  /** keryx's configured MCP servers, one runtime per project root, built lazily as `keryx shell` does. */
  const keryxMcpRuntimes = new Map<string, McpRuntime | undefined>();
  /**
   * Whether `keryxMcpFor(root)` gives a runtime — answered without starting
   * one. The one owner of that rule: `keryxMcpFor` builds by it, and `/status`
   * reports by it.
   */
  const keryxMcpWouldBind = (root: string): boolean => {
    if (keryxMcpRuntimes.has(root)) return keryxMcpRuntimes.get(root) !== undefined;
    if (stopping) return false;
    return keryxMcpSource.configured(root);
  };
  const keryxMcpFor = (root: string): McpRuntime | undefined => {
    if (!keryxMcpRuntimes.has(root)) {
      keryxMcpRuntimes.set(root, keryxMcpWouldBind(root) ? keryxMcpSource.start(root) : undefined);
    }
    return keryxMcpRuntimes.get(root);
  };

  // Only this exact, non-sensitive presentation question is eligible; free-form,
  // model-supplied action/policy flags and every other question remain Desktop-only.
  function vettedFormatQuestion(request: Parameters<AskUserFn>[0]): boolean {
    return request.question === "Which response format do you prefer?" && request.options.length === 2 &&
      request.options[0]?.label === "Concise" && request.options[1]?.label === "Detailed" &&
      request.options.every((option) => /^[A-Za-z0-9_-]{1,64}$/.test(option.id)) && request.options[0]?.id !== request.options[1]?.id &&
      !request.allowFreeform && !request.irreversible && !request.untrustedContent && request.action === undefined && request.policy === undefined && request.source === undefined;
  }

  async function askVettedQuestion(sessionId: string, request: Parameters<AskUserFn>[0], turn: AcpActiveTurn, generation: string): Promise<import("../lib/ask-user-contract").AskUserAnswer> {
    const projection = new AbortController();
    let requestId: string | undefined;
    let projected = false;
    const decision = new ProjectedDecision<string>({
      deadline: Date.now() + 300_000,
      current: (source) => !turn.cancelled && activeTurns.get(sessionId) === turn && registry.canPersist(sessionId) && (source === "desktop" || telegramBindings.isCurrent(sessionId, generation)),
      validate: (answer): answer is string => typeof answer === "string" && request.options.some((option) => option.id === answer),
      onSettled: (outcome) => {
        if (outcome.kind !== "answered" || outcome.source !== "telegram") projection.abort(outcome.kind === "answered" ? "shell" : "cancelled");
        if (requestId !== undefined && (outcome.kind !== "answered" || outcome.source !== "desktop")) {
          if (clientRequests.cancel(requestId, "the question was settled elsewhere")) sendUpdate(sessionId, { sessionUpdate: "_keryx/telegram/decision", requestId, phase: "closed" });
        }
      },
    });
    const cancel = (): void => decision.cancel();
    turn.controller.signal.addEventListener("abort", cancel, { once: true });
    const params = askUserParams(sessionId, request);
    const keryx = params._meta?.["keryx"];
    const projectedParams = { ...params, _meta: { ...params._meta, keryx: { ...(typeof keryx === "object" && keryx !== null ? keryx : {}), telegramProjectable: true } } };
    const desktop = clientRequests.request(KERYX_ACP_EXTENSION_METHODS.askUser, projectedParams, (id) => {
      requestId = id;
      turn.permissionRequestIds.add(id);
      telegramQuestions.set(id, { sessionId, revoke: () => projection.abort("cancelled"), project: () => {
        if (projected || projection.signal.aborted || !telegramBindings.isCurrent(sessionId, generation)) return false;
        projected = telegramBindings.projectChoice(sessionId, generation, projection.signal, (index, actor) => {
          if (!Number.isSafeInteger(actor) || actor <= 0 || (index !== 0 && index !== 1)) return false;
          const option = request.options[index];
          return option !== undefined && decision.claim("telegram", option.id);
        });
        return projected;
      } });
    });
    void desktop.then((outcome) => {
      if (outcome.kind !== "result" || !decision.claim("desktop", askUserAnswerFromResult(outcome.result, request))) decision.cancel();
    }, () => decision.cancel());
    if (turn.controller.signal.aborted) decision.cancel();
    const result = await decision.result;
    turn.controller.signal.removeEventListener("abort", cancel);
    if (requestId !== undefined) { telegramQuestions.delete(requestId); turn.permissionRequestIds.delete(requestId); }
    return result.kind === "answered" ? result.value : ASK_USER_CANCEL;
  }

  function handleProjectTelegramQuestion(params: unknown): { projected: boolean } {
    requireInitialized("_keryx/telegram/project-question");
    refuseIfStopping("_keryx/telegram/project-question");
    const value = requireObjectParams(params, "_keryx/telegram/project-question");
    const sessionId = requireStringField(value, "sessionId", "_keryx/telegram/project-question");
    const requestId = requireStringField(value, "requestId", "_keryx/telegram/project-question");
    if (Object.keys(value).some((key) => key !== "sessionId" && key !== "requestId") || !telegramControlEnabled() || !registry.canPersist(sessionId)) return { projected: false };
    const pending = telegramQuestions.get(requestId);
    return { projected: pending?.sessionId === sessionId && pending.project() };
  }

  /** `_keryx/ask_user` for one session; every non-answer is a declined question. */
  const askClientFor = (sessionId: string): AskUserFn => async (request) => {
    const turn = activeTurns.get(sessionId);
    if (turn?.cancelled === true) return ASK_USER_CANCEL;
    const generation = telegramBindings.currentGeneration(sessionId);
    if (generation !== undefined && turn !== undefined && telegramControlEnabled() && vettedFormatQuestion(request)) return askVettedQuestion(sessionId, request, turn, generation);
    if (generation !== undefined) void telegramBindings.send(sessionId, generation, "Waiting for the Desktop operator to answer a question.").catch(() => false);
    let requestId: string | undefined;
    const outcome = await clientRequests.request(KERYX_ACP_EXTENSION_METHODS.askUser, askUserParams(sessionId, request), (id) => {
      requestId = id;
      // Settled by `session/cancel` exactly like a pending permission ask.
      turn?.permissionRequestIds.add(id);
    });
    if (requestId !== undefined) turn?.permissionRequestIds.delete(requestId);
    if (outcome.kind === "error") {
      options.logError(
        `acp: ${KERYX_ACP_EXTENSION_METHODS.askUser} refused by the client (${outcome.error.code}: ${outcome.error.message}); ` +
          "the question counts as declined",
      );
      return ASK_USER_CANCEL;
    }
    if (outcome.kind === "closed") {
      options.logError(`acp: ${KERYX_ACP_EXTENSION_METHODS.askUser} went unanswered (${outcome.reason}); the question counts as declined`);
      return ASK_USER_CANCEL;
    }
    return askUserAnswerFromResult(outcome.result, request);
  };

  const openIssueAsks = new Map<string, ReturnType<AskUserFn>>();
  const askUserFor = (sessionId: string): AskUserFn => async (request) => {
    const state = registry.get(sessionId);
    const bound = state && issueContextForSession(state.handle.dir, options.dataDir);
    if (!state || !bound?.launch.flow) return askClientFor(sessionId)(request);
    const saved = rememberIssueQuestion(state.handle.dir, bound, request);
    if (saved.answer !== undefined) return saved.answer;
    const key = sessionId + "/" + saved.id;
    const waiting = openIssueAsks.get(key);
    if (waiting) return waiting;
    const ask = askClientFor(sessionId)(request);
    openIssueAsks.set(key, ask);
    try {
      const answer = await ask;
      if (registry.canPersist(sessionId)) answerIssueQuestion(state.handle.dir, saved, answer);
      return answer;
    } finally { openIssueAsks.delete(key); }
  };

  const reviewDraftFor = (sessionId: string): RequestReviewDraft => async hints => {
    const turn = activeTurns.get(sessionId);
    if (!turn || turn.cancelled || stopping) return false;
    let requestId: string | undefined;
    try {
      const outcome = await clientRequests.request(PREPARE_REVIEW_METHOD, { sessionId, ...hints }, id => {
        requestId = id;
        turn.permissionRequestIds.add(id);
      });
      return outcome.kind === "result" && (outcome.result as { prepared?: unknown } | null)?.prepared === true;
    } finally {
      if (requestId !== undefined) turn.permissionRequestIds.delete(requestId);
    }
  };

  function recoveryMeta(state: AcpSessionState): Pick<AcpLoadSessionResponse, "_meta"> {
    if (shellProfile && clientAnswersAskUser(state.clientCapabilities) && issueContextForSession(state.handle.dir, options.dataDir)?.launch.flow
      && issueQuestionsToRestore(state.handle.dir).length) return { _meta: { keryx: { pendingIssueQuestions: true } } };
    return {};
  }

  /** Entered only by a client-owned prompt after the load reply and session admission. */
  async function resumeIssueQuestions(state: AcpSessionState): Promise<AcpPromptResponse> {
    const { sessionId } = state;
    if (!shellProfile || !clientAnswersAskUser(state.clientCapabilities) || !issueContextForSession(state.handle.dir, options.dataDir)?.launch.flow)
      throw new Error("This session cannot resume issue questions.");
    const questions = issueQuestionsToRestore(state.handle.dir);
    if (!questions.length) return { stopReason: "end_turn" };
    const slot: AcpActiveTurn = { controller: new AbortController(), cancelled: false, permissionRequestIds: new Set() };
    activeTurns.set(sessionId, slot);
    const answers = [];
    try {
      for (const q of questions) {
        const answer = q.answer ?? await askClientFor(sessionId)(q.request);
        if (answer === ASK_USER_CANCEL || slot.cancelled || stopping || !registry.canPersist(sessionId)) return { stopReason: "cancelled" };
        if (q.answer === undefined) answerIssueQuestion(state.handle.dir, q, answer, true);
        answers.push({ question: q.request.question, answer });
      }
    } finally { if (activeTurns.get(sessionId) === slot) activeTurns.delete(sessionId); }
    const ids = new Set(questions.map(q => q.id));
    const uri = "keryx:issue-questions/" + [...ids].join("/");
    // If the process stopped after the conversation persisted this handoff, the existing turn owns the answers.
    if (state.history.some(message => message.role === "user" && message.content.includes(uri))) {
      finishIssueQuestionRecovery(state.handle.dir, ids);
      return { stopReason: "end_turn" };
    }
    const response = await handleSessionPrompt({ sessionId, prompt: [
      textBlock("Continue preparing the existing issue Flow using my saved answers. Check existing artifacts before resuming work."),
      { type: "resource", _meta: { keryx: { untrusted: true } }, resource: { uri, text: JSON.stringify(answers) } },
    ] });
    if (registry.canPersist(sessionId) && state.history.some(message => message.role === "user" && message.content.includes(uri)))
      finishIssueQuestionRecovery(state.handle.dir, ids);
    return response;
  }

  /** Token totals per session, for `usage_update`. */
  const sessionUsage = new Map<string, TokenTally>();

  /**
   * Execution-plan changes, from the plan tools' own store notification, mapped
   * back to the session whose directory they were written in.
   */
  const planDirSessions = new Map<string, string>();
  const unsubscribePlans = shellProfile
    ? subscribeExecutionPlans((dir, plan) => {
        const sessionId = planDirSessions.get(dir);
        if (sessionId !== undefined && !stopping) {
          sendUpdate(sessionId, { sessionUpdate: "plan", entries: acpPlanEntries(plan) });
        }
      })
    : () => {};

  /** One metaproject adapter per project root, as `keryx shell` builds one per session (its staleness cache lives in it). */
  const metaprojectAdapters = new Map<string, MetaprojectPort>();
  const metaprojectFor = (root: string): MetaprojectPort => {
    let port = metaprojectAdapters.get(root);
    if (port === undefined) {
      port = createMetaprojectAdapter(root);
      metaprojectAdapters.set(root, port);
    }
    return port;
  };

  /**
   * Each session's built roster (performance review F-001), reused by every turn
   * and `/status` until one of its inputs changes. The other inputs are fixed for
   * the session's registration: its job registry, the connection's search
   * controller, and closures that read the registry or the client live.
   */
  interface ShellRoster {
    readonly root: string;
    readonly clientCapabilities: AcpClientCapabilities | undefined;
    readonly clientMcp: SharedMcpSet | undefined;
    readonly keryxMcp: McpRuntime | undefined;
    readonly tools: InteractiveTool[];
  }
  const shellRosters = new Map<string, ShellRoster>();
  const buildShellRoster = options.buildShellRoster ?? buildAcpShellSessionTools;
  /** The cached roster when its inputs still hold. Never starts keryx's MCP runtime. */
  function cachedShellRoster(sessionId: string, state: AcpSessionState): InteractiveTool[] | undefined {
    const cached = shellRosters.get(sessionId);
    const root = state.resolvedRoot;
    if (
      cached === undefined ||
      cached.root !== root ||
      cached.clientCapabilities !== state.clientCapabilities ||
      cached.clientMcp !== sessionMcp.get(sessionId) ||
      !keryxMcpRuntimes.has(root) ||
      cached.keryxMcp !== keryxMcpRuntimes.get(root)
    ) {
      return undefined;
    }
    return cached.tools;
  }

  /**
   * Shell profile: live sessions (PR #1213 r04, owner decision on review
   * ui-ux-w3 UX-W3-R3-002). Every session a `session/new` or `session/load`
   * opens is HELD by the connection, beside the others: each keeps its own
   * turn, mode, model, usage, MCP set, plan routing, hook runtime and shell
   * tasks, and a turn in a session the client is not showing keeps running and
   * keeps sending its updates and requests, each with its `sessionId`. Opening
   * one session never releases another.
   *
   * Memory is bounded by the idle cap instead: past `MAX_HELD_SESSIONS`, the
   * least recently used session that is idle (`sessionIsBusy`) is released
   * (`teardownSession`) and the client is told with
   * `_keryx/session_released`, so a return to it does `session/load`. A
   * session is released only by that cap or by the connection's end.
   *
   * The editor profile holds every session until the connection ends, as
   * before: no cap, and its `session/load` still rebuilds the session.
   */
  /** Recency for the idle cap: a session is used when it is opened, prompted or configured. */
  const lastUsed = new Map<string, number>();
  let useClock = 0;
  const touch = (sessionId: string): void => {
    useClock += 1;
    lastUsed.set(sessionId, useClock);
  };
  /**
   * Requests working on a session outside its turn slot — a `session/new` or
   * `session/load` opening it, a `session/set_config_option` building its
   * provider. The idle cap never releases a session with one in flight.
   */
  const sessionWork = new Map<string, number>();
  async function withSessionWork<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    // Counted synchronously, before the first await, so a cap run that lands
    // during `work` already sees it.
    sessionWork.set(sessionId, (sessionWork.get(sessionId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (sessionWork.get(sessionId) ?? 1) - 1;
      if (left > 0) sessionWork.set(sessionId, left);
      else sessionWork.delete(sessionId);
    }
  }
  /** Shell profile: sessions a `session/new`/`session/load` is still opening. A second load of one is refused. */
  const opening = new Set<string>();
  /** Teardowns the idle cap or a failed open started, awaited with the rest when the connection ends. */
  const releasing = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    releasing.add(work);
    void work.finally(() => releasing.delete(work));
  };

  /**
   * Whether the idle cap must keep `sessionId`: a turn or slash command holds
   * its slot (every client request keryx sends — a permission, an ask_user, a
   * file read — belongs to one), a request is working on it, or one of its
   * shell tasks is still running.
   */
  function sessionIsBusy(sessionId: string): boolean {
    if (activeTurns.has(sessionId) || sessionWork.has(sessionId)) return true;
    const jobs = sessionJobs.get(sessionId);
    return jobs !== undefined && jobs.list({ includePrivate: true }).some((job) => job.status === "running");
  }

  /**
   * Shell profile, after a `session/new`/`session/load` succeeded: while the
   * connection holds more than `MAX_HELD_SESSIONS`, release the least recently
   * used idle one and tell the client. Every held session busy: all are kept.
   */
  function enforceIdleCap(): void {
    if (!shellProfile) return;
    for (;;) {
      const held = registry.ids();
      if (held.length <= MAX_HELD_SESSIONS) return;
      let victim: string | undefined;
      for (const sessionId of held) {
        if (sessionIsBusy(sessionId)) continue;
        if (victim === undefined || (lastUsed.get(sessionId) ?? 0) < (lastUsed.get(victim) ?? 0)) victim = sessionId;
      }
      if (victim === undefined) return;
      track(teardownSession(victim, IDLE_CAP_RELEASE_REASON));
      writeMessage(
        notificationMessage(KERYX_ACP_EXTENSION_METHODS.sessionReleased, { sessionId: victim, reason: IDLE_CAP_RELEASE_REASON }),
      );
    }
  }

  /**
   * Shell profile: a `session/new`, or a `session/load` of a session the
   * connection did not hold, failed. The session it opened goes back; the
   * client was never told it is open. The editor profile keeps it, as before.
   */
  function abandonOpen(sessionId: string): void {
    if (!shellProfile) return;
    track(teardownSession(sessionId, OPEN_FAILED_END_REASON));
  }

  /** `SessionEnd` for one session's hook runtime; a failing hook is logged, never thrown. */
  async function fireSessionEnd(hooks: ShellHookContext, endReason: string): Promise<void> {
    try {
      await hooks.runtime.fire("SessionEnd", { sessionId: hooks.sessionId, runId: hooks.runId, endReason });
    } catch (error) {
      options.logError(`acp: SessionEnd hook fire failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Everything this connection holds for one session, given back: the lease
   * and registry entry, its client MCP binding, its shell tasks (swept), its
   * plan routing, cached roster and model binding, and its hook runtime, whose
   * `SessionEnd` is fired with `endReason`. Synchronous up to the returned
   * sweep, so the lease is free when this returns. Idempotent. Runs on the
   * idle cap, a failed shell-profile open, and the connection's end.
   *
   * Kept, because they are small and the session's own if the client loads it
   * again (PR #1213 review degradation-w1 DEG-R2-001): its permission mode, its
   * usage tally, its reasoning override, its control nonce, and the model it
   * was on — as a choice only (`releasedModelChoices`); the provider binding is
   * dropped and rebuilt by `restoreRecordedModel` on the next load. The model
   * switch sequence is connection-wide and a reload is a new hold
   * (`holdGeneration`), so a switch from before the release never applies to
   * the reloaded session (review logic-w11 LOGIC-W11R3-001, logic-w7
   * LOGIC-W7-R3-001).
   */
  function teardownSession(sessionId: string, endReason: string): Promise<void> {
    const lease = registry.get(sessionId)?.lease;
    const telegramRelease = lease === undefined ? undefined : telegramBindings.release(sessionId, lease);
    registry.release(sessionId);
    lastUsed.delete(sessionId);
    for (const [dir, owner] of planDirSessions) {
      if (owner === sessionId) planDirSessions.delete(dir);
    }
    shellRosters.delete(sessionId);
    mcpGrants.delete(sessionId);
    unbindSessionMcp(sessionId);
    const model = sessionModels.get(sessionId);
    if (model !== undefined) releasedModelChoices.set(sessionId, model.choice.value);
    sessionModels.delete(sessionId);
    switchApplied.delete(sessionId);
    pendingLateModelList.delete(sessionId);
    sessionReadOnly.delete(sessionId);
    sessionRewinds.delete(sessionId);
    sessionExternalRuns.get(sessionId)?.stop("the session was released");
    sessionExternalRuns.get(sessionId)?.dispose();
    sessionExternalRuns.delete(sessionId);
    pendingDelegateNotes.delete(sessionId);
    sessionSlates.delete(sessionId);
    const jobs = sessionJobs.get(sessionId);
    sessionJobs.delete(sessionId);
    const hooks = shellHooksBySession.get(sessionId);
    shellHooksBySession.delete(sessionId);
    return Promise.all([telegramRelease, jobs?.sweepAll(), hooks !== undefined ? fireSessionEnd(hooks, endReason) : undefined]).then(() => undefined);
  }

  /** Bind a new or loaded shell-profile session: its mode, its plan directory, and what the client is told after the reply. */
  function bindShellSession(state: AcpSessionState, requestId: JsonRpcId): PermissionMode {
    const sessionId = state.sessionId;
    if (!sessionModes.has(sessionId)) sessionModes.set(sessionId, initialModeFor(state.resolvedRoot));
    const dir = state.handle.dir;
    planDirSessions.set(dir, sessionId);
    onReplied(requestId, () => {
      const title = state.handle.summary.title;
      if (typeof title === "string" && title.length > 0) {
        sendUpdate(sessionId, { sessionUpdate: "session_info_update", title, updatedAt: state.handle.summary.updatedAt });
      }
      void getExecutionPlan(dir)
        .then((plan) => {
          if (plan !== undefined && plan.items.length > 0 && !stopping) {
            sendUpdate(sessionId, { sessionUpdate: "plan", entries: acpPlanEntries(plan) });
          }
        })
        .catch(() => {
          // An unreadable plan file is shown as no plan, as the plan tools themselves treat it.
        });
    });
    return modeOf(sessionId);
  }

  /** Switch a session's mode (`session/set_mode` or `/mode`) and tell the client. */
  function setSessionMode(sessionId: string, mode: PermissionMode): void {
    sessionModes.set(sessionId, mode);
    sendUpdate(sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
  }

  /**
   * Build (or rebuild) THIS session's hook runtime and fire `SessionStart`
   * — called once from `handleSessionNew` and once from `handleSessionLoad`,
   * both "session creation" for hook-runtime purposes (a `session/load` binds
   * a durable session to a brand new in-process `HookRuntime`, just like a
   * restarted `keryx shell` resuming a session would).
   *
   * `KERYX_HOOKS=off` makes `buildShellHookRuntime` return `undefined` —
   * this session then simply has no entry in `shellHooksBySession`, and
   * `AgentDeps.hooks` stays unset for its turns (byte-identical to today).
   */
  async function ensureShellHooksAndFireStart(sessionId: string, resolvedRoot: string, requestId: JsonRpcId): Promise<void> {
    const shellHooks = buildShellHookRuntime({
      projectRoot: resolvedRoot,
      sessionId,
      runId: idSeq(),
      interactive: true,
      profileId: "monitored-trusted-local",
      // R700-01: ACP has no terminal to ask "trust this?" in — the notice
      // text must say so instead of pointing at a prompt no one will see.
      noticeSurface: "headless",
      ...(options.hooksEnv !== undefined ? { env: options.hooksEnv } : {}),
    });
    if (shellHooks === undefined) {
      shellHooksBySession.delete(sessionId);
      return;
    }
    shellHooksBySession.set(sessionId, shellHooks);
    // After the reply, like the MCP problems and the command list: a client
    // learns a new session's id from the `session/new` reply, so an update
    // sent before it is for a session the client does not know yet (PR #1213
    // review frontend-w3 FE-S03-002, logic-w4 LOGIC-W4R2-002).
    const notices = shellHooks.notices ?? [];
    onReplied(requestId, () => reportHookNotices(sessionId, notices));
    // SessionStart is never gate-capable (`GATE_CAPABLE_EVENTS` excludes it —
    // `harness/hooks/semantics.ts`'s own comment) — a hook here cannot refuse
    // the session, so this is fired for its side effects only and never
    // blocks `session/new`/`session/load` on a slow/failing hook beyond the
    // hook's own timeout.
    await shellHooks.runtime.fire("SessionStart", {
      sessionId: shellHooks.sessionId,
      runId: shellHooks.runId,
      projectRoot: resolvedRoot,
      policyProfile: "monitored-trusted-local",
    });
  }

  /**
   * ONE turn per session, at a time (flow 285, T16).
   *
   * A session's `history` array is mutated IN PLACE by `runAgentTurn` for the
   * session's whole lifetime (`session.ts`, `AcpSessionState.history`), so two
   * overlapping turns on one session id do not run "in parallel": they
   * interleave writes into the same transcript, persist each other's partial
   * state, and leave `activeTurns` holding one `AcpActiveTurn` where two are
   * live — which `session/cancel` could then only ever reach the newer of
   * (and whose `finally` would delete the other turn's slot). `session/load`
   * is the same hazard from the other side: it REPLACES the registry entry,
   * and therefore the history array a turn already running against the old
   * entry keeps writing to.
   *
   * Refused rather than queued: a client that sent a second prompt has not
   * been told the first one finished, and silently serialising would look like
   * a hung request. `invalidRequest` is the code this file already uses for a
   * request that is well-formed but not legal in the connection's current
   * state (`requireInitialized`), as opposed to `invalidParams` for a
   * malformed field or `resourceNotFound` for a session that does not exist.
   */
  function refuseIfBusy(method: string, sessionId: string): void {
    if (!activeTurns.has(sessionId)) {
      return;
    }
    refuse(
      invalidRequest({
        // The remedy names WAITING, not just cancelling: `session/cancel`
        // aborts the turn but does not free the slot by itself — the turn's own
        // `finally` does that once it observes the abort, which for a turn
        // parked in a long tool call is not immediate. A client told merely to
        // "cancel first" would re-prompt straight away and be refused again.
        reason:
          `${method}: a turn is already running for session ${sessionId}; ` +
          "wait for its session/prompt response — send session/cancel first if you do not want to wait for it to finish, " +
          "then prompt again once the cancelled turn has replied",
        method,
        sessionId,
        condition: "session-busy",
      }),
    );
  }

  /** Shell profile: refuses a request for a session whose open may still fail and tear it down. */
  function refuseIfOpening(method: string, sessionId: string): void {
    if (!opening.has(sessionId)) return;
    refuse(
      invalidRequest({
        reason: `${method}: session ${sessionId} is still being opened by an earlier session/new or session/load; wait for its reply`,
        method,
        sessionId,
        condition: "session-opening",
      }),
    );
  }

  /** Shapes, sends and interprets one `session/request_permission`. `undefined` = could not be asked. */
  const askPermissionFor = (sessionId: string, turn: AcpActiveTurn): AcpPermissionAsker => {
    return async (ask): Promise<AcpRequestPermissionResponse | undefined> => {
      // Flow 306 (W6, T15): wiring a real `HookRuntime` into `AgentDeps.hooks`
      // (above) puts a genuine process spawn — `firePreToolUseHook`'s built-in
      // command hooks — between `io.onToolCall`'s `tool_call` announcement and
      // THIS ask, where before there was none. That gap is exactly what
      // `session/cancel` racing right after the announcement (as a client
      // reasonably does: it has been shown the call, so it can act on it) can
      // now land inside: `handleSessionCancel` already ran and found nothing
      // in `turn.permissionRequestIds` to settle, because this call had not
      // registered itself yet. Checked here, before this id is even minted,
      // so a turn already cancelled by the time its gate resolves asks
      // nothing — it denies the same way an unanswerable client does, rather
      // than sending a `session/request_permission` no one will ever answer.
      if (turn.cancelled) {
        return undefined;
      }
      if (!clientAnswersPermissions) {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} not asked for ${ask.toolCall.name ?? "a tool call"}: ` +
            "this client already refused the method; the call is denied",
        );
        return undefined;
      }
      const params: AcpRequestPermissionRequest = {
        sessionId,
        toolCall: ask.toolCall,
        options: [...ask.options],
      };
      let requestId: string | undefined;
      const currentGeneration = telegramBindings.currentGeneration(sessionId);
      const generation = ask.telegramPrompt === undefined ? undefined : currentGeneration;
      if (generation === undefined && currentGeneration !== undefined) void telegramBindings.send(sessionId, currentGeneration, "Waiting for the Desktop operator to review a permission request.").catch(() => false);
      if (generation !== undefined && ask.telegramPrompt !== undefined) {
        try {
          return await raceTelegramApproval({
            desktop: () => clientRequests.request(ACP_CLIENT_METHODS.sessionRequestPermission, params, (id) => { requestId = id; turn.permissionRequestIds.add(id); }),
            cancelDesktop: () => {
              if (requestId !== undefined && clientRequests.cancel(requestId, "the decision was settled elsewhere")) {
                sendUpdate(sessionId, { sessionUpdate: "_keryx/telegram/decision", requestId, phase: "closed" });
              }
            },
            project: (signal, claim) => telegramBindings.projectApproval(sessionId, generation, ask.telegramPrompt!, 300_000, signal, claim),
            current: (source) => !turn.cancelled && activeTurns.get(sessionId) === turn && registry.canPersist(sessionId) && (source === "desktop" || telegramBindings.isCurrent(sessionId, generation)),
            turnSignal: turn.controller.signal,
            choices: ask.options,
            timeoutMs: 300_000,
          });
        } finally { if (requestId !== undefined) turn.permissionRequestIds.delete(requestId); }
      }
      const outcome = await clientRequests.request(
        ACP_CLIENT_METHODS.sessionRequestPermission,
        params,
        (id) => {
          requestId = id;
          turn.permissionRequestIds.add(id);
        },
      );
      if (requestId !== undefined) {
        // Settled one way or another (answered, errored, closed, or — F-14 —
        // cancelled out from under it by `handleSessionCancel`): it is no
        // longer a request `session/cancel` needs to reach.
        turn.permissionRequestIds.delete(requestId);
      }
      if (outcome.kind === "error") {
        // `-32601` here is a client with no permission surface at all; any
        // other error is a client that failed to answer this one. Both are
        // "not authorised", and both latch: a client that errors on the method
        // will error on the next one too.
        clientAnswersPermissions = false;
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} refused by the client ` +
            `(${outcome.error.code}: ${outcome.error.message}); the call is denied`,
        );
        return undefined;
      }
      if (outcome.kind === "closed") {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} went unanswered (${outcome.reason}); the call is denied`,
        );
        return undefined;
      }
      const result = outcome.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} answered with a non-object result; the call is denied`,
        );
        return undefined;
      }
      // The outcome's own shape is validated where it is interpreted
      // (`approvalFromPermissionResponse`), which denies anything that is not
      // an explicit allow — including a missing or malformed `outcome`.
      return result as AcpRequestPermissionResponse;
    };
  };

  /**
   * Flow 287, AC2: with no usable provider, a session is refused — with the
   * message that says what to configure — rather than created and then
   * answered by a stand-in. `initialize` is untouched: a client that cannot
   * initialise shows the operator nothing at all, not even this message.
   */
  /**
   * Set the moment a shutdown begins (flow 287, T14). The read loop is raced,
   * not cancelled, so a `session/new` can still be dispatched after
   * `closeAllMcp` has run — and a set it started then would never be closed.
   * Session work is refused from here on instead.
   */
  let stopping = false;
  function refuseIfStopping(method: string): void {
    if (stopping) {
      refuse({
        code: JSON_RPC_ERROR_CODES.invalidRequest,
        message: `${method}: keryx acp is shutting down`,
        data: { method, condition: "shutting-down" },
      });
    }
  }

  function requireProvider(method: string): ProviderPort {
    if (options.provider === undefined) {
      // The remedy goes in `message`, not only in `data`: `message` is the
      // field every client shows a person (Zed prints it in the thread), and
      // `invalidRequest`'s own message is a fixed "Invalid request".
      refuse({
        code: JSON_RPC_ERROR_CODES.invalidRequest,
        message: options.providerUnavailable ?? `${method}: keryx acp has no provider configured`,
        data: { method, condition: "provider-not-configured" },
      });
    }
    return options.provider;
  }

  /**
   * The model each session runs (flow 288, AC5/AC6).
   *
   * Per SESSION, because ACP's config options are: two threads in one editor
   * may run two models. A session that never switched runs the launch model.
   * A turn reads its session's entry ONCE, before it starts, and runs to the
   * end with that binding — so a switch that lands mid-turn (through
   * `session/set_config_option`, which is not refused while a turn runs)
   * changes the next turn, never the running one.
   */
  interface SessionModel {
    readonly choice: AcpModelChoice;
    readonly binding: AcpModelBinding;
  }
  const sessionModels = new Map<string, SessionModel>();
  /**
   * The model value a released shell-profile session was on (`teardownSession`
   * keeps the choice, not the provider binding). `restoreRecordedModel` prefers
   * it over the transcript's record when the session is loaded again.
   */
  const releasedModelChoices = new Map<string, string>();
  /**
   * Overlapping switches (flow 288, T14). Every switch — and a load's restore
   * — takes a number when it starts; a finished one is applied only if no
   * LATER-started one has been applied already. So the later request wins when
   * both succeed, and a later one that FAILS leaves the earlier one in effect
   * instead of discarding it.
   *
   * The number is connection-wide and never reset, and each switch also
   * carries the HOLD it started in: every time the connection starts holding a
   * session (`beginHold`, on a `session/new` or on a load of a session it did
   * not hold) the session gets a new hold number. A switch that finishes in a
   * later hold than its own — its session was released and loaded again
   * meanwhile — binds nothing (review logic-w11 LOGIC-W11R3-001, logic-w7
   * LOGIC-W7-R3-001).
   */
  let switchSeq = 0;
  let holdSeq = 0;
  const holdGeneration = new Map<string, number>();
  const switchApplied = new Map<string, number>();
  interface SwitchTicket {
    readonly seq: number;
    readonly hold: number | undefined;
  }
  function beginHold(sessionId: string): void {
    holdSeq += 1;
    holdGeneration.set(sessionId, holdSeq);
  }
  function beginSwitch(sessionId: string): SwitchTicket {
    switchSeq += 1;
    return { seq: switchSeq, hold: holdGeneration.get(sessionId) };
  }
  /** Applies a finished switch. `false`: its session is no longer the hold it started in, and nothing was bound. */
  function applySwitch(sessionId: string, ticket: SwitchTicket, next: SessionModel): boolean {
    if (registry.get(sessionId) === undefined || holdGeneration.get(sessionId) !== ticket.hold) return false;
    if (ticket.seq > (switchApplied.get(sessionId) ?? 0)) {
      switchApplied.set(sessionId, ticket.seq);
      sessionModels.set(sessionId, next);
    }
    return true;
  }
  /** `/reasoning <level>` for one session — the shell's session override, never saved. */
  const reasoningOverrides = new Map<string, ReasoningEffortLevel>();
  const launchChoice = acpModelChoice(options.providerId, options.modelId);
  /**
   * The model an operator last switched to explicitly on this connection. A NEW
   * session starts on it (when it is still a choice and can be bound), else on
   * the launch model, which is itself the saved selection unless flags said otherwise.
   */
  let rememberedValue: string | undefined;

  function launchModel(method: string): SessionModel {
    return {
      choice: launchChoice,
      binding: {
        provider: requireProvider(method),
        providerId: options.providerId,
        modelId: options.modelId,
        turnSettings: options.turnSettings ?? {},
      },
    };
  }

  function sessionModel(sessionId: string, method: string): SessionModel {
    return sessionModels.get(sessionId) ?? launchModel(method);
  }

  /**
   * Every model a session can switch to (flow 288, AC5; bounded in T14).
   *
   * The source probes the network, so it is started as soon as there is a
   * provider and a SUCCESSFUL answer is kept for the connection. What a
   * session waits for it is bounded by `modelListTimeoutMs`: a list that has
   * not arrived by then is not waited for — that session is offered the launch
   * model only, stderr says so, and the next session asks again (the same
   * in-flight request, or a fresh one if it failed). A slow or hung source can
   * therefore never hold `session/new` beyond the bound, and one bad moment is
   * not cached for the process lifetime. The launch model is always a choice.
   */
  const withLaunch = (listed: readonly AcpModelChoice[]): readonly AcpModelChoice[] =>
    listed.some((choice) => choice.value === launchChoice.value) ? listed : [launchChoice, ...listed];
  const modelListTimeoutMs = options.modelListTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
  let listedChoices: readonly AcpModelChoice[] | undefined;
  let listing: Promise<readonly AcpModelChoice[]> | undefined;
  /** Bumped when the providers change: a listing started before it is stale and must not become the cached list. */
  let listingGeneration = 0;
  const startListing = (source: AcpModelSource): Promise<readonly AcpModelChoice[]> => {
    const generation = listingGeneration;
    return (listing ??= source.choices().then(
      (listed) => {
        const choices = withLaunch(listed);
        if (generation === listingGeneration) listedChoices = choices;
        return choices;
      },
      (error: unknown) => {
        if (generation === listingGeneration) listing = undefined;
        throw error;
      },
    ));
  };
  /**
   * Sessions currently holding a configOptions built from the launch-only
   * list because THEIR wait timed out (flow 288, T15). Drained by
   * `armLateModelListNotify` once the specific listing they timed out on
   * settles — successfully or not — and by `modelChoices` itself the moment a
   * session's own next call sees the real list directly (nothing left to
   * notify it about).
   */
  const pendingLateModelList = new Set<string>();
  /**
   * `sessionId` timed out waiting on `listPromise` (the SAME in-flight
   * listing `modelChoices` raced against). If `listPromise` later resolves
   * with a usable list, that session is told once, with a `session/update`
   * carrying the complete `configOptions` — the one thing partial-list
   * sessions are never otherwise told (flow 288 review gap). Nothing is sent
   * when it fails (the next session simply asks again, as today), when the
   * connection has closed or shutdown began by the time it settles, or when
   * this session already got the full list some other way in the meantime
   * (`pendingLateModelList.delete` below returns `false` and this is a
   * no-op) — so a session is notified at most once per timeout.
   */
  function armLateModelListNotify(listPromise: Promise<readonly AcpModelChoice[]>, sessionId: string, method: string): void {
    pendingLateModelList.add(sessionId);
    listPromise.then(
      () => {
        if (!pendingLateModelList.delete(sessionId)) return;
        if (stopping || registry.get(sessionId) === undefined) return;
        void configOptionsFor(sessionId, method).then((configOptions) => {
          sendUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions });
        });
      },
      () => {
        // The late list failed too: send nothing, same as today.
        pendingLateModelList.delete(sessionId);
      },
    );
  }
  async function modelChoices(sessionId: string, method: string): Promise<readonly AcpModelChoice[]> {
    if (listedChoices !== undefined) {
      pendingLateModelList.delete(sessionId);
      return listedChoices;
    }
    const source = options.models;
    if (source === undefined) return [launchChoice];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), modelListTimeoutMs);
    });
    try {
      const listPromise = startListing(source);
      const outcome = await Promise.race([listPromise.catch((error: unknown) => ({ error })), timedOut]);
      if (outcome === "timeout") {
        options.logError(
          `acp: the model list did not arrive within ${modelListTimeoutMs}ms; this session is offered only the launch ` +
            `model (${launchChoice.value}), and the next session asks again`,
        );
        armLateModelListNotify(listPromise, sessionId, method);
        return [launchChoice];
      }
      if ("error" in outcome) {
        const error = outcome.error;
        options.logError(
          `acp: listing models failed (${error instanceof Error ? error.message : String(error)}); ` +
            "only the launch model is offered, and the next session asks again",
        );
        pendingLateModelList.delete(sessionId);
        return [launchChoice];
      }
      pendingLateModelList.delete(sessionId);
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
  if (options.provider !== undefined && options.models !== undefined) {
    void startListing(options.models).catch(() => {
      // Reported when a session asks for the list.
    });
  }

  /**
   * Shell profile, after `_keryx/providers/*` connected or disconnected a provider (specification
   * §3.9.3): the model list is read again from the source (`keryx shell`'s picker detection over
   * the credentials now saved) and every held session is sent a `config_option_update`, so its
   * model option reflects the providers. A session's own model is never switched. Not awaited by
   * the request: the live model lists can take seconds. A failed listing keeps the list the
   * sessions already have and says so on stderr.
   */
  function refreshModelChoicesAfterProviderChange(): void {
    const source = options.models;
    if (source === undefined || stopping) return;
    if (options.routingProviders) {
      routingRefreshNeeded = true;
      routingProviders = [];
    }
    listingGeneration += 1;
    listedChoices = undefined;
    listing = undefined;
    pendingLateModelList.clear();
    const generation = listingGeneration;
    const method = KERYX_ACP_EXTENSION_METHODS.providersList;
    track(
      startListing(source).then(
        async () => {
          if (stopping || generation !== listingGeneration) return;
          for (const sessionId of registry.ids()) {
            const configOptions = await configOptionsFor(sessionId, method);
            if (stopping || generation !== listingGeneration || registry.get(sessionId) === undefined) continue;
            sendUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions });
          }
        },
        (error: unknown) => {
          options.logError(
            `acp: listing models after a provider change failed (${error instanceof Error ? error.message : String(error)}); ` +
              "sessions keep the list they have",
          );
        },
      ),
    );
  }

  async function configOptionsFor(sessionId: string, method: string): Promise<AcpSessionConfigOption[]> {
    const choices = await modelChoices(sessionId, method);
    return [acpModelConfigOption(choices, sessionModel(sessionId, method).choice)];
  }

  /** Build the binding for `choice`, or the reason it cannot run. */
  async function bindChoice(choice: AcpModelChoice, method: string, signal?: AbortSignal): Promise<AcpModelBinding | string> {
    if (choice.value === launchChoice.value) {
      return launchModel(method).binding;
    }
    try {
      return options.models === undefined ? "keryx acp has no model source" : await options.models.bind(choice, signal);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Switch `sessionId` to the model `requested` names, from its next turn on.
   * Refused — with the reason, and the session left on its current model —
   * when `requested` is not a choice or its provider cannot be built. An
   * explicit switch is also handed to `options.rememberModel` (the saved default for new sessions).
   * `"cancelled"` when `signal` (a `/model` command's turn slot) was aborted
   * while the provider was being built: nothing is applied.
   */
  async function switchSessionModel(
    sessionId: string,
    requested: string,
    method: string,
    allowBareModelId: boolean,
    signal?: AbortSignal,
  ): Promise<SessionModel | "cancelled"> {
    const choices = await modelChoices(sessionId, method);
    const choice = findAcpModelChoice(choices, requested, allowBareModelId);
    const available = choices.map((entry) => entry.value);
    if (choice === undefined) {
      refuse(
        invalidParams(
          `${method}: "${requested.length > 80 ? `${requested.slice(0, 80)}…` : requested}" is not a model this session can run; ` +
            `choose one of: ${available.join(", ")}`,
          { value: requested, available },
        ),
      );
    }
    const ticket = beginSwitch(sessionId);
    const current = sessionModel(sessionId, method);
    const built = choice.value === current.choice.value ? current.binding : await bindChoice(choice, method, signal);
    if (signal?.aborted === true) {
      return "cancelled";
    }
    if (typeof built === "string") {
      refuse(invalidParams(`${method}: cannot switch to ${choice.value}: ${built}`, { value: choice.value, reason: built }));
    }
    const next: SessionModel = { choice, binding: built };
    if (!applySwitch(sessionId, ticket, next)) {
      // Released while the provider was being built: say so rather than answer
      // success with a model the session does not run.
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `${method}: session ${sessionId} was released while its model was being switched; load it again`,
        data: { sessionId, condition: "session-released" },
      });
    }
    rememberedValue = choice.value;
    try {
      options.rememberModel?.(choice);
    } catch (error) {
      options.logError(`acp: could not save ${choice.value} as the default model (${error instanceof Error ? error.message : String(error)})`);
    }
    return sessionModels.get(sessionId) ?? next;
  }

  /** A NEW session starts on the remembered model when it is still available; otherwise it keeps the launch model. */
  async function startOnRememberedModel(sessionId: string, method: string): Promise<void> {
    const value = rememberedValue;
    if (value === undefined || value === launchChoice.value || sessionModels.has(sessionId)) return;
    const ticket = beginSwitch(sessionId);
    const choice = findAcpModelChoice(await modelChoices(sessionId, method), value, false);
    if (choice === undefined) return;
    const built = await bindChoice(choice, method);
    if (typeof built === "string") {
      options.logError(`acp: remembered model ${value} cannot run (${built}); the session starts on ${launchChoice.value}`);
      return;
    }
    applySwitch(sessionId, ticket, { choice, binding: built });
  }

  /**
   * `session/load` of a session this connection holds no model binding for:
   * continue on the model it was switched to before the shell profile's idle
   * cap released it (`releasedModelChoices`), else on the model it last ran (its transcript
   * records it), when that is still a choice here, else on the launch model —
   * and say which, and why, once the reply is out. A session this connection
   * still holds keeps whatever it runs now.
   */
  async function restoreRecordedModel(state: AcpSessionState, requestId: JsonRpcId, method: string): Promise<void> {
    const sessionId = state.sessionId;
    const recorded = state.recordedModel;
    const kept = releasedModelChoices.get(sessionId);
    releasedModelChoices.delete(sessionId);
    if (sessionModels.has(sessionId)) return;
    const value = kept ?? (recorded !== undefined ? acpModelValue(recorded.providerId, recorded.modelId) : undefined);
    if (value === undefined || value === launchChoice.value) return;
    const ticket = beginSwitch(sessionId);
    const choice = findAcpModelChoice(await modelChoices(sessionId, method), value, false);
    const built = choice === undefined ? "it is not among the models keryx can run here" : await bindChoice(choice, method);
    if (choice !== undefined && typeof built !== "string") {
      applySwitch(sessionId, ticket, { choice, binding: built });
      return;
    }
    const reason = typeof built === "string" ? built : "it could not be restored";
    onReplied(requestId, () => {
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: textBlock(
          `keryx: this session ${kept !== undefined ? "was on" : "last ran"} ${value}, but ${reason}; it continues on ${launchChoice.value}.\n`,
        ),
        _meta: SYSTEM_NOTE_META,
      });
    });
  }

  /** The reasoning effort a turn of `sessionId` runs with: the session's `/reasoning`, else the shell's resolution. */
  function reasoningFor(sessionId: string, model: SessionModel): string | undefined {
    return reasoningOverrides.get(sessionId) ?? model.binding.turnSettings.reasoningEffort;
  }

  /** Tell the client which commands keryx handles, once the reply creating/loading the session is out. */
  function announceCommands(sessionId: string, requestId: JsonRpcId): void {
    onReplied(requestId, () => {
      sendUpdate(sessionId, {
        sessionUpdate: "available_commands_update",
        // The shell profile advertises the whole served table with `_meta.keryx`; the editor list is unchanged.
        availableCommands: shellProfile ? shellAvailableCommands() : acpAvailableCommands(slashCommands),
      });
    });
  }

  /**
   * Tell the client which of this session's MCP servers are not running, and
   * why (flow 287, AC5).
   *
   * THE CHANNEL: an `agent_message_chunk` `session/update`, plus a stderr line.
   * ACP v1 has no notification for MCP server status and no field for it in
   * the `session/new`/`session/load` response (only `_meta`, which no client
   * shows a person). An agent message is the one channel every client renders
   * in the thread the operator is looking at — Zed included — so it is the
   * most visible honest answer: the operator reads "server X was not started:
   * reason" where they would otherwise wonder why its tools never appear.
   * stderr carries the same line for the client's agent log.
   */
  function reportMcpProblems(sessionId: string, problems: readonly AcpMcpServerProblem[]): void {
    for (const problem of problems) {
      options.logError(`acp: MCP server "${problem.name}" for session ${sessionId}: ${problem.reason}`);
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: textBlock(`keryx: MCP server "${problem.name}" ${problem.reason}\n`),
        _meta: SYSTEM_NOTE_META,
      });
    }
  }

  /**
   * R700-01: tell the client (and the agent log) about this session's hook
   * config notices — untrusted/changed project hooks, a load failure,
   * tighten-only warnings, gate-off banners (`harness/hooks/notices.ts`).
   * Same channel as {@link reportMcpProblems}: an `agent_message_chunk` so
   * every client renders it in the thread, plus a stderr line.
   */
  function reportHookNotices(sessionId: string, notices: readonly string[]): void {
    for (const line of notices) {
      options.logError(`acp: session ${sessionId}: ${line}`);
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: textBlock(`${line}\n`),
        _meta: SYSTEM_NOTE_META,
      });
    }
  }

  /** Drop `sessionId`'s binding; stop the set if no session uses it any more. */
  function unbindSessionMcp(sessionId: string): void {
    const previous = sessionMcp.get(sessionId);
    if (previous === undefined) return;
    sessionMcp.delete(sessionId);
    previous.sessions.delete(sessionId);
    if (previous.sessions.size === 0 && mcpSets.get(previous.key) === previous) {
      mcpSets.delete(previous.key);
      retiring.push(previous.mcp.close());
    }
  }

  /**
   * Bind `sessionId` to the running set for `parsed` (starting it if no
   * session on this connection runs that list yet), releasing whatever it was
   * bound to before, and report the set's problems to THIS session once the
   * reply to `requestId` is on the wire — a second thread is told about a
   * failed server as the first was.
   */
  function bindSessionMcp(sessionId: string, requestId: JsonRpcId, parsed: ParsedAcpMcpServers, resolvedRoot: string): void {
    // A set started after the shutdown's close sweep would never be stopped
    // (review logic-w11 LOGIC-W11R3-002); `keryxMcpWouldBind` holds the same rule.
    if (stopping) return;
    if (parsed.stdio.length === 0 && parsed.refused.length === 0) {
      unbindSessionMcp(sessionId);
      return;
    }
    const rooted: ParsedAcpMcpServers = {
      ...parsed,
      // Each server runs in the session's resolved project root.
      stdio: parsed.stdio.map((server) => ({ ...server, cwd: resolvedRoot })),
    };
    const key = acpMcpSetKey(rooted);
    let set = mcpSets.get(key);
    if (set !== undefined) {
      // Reusing a running set: redial what failed or stopped answering, so a
      // new thread still recovers a server the way it did when every thread
      // dialled its own (flow 287, T14). The report below waits for it.
      set.mcp.revive();
    } else {
      set = {
        key,
        mcp: startAcpSessionMcp(rooted, {
          ...(options.mcpEnv !== undefined ? { env: options.mcpEnv } : {}),
          ...(options.mcpConnect !== undefined ? { connect: options.mcpConnect } : {}),
        }),
        sessions: new Set(),
      };
      mcpSets.set(key, set);
    }
    // Take the new reference BEFORE releasing the old one, so rebinding a
    // session to the list it already had never stops and restarts the set.
    set.sessions.add(sessionId);
    if (sessionMcp.get(sessionId) !== set) {
      unbindSessionMcp(sessionId);
      sessionMcp.set(sessionId, set);
    }
    const bound = set;
    onReplied(requestId, () => {
      reportMcpProblems(sessionId, bound.mcp.refused);
      void bound.mcp.ready.then(() => {
        // A session rebound before its servers settled reports nothing: the
        // client has already been told about the set that replaced it.
        if (sessionMcp.get(sessionId) === bound) {
          reportMcpProblems(sessionId, bound.mcp.failed());
        }
      });
    });
  }

  /**
   * Stop every client MCP server this connection started. Idempotent; used by
   * the normal end of input, by a read loop that throws, and by `shutdown`.
   */
  let closingAll: Promise<void> | undefined;
  const closeAllMcp = (): Promise<void> =>
    (closingAll ??= (async () => {
      const running = [...mcpSets.values()].map((set) => set.mcp.close());
      mcpSets.clear();
      sessionMcp.clear();
      await Promise.allSettled([...running, ...retiring]);
    })());

  /** AC1 / spec: a request before `initialize` is refused, not served. */
  function requireInitialized(method: string): void {
    if (!initialized) {
      refuse(invalidRequest({ reason: `${method}: call initialize before any other request`, method }));
    }
  }

  function handleInitialize(params: unknown): AcpInitializeResponse {
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.initialize);
    const negotiation = negotiateProtocolVersion(obj["protocolVersion"]);
    if (negotiation.kind === "refuse") {
      refuse(negotiation.error);
    }
    initialized = true;
    const rawCaps = obj["clientCapabilities"];
    clientCapabilities =
      typeof rawCaps === "object" && rawCaps !== null && !Array.isArray(rawCaps)
        ? (rawCaps as AcpClientCapabilities)
        : undefined;
    return {
      protocolVersion: negotiation.version,
      agentCapabilities: KERYX_AGENT_CAPABILITIES,
      authMethods: KERYX_AUTH_METHODS,
      agentInfo: options.agentInfo ?? DEFAULT_AGENT_INFO,
      // Shell profile only: the editor profile's answer stays byte-for-byte
      // what it was (AC2). `_keryx/info` answers the same in either profile.
      // `liveSessions: true` tells a client that opening a session releases none.
      ...(shellProfile ? { _meta: { keryx: { ...keryxAcpProfileMeta(profile, clientPreparesReview(clientCapabilities)), ...(telegramControlEnabled() ? { extensions: [...keryxAcpProfileMeta(profile, clientPreparesReview(clientCapabilities)).extensions, ACP_TELEGRAM_SESSION_METHOD] } : {}) } } } : {}),
    };
  }

  /** `_keryx/info` (any profile): what a client checks before it relies on a keryx extension. */
  function handleKeryxInfo(): ReturnType<typeof keryxAcpInfo> {
    const info = keryxAcpInfo((options.agentInfo ?? DEFAULT_AGENT_INFO).version, profile, clientPreparesReview(clientCapabilities));
    return telegramControlEnabled() ? { ...info, extensions: [...info.extensions, ACP_TELEGRAM_SESSION_METHOD] } : info;
  }

  /** `session/set_mode` — registered in the shell profile only; the editor profile still refuses it. */
  function handleSetMode(params: unknown, requestId: JsonRpcId): Record<string, never> {
    const method = ACP_AGENT_METHODS.sessionSetMode;
    requireInitialized(method);
    refuseIfStopping(method);
    const obj = requireObjectParams(params, method);
    const sessionId = requireStringField(obj, "sessionId", method);
    const modeId = requireStringField(obj, "modeId", method);
    refuseIfOpening(method, sessionId);
    if (registry.get(sessionId) === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId },
      });
    }
    if (!isPermissionMode(modeId)) {
      refuse(invalidParams(`${method}: unknown mode "${modeId}"; choose one of: ask, trust, auto`, { modeId }));
    }
    // Applied now — the next gated call reads it — and announced once the reply is out.
    sessionModes.set(sessionId, modeId);
    touch(sessionId);
    onReplied(requestId, () => {
      sendUpdate(sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
    });
    return {};
  }

  async function handleSessionNew(params: unknown, requestId: JsonRpcId): Promise<AcpNewSessionResponse> {
    requireInitialized(ACP_AGENT_METHODS.sessionNew);
    refuseIfStopping(ACP_AGENT_METHODS.sessionNew);
    requireProvider(ACP_AGENT_METHODS.sessionNew);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionNew);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionNew);
    // Validated BEFORE the session exists, so a malformed list creates nothing.
    // Well-formed entries keryx will not start are refused per entry and
    // reported, not refused for the whole call (see `parseAcpMcpServers`).
    const parsed = parseAcpMcpServers(ACP_AGENT_METHODS.sessionNew, obj["mcpServers"]);
    const state = registry.create(cwd, clientCapabilities);
    const sessionId = state.sessionId;
    const method = ACP_AGENT_METHODS.sessionNew;
    beginHold(sessionId);
    touch(sessionId);
    if (shellProfile) opening.add(sessionId);
    // Shell profile: held beside every other session (live sessions); nothing
    // else is released. Each step after an await refuses once a shutdown began,
    // so nothing is bound for a session the connection's end already released
    // (review logic-w11 LOGIC-W11R3-002).
    return withSessionWork(sessionId, async () => {
      try {
        // Flow 306 (W6, T15): this session's own hook runtime, built now and
        // fired with `SessionStart` — before the response is even returned, so a
        // `session/prompt` racing in right after `session/new` answers always
        // finds `shellHooksBySession` already populated. Its notices go out
        // after the reply.
        await ensureShellHooksAndFireStart(sessionId, state.resolvedRoot, requestId);
        refuseIfStopping(method);
        // Started in the background — the session's first prompt waits for the
        // dials to settle. A client that sends the same list with every session
        // keeps one set.
        bindSessionMcp(sessionId, requestId, parsed, state.resolvedRoot);
        announceCommands(sessionId, requestId);
        const mode = shellProfile ? bindShellSession(state, requestId) : undefined;
        await startOnRememberedModel(sessionId, method);
        refuseIfStopping(method);
        // The model list, which the connection started resolving at launch (flow 288, AC5).
        const configOptions = await configOptionsFor(sessionId, method);
        refuseIfStopping(method);
        enforceIdleCap();
        return {
          sessionId,
          ...(mode !== undefined ? { modes: acpModeState(modeOf(sessionId)) } : {}),
          configOptions,
        };
      } catch (error) {
        abandonOpen(sessionId);
        throw error;
      } finally {
        opening.delete(sessionId);
      }
    });
  }

  /**
   * The tools one turn of `sessionId` is offered (`roster.ts`). `read_file`
   * goes through the client's `fs/read_text_file` when — and only when — this
   * session's client advertised `fs.readTextFile` (T11, AC6). The shell
   * profile's roster is built once per session and reused (`shellRosters`).
   */
  function sessionTools(sessionId: string, state: AcpSessionState): InteractiveTool[] {
    if (shellProfile) {
      const root = state.resolvedRoot;
      const keryxMcp = keryxMcpFor(root);
      const cached = cachedShellRoster(sessionId, state);
      if (cached !== undefined) return cached;
      const clientMcp = sessionMcp.get(sessionId);
      const merged = mergeAcpMcp(keryxMcp, clientMcp?.mcp);
      // Said once per binding: the roster is rebuilt only when the binding changes.
      reportMcpProblems(sessionId, merged.shadowed);
      const tools = shellRosterTools(sessionId, state, clientFsReader(sessionId), merged.binding);
      shellRosters.set(sessionId, { root, clientCapabilities: state.clientCapabilities, clientMcp, keryxMcp, tools });
      return tools;
    }
    return buildAcpSessionTools({
      root: state.resolvedRoot,
      clientCapabilities: state.clientCapabilities,
      readViaClient: clientFsReader(sessionId),
      // Flow 287 (AC3/AC4): the client's own MCP servers for THIS session —
      // offered only when the session has any.
      clientMcpTools: sessionMcp.get(sessionId)?.mcp.tools ?? [],
    });
  }

  let routingProviders: readonly FlatPickerProvider[] | undefined;
  let routingRefresh: Promise<void> | undefined;
  let routingRefreshNeeded = false;
  let routingForceRetry = false;
  let routingRefreshFailedAt: number | undefined;
  function freshRoutingProvider(provider: FlatPickerProvider, now: number): boolean {
    const age = now - Date.parse(provider.observedAt ?? "");
    return age >= 0 && age < ROUTING_AVAILABILITY_TTL_MS;
  }
  function refreshRoutingProviders(): Promise<void> {
    const load = options.routingProviders;
    if (!load) return Promise.resolve();
    if (routingRefresh) return routingRefresh;
    const now = Date.now();
    const retryAge = routingRefreshFailedAt === undefined ? Infinity : now - routingRefreshFailedAt;
    if (!routingRefreshNeeded && (
      (retryAge >= 0 && retryAge < 10_000) ||
      (routingProviders && routingProviders.length > 0 && routingProviders.every(provider => freshRoutingProvider(provider, now)))
    )) return Promise.resolve();
    const force = routingRefreshNeeded || routingForceRetry;
    routingRefreshNeeded = false;
    return routingRefresh = Promise.resolve().then(() => load(force)).then(providers => {
      routingRefreshFailedAt = providers.length === 0 ? Date.now() : undefined;
      routingForceRetry = false;
      if (!routingRefreshNeeded) routingProviders = providers;
    }, () => {
      routingRefreshFailedAt = Date.now();
      routingForceRetry = force;
      options.logError("acp: could not refresh the provider catalogue for model routing");
    }).finally(() => {
      routingRefresh = undefined;
      // Existing waiters must also wait for changes that arrived mid-refresh.
      if (routingRefreshNeeded) return refreshRoutingProviders();
    });
  }

  /** Each session's MCP trust grants (`trustedMcpTools`), never persisted; dropped with the session. */
  const mcpGrants = new Map<string, SessionMcpGrants>();

  /** Each session's `spawn_subagent` budget reset, called at the start of every turn (the shell's `deps.resetSubagentBudget`). */
  const subagentBudgetResets = new Map<string, () => void>();

  /**
   * What `spawn_subagent` needs for one session (specification §3.9.4): its live parent model, the
   * provider factory, the providers a child may route to (the connection's model list, grouped), its
   * hook runtime, and ITS OWN fleet closure — `_keryx/subagent { sessionId, event }` — never a bridge
   * shared with another session.
   */
  function spawnInputFor(sessionId: string, ownsBudget: boolean): AcpShellRosterInput["spawn"] {
    const method = KERYX_ACP_EXTENSION_METHODS.subagent;
    const parent = (): { providerId: string; modelId: string; baseUrl?: string } => {
      const { binding, choice } = sessionModel(sessionId, method);
      return { providerId: binding.providerId, modelId: binding.modelId, ...(choice.baseUrl !== undefined ? { baseUrl: choice.baseUrl } : {}) };
    };
    const hooks = shellHooksBySession.get(sessionId)?.runtime;
    return {
      getParentModel: parent,
      providerFactory: (providerId, modelId, baseUrl) => {
        if (options.makeProvider !== undefined) return options.makeProvider(providerId, modelId, baseUrl);
        const { binding } = sessionModel(sessionId, method);
        if (providerId === binding.providerId && modelId === binding.modelId) return binding.provider;
        throw new Error(`keryx acp has no provider factory for ${providerId}/${modelId}; a subagent runs on its parent's model here`);
      },
      ...(options.routingProviders ? { refreshRoutingProviders } : {}),
      getDetectedProviders: (lookup) => {
        const now = Date.now();
        // Expiry triggers refresh for new routes. Active routes still respect
        // newer probe results and explicit credential invalidation.
        const verified = (lookup?.forActiveRoute
          ? routingProviders
          : routingProviders?.filter(provider => freshRoutingProvider(provider, now))) ?? [];
        if (verified.length > 0) {
          const providerId = parent().providerId;
          return verified.some(entry => entry.name === providerId)
            ? verified
            : [{ name: providerId, models: [] }, ...verified];
        }
        const byProvider = new Map<string, string[]>();
        for (const choice of listedChoices ?? []) byProvider.set(choice.providerId, [...(byProvider.get(choice.providerId) ?? []), choice.modelId]);
        const fallback = withSessionProvider(
          parent().providerId,
          [...byProvider].map(([name, models]) => ({ name, models })),
        );
        // Picker rows can describe models without verifying their availability.
        return options.routingProviders ? fallback.map(row => ({ ...row, offline: true })) : fallback;
      },
      onFleetEvent: (event) => {
        if (!stopping) writeMessage(notificationMessage(KERYX_ACP_EXTENSION_METHODS.subagent, { sessionId, event }));
      },
      // Only the roster the session keeps owns the turn's budget; the throwaway `/status` builds none.
      onLedgerReady: (controls) => {
        if (ownsBudget) subagentBudgetResets.set(sessionId, controls.resetBudget);
      },
      ...(hooks !== undefined ? { hooks } : {}),
    };
  }

  /** Builds the shell-profile roster for one session with the given MCP binding. */
  function shellRosterTools(
    sessionId: string,
    state: AcpSessionState,
    readViaClient: AcpFsReader,
    mcp: McpToolBinding | undefined,
    ownsBudget = true,
  ): InteractiveTool[] {
    const root = state.resolvedRoot;
    return buildShellRoster({
      root,
      clientCapabilities: state.clientCapabilities,
      readViaClient,
      searchController: searchControllerFor(),
      jobRegistry: jobsFor(sessionId, root),
      spawn: spawnInputFor(sessionId, ownsBudget),
      // A model-chosen external run needs the client's terminal (the desktop); without one it stays native-only.
      ...(clientRunsTerminal(state.clientCapabilities) ? { runExternal: (request) => externalRunsFor(sessionId, state).startForModel(request) } : {}),
      // Read through the registry, not captured: `persistHistory` replaces the handle.
      getSessionDir: () => registry.get(sessionId)?.handle.dir,
      metaprojectPort: metaprojectFor(root),
      ...(clientAnswersAskUser(state.clientCapabilities) ? { askUser: askUserFor(sessionId) } : {}),
      ...(clientPreparesReview(state.clientCapabilities) ? {
        requestReviewDraft: reviewDraftFor(sessionId),
        sessionReviews: sessionReviewsTool(() => readVisibleSessionReviews(root, sessionId, true)),
      } : {}),
      ...(clientShowsOperatorCards(state.clientCapabilities)
        ? {
            operatorCards: true,
            scheduleDefaults: () => {
              const { binding } = sessionModel(sessionId, ACP_AGENT_METHODS.sessionPrompt);
              return { provider: binding.providerId, model: binding.modelId };
            },
          }
        : {}),
      ...(mcp !== undefined ? { mcp } : {}),
    });
  }

  /**
   * The tool names `/status` reports, without starting keryx's MCP runtime
   * (performance review F-002): the cached roster when there is one; otherwise
   * the roster built with an empty MCP binding wherever the real one would
   * bind — `keryxMcpWouldBind` and `acpMcpBinds` are the rules the turn's own
   * build follows, and the factory decides which names a binding adds.
   */
  function statusToolNames(sessionId: string, state: AcpSessionState): string[] {
    if (!shellProfile) return sessionTools(sessionId, state).map((tool) => tool.definition.name);
    const cached = cachedShellRoster(sessionId, state);
    if (cached !== undefined) return cached.map((tool) => tool.definition.name);
    const binds = acpMcpBinds(keryxMcpWouldBind(state.resolvedRoot), sessionMcp.get(sessionId)?.mcp);
    const namesOnly: McpToolBinding | undefined = binds ? { catalog: () => mergeCatalogs([]), servers: () => [] } : undefined;
    return shellRosterTools(sessionId, state, clientFsReader(sessionId), namesOnly, false).map((tool) => tool.definition.name);
  }

  /** `fs/read_text_file` to the client for one session; `undefined` for any non-answer. */
  function clientFsReader(sessionId: string): AcpFsReader {
    return async (path, line) => {
      const params: AcpReadTextFileRequest = {
        sessionId,
        path,
        ...(line !== undefined ? { line } : {}),
      };
      const outcome = await clientRequests.request(ACP_CLIENT_METHODS.fsReadTextFile, params);
      if (outcome.kind !== "result") {
        return undefined;
      }
      const result = outcome.result;
      if (typeof result !== "object" || result === null) {
        return undefined;
      }
      const content = (result as Partial<AcpReadTextFileResponse>).content;
      return typeof content === "string" ? content : undefined;
    };
  }

  /**
   * Run one advertised slash command (flow 288, AC4) and return the text keryx
   * answers with. An unlisted command is answered with the list — it is not
   * passed to the model as if it were a question.
   */
  async function runSlashCommand(
    sessionId: string,
    state: AcpSessionState,
    name: string,
    args: string,
    signal: AbortSignal,
  ): Promise<string> {
    const method = ACP_AGENT_METHODS.sessionPrompt;
    switch (name) {
      case "help":
        return `Commands keryx handles in this editor:\n${acpCommandHelpText(slashCommands)}`;
      case "mode": {
        if (!shellProfile) {
          return unknownAcpCommandText(name, slashCommands);
        }
        if (args.length === 0) {
          return `Permission mode: ${modeOf(sessionId)}. Set with /mode <ask|trust|auto>.`;
        }
        if (!isPermissionMode(args)) {
          return `Unknown permission mode "${args}"; choose one of: ask, trust, auto.`;
        }
        setSessionMode(sessionId, args);
        return `Permission mode: ${args}, from the next tool call.`;
      }
      case "model": {
        const current = sessionModel(sessionId, method);
        if (args.length === 0) {
          const choices = await modelChoices(sessionId, method);
          const lines = choices.map(
            (choice) => `  ${choice.value === current.choice.value ? "*" : " "} ${choice.value}`,
          );
          return `Model: ${current.choice.value}\nThis session can run:\n${lines.join("\n")}\nSwitch with /model <model>; it applies from the next turn.`;
        }
        let switched: SessionModel | "cancelled";
        try {
          switched = await switchSessionModel(sessionId, args, "/model", true, signal);
        } catch (error) {
          if (error instanceof AcpError) {
            return error.message;
          }
          throw error;
        }
        if (switched === "cancelled") {
          return "";
        }
        sendUpdate(sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: await configOptionsFor(sessionId, method),
        });
        return `Model: ${switched.choice.value}, from the next turn.`;
      }
      case "reasoning": {
        const model = sessionModel(sessionId, method);
        if (args.length === 0) {
          const override = reasoningOverrides.get(sessionId);
          const effort = reasoningFor(sessionId, model) ?? "off";
          const source = override !== undefined ? "set for this session" : "keryx shell's saved setting or KERYX_REASONING_EFFORT";
          return `Reasoning effort: ${effort} (${source}). Set with /reasoning <${REASONING_EFFORT_LEVELS.join("|")}>.`;
        }
        if (!isReasoningEffortLevel(args)) {
          return `Unknown reasoning effort "${args}"; choose one of: ${REASONING_EFFORT_LEVELS.join(", ")}.`;
        }
        reasoningOverrides.set(sessionId, args);
        return `Reasoning effort: ${args}, from the next turn (this session only).`;
      }
      case "status": {
        const model = sessionModel(sessionId, method);
        const tools = statusToolNames(sessionId, state);
        const mcp = sessionMcp.get(sessionId)?.mcp;
        const problems = mcp === undefined ? [] : [...mcp.refused, ...mcp.failed()];
        return [
          `Session: ${sessionId}`,
          `Project: ${state.resolvedRoot}`,
          `Model: ${model.choice.value}`,
          `Reasoning effort: ${reasoningFor(sessionId, model) ?? "off"}`,
          ...(shellProfile ? [`Permission mode: ${modeOf(sessionId)}`] : []),
          `Tools (${tools.length}): ${tools.join(", ")}`,
          `Client MCP servers: ${
            mcp === undefined
              ? "none"
              : problems.length === 0
                ? "running"
                : `not running: ${problems.map((problem) => `${problem.name} (${problem.reason})`).join("; ")}`
          }`,
        ].join("\n");
      }
      default:
        return unknownAcpCommandText(name, slashCommands);
    }
  }

  /** `/rewind`'s per-session recorder and state machine, built on first use over the session's live registry entry. */
  function rewindFor(sessionId: string): AcpSessionRewind {
    const held = sessionRewinds.get(sessionId);
    if (held !== undefined) return held;
    const state = registry.get(sessionId);
    if (state === undefined) {
      refuse({ code: JSON_RPC_ERROR_CODES.resourceNotFound, message: `Unknown ACP session: ${sessionId}`, data: { sessionId } });
    }
    const created = createAcpSessionRewind({
      root: state.resolvedRoot,
      session: commandSession(sessionId),
      sessionDir: () => registry.get(sessionId)?.handle.dir,
      onError: (message) => options.logError(`acp: rewind: ${message}`),
    });
    sessionRewinds.set(sessionId, created);
    return created;
  }

  /**
   * A terminal `/delegate` run finished a turn (D-14, §3.9.5a): tell the client (`_keryx/delegate_result`,
   * the "returned" card) and put the answer in the parent's history as a labelled, untrusted user-role
   * note. No turn starts: the operator decides what the parent does with it. A note that arrives while
   * the session's turn runs waits for the turn to end, so it never lands between a tool call and its result.
   */
  function handOffDelegateResult(sessionId: string, result: DelegateTurnResult): void {
    if (stopping) return;
    writeMessage(notificationMessage(KERYX_ACP_EXTENSION_METHODS.delegateResult, { sessionId, ...result, text: capResultText(result.text) }));
    // A model-started run returns its text as the `spawn_subagent` result: no history note on top of it.
    if (result.autoClose === true) return;
    const note = delegateResultNote({ ...result, nonce: randomBytes(6).toString("hex") });
    if (activeTurns.has(sessionId)) {
      pendingDelegateNotes.set(sessionId, [...(pendingDelegateNotes.get(sessionId) ?? []), note]);
      return;
    }
    appendDelegateNotes(sessionId, [note]);
  }

  /**
   * A session nobody has named yet (no operator message: it was opened only to run `/delegate`)
   * takes its title from the delegated task, "Claude Code: fix the login test", so the sidebar
   * does not show "Untitled session". A titled session keeps its title.
   */
  function nameSessionFromDelegate(sessionId: string, run: { label: string; task: string }): void {
    const state = registry.get(sessionId);
    if (state === undefined || !UNNAMED_SESSION_TITLES.has(state.handle.summary.title)) return;
    if (!registry.canPersist(sessionId)) return;
    try {
      registry.updateHandle(sessionId, renameSession(state.handle, titleFromPrompt(`${run.label}: ${run.task}`)));
    } catch (cause) {
      options.logError(`acp: session title not saved: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    const named = registry.get(sessionId)?.handle.summary;
    if (named !== undefined && !stopping) sendUpdate(sessionId, { sessionUpdate: "session_info_update", title: named.title, updatedAt: named.updatedAt });
  }

  function appendDelegateNotes(sessionId: string, notes: readonly string[]): void {
    appendInjectedNotes(sessionId, notes, KERYX_ACP_EXTENSION_METHODS.delegateResult, "delegate result");
  }

  /**
   * Puts harness-written notes in a session's history as user-role entries (`provenance: "harness"`,
   * `injected: true`) and persists them at once. `method` names the caller in a model-binding refusal,
   * `what` the notes in a persist failure, which is logged: the notes stay in the live history.
   */
  function appendInjectedNotes(sessionId: string, notes: readonly string[], method: string, what: string): void {
    const state = registry.get(sessionId);
    if (state === undefined || notes.length === 0) return;
    for (const note of notes) state.history.push({ role: "user", content: note, provenance: "harness", injected: true });
    syncAcpArchive(state.archive, state.history);
    if (!registry.canPersist(sessionId)) return;
    try {
      const { providerId, modelId } = sessionModel(sessionId, method).binding;
      registry.updateHandle(sessionId, persistHistory(state.handle, state.history, { provider: providerId, model: modelId, archive: state.archive.messages }));
    } catch (cause) {
      options.logError(`acp: ${what} not persisted: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /**
   * `session/prompt`'s `_meta.keryx.terminalResults` (shell profile, flow 523): the results of commands
   * the operator ran from the client's Run button, validated. `undefined` when the prompt carries none.
   * Refused as invalid params when malformed, or when combined with an issue launch or a question
   * resume (a terminal-results prompt is neither), before anything is stored or a turn starts.
   */
  function terminalResultsOf(params: Record<string, unknown>): readonly TerminalResult[] | undefined {
    const method = ACP_AGENT_METHODS.sessionPrompt;
    const raw = terminalResultsMeta(params);
    if (raw === undefined) return undefined;
    const parsed = parseTerminalResults(raw);
    if (!parsed.ok) refuse(invalidParams(`${method}: _meta.keryx.${parsed.reason}`, { field: "_meta.keryx.terminalResults" }));
    const keryx = (params["_meta"] as { keryx?: { issueLaunchId?: unknown; resumeIssueQuestions?: unknown } } | undefined)?.keryx;
    if (keryx?.issueLaunchId !== undefined || keryx?.resumeIssueQuestions !== undefined) {
      refuse(invalidParams(`${method}: _meta.keryx.terminalResults cannot be combined with issueLaunchId or resumeIssueQuestions`, { field: "_meta.keryx.terminalResults" }));
    }
    return parsed.results;
  }

  /**
   * `results` split by whether the session already stored them (reviews R2-HL-002, R3-LG-006): by run id
   * and kind, read from the notes in its live history and its archive, which keeps the notes a compaction
   * took out of the history. A final result after a stored running snapshot is fresh.
   */
  function withoutStoredRuns(state: AcpSessionState, results: readonly TerminalResult[]): { fresh: readonly TerminalResult[]; duplicates: string[] } {
    const stored = storedTerminalRuns(state.archive.messages, state.history);
    return {
      fresh: results.filter((result) => !isStoredTerminalResult(stored, result)),
      duplicates: results.filter((result) => isStoredTerminalResult(stored, result)).map((result) => result.runId),
    };
  }

  /** One labelled untrusted note per terminal result, each with its own nonce, stored before the turn they start. */
  function appendTerminalResultNotes(sessionId: string, results: readonly TerminalResult[]): void {
    const notes = results.map((result) => terminalResultNote(result, randomBytes(6).toString("hex")));
    appendInjectedNotes(sessionId, notes, ACP_AGENT_METHODS.sessionPrompt, "terminal result");
  }

  /** `_keryx/delegate_exited` (shell profile): the run's terminal process ended; its hook file is read once more and removed. */
  function handleDelegateExited(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const { sessionId, runId } = params as Record<string, unknown>;
    if (typeof sessionId === "string" && typeof runId === "string") sessionExternalRuns.get(sessionId)?.exited(runId);
  }

  /** `/delegate`'s runs for one session: the approval is a `session/request_permission`, the events `_keryx/subagent`. */
  function externalRunsFor(sessionId: string, state: AcpSessionState): SessionExternalRuns {
    const held = sessionExternalRuns.get(sessionId);
    if (held !== undefined) return held;
    const created = createSessionExternalRuns({
      cwd: state.resolvedRoot,
      configDir: options.shellConfigDir,
      sessionId,
      terminalCapable: clientRunsTerminal(state.clientCapabilities),
      sessionDir: () => registry.get(sessionId)?.handle.dir,
      onTurnResult: (result) => handOffDelegateResult(sessionId, result),
      onRunStarted: (run) => nameSessionFromDelegate(sessionId, run),
      permissionMode: () => modeOf(sessionId),
      openTerminal: (launch) => {
        if (!stopping) writeMessage(notificationMessage(KERYX_ACP_EXTENSION_METHODS.delegateTerminal, { sessionId, ...launch }));
      },
      onHookError: (message) => options.logError(`acp: ${message}`),
      gateEnv: options.externalGateEnv,
      makeRunExternal: options.makeRunExternal,
      emitFleet: (event) => {
        if (!stopping) writeMessage(notificationMessage(KERYX_ACP_EXTENSION_METHODS.subagent, { sessionId, event }));
      },
      ask: async (request, onSent) => {
        if (!clientAnswersPermissions) return undefined;
        const outcome = await clientRequests.request(ACP_CLIENT_METHODS.sessionRequestPermission, request, onSent);
        if (outcome.kind !== "result") return undefined;
        const result = outcome.result;
        return typeof result === "object" && result !== null && !Array.isArray(result) ? (result as AcpRequestPermissionResponse) : undefined;
      },
      withdraw: (requestId, reason) => {
        clientRequests.cancel(requestId, reason);
      },
    });
    sessionExternalRuns.set(sessionId, created);
    return created;
  }

  /** The session as a transcript command sees it. Read through the registry: `session/load` and `persistHistory` replace entries. */
  function commandSession(sessionId: string): ShellCommandHost["session"] {
    const live = (): AcpSessionState => {
      const state = registry.get(sessionId);
      if (state === undefined) {
        refuse({ code: JSON_RPC_ERROR_CODES.resourceNotFound, message: `Unknown ACP session: ${sessionId}`, data: { sessionId } });
      }
      return state;
    };
    return {
      get history() {
        return live().history;
      },
      get archive() {
        return live().archive;
      },
      handle: () => live().handle,
      setHandle: (handle) => registry.updateHandle(sessionId, handle),
      canPersist: () => registry.canPersist(sessionId),
      modelIds: () => {
        const { providerId, modelId } = sessionModel(sessionId, KERYX_ACP_EXTENSION_METHODS.command).binding;
        return { providerId, modelId };
      },
    };
  }

  /** What `_keryx/command` lends a runner: this session's state and the server's own answers (`status`, `model`, `reasoning`, `mode`). */
  function commandHost(sessionId: string, state: AcpSessionState): ShellCommandHost {
    const method = KERYX_ACP_EXTENSION_METHODS.command;
    return {
      cwd: state.resolvedRoot,
      configDir: options.shellConfigDir,
      session: commandSession(sessionId),
      sessionDir: () => registry.get(sessionId)?.handle.dir,
      permissionMode: () => modeOf(sessionId),
      reasoningOverride: () => reasoningOverrides.get(sessionId),
      readOnly: () => sessionReadOnly.get(sessionId) === true,
      setReadOnly: (on) => {
        sessionReadOnly.set(sessionId, on);
      },
      jobs: () => jobsFor(sessionId, state.resolvedRoot),
      searchController: searchControllerFor,
      rewind: () => rewindFor(sessionId).command,
      slate: () => {
        const held = sessionSlates.get(sessionId);
        if (held !== undefined) return held.ref;
        const dir = registry.get(sessionId)?.handle.dir;
        if (dir === undefined) return undefined;
        const ref: SlateSessionRef = { dir, cwd: state.resolvedRoot, opened: false };
        sessionSlates.set(sessionId, { ref });
        return ref;
      },
      goalStarted: (prompt) => {
        const held = sessionSlates.get(sessionId);
        if (held !== undefined) held.goalPrompt = prompt;
      },
      externalRuns: () => externalRunsFor(sessionId, state),
      modelChoices: () => modelChoices(sessionId, method),
      serverCommand: async (name, args): Promise<ShellCommandOutcome> => {
        const before = { mode: modeOf(sessionId), model: sessionModel(sessionId, method).choice.value, reasoning: reasoningOverrides.get(sessionId) };
        // Not tied to `session/cancel`: this is not a turn, so there is nothing for a cancel to reach.
        const reply = await runSlashCommand(sessionId, state, name, args, new AbortController().signal);
        const effects: ShellCommandEffect[] = [];
        if (modeOf(sessionId) !== before.mode) effects.push("mode");
        if (sessionModel(sessionId, method).choice.value !== before.model) effects.push("model");
        if (reasoningOverrides.get(sessionId) !== before.reasoning) effects.push("config");
        return { text: reply.length === 0 || reply.endsWith("\n") ? reply : `${reply}\n`, ...(effects.length > 0 ? { effects } : {}) };
      },
    };
  }

  /**
   * `_keryx/command` (shell profile, specification §3.9.1): runs one command of the served
   * table. Not a turn: no prompt slot, nothing added to the model's history, and it may run
   * while a turn runs, by `busy-dispatch.ts`'s rules — a command the shell would queue or
   * refuse while busy is answered `{ text, _meta.keryx.refused }` with the shell's wording.
   * The two that rewrite the transcript (`/compact`, `/rewind`) hold the session's slot while
   * they run, so a prompt cannot interleave with the rewrite.
   */
  async function handleKeryxCommand(params: unknown): Promise<{ text: string; _meta: { keryx: { effects?: ShellCommandEffect[]; refused?: true; view?: ShellView; prompt?: string; terminal?: DelegateTerminalLaunch; confirmAction?: ShellConfirmAction } } }> {
    const method = KERYX_ACP_EXTENSION_METHODS.command;
    requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const sessionId = requireStringField(obj, "sessionId", method);
    const rawName = requireStringField(obj, "name", method);
    const argsField = obj["args"];
    if (argsField !== undefined && typeof argsField !== "string") {
      refuse(invalidParams(`${method}: args must be a string`, { received: argsField }));
    }
    const name = rawName.replace(/^\//, "").toLowerCase();
    const args = (argsField ?? "").trim();
    const row = findShellCommand(name);
    if (row === undefined) {
      refuse(invalidParams(`${method}: keryx does not serve /${name}`, { name }));
    }
    if (row.surface === "client" || row.surface === "dialog") {
      refuse(invalidParams(`${method}: /${name} is handled by the desktop client, not by keryx`, { name, surface: row.surface }));
    }
    const state = registry.get(sessionId);
    if (state === undefined) {
      refuse({ code: JSON_RPC_ERROR_CODES.resourceNotFound, message: `Unknown ACP session: ${sessionId}`, data: { sessionId } });
    }
    refuseIfOpening(method, sessionId);
    const refusedResult = (reason: string) => ({ text: reason, _meta: { keryx: { refused: true as const } } });
    if (activeTurns.has(sessionId) && row.busy === "refuse") {
      return refusedResult(busyRefusalText(name));
    }
    touch(sessionId);
    const rewritesTranscript = row.name === "compact" || row.name === "rewind";
    // Counted as work on the session, so the idle cap does not release it mid-command.
    return withSessionWork(sessionId, async () => {
      const slot: AcpActiveTurn | undefined = rewritesTranscript
        ? { controller: new AbortController(), cancelled: false, permissionRequestIds: new Set() }
        : undefined;
      if (slot !== undefined) activeTurns.set(sessionId, slot);
      try {
        const outcome = await runShellTextCommand(commandHost(sessionId, state), row, args);
        // A view command with no text form for these arguments: T10b's views replace this answer.
        if (outcome === undefined) return refusedResult(viewNotServedText(name));
        if (outcome.refused === true) return refusedResult(outcome.text);
        return {
          text: outcome.text,
          _meta: { keryx: { effects: [...(outcome.effects ?? [])], ...(outcome.view !== undefined ? { view: outcome.view } : {}), ...(outcome.prompt !== undefined ? { prompt: outcome.prompt } : {}), ...(outcome.terminal !== undefined ? { terminal: outcome.terminal } : {}), ...(outcome.confirmAction !== undefined ? { confirmAction: outcome.confirmAction } : {}) } },
        };
      } finally {
        if (slot !== undefined && activeTurns.get(sessionId) === slot) activeTurns.delete(sessionId);
        touch(sessionId);
      }
    });
  }

  async function handleSessionPrompt(params: unknown, telegram?: { sessionId: string; generation: string; actorId: number; updateId: number; text: string }): Promise<AcpPromptResponse> {
    requireInitialized(ACP_AGENT_METHODS.sessionPrompt);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionPrompt);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionPrompt);
    const promptField = obj["prompt"];
    if (!Array.isArray(promptField)) {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionPrompt}: prompt must be an array of content blocks`, {
        received: promptField,
      }));
    }
    // Flow 523: the result of a Run in the client's terminal. Validated before anything else, so a
    // malformed one is refused with nothing stored and no turn; the editor profile does not serve it.
    const terminalResults = shellProfile ? terminalResultsOf(obj) : undefined;
    const state = registry.get(sessionId);
    if (state === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId },
      });
    }
    // Owner 2026-11-25 (review F-001/RR-001): only a run-tracking client sends results. `terminal: true`
    // alone is /delegate's capability, which desktops released before flow 523 send as well.
    if (terminalResults !== undefined && !clientTakesTerminalResults(state.clientCapabilities)) {
      refuse(
        invalidParams(
          `${ACP_AGENT_METHODS.sessionPrompt}: _meta.keryx.terminalResults is accepted only from a client that advertised _meta.keryx.terminalResults in its initialize client capabilities`,
          { field: "_meta.keryx.terminalResults" },
        ),
      );
    }
    // Before anything mutates `state.history` (see `refuseIfBusy`). Safe to
    // check synchronously here: `dispatch` starts every handler in wire order
    // and this whole prologue — including the `activeTurns.set` below — runs
    // before the first `await`, so no second prompt can slip between the check
    // and the registration.
    refuseIfOpening(ACP_AGENT_METHODS.sessionPrompt, sessionId);
    refuseIfBusy(ACP_AGENT_METHODS.sessionPrompt, sessionId);
    refuseIfStopping(ACP_AGENT_METHODS.sessionPrompt);
    requireProvider(ACP_AGENT_METHODS.sessionPrompt);
    touch(sessionId);
    // Review R2-HL-002: a result is stored at most once per run id and kind (R3-LG-006: a final result
    // after a stored running snapshot is new). The desktop re-sends results whose prompt was lost with its
    // connection, so an entry the session already stored is skipped. A prompt holding nothing else stores
    // nothing and is answered as delivered, with the duplicates named. It starts no turn, unless the
    // notes for them end the history (R3-LG-005): keryx stopped before the turn they started was
    // persisted, so that turn runs now, on the stored notes.
    const freshResults = terminalResults === undefined ? undefined : withoutStoredRuns(state, terminalResults);
    const allStored = freshResults !== undefined && freshResults.fresh.length === 0;
    const resumedNotes = allStored ? trailingNotesAwaitingTurn(state.history, freshResults.duplicates) : 0;
    const storedAnswer = allStored ? { _meta: { keryx: { terminalResults: { stored: 0, duplicates: freshResults.duplicates } } } } : {};
    if (allStored && resumedNotes === 0) {
      return { stopReason: "end_turn", ...storedAnswer };
    }
    // Read ONCE, here: this turn runs with this model to its end, whatever a
    // `session/set_config_option` arriving meanwhile does (flow 288, AC6).
    if ((obj["_meta"] as { keryx?: { resumeIssueQuestions?: unknown } } | undefined)?.keryx?.resumeIssueQuestions === true)
      return resumeIssueQuestions(state);
    const model = sessionModel(sessionId, ACP_AGENT_METHODS.sessionPrompt);

    // A slash command (flow 288, AC4) is keryx's to answer; it never reaches
    // the model and adds nothing to the transcript. It holds the session's
    // turn slot while it runs, like a turn: `/model` builds a provider, and a
    // prompt slipping in beside it would race the switch. A terminal-results prompt's text is the
    // client's display text, never read: it is not a command either.
    const command = terminalResults === undefined ? parseAcpSlashPrompt(promptField) : undefined;
    if (command !== undefined) {
      const slot: AcpActiveTurn = { controller: new AbortController(), cancelled: false, permissionRequestIds: new Set() };
      activeTurns.set(sessionId, slot);
      try {
        const problem = acpCommandInputProblem(command, slashCommands);
        const reply =
          problem ?? (await runSlashCommand(sessionId, state, command.name, command.args, slot.controller.signal));
        // A cancelled command says nothing more, like a cancelled turn.
        if (!slot.cancelled && reply.length > 0) {
          sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(`${reply}\n`) });
        }
        return { stopReason: slot.cancelled ? "cancelled" : "end_turn" };
      } finally {
        if (activeTurns.get(sessionId) === slot) {
          activeTurns.delete(sessionId);
        }
        touch(sessionId);
      }
    }

    const launchId = (obj["_meta"] as { keryx?: { issueLaunchId?: unknown } } | undefined)?.keryx?.issueLaunchId;
    const bound = shellProfile ? issueContextForSession(state.handle.dir, options.dataDir) : undefined;
    const includeSource = bound && (launchId !== undefined || !state.history.some(message => message.role === "user" && !message.injected));
    // A terminal-results turn's user line is keryx's own continuation sentence, untrusted from its start
    // (the existing untrusted-prompt floor below), with no operator text in it.
    const rendered = terminalResults !== undefined ? TERMINAL_RESULTS_PROMPT : renderAcpPrompt(includeSource ? [...promptField,
      { type: "resource", _meta: { keryx: { untrusted: true } },
        resource: { uri: bound.launch.issue.url, text: `GitHub issue (updated ${bound.updatedAt})\n${bound.body}` } }] : promptField);
    const userLine = rendered.text;
    // The roster, and why it is exactly what it is: `roster.ts`.
    const tools = sessionTools(sessionId, state);
    const toolNames = tools.map((tool) => tool.definition.name);
    const { provider, providerId, modelId, turnSettings } = model.binding;
    const reasoningEffort = reasoningFor(sessionId, model);
    const shellHooks = shellHooksBySession.get(sessionId);
    const deps: AgentDeps = {
      ...turnSettings,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      provider,
      providerId,
      modelId,
      tools,
      systemInstruction: buildAgentSystemInstruction(undefined, {
        providerId,
        modelId,
        toolNames,
        // Flow 523: the desktop's Run button and the result note that comes back from it — for a client
        // that returns Run results, and never on a Telegram turn, whose operator has no Run button.
        ...(shellProfile && telegram === undefined && clientTakesTerminalResults(state.clientCapabilities) ? { clientReturnsRunResults: true } : {}),
      }),
      controlNonce: controlNonceFor(sessionId),
      idSeq,
      // Flow 306 (W6, T15): this session's own `HookRuntime` (built at
      // `session/new`/`session/load`, `ensureShellHooksAndFireStart` above),
      // absent only when `KERYX_HOOKS=off` — every existing PreToolUse/
      // PostToolUse/UserPromptSubmit/Stop wiring in `agent.ts`'s `runAgentTurn`
      // already short-circuits to a no-op the moment `deps.hooks` is
      // undefined, so this is purely additive for every call site that ran
      // before this task.
      ...(shellHooks !== undefined ? { hooks: shellHooks } : {}),
      // Deliberately NOT `unattended: true` (context.md F-4; AC3 groundwork
      // for T9). `keryx shell` never sets it either — an operator is present
      // at a real terminal there, and an ACP client is that same operator
      // here, just over a different transport. Setting `unattended: true`
      // would intercept `ask_user` and turn budget exhaustion into a silent
      // TerminalState instead of a question the client could ever be asked.
      // `requestApproval` IS now set on the `AgentIO` this turn runs with (T9,
      // below): it forwards to `session/request_permission`. `unattended` must
      // stay unset for that to mean anything — the two undo each other exactly
      // as F-4 warned, since `unattended` intercepts the very questions this
      // wire exists to carry.
    };

    // AC4 / F-5, F-12, F-14 (context.md): one `AbortController` per in-flight
    // turn, keyed by session id, so `session/cancel` — a NOTIFICATION that can
    // arrive on any later line while this handler is still suspended (F-12: the
    // read loop never awaits a handler before reading the next line) — has
    // something to reach. `RunAgentTurnResult.finishReason` does not reliably
    // distinguish an abort from a clean toolless finish (most abort paths and a
    // toolless finish both return `undefined`; only an abort during a
    // `submit_result` wrap-up returns `"interrupted"`), so `turn.cancelled` is
    // the authoritative record of "this exact turn was cancelled" and it is set
    // by `handleSessionCancel`, never inferred from the result below.
    const turn: AcpActiveTurn = {
      controller: new AbortController(),
      cancelled: false,
      permissionRequestIds: new Set(),
      ...(telegram === undefined ? {} : { telegramGeneration: telegram.generation }),
    };
    activeTurns.set(sessionId, turn);
    const outputGeneration = telegram?.generation ?? telegramBindings.currentGeneration(sessionId);
    if (telegram !== undefined) {
      writeMessage(notificationMessage(ACP_CLIENT_METHODS.sessionUpdate, { sessionId, update: {
        sessionUpdate: "_keryx/telegram/turn", source: "telegram", phase: "started", actorId: telegram.actorId, updateId: telegram.updateId, generation: telegram.generation,
      } }));
      sendUpdate(sessionId, { sessionUpdate: "user_message_chunk", content: textBlock(telegram.text) });
    }
    let finishIssueActivity: (() => void) | undefined;
    try {
      // The dials `session/new`/`session/load` started — bounded by each
      // server's handshake budget — must have settled before the turn, or the
      // first turn would search an empty catalog. Awaited only AFTER the slot
      // is taken, so the busy guard above still holds while this waits.
      await sessionMcp.get(sessionId)?.mcp.ready;
      if (telegram !== undefined && !telegramBindings.isCurrent(sessionId, telegram.generation)) throw new Error("Telegram attachment is no longer active");
      if (launchId !== undefined) {
        const missing = ["ask_user", "spawn_subagent", "shell_exec", "apply_patch"].filter(name => !toolNames.includes(name));
        if (typeof launchId !== "string" || !shellProfile || missing.length || sessionReadOnly.get(sessionId))
          throw new Error(`capability_missing: Issue preparation needs the writable shell coordinator with interactive tools (${missing.join(", ")}).`);
        if (!acceptIssueTurn(state.handle.dir, bound, launchId, rendered.trustedText)) return { stopReason: "end_turn" };
      }
      if (bound?.launch.flow) finishIssueActivity = startIssueSessionActivity(state.handle.dir, options.dataDir);
      let finalText = "";
      let progressSent = false;
      const mirror = (text: string, final = false): void => {
        if (outputGeneration === undefined) return;
        const safe = redactSensitiveText(text).trim();
        if (safe.length === 0) return;
        void telegramBindings.enqueueMirror(sessionId, outputGeneration, safe).then((accepted) => {
          if (final && !accepted && !stopping && registry.get(sessionId)?.lease === state.lease && registry.canPersist(sessionId)) {
            sendUpdate(sessionId, { sessionUpdate: "_keryx/telegram/delivery", status: "unconfirmed" });
          }
        }).catch(() => undefined);
      };
      const turnUpdates = (id: string, update: AcpSessionUpdate): void => {
        sendUpdate(id, update);
        if (outputGeneration === undefined) return;
        if (update.sessionUpdate === "tool_call") {
          finalText = "";
          if (!progressSent) { progressSent = true; mirror("Working on a tool call."); }
        } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update._meta === undefined) {
          finalText += update.content.text;
        }
      };
      const io = createAcpAgentIo(
        sessionId,
        turnUpdates,
        askPermissionFor(sessionId, turn),
        // The shell's own gate semantics (`resolveApprovalDecision`, read fresh
        // per call by `executeCall`) — the mode is the only thing ACP supplies.
        // Every ask also says why it is asked (`_meta.keryx.reasons`).
        shellProfile ? { permissionMode: () => telegram === undefined ? modeOf(sessionId) : "ask", permissionReasons: true } : {},
      );
      if (shellProfile) {
        // `spawn_subagent` links its subagents to THIS call: the id the client was shown is minted by
        // the turn's IO, so the tool gets it through its context (`InteractiveToolContext.toolCallId`).
        deps.tools = deps.tools.map((tool) =>
          tool.definition.name === "spawn_subagent" ? withHostToolCallId(tool, io.toolCallIdFor) : tool,
        );
        // A turn starts with a fresh subagent budget, as the shell's turn driver does.
        subagentBudgetResets.get(sessionId)?.();
        // `/plan on`: read fresh by every gated call, as the readline shell's own flag is.
        io.readOnly = () => sessionReadOnly.get(sessionId) === true;
        // The client's MCP servers: trust grants for the session, and the first-party ones
        // (the desktop side panel, D-13) exempt from the untrusted-content floor per tool.
        const clientMcpSet = sessionMcp.get(sessionId)?.mcp;
        if (clientMcpSet !== undefined) {
          let grants = mcpGrants.get(sessionId);
          if (grants === undefined) {
            grants = new SessionMcpGrants(
              () => sessionMcp.get(sessionId)?.mcp.firstParty,
              () => sessionMcp.get(sessionId)?.mcp.catalog() ?? { entries: [] },
            );
            mcpGrants.set(sessionId, grants);
          }
          io.trustedMcpTools = grants;
          io.mcpToolFingerprint = (fqn) => catalogFingerprintResolver(clientMcpSet.catalog())(fqn);
          io.mcpToolDestructive = (fqn) => catalogDestructiveResolver(clientMcpSet.catalog())(fqn);
          io.mcpFloorExempt = (fqn) => firstPartyFloorExempt(clientMcpSet.firstParty, fqn);
        }
        // `auto` mode answers ask_user itself; without this the client would
        // see the answer land in the model's context but never be told.
        io.onQuestionSelfAnswered = (question, answerLabel) => {
          sendUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: textBlock(`Auto mode answered: ${selfAnsweredLine(question, answerLabel)}\n`),
            _meta: { keryx: { selfAnsweredQuestion: true } },
          });
        };
        let turnUsage: TokenTally = { inputTokens: 0, outputTokens: 0 };
        const contextWindow = agentContextWindow(deps) ?? 0;
        io.onUsage = (usage) => {
          turnUsage = addUsage(turnUsage, usage);
          const session = addUsage(sessionUsage.get(sessionId) ?? { inputTokens: 0, outputTokens: 0 }, usage);
          sessionUsage.set(sessionId, session);
          sendUpdate(sessionId, {
            sessionUpdate: "usage_update",
            // ACP's own pair: the context this model call occupied, and the window (0 = unknown).
            used: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            size: contextWindow,
            _meta: {
              keryx: {
                call: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
                turn: { ...turnUsage },
                session: { ...session },
              },
            },
          });
        };
      }
      // Flow 387 review r1 F-001 / r2 F-021: `persistHistory` without an archive writes the
      // CONTEXT as the archive, so this host keeps the originals itself (`state.archive`). It is
      // synced on every history change (the shells' `onHistoryChange` contract) and its cursor is
      // re-pointed when the history is shortened in place (overflow compaction), so the turn that
      // triggered the compaction still reaches archive.jsonl. This host does not set `pruneArchive`.
      const archive = state.archive;
      syncAcpArchive(archive, state.history);
      io.onHistoryChange = () => syncAcpArchive(archive, state.history);
      deps.onContextCompaction = () => {
        archive.next = state.history.length;
      };
      if (shellProfile) {
        // `/rewind`: a snapshot of the files before each mutating call, and the turn's place in the archive.
        const rewind = rewindFor(sessionId);
        io.beforeMutation = () => rewind.recorder.beforeMutation();
        // A resumed turn (R3-LG-005) starts at the stored notes it runs on, so rewinding it takes them out too.
        const resumedInArchive = resumedNotes > 0 && freshResults !== undefined ? Math.min(resumedNotes, trailingNotesAwaitingTurn(archive.messages, freshResults.duplicates)) : 0;
        rewind.recorder.beginTurn({ archiveIndex: archive.messages.length - resumedInArchive, prompt: userLine });
      }
      // After a `/goal` the session keeps its slate, as the shells do; the goal's own turn skips the
      // close-phrase check once, since `/goal` has just opened the slate it would archive.
      const slate = sessionSlates.get(sessionId);
      const goalTurn = slate !== undefined && slate.goalPrompt !== undefined && slate.goalPrompt === userLine;
      if (slate !== undefined) delete slate.goalPrompt;
      // Flow 523: the results go in right before the continuation line the turn pushes, inside the
      // turn `/rewind` recorded above, so rewinding this turn takes them out with it. The turn is
      // keryx's (`origin: "terminal-results"`, review AR2-001): its line is not the operator's, so no
      // `UserPromptSubmit` hook sees or refuses it, and nothing can leave these notes without their turn.
      // A resumed turn (R3-LG-005) stores nothing: its notes are the stored ones before this line.
      if (freshResults !== undefined) appendTerminalResultNotes(sessionId, freshResults.fresh);
      const result = await runAgentTurn(io, deps, state.history, userLine, {
        signal: turn.controller.signal,
        ...(terminalResults !== undefined ? { origin: "terminal-results" as const } : {}),
        ...(rendered.untrusted ? { untrustedPrompt: true, operatorText: rendered.trustedText } : {}),
        ...(telegram === undefined ? {} : { source: "telegram", automaticReview: false }),
        ...(slate !== undefined ? { slateSession: slate.ref, ...(goalTurn ? { skipCloseTrigger: true } : {}) } : {}),
      });
      syncAcpArchive(archive, state.history);
      if (!registry.canPersist(sessionId)) {
        // Another instance took the lease over mid-turn: its transcript is not
        // ours to rewrite. Said to the client instead of writing silently.
        refuse({
          code: JSON_RPC_ERROR_CODES.internalError,
          message: describeLeaseLoss(state.lease).trim(),
          data: { sessionId, reason: "session-lease-lost" },
        });
      }
      const updatedHandle = persistHistory(state.handle, state.history, {
        provider: providerId,
        model: modelId,
        archive: archive.messages,
      });
      registry.updateHandle(sessionId, updatedHandle);
      if (!turn.cancelled && finalText.trim()) mirror(finalText, true);
      if (bound?.launch.flow) settleIssueTurn(state.handle.dir);
      if (shellProfile && updatedHandle.summary.title !== state.handle.summary.title) {
        sendUpdate(sessionId, {
          sessionUpdate: "session_info_update",
          title: updatedHandle.summary.title,
          updatedAt: updatedHandle.summary.updatedAt,
        });
      }
      // `turn.cancelled` wins over whatever `finishReason` came back: a turn
      // `session/cancel` interrupted reports `cancelled` even though most of
      // `runAgentTurn`'s abort paths return `finishReason: undefined` — the
      // SAME value an ordinary toolless finish returns (F-5) — which
      // `finishReasonToStopReason` alone would read as `end_turn`. (An abort
      // during a `submit_result` wrap-up returns `"interrupted"`, which already
      // maps to `cancelled`.)
      return { stopReason: turn.cancelled ? "cancelled" : finishReasonToStopReason(result.finishReason), ...storedAnswer };
    } finally {
      if (registry.canPersist(sessionId)) finishIssueActivity?.();
      // Released on EVERY exit path — a normal finish, a thrown error, and a
      // cancelled turn alike — or the session would stay "busy" for the rest
      // of the connection and every later prompt would be refused.
      //
      // No further `session/cancel` for this turn is meaningful once it has
      // finished (there is nothing left running to stop, and nothing left
      // pending to settle — `askPermissionFor` already removes its own
      // request id from `turn.permissionRequestIds` as each ask settles).
      // Only THIS turn's own slot is released: deleting by id alone would, if
      // the busy guard above ever regressed, hand a later turn's slot away.
      if (activeTurns.get(sessionId) === turn) {
        // A session-owned draft is active only while this turn runs. Preserve it as a partial review if abandoned.
        settleSessionReviews(state.resolvedRoot, sessionId, sessionJobs.get(sessionId)?.activeTaskTokens?.());
        activeTurns.delete(sessionId);
        if (telegram !== undefined) {
          sendUpdate(sessionId, { sessionUpdate: "_keryx/telegram/turn", source: "telegram", phase: "finished", actorId: telegram.actorId, updateId: telegram.updateId, generation: telegram.generation });
          if (turn.cancelled) void telegramBindings.send(sessionId, telegram.generation, "The Telegram turn stopped.").catch(() => false);
        }
        const notes = pendingDelegateNotes.get(sessionId);
        if (notes !== undefined) {
          pendingDelegateNotes.delete(sessionId);
          appendDelegateNotes(sessionId, notes);
        }
      }
      touch(sessionId);
    }
  }

  /**
   * `session/cancel` (flow 285, T10 — AC4). A NOTIFICATION: no reply, ever —
   * the turn's eventual `session/prompt` response IS the acknowledgement, and
   * it carries `stopReason: "cancelled"` because this handler set
   * `turn.cancelled` before that response was computed.
   *
   * Two effects, both synchronous with respect to THIS line's dispatch (F-12:
   * this handler itself never awaits anything that could let another line's
   * dispatch interleave before both have run):
   *
   *   1. `turn.controller.abort()` — the same `AbortSignal` a local hard-stop
   *      uses. Every `isAborted()` check inside `runAgentTurn` (`commands/
   *      agent.ts`) starts returning true from here on, so no FURTHER
   *      `session/update` for this turn is emitted once the turn's current
   *      unit of work (a streaming round, or an already-dispatched tool call)
   *      finishes — exactly the local-abort shape AC4 asks to match.
   *   2. F-14: settles every one of THIS turn's own outstanding
   *      `session/request_permission` requests as a local denial
   *      (`AcpClientRequests.cancel`, scoped to this turn's own request ids —
   *      never `close()`, which would also deny every OTHER session's live
   *      questions). `askPermissionFor` already treats a "closed" outcome as
   *      a denial, so the pending `requestApproval` call this unblocks
   *      resolves `false` — the tool does not run — and the turn then stops
   *      at its next `isAborted()` check via effect 1. Per context.md F-14,
   *      keryx sends no `$/cancel_request` to the client for the request it
   *      is abandoning; a client that wants out of answering it can itself
   *      answer `cancelled`, which is already mapped to the same denial.
   *
   * An unknown or already-finished `sessionId` is not an error — the turn it
   * would have cancelled is simply not running any more (or never was), which
   * is not distinguishable from "cancel arrived one tick too late" and is
   * logged, not refused (this is a notification; there is nothing to refuse
   * TO).
   */
  /** `_keryx/session_shown` (shell profile): the client shows this held session now, so it counts as used. */
  function handleSessionShown(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const sessionId = (params as Record<string, unknown>)["sessionId"];
    if (typeof sessionId === "string" && registry.get(sessionId) !== undefined) touch(sessionId);
  }

  function handleSessionCancel(params: unknown): void {
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionCancel);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionCancel);
    // A `/delegate` run is not a turn, but a cancel stops it all the same.
    sessionExternalRuns.get(sessionId)?.stop("cancelled by session/cancel");
    const turn = activeTurns.get(sessionId);
    if (turn === undefined) {
      options.logError(
        `acp: ${ACP_AGENT_METHODS.sessionCancel} for ${sessionId}: no turn is currently running for this session`,
      );
      return;
    }
    cancelTurn(turn);
  }

  function cancelTurn(turn: AcpActiveTurn): void {
    turn.cancelled = true;
    turn.controller.abort();
    for (const requestId of turn.permissionRequestIds) clientRequests.cancel(requestId, "the turn was cancelled");
    turn.permissionRequestIds.clear();
  }

  function stopTelegramTurn(sessionId: string, generation: string): boolean {
    const turn = activeTurns.get(sessionId);
    if (turn === undefined || turn.telegramGeneration !== generation) return false;
    cancelTurn(turn);
    return true;
  }

  /**
   * `session/list` (flow 285, T10 — AC5). `listSessions()`'s own store is the
   * one `keryx shell`, `keryx sessions` and `session/new`/`session/load` all
   * share — a session created through any of them is visible here.
   *
   * F-7 (context.md): ACP's `cwd` is an optional FILTER ("omit it and get
   * every session"), but `listSessions(cwd, ...)` is project-isolated by
   * construction and keryx has no cross-project listing to fall back to.
   * Recommended reading, applied here: an omitted `cwd` lists the sessions of
   * the ACP PROCESS's own project root (`resolveProjectRoot(process.cwd())`)
   * rather than refusing an optional parameter, which is its own conformance
   * break. `cursor`/pagination has no keryx equivalent either — every call
   * answers a single page and never sets `nextCursor`, which the spec allows.
   */
  function handleSessionList(params: unknown): AcpListSessionsResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionList);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionList);
    const rawCwd = obj["cwd"];
    if (rawCwd !== undefined && rawCwd !== null && typeof rawCwd !== "string") {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionList}: cwd must be a string, null or omitted`, { received: rawCwd }));
    }
    const cwd = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : process.cwd();
    const summaries = listSessions(cwd, options.dataDir);
    const sessions: AcpSessionInfo[] = summaries.map((summary) => ({
      sessionId: summary.id,
      // F-6: the RESOLVED project root the session is actually bound to
      // (`summary.projectPath`), never a requested cwd this listing did not
      // even take per-session — honest, and consistent with what
      // `session/load`'s own cwd check compares against.
      cwd: summary.projectPath,
      title: listedTitle(cwd, summary, options.dataDir),
      updatedAt: summary.updatedAt,
      // Shell profile: how the person organised it (archived, pinned, flow) and how many messages it
      // holds, so a client can tell an empty session from a used one. The editor profile's wire stays as it was.
      ...(shellProfile ? listMeta(readSessionFlags(sessionDir(summary.projectPath, summary.id, options.dataDir)), summary.messageCount) : {}),
    }));
    return { sessions };
  }

  function listMeta(flags: SessionFlags, messageCount: number): { _meta: { keryx: SessionFlags & { messageCount: number } } } {
    return { _meta: { keryx: { ...flags, messageCount } } };
  }

  /** The `sessionId` and optional `cwd` of an organise request; `cwd` defaults like `session/list`'s. */
  function organiseTarget(params: unknown, method: string): { obj: Record<string, unknown>; sessionId: string; cwd: string } {
    requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const sessionId = requireStringField(obj, "sessionId", method);
    const rawCwd = obj["cwd"];
    if (rawCwd !== undefined && rawCwd !== null && typeof rawCwd !== "string") {
      refuse(invalidParams(`${method}: cwd must be a string, null or omitted`, { received: rawCwd }));
    }
    return { obj, sessionId, cwd: typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : process.cwd() };
  }

  async function handleSessionReviews(params: unknown) {
    requireInitialized(SESSION_REVIEWS_METHOD);
    const request = requireObjectParams(params, SESSION_REVIEWS_METHOD);
    const sessionId = requireStringField(request, "sessionId", SESSION_REVIEWS_METHOD);
    const state = registry.get(sessionId);
    if (!state) return [];
    try {
      return sessionReviewSummaries(await readVisibleSessionReviews(state.resolvedRoot, sessionId), sessionId, state.handle.dir);
    } catch {
      return [];
    }
  }

  async function handleSessionReviewRequest(params: unknown) {
    const method = SESSION_REVIEW_REQUEST_METHOD;
    requireInitialized(method);
    const request = requireObjectParams(params, method);
    const sessionId = requireStringField(request, "sessionId", method);
    const attemptId = requireStringField(request, "attemptId", method);
    const text = requireStringField(request, "text", method);
    const state = registry.get(sessionId);
    if (!state || !registry.canPersist(sessionId)) return null;
    return withSessionWork(sessionId, () => recordSessionReviewRequest(state.resolvedRoot, sessionId, state.handle.dir, attemptId, text));
  }

  function refuseStore(method: string, sessionId: string, error: unknown): never {
    refuse(invalidRequest({ reason: `${method}: ${error instanceof Error ? error.message : String(error)}`, method, sessionId }));
  }

  /** `_keryx/session_flags` (shell profile): archive/unarchive, pin/unpin a stored session, link it to a flow and a GitHub subject. */
  async function handleSessionFlags(params: unknown): Promise<SessionFlags> {
    const method = KERYX_ACP_EXTENSION_METHODS.sessionFlags;
    const { obj, sessionId, cwd } = organiseTarget(params, method);
    const change: SessionFlagsChange = {};
    for (const key of ["archived", "pinned"] as const) {
      const value = obj[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") refuse(invalidParams(`${method}: ${key} must be a boolean or omitted`, { received: value }));
      change[key] = value;
    }
    const flow = obj["flow"];
    if (flow !== undefined) {
      if (flow !== null && typeof flow !== "string") refuse(invalidParams(`${method}: flow must be a string, null or omitted`, { received: flow }));
      change.flow = flow;
    }
    const subject = obj["subject"];
    if (subject !== undefined) {
      if (subject !== null && (typeof subject !== "object" || Array.isArray(subject))) {
        refuse(invalidParams(`${method}: subject must be an object, null or omitted`, { received: subject }));
      }
      // Its fields are checked by the store, which refuses a subject that is not a GitHub PR or issue.
      change.subject = subject as Exclude<SessionFlagsChange["subject"], undefined>;
    }
    try {
      // Async: another process's flags lock is waited out without freezing this server's event loop.
      // The store applies this server's writes to one session in the order they arrive.
      return await setSessionFlagsAsync(cwd, sessionId, change, options.dataDir, { timing: options.sessionFlagsLock });
    } catch (error) {
      refuseStore(method, sessionId, error);
    }
  }

  /**
   * `_keryx/session_trash` (shell profile): moves a stored session to the
   * system trash. A held session is released first (no `session_released`
   * follows: the client asked); a busy or opening one is refused.
   */
  async function handleSessionTrash(params: unknown): Promise<{ trashedTo: string }> {
    const method = KERYX_ACP_EXTENSION_METHODS.sessionTrash;
    const { sessionId, cwd } = organiseTarget(params, method);
    refuseIfOpening(method, sessionId);
    if (registry.get(sessionId) !== undefined) {
      if (sessionIsBusy(sessionId)) {
        refuse(
          invalidRequest({
            reason: `${method}: session ${sessionId} has a running turn or task; stop it first`,
            method,
            sessionId,
            condition: "session-busy",
          }),
        );
      }
      await teardownSession(sessionId, TRASHED_END_REASON);
    }
    try {
      return { trashedTo: trashSession(cwd, sessionId, { ...options.trash, dataDir: options.dataDir }) };
    } catch (error) {
      refuseStore(method, sessionId, error);
    }
  }

  /**
   * Replays one durable session's history as `session/update` notifications,
   * in order, BEFORE `session/load` responds (the spec requires the replay to
   * precede the response). Flow 285, T10 — AC5, F-9.
   *
   * The role mapping F-9 asks every implementation to decide explicitly:
   *
   *   `user`      -> `user_message_chunk` (a delegate note: its text + `_meta.keryx.delegateResult`;
   *                  a terminal-result note: `_meta.keryx.terminalResult`, keryx's continuation line
   *                  (the message marked `terminalContinuation`) `_meta.keryx.terminalContinuation`;
   *                  skipped when the content is empty —
   *                  mirrors `AgentIO.write`/`onSystem`'s own "nothing to
   *                  say" no-op below).
   *   `assistant` -> `agent_message_chunk` for the text (if any), followed by
   *                  one `tool_call` per `NormalizedToolCall` the round made
   *                  — using the SAME `toolKindFor`/`tryParseJson` a LIVE
   *                  turn's `onToolCall` uses (`agent-io.ts`), so a replayed
   *                  call and a live one look identical on the wire. Status
   *                  `pending` until the matching `tool` message (below)
   *                  updates it — it is never left there if one exists.
   *   `tool`      -> `tool_call_update` for the call it answers
   *                  (`toolCallId`), status `completed`. A `NormalizedMessage`
   *                  keeps no separate success/failure marker once persisted
   *                  (only the text content, which may itself say "not
   *                  executed" or similar) — `completed` is the honest
   *                  approximation available from stored history; a message
   *                  with no matching prior `tool_call` (a transcript hand-
   *                  edited or from a schema this replay does not expect)
   *                  still gets a fresh `tool_call`/`tool_call_update` pair
   *                  rather than being dropped.
   *   `system`    -> DROPPED. F-9: system has no ACP chunk home at all, and
   *                  replaying it as a `user_message_chunk` or
   *                  `agent_message_chunk` would misattribute it as something
   *                  the human or the model said. The drop is explicit (this
   *                  comment, and `capability-tools.ts`-style documentation)
   *                  rather than an accidental fallthrough.
   */
  function replayHistory(sessionId: string, history: readonly NormalizedMessage[]): void {
    let parentTurn = 0;
    const spawnCalls = new Set<string>();
    for (const message of history) {
      if (message.role === "system") {
        continue;
      }
      if (message.role === "user") {
        if (message.content.length === 0) continue;
        // Flow 523 review AR2-001: keryx's continuation line is injected (not the operator's), but it
        // starts the turn a Run's result began, as the desktop counts it live. Read by its marker,
        // never its text: the operator may type the same sentence, and the wording may change.
        if (message.terminalContinuation === true) {
          parentTurn++;
          sendUpdate(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: textBlock(message.content),
            _meta: { keryx: { terminalContinuation: true, parentTurn, ...(message.ts ? { recordedAt: message.ts } : {}) } },
          });
          continue;
        }
        // A delegate note replays as what it is: the result text with the run it came from in `_meta`,
        // never the envelope (the model-facing history keeps it). A client that does not know the
        // meta shows the plain text.
        const injected = isInjectedUserMessage(message);
        if (!injected) parentTurn++;
        const note = injected ? parseDelegateNote(message.content) : undefined;
        if (note !== undefined) {
          sendUpdate(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: textBlock(note.text),
            _meta: { keryx: { delegateResult: note, parentTurn, ...(message.ts ? { recordedAt: message.ts } : {}) } },
          });
          continue;
        }
        // Flow 523: a terminal-result note replays as its parsed fields (the desktop draws a run card),
        // never the envelope. Only an injected note: an operator line of the same shape is their text.
        const terminal = injected ? parseTerminalResultNote(message.content) : undefined;
        if (terminal !== undefined) {
          sendUpdate(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: textBlock(terminalResultText(terminal)),
            _meta: { keryx: { terminalResult: terminal, parentTurn, ...(message.ts ? { recordedAt: message.ts } : {}) } },
          });
          continue;
        }
          sendUpdate(sessionId, { sessionUpdate: "user_message_chunk", content: textBlock(message.content),
            _meta: { keryx: { parentTurn, ...(message.source === undefined ? {} : { source: message.source }) } } });
        continue;
      }
      if (message.role === "assistant") {
        if (message.content.length > 0) {
          sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(message.content) });
        }
        for (const call of message.toolCalls ?? []) {
          if (call.name === "spawn_subagent") spawnCalls.add(call.id);
          sendUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: call.name,
            name: call.name,
            kind: toolKindFor(call.name),
            status: "pending",
            rawInput: tryParseJson(call.arguments),
            ...(call.name === "spawn_subagent" ? { _meta: { keryx: { parentTurn, ...(message.ts ? { recordedAt: message.ts } : {}) } } } : {}),
          });
        }
        continue;
      }
      // message.role === "tool"
      const toolCallId = message.toolCallId ?? randomUUID();
      sendUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: spawnCalls.delete(toolCallId) && message.isError ? "failed" : "completed",
        content: [{ type: "content", content: textBlock(message.content) }],
        rawOutput: message.content,
      });
    }
  }

  /**
   * `session/load` (flow 285, T10 — AC5). Loads a durable session created
   * through ANY entry point into that store (`keryx shell`, `keryx sessions`,
   * an earlier `session/new`) and replays it before responding.
   */
  async function handleSessionLoad(params: unknown, requestId: JsonRpcId): Promise<AcpLoadSessionResponse> {
    requireInitialized(ACP_AGENT_METHODS.sessionLoad);
    refuseIfStopping(ACP_AGENT_METHODS.sessionLoad);
    requireProvider(ACP_AGENT_METHODS.sessionLoad);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionLoad);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionLoad);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionLoad);
    // Validated up front (same split as `session/new`); nothing is STARTED
    // until the load has succeeded, so a refused load spawns nothing.
    const parsedMcp = parseAcpMcpServers(ACP_AGENT_METHODS.sessionLoad, obj["mcpServers"]);
    // A load REPLACES the registry entry, and with it the `history` array a
    // turn in flight is still writing into — refused for the same reason a
    // second prompt is (`refuseIfBusy`), and before `registry.load` does any
    // work. The shell profile keeps a held session's entry, but a replay beside
    // a running turn would still interleave with it.
    refuseIfBusy(ACP_AGENT_METHODS.sessionLoad, sessionId);
    const method = ACP_AGENT_METHODS.sessionLoad;
    if (shellProfile) {
      refuseIfOpening(method, sessionId);
      const held = registry.get(sessionId);
      if (held !== undefined) return loadHeldSession(held, cwd, requestId);
    }
    const wasHeld = registry.get(sessionId) !== undefined;
    let state: ReturnType<typeof registry.load>;
    try {
      state = registry.load(sessionId, cwd, clientCapabilities);
    } catch (cause) {
      if (cause instanceof SessionLeasedError) {
        // A live `keryx shell` (or another `keryx acp`) holds this session: loading
        // it here would let both surfaces overwrite each other's transcript.
        refuse({
          code: JSON_RPC_ERROR_CODES.internalError,
          message: `Cannot load session ${sessionId}: it is open in ${describeLeaseHolder(cause.holder)}`,
          data: {
            sessionId,
            cwd,
            reason: "session-leased",
            leaseState: cause.state,
            ...(cause.holder !== undefined ? { holder: { pid: cause.holder.pid, host: cause.holder.host } } : {}),
          },
        });
      }
      if (!(cause instanceof AcpSessionTranscriptUnreadableError)) {
        throw cause;
      }
      // The session exists but its transcript could not be read — a distinct,
      // actionable answer, not `resourceNotFound` (that would say "no such
      // session", which is false) and not a silent resume into an empty
      // history (the one thing `TranscriptUnreadableError` exists to prevent).
      refuse({
        code: JSON_RPC_ERROR_CODES.internalError,
        message: `Cannot load session ${sessionId}: ${cause.cause.message}`,
        data: { sessionId, cwd, file: cause.cause.file, reason: cause.cause.reason },
      });
    }
    if (state === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId, cwd },
      });
    }
    // An editor-profile reload of a session it holds is the same hold.
    if (!wasHeld) beginHold(sessionId);
    touch(sessionId);
    const loaded = state;
    if (shellProfile) opening.add(sessionId);
    return withSessionWork(sessionId, async () => {
      try {
        // Replay BEFORE responding — the spec's own ordering requirement.
        replayHistory(sessionId, loaded.history);
        // Flow 306 (W6, T15): the load REPLACES the registry entry, so it also
        // replaces (or creates, if this connection has never seen this session
        // id) this session's hook runtime — same hazard, same fix, as the MCP
        // rebind just below.
        await ensureShellHooksAndFireStart(sessionId, loaded.resolvedRoot, requestId);
        refuseIfStopping(method);
        // The load REPLACES the session's entry, so it replaces its MCP servers
        // too: whatever an earlier `session/new`/`session/load` on this connection
        // started for this id is stopped, and this request's list is started.
        bindSessionMcp(sessionId, requestId, parsedMcp, loaded.resolvedRoot);
        announceCommands(sessionId, requestId);
        // After a restart, or a release by the idle cap, continue on the model the
        // session was on, when it can run here (flow 288, T14).
        await restoreRecordedModel(loaded, requestId, method);
        refuseIfStopping(method);
        // A session this connection ran before keeps its mode, across a release
        // and reload too; otherwise the project's default.
        const mode = shellProfile ? bindShellSession(loaded, requestId) : undefined;
        const configOptions = await configOptionsFor(sessionId, method);
        refuseIfStopping(method);
        enforceIdleCap();
        return { ...(mode !== undefined ? { modes: acpModeState(modeOf(sessionId)) } : {}), configOptions, ...recoveryMeta(loaded) };
      } catch (error) {
        abandonOpen(sessionId);
        throw error;
      } finally {
        opening.delete(sessionId);
      }
    });
  }

  /**
   * Shell profile: `session/load` of a session this connection already holds
   * (live sessions, r04). Nothing is rebuilt — its mode, model, usage, shell
   * tasks, MCP set and hook runtime stay as they are, and the `mcpServers` this
   * request names are not started. Its transcript is replayed, its title, plan
   * and commands are sent again, and the reply carries its current mode and
   * config options. A failure leaves it held.
   */
  async function loadHeldSession(state: AcpSessionState, cwd: string, requestId: JsonRpcId): Promise<AcpLoadSessionResponse> {
    const method = ACP_AGENT_METHODS.sessionLoad;
    const sessionId = state.sessionId;
    // Same answer as a not-held load of an id from another project.
    if (resolveProjectRoot(cwd) !== state.resolvedRoot) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId, cwd },
      });
    }
    touch(sessionId);
    return withSessionWork(sessionId, async () => {
      replayHistory(sessionId, state.history);
      announceCommands(sessionId, requestId);
      bindShellSession(state, requestId);
      const configOptions = await configOptionsFor(sessionId, method);
      refuseIfStopping(method);
      return { modes: acpModeState(modeOf(sessionId)), configOptions, ...recoveryMeta(state) };
    });
  }

  /**
   * `session/set_config_option` (flow 288, AC6). keryx has one option, the
   * model. Answered with the COMPLETE option list, as the spec requires. Not
   * refused while a turn runs: that turn keeps the model it started with.
   */
  async function handleSetConfigOption(params: unknown): Promise<AcpSetSessionConfigOptionResponse> {
    const method = ACP_AGENT_METHODS.sessionSetConfigOption;
    requireInitialized(method);
    refuseIfStopping(method);
    const obj = requireObjectParams(params, method);
    const sessionId = requireStringField(obj, "sessionId", method);
    const configId = requireStringField(obj, "configId", method);
    const value = obj["value"];
    if (typeof value !== "string" || value.length === 0) {
      refuse(invalidParams(`${method}: value must be a non-empty string`, { received: value }));
    }
    refuseIfOpening(method, sessionId);
    if (registry.get(sessionId) === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId },
      });
    }
    if (configId !== ACP_MODEL_CONFIG_ID) {
      refuse(
        invalidParams(`${method}: keryx has no config option "${configId}"; the only one is "${ACP_MODEL_CONFIG_ID}"`, {
          configId,
        }),
      );
    }
    touch(sessionId);
    // Counted as work on the session, so the idle cap does not release it while its provider is built.
    return withSessionWork(sessionId, async () => {
      await switchSessionModel(sessionId, value, method, false);
      return { configOptions: await configOptionsFor(sessionId, method) };
    });
  }

  /** Shell profile: `_keryx/providers/*` and `_keryx/search_providers/*` (specification §3.9.3). */
  const providers = shellProfile
    ? createProvidersHandlers({
        ...options.providers,
        ...(options.providers?.configDir === undefined && options.shellConfigDir !== undefined ? { configDir: options.shellConfigDir } : {}),
        searchController: searchControllerFor,
        requireInitialized,
        notify: (method, params) => writeMessage(notificationMessage(method, params)),
        onProvidersChanged: refreshModelChoicesAfterProviderChange,
        newId: idSeq,
      })
    : undefined;

  const dispatcher = new AcpDispatcher(
    {
      requests: {
        [ACP_AGENT_METHODS.initialize]: (params) => handleInitialize(params),
        [ACP_AGENT_METHODS.sessionNew]: (params, context) => handleSessionNew(params, context.id),
        [ACP_AGENT_METHODS.sessionPrompt]: (params) => handleSessionPrompt(params),
        [ACP_AGENT_METHODS.sessionList]: (params) => handleSessionList(params),
        [ACP_AGENT_METHODS.sessionLoad]: (params, context) => handleSessionLoad(params, context.id),
        [ACP_AGENT_METHODS.sessionSetConfigOption]: (params) => handleSetConfigOption(params),
        [KERYX_ACP_EXTENSION_METHODS.info]: () => handleKeryxInfo(),
        // Shell profile only: the editor profile keeps refusing it with -32601.
        ...(shellProfile
          ? {
              [ACP_AGENT_METHODS.sessionSetMode]: (params: unknown, context: { id: JsonRpcId }) => handleSetMode(params, context.id),
              [KERYX_ACP_EXTENSION_METHODS.command]: (params: unknown) => handleKeryxCommand(params),
              [ACP_TELEGRAM_SESSION_METHOD]: (params: unknown) => handleTelegramSession(params),
              ["_keryx/telegram/project-question"]: (params: unknown) => handleProjectTelegramQuestion(params),
              ...(providers?.requests ?? {}),
              ...createTasksHandlers({
                requireInitialized,
                jobsOf: (sessionId) => {
                  const state = registry.get(sessionId);
                  return state === undefined ? undefined : jobsFor(sessionId, state.resolvedRoot);
                },
              }).requests,
              [SESSION_REVIEWS_METHOD]: handleSessionReviews,
              [SESSION_REVIEW_REQUEST_METHOD]: handleSessionReviewRequest,
              [KERYX_ACP_EXTENSION_METHODS.sessionFlags]: (params: unknown) => handleSessionFlags(params),
              [KERYX_ACP_EXTENSION_METHODS.sessionTrash]: (params: unknown) => handleSessionTrash(params),
            }
          : {}),
      },
      notifications: {
        [ACP_AGENT_METHODS.sessionCancel]: (params) => handleSessionCancel(params),
        // Shell profile only: the editor profile leaves it unhandled (logged, ignored).
        ...(shellProfile
          ? {
              [KERYX_ACP_EXTENSION_METHODS.sessionShown]: (params: unknown) => handleSessionShown(params),
              [KERYX_ACP_EXTENSION_METHODS.delegateExited]: (params: unknown) => handleDelegateExited(params),
            }
          : {}),
      },
    },
    {
      onUnhandledNotification: (method) => options.logError(`acp: unhandled notification ${method}`),
      onHandlerError: (method, error) =>
        options.logError(`acp: ${method} failed: ${error instanceof Error ? error.message : String(error)}`),
    },
  );

  const handleOutcome = (outcome: AcpDispatchOutcome): void => {
    if (outcome.kind === "reply") {
      writeMessage(outcome.message);
      const key = replyKey(outcome.message.id);
      const after = afterReply.get(key);
      if (after !== undefined) {
        afterReply.delete(key);
        // Only a SUCCESS reply has a session to report on. (A handler that
        // registers work and then fails — `session/new` awaiting its model
        // list, say — must not announce a session the client was refused.)
        if (!("error" in outcome.message)) {
          for (const work of after) work();
        }
      }
      return;
    }
    if (outcome.kind === "incoming-response") {
      // A `session/request_permission` answer arrives here. The pending table
      // owns it; anything it does not claim is unsolicited or duplicate and is
      // reported rather than dropped.
      if (!clientRequests.resolve(outcome.message)) {
        options.logError(`acp: unexpected response with no pending request: ${JSON.stringify(outcome.message)}`);
      }
    }
  };

  /**
   * Lines are STARTED in order and AWAITED separately.
   *
   * This loop used to `await` each line's dispatch before reading the next
   * one, which was fine while every handler answered out of its own state. It
   * deadlocks the moment keryx asks the client something: `session/prompt`
   * blocks on `session/request_permission`, whose answer is the NEXT LINE ON
   * STDIN — a line a loop parked inside the prompt handler will never read.
   *
   * Handlers still START in wire order: `handleLine` runs synchronously into
   * the handler body (through `handleMessage` -> `handleRequest` ->
   * `handler(...)`), and `session/new` — whose only `await` (the model list)
   * comes AFTER the session is registered — has finished registering it
   * before the next line is even decoded; its reply may then wait on that
   * list. A handler that SUSPENDS no longer suspends the reader with it, so
   * two handlers that both suspend can FINISH in either order. A handler whose
   * effects must keep arrival order across its own suspension has to order
   * them itself: `_keryx/session_flags` waits for another process's lock, and
   * the store queues this process's writes to one session so they apply in
   * the order they arrived. JSON-RPC ids carry the correlation, so replies
   * may land in completion order.
   */
  const inflight = new Set<Promise<unknown>>();
  const dispatch = (line: string): void => {
    const task = dispatcher.handleLine(line).then(handleOutcome, (error: unknown) => {
      // `handleLine` is documented as total, so this is a floor, not a path.
      options.logError(`acp: dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    inflight.add(task);
    void task.finally(() => {
      inflight.delete(task);
    });
  };

  const framer = new AcpLineFramer();
  const readLoop = async (): Promise<void> => {
    for await (const chunk of options.input) {
      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch (error) {
        options.logError(`acp: framing error: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const line of lines) {
        dispatch(line);
      }
    }
    for (const line of framer.flush()) {
      dispatch(line);
    }
  };

  // `shutdown` (flow 287): the CLI aborts it on SIGTERM/SIGINT — editors stop
  // an agent by signalling it far more often than by closing its stdin. A
  // pending `for await` over stdin cannot be interrupted, so the loop is RACED
  // against the abort instead of waiting for a line that will never come.
  const shutdown = options.shutdown;
  const shutdownRequested = new Promise<"shutdown">((resolve) => {
    if (shutdown === undefined) return;
    const begin = (): void => {
      // Synchronously, in the abort itself: no line dispatched after this
      // point can start session work (`refuseIfStopping`).
      stopping = true;
      resolve("shutdown");
    };
    if (shutdown.aborted) begin();
    else shutdown.addEventListener("abort", begin, { once: true });
  });

  // What every session still held is ended with (its `SessionEnd`). A read
  // loop that throws ends them as a closed connection.
  let endReason = "connection-closed";
  try {
    const ended = await Promise.race([readLoop().then(() => "eof" as const), shutdownRequested]);

    // Input has ended (or the process is being stopped): no answer can arrive
    // any more. Every question still open settles as a denial NOW rather than
    // waiting on a pipe that is closed — that is the difference between a turn
    // that finishes refusing a tool call and a process that hangs holding one.
    clientRequests.close("the client closed the connection before answering");
    if (ended === "shutdown") {
      // Stopping: every running turn is aborted the way `session/cancel`
      // aborts one, and waited for — briefly — so it unwinds and persists
      // while its session is still held (PR #1213 review logic-w8
      // LOGIC-W8-001). The process is about to exit, so the wait is bounded.
      for (const turn of activeTurns.values()) {
        turn.cancelled = true;
        turn.controller.abort();
      }
      for (const runs of sessionExternalRuns.values()) {
        runs.stop("keryx acp is shutting down");
        runs.dispose();
      }
      await within(Promise.allSettled([...inflight]), SHUTDOWN_TURN_GRACE_MS);
    } else {
      // Shell profile: nobody is left to watch a turn, and a trust or auto
      // turn would keep acting unattended. Aborted the way a Stop aborts it,
      // then drained below so it still unwinds and replies.
      if (shellProfile) {
        for (const turn of activeTurns.values()) {
          turn.cancelled = true;
          turn.controller.abort();
        }
        for (const runs of sessionExternalRuns.values()) {
        runs.stop("the client closed the connection");
        runs.dispose();
      }
      }
      // A turn started before the close still has a response to write, and the
      // stream it writes to is still open. Draining is what makes the denial
      // observable to the client instead of dying with the process.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    }
    endReason = ended === "shutdown" ? "shutdown" : "connection-closed";
  } finally {
    stopping = true;
    providers?.close();
    // Flow 306 (W6, T15): ACP advertises no `session/close` (see the
    // `SharedMcpSet` doc comment above) — the connection itself is the only
    // boundary every session this process created actually has. The same
    // per-session teardown the shell profile's idle cap runs gives their leases back
    // (synchronously, so a shell can resume them), sweeps their shell tasks,
    // and fires each hook runtime's `SessionEnd` once — never awaited past its
    // own hook timeouts (`fire()`'s own contract).
    const held = new Set([...registry.ids(), ...shellHooksBySession.keys()]);
    const teardowns = [...held].map((sessionId) => teardownSession(sessionId, endReason));
    unsubscribePlans();
    // Flow 287, AC3: every MCP server process this connection started is
    // stopped, and AWAITED — on a clean end of input, on a read loop that
    // throws, and on `shutdown`. Returning first would orphan the children.
    // Shell profile: the same for every shell task its sessions started
    // (including teardowns the idle cap started), and for keryx's own configured
    // MCP servers.
    await Promise.allSettled([
      closeAllMcp(),
      ...teardowns,
      ...releasing,
      ...[...sessionJobs.values()].map((jobs) => jobs.sweepAll()),
      ...[...keryxMcpRuntimes.values()].map((runtime) => runtime?.close()),
    ]);
  }
}
