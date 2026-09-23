// OpenTUI interactive agent shell (flows 060 skeleton + 061 chrome parity).
//
// A new IO implementation of the existing `AgentIO` hook surface (src/commands/
// agent.ts): it renders into an OpenTUI transcript and drives `runAgentTurn` from
// a `split-footer` composer (a fixed footer input over a scrolling main region —
// the Pi/grok layout). Chrome parity with the readline shell: assistant text →
// one sibling renderable per markdown segment, styled by the worker-free
// `markdownToChunks` (the native `MarkdownRenderable` is deliberately NOT used —
// flow 109 decision D-2); `● keryx` role header; `⚙ tool(args)` (via the pure
// `summarizeToolArgs`); collapsed tool output (`collapseToolOutput`); reasoning
// as a bounded `▸ thought (n lines)` block. The deterministic driver and the
// pure helpers are unchanged. Gutter = the transcript box `padding`.
//
// Usage is rendered TWICE, on purpose, because the two readings answer different
// questions. `createTuiAgentIo.onUsage` appends the per-turn `↑in ↓out tokens`
// transcript line flow 050 shipped — what THIS turn cost, the point of a metered
// provider — and `attachUsageIo` WRAPS that hook (it does not replace it) to add
// the cumulative header + sidebar counter, which tracks the context budget across
// the session. `launchTuiAgentShell` used to ASSIGN `io.onUsage`, which deleted
// the per-turn line from the running shell while leaving its code in place and
// apparently working; that was gap G-1 in the feature-parity checklist, now
// closed. Assigning the hook again would silently reopen it.
//
// The working directory the agent acts on is the sidebar `Directory` panel
// (`mountCwdPanel`), shortened to the sidebar's fixed 26-column text budget by
// the pure `shortenCwd`. It was absent from the TUI entirely — gap G-2, also
// closed: an agent holding `shell_exec` acts on a directory, and the operator
// approving that command has to be able to see which one.
//
// Since flow 112 the LAYOUT itself is not built here: `launchTuiAgentShell`
// mounts `createShellChrome` (./shell-chrome) and keeps only what knows what a
// tool is — approval, ask_user, the worker fleet, side workers, the wiki-enrich
// pre-router, the block registry/nav and the `runAgentTurn` call site. The chat
// driver mounts the same chrome, so the two surfaces cannot drift apart.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005) loaded ONLY via a dynamic
// `import()` — never a top-level import (keryx's zero-`dependencies` floor + lazy
// optional-import guard, src/capability/no-optional-imports). `launchTuiAgentShell`
// is defensive: it returns `false` (caller falls back to the readline shell)
// whenever there is no TTY, the package is absent, or the renderer fails to init.
import type { AgentDeps, AgentIO } from "../commands/agent";
import {
  describeReasoningEffortSource,
  isReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
  resolveMaxAutoWake,
  runAgentTurn,
} from "../commands/agent";
import { runModelTurn } from "../harness/provider/single-turn";
import { buildNextStepPrompt, NextStepSuggestionGate, sanitizeNextStepSuggestion } from "./next-step-suggestion";
import { buildApprovalContext } from "../commands/agent-approval-context";
import {
  closeSlateSession,
  detachSlateSession,
  mintTimestampAttemptId,
  recordSlateSessionTouch,
  type SlateSessionRef,
} from "../session/slate-lifecycle";
import { renderAnchorsBlock } from "../session/slate";
import { runGoalCommand } from "../commands/goal-command";
import { spawnSync } from "node:child_process";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { NormalizedMessage, NormalizedUsage } from "../harness/provider/types";
import { estimateRequestTokens } from "../harness/provider/context-guard";
import packageJson from "../../package.json" with { type: "json" };
import { isFlowsCommand, openFlows } from "./flow-inspector";
import { mountOpsSidebar, routeOpsCommand, type OpsSidebar } from "./ops-sidebar";
import { describeDetachedRuns } from "./trigger-run-now";
import { mountSchedulesSidebar, routeSchedulesCommand, type SchedulesSidebar } from "./schedules-sidebar";
import { classifyBusyDispatch } from "./busy-dispatch";
import { debugEvent } from "./debug-log";
import {
  createSplashLifecycle,
  mountEmptyTranscriptSplash,
  mountStartupIndicator,
  playBootAnimation,
  type SplashLifecycle,
} from "./boot-animation";
import {
  catchUpItems,
  loadInspectorCatchUp,
  loadInspectorFlows,
  loadInspectorSlates,
  loadInspectorWorkspace,
  loadInspectorWorkspaces,
  type SlateInspectorItem,
  type WorkspaceInfo,
} from "./inspector-sources";
import { isWorkspaceCommand, openWorkspace } from "./workspace-inspector";
import { isReviewCommand, openReview } from "./review-inspector";
import { acceptProposalViaShell, declineProposalViaShell } from "./review-accept";
import { isMcpToolsCommand, openMcpTools } from "./mcp-inspector";
import {
  buildConsumerModel,
  isMcpConsumerCommand,
  openMcpConsumer,
} from "./mcp-consumer";
import { projectConfigFile, userConfigFile } from "../mcp-servers/store";
import {
  APPROVAL_ALLOW_ID,
  catalogResolver,
  describeUseToolApproval,
  isDockApproval,
  isMcpToolCall,
  MAX_ARGUMENT_CHARS,
  summariseUseToolApproval,
} from "../mcp-servers/approval-render";
import { installMcpClient, mcpClientStatus, mcpRuntimeIds, uninstallMcpClient } from "../mcp/client-config";
import { makeCommandRunner } from "../harness/tool/builtin/shell-exec-tool";
import { readSlate } from "../session/slate";
import {
  buildSessionInfoSnapshot,
  isSessionInfoCommand,
  openSessionInfo,
} from "./session-info";
import { openModal, type ModalChrome, type ModalFooterAction } from "./modal-host";
import { openHelpModal } from "./help-modal"; // flow 303 AC6: the grouped, tabbed `/help` modal
import { helpFirstRunShown, markHelpFirstRunShown, shouldOpenFirstRunHelp } from "./help-first-run"; // flow 303 AC8
import { createDefaultSearchProviderController, describeConnectionFailure } from "../harness/search";
import type { SearchProviderController, SearchProviderDescriptor, SearchProviderId } from "../harness/search";
import type { SearchFieldDescriptor } from "../harness/search/types";
import {
  commandsForMode,
  describeUnavailableCommand,
  filterCommands,
  findAgentCommand,
  parseDelegateCommand,
  parseDemoteCommand,
  renderCommandHelp,
} from "../commands/agent-commands";
// Flow 266 (AC8): the demote EFFECT lives with the registry so both shells
// dispatch into one rule rather than growing two.
import { demoteTask } from "../harness/tool/builtin/background-job-registry";
import {
  applyThemeId,
  formatThemeList,
  getTheme,
  getThemeId,
  loadPersistedThemeId,
  parseThemeId,
  persistThemeId,
  themeLabel,
} from "./theme";
import { boldChunk, dimChunk, roleChunk } from "./theme-text";
import { openThemePicker } from "./theme-picker";
import { openGamesModal } from "./games";
import { mountBalancePanel } from "./balance-panel";
import type { DetectedProvider } from "../commands/select";
import type { ModelsFailure, ModelsResolveResult } from "../commands/providers";
import {
  MODELS_FETCH_TIMEOUT_MS,
  fetchOpenAiCompatModelsDetailed,
  modelsFailureLine,
  providerByName,
  resolveModelsForPicker,
} from "../commands/providers";
import { loadSessionLimits } from "../commands/model-limits";
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";
import { classifyDiffLine, summarizeSubmittedLine } from "../lib/md-blocks";
import { extractPatchText } from "../lib/patch-risk";
import { collapseHome } from "../lib/statusbar";
import { catalogAllows, catalogMethods, deviceCodeMethodLabel } from "../lib/oauth/catalog";
import { applyOAuthAccessToEnv, oauthAccessToken } from "../lib/oauth/grants";
import { loginDeviceCode } from "../lib/oauth/login";
import { openVerificationUrl } from "../lib/oauth/open-url";
import { loadShellConfig, noteSavedCredentialEnv, saveApiKey, saveProviderBaseUrl, saveShellConfig } from "../lib/shell-config";
import { saveCustomCompatProvider } from "../lib/provider-config";
import {
  allowShellPattern,
  parseShellExecCommand,
  shellPermissionsFingerprint,
  shellPermissionsPath,
  loadShellPermissions,
  suggestShellPatterns,
} from "../lib/shell-permissions";
import { evaluateShellApproval } from "../commands/shell-approval";
import { describeElicitationPrompt, MCP_ELICITATION_TOOL_PREFIX } from "../mcp-client/elicitation";
import { getProjectPermissionMode, setProjectPermissionMode } from "../lib/permission-mode-config";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from "../commands/permission-mode";
import { isWikiEnrichIntent, planWikiEnrich, wikiEnrich } from "../wiki/enrich";
import {
  createForegroundAgentIoFacade,
  createForegroundForceHandoff,
  createForegroundOperationOwner,
  finalizeWikiForegroundOperation,
  forceForegroundQueueItem,
} from "./foreground-operation";
import {
  compactSession,
  exportSessionMarkdown,
  findSession,
  isExternalRunSession,
  type SessionSummary,
  listSessions,
  persistCompacted,
  persistHistory,
  shortSessionId,
  type SessionHandle,
} from "../session";
import { LOST_LEASE_COMPACT_REFUSAL, openLeasedSession, SessionLeasedError, whilePersisting } from "../session/lease";
import { describeSkippedSession } from "../session/lease-choice";
import {
  createTuiLeaseHolder,
  leasedChoiceRequest,
  leaseStateLookup,
  type LeaseStateLookup,
  resolveLeasedStartup,
  toLeasedChoice,
  withLeaseMarker,
} from "./tui-session-lease";
import { setAskUserHost } from "./ask-user-bridge";
import { createHerdrReporter, herdrStateFor } from "./herdr-report";
import { showComposerChoice, type ChoiceOption } from "./composer-choice";
import { createShellChrome, createShellRenderer, selectThemeColors, SIDEBAR_TEXT_WIDTH, SIDEBAR_WIDTH, type ShellChrome } from "./shell-chrome";
import {
  buildSideWorkerPrompt,
  buildSideWorkerSystemInstruction,
  isSideWorkerId,
  SIDE_WORKER_ID_PREFIX,
  sideWorkerLabel,
} from "./side-worker";
import type { QueuedMainQuestion } from "./main-queue";
import {
  formatMainQueueMarker,
  parseQueueCommand,
  removeMainQueueItem,
  editMainQueueItem,
  reinsertMainQueueItem,
} from "./main-queue";
import type { QueueNavAction } from "./queue-nav";
import { clampQueueNavIndex, stepQueueNavAction, stepQueueNavIndex } from "./queue-nav";

import { setSubagentFleetListener } from "./subagent-bridge";
import { openSubagentInspector, paintSubagentSidebar } from "./subagent-inspector";
import { SubagentSessionStore } from "./subagent-session";
// Flow 176 T18 — the external-agent operator loop. Everything but the four call
// sites below lives in `external-operator.ts`; this file only constructs it,
// attaches it, routes a sidebar click and dispatches `/delegate`.
import { attachExternalOperator, type ExternalOperator } from "./external-operator";
import { openExternalInspector } from "./external-inspector";
import { setBackgroundJobListener } from "./job-bridge";
import { openJobInspector, paintBackgroundJobSidebar } from "./background-job-inspector";
import { getExecutionPlan } from "../session/execution-plan";
import { mountExecutionPlanPanel } from "./execution-plan-panel";
import { runScheduleSlashCommand } from "./schedule-command";
import { openExecutionPlanInspector } from "./execution-plan-inspector";
import { BackgroundJobStore, type BackgroundJobStoreHint } from "./background-job-session";
import { formatFleetSidebarWithPeers, MAIN_AGENT_ID, shortWorkerLabel, WorkerFleet, type FleetPeer } from "./worker-fleet";
import type { VersionCheckResult } from "../lib/version-check";
// Flow 273 (agent bus P2, T7): join/heartbeat/poll/leave all live in the
// surface-independent client; this file only wires status/activity in and
// renders what it hands back (specification §5.1, §5.2, §7.2).
import { joinBus, type BusClient } from "../bus/client";
import { makeBusErrorReporter } from "../bus/display";
import { listPresence } from "../bus/presence";
// Flow 274 (agent bus P3, T7; specification §5.3): delivery to the agent.
// `createBusInbox` and its drain contract are T5's (`../bus/inbox.ts`); this
// file only feeds `BusClient.onEvent` into one and, via
// `createBusWakeController` (review r1 F11 — the stateful wrapper around the
// pure `decideBusWake`), decides whether to start a turn for it.
import { createBusInbox, type BusInbox } from "../bus/inbox";
import {
  BUS_WAKE_CAPPED_NOTICE,
  busInboxFullNotice,
  createBusDropNotifier,
  createBusWakeController,
  // Flow 275 (agent bus P4, T7; specification §4.3, §5.2): the held→released
  // edge detector that drains the queue built up while a `turns` lease held
  // this instance — same shape `createBusWakeController` already uses.
  createLeaseHoldController,
  type BusDropNotifier,
  type BusWakeController,
  type LeaseHoldController,
} from "./bus-wake";
import { holderLivenessFrom, listActiveLeases } from "../bus/leases";
import { cursorAtStart, readEvents } from "../bus/log";
import { parseBusCommand } from "./bus-command";
// Flow 277 (P2): the join-adoption decision and onEvent/onPeers callbacks,
// extracted so they're unit-testable without a renderer (see `./bus-join.ts`).
import { buildBusJoinCallbacks, decideJoinAdoption } from "./bus-join";
import { leaveBusThenRelease, performSlateExit } from "./shell-exit";
import { openBus } from "./bus-panel";
// Flow 275 (agent bus P4, T7; specification §4.3, §7.2): pause leases — held
// turns, the status-bar banner, and `/bus pause|resume|override`.
// `PauseLeaseView` is T5's cached reader (`../bus/pause.ts`); this file only
// polls it (via `BusClient.leaseView()`) and reacts.
import type { PauseLeaseView } from "../bus/pause";
import {
  appendUserEcho,
  clearTranscriptChildren,
  createAssistantMessageStream,
  createBlockMount,
  createBlockNavController,
  createBlockRegistry,
  MAX_THOUGHT_LINES,
  type BlockState,
  type BlockViewOptions,
} from "./transcript-blocks";
import {
  formatReasoningBlockSummary,
  formatReasoningOneLiner,
  parseThinkDisplayMode,
  reasoningLivePreviewLines,
  resolveThinkDisplayMode,
  THINK_DISPLAY_MODES,
  type ThinkDisplayMode,
} from "./reasoning-display";

/** Result of a cheap git + gh lookup for sidebar metadata. */
interface SidebarRepoMetadata {
  branch?: string;
  prUrl?: string;
}

const SESSION_PREVIEW_MESSAGE_COUNT = 200;

/**
 * Flow 173 F-003: `risk === "read"` alone is NOT the side-worker safety
 * boundary — `shell_job_kill` is intentionally `risk:"read"` (this flow's
 * FROZEN AC6: tool-budget classification only, not an approval/trust signal)
 * but it mutates state a side worker never approved: killing a job the MAIN
 * session started, through a live reference to the main session's own
 * `JobRegistry`. The side-worker deps builder below filters on `risk`, then
 * additionally excludes any tool named here — a small, explicit deny-list
 * (not a second risk tier) so a future read-risk-but-actually-mutating tool
 * has to be added here on purpose rather than silently inheriting
 * side-worker access via `risk === "read"` alone.
 *
 * This paragraph used to end "`shell_job_output` stays available — it is
 * genuinely read-only in effect." Flow 266 then added `shell_job_output` to
 * the list below, for the reason stated there: its cursor is implicit shared
 * state, so a side worker reading it consumes output the main session has not
 * seen. The sentence contradicted the list six lines under it until flow 277.
 */
export const SIDE_WORKER_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "shell_job_kill",
  // Flow 266 (D-16, AC9). Two hazards a side worker must not have:
  //
  // `shell_task_kill` and `shell_task_wait` act on the MAIN session's tasks —
  // one ends them, the other blocks on them — and a read-only helper has no
  // business doing either.
  //
  // `shell_job_output` is subtler and is the reason this list exists rather
  // than a `risk === "read"` filter alone: its cursor is implicit shared state,
  // so a side worker reading it would consume output the main session has not
  // seen. `shell_task_output` stays available because its cursor is explicit
  // (`since`), and its side-worker copy is built with observer "side", so it
  // also cannot mark a task delivered and make the main session's notification
  // vanish.
  "shell_task_kill",
  "shell_task_wait",
  "shell_job_output",
  // Flow 274 (agent bus P3, T7): `bus_send` is ALSO `risk: "read"` (specification
  // §7.1, AC8) — a classifier choice about tool-budget accounting, not an
  // approval/trust signal (same FROZEN AC6 caveat as `shell_job_kill` above) —
  // but sending a real peer message under the MAIN session's own bus identity is
  // exactly the "read-risk-but-actually-mutating" hazard this list exists for. A
  // side worker answers a transient status question; it must never speak on the
  // session's behalf.
  //
  // review r1 F9: `bus_list` no longer reaches a side worker either — not
  // because it is unsafe (it genuinely is read-only), but because the side
  // worker's own `makeAgentDeps` call now passes no bus getter at all (see
  // that call site's own doc comment), so `bus_list`/`bus_send` are never
  // even built into `base.tools` for it to filter here. Named anyway, should
  // that ever change.
  "bus_send",
]);

/**
 * Flow 173 F-003 (P2 conversion, flow 277): the side-worker tools filter's
 * own predicate — `risk === "read"` AND not on {@link SIDE_WORKER_DENIED_TOOL_NAMES}
 * — extracted from `spawnSideWorker`'s inline `base.tools.filter(...)` so the
 * rule is a plain, unit-testable function instead of a source-text audit
 * reading the filter's call site (`tui-shell.test.ts`'s flow 173 F-003
 * block). Takes a narrow structural type — mirroring `InteractiveTool`'s
 * `definition.risk`/`definition.name` (`../commands/agent.ts`,
 * `../harness/tool/builtin/interactive-tools.ts`) — so this module stays free
 * of importing those types just for this one check.
 */
export function isToolAvailableToSideWorker(tool: { definition: { risk?: string; name: string } }): boolean {
  return tool.definition.risk === "read" && !SIDE_WORKER_DENIED_TOOL_NAMES.has(tool.definition.name);
}

/** Parse a GitHub remote URL into `owner/repo` (if possible). */
function parseGitHubRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com") {
        return undefined;
      }
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      if (!owner || !repo) {
        return undefined;
      }
      return `${owner}/${repo.replace(/\.git$/, "")}`;
    } catch {
      return undefined;
    }
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  }

  const sshUrlMatch = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshUrlMatch?.[1] && sshUrlMatch[2]) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  return undefined;
}

function runGitText(args: string[], cwd: string): string | undefined {
  try {
    const proc = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1200,
    });
    if (proc.status !== 0 || proc.error !== undefined) {
      return undefined;
    }
    const out = typeof proc.stdout === "string" ? proc.stdout.trim() : "";
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function runGhJson(repo: string, branch: string, cwd: string): string | undefined {
  try {
    const proc = spawnSync("gh", ["pr", "view", branch, "--repo", repo, "--json", "url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1800,
    });
    if (proc.status !== 0 || proc.error !== undefined) {
      return undefined;
    }
    return typeof proc.stdout === "string" ? proc.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSidebarMetadata(
  cwd: string,
  git: (args: string[], cwd: string) => string | undefined = runGitText,
): SidebarRepoMetadata {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === undefined || branch === "HEAD") {
    return {};
  }

  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const repo = parseGitHubRemote(remote ?? "");
  if (repo === undefined) {
    return { branch };
  }

  const rawPr = runGhJson(repo, branch, cwd);
  if (rawPr === undefined) {
    return { branch };
  }

  try {
    const parsed = JSON.parse(rawPr) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url.length > 0) {
      return { branch, prUrl: parsed.url };
    }
  } catch {
    // fall through
  }
  return { branch };
}

/** A resolved provider/model selection. */
export interface TuiSelection {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface SelectProviderModelOptions {
  /**
   * When true, only providers considered "connected" are shown: OpenAI-compatible
   * providers with required keys present and successful live `/models` checks.
   */
  onlyConnected?: boolean;
  /** Test/injected fetch for provider validation; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test/injected environment for env-key checks; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Config directory the wizard persists into (base URL, API key). Defaults to
   * the operator's real one. Threaded so a test of this wizard cannot write to
   * the machine running it — `keryxConfigDir` only honours `XDG_DATA_HOME` on
   * Linux, so an env-var-only seam would still hit `~/.local/share/keryx` on a
   * developer's Mac.
   */
  configDir?: string;
}

/**
 * Keep only already-connected providers for `/connect`:
 * - hosted providers need a configured key AND a live `/models` list;
 * - local OpenAI-compat providers (no key) need a successful live probe;
 * - non-registry entries (ollama/anthropic/fake) stay as detection left them.
 */
export async function filterConnectedDetectedProviders(
  detected: readonly DetectedProvider[],
  options: SelectProviderModelOptions = {},
): Promise<DetectedProvider[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;

  const connected: DetectedProvider[] = [];
  for (const prov of detected) {
    const registry = providerByName(prov.name);
    if (registry === undefined) {
      connected.push(prov);
      continue;
    }

    const requiresApiKey = registry.requiresApiKey ?? true;
    const envKey = prov.envKey ?? registry.envKey;
    const raw = envKey !== undefined ? env[envKey] : undefined;
    if (requiresApiKey && (raw === undefined || raw.length === 0)) {
      continue;
    }

    const compat = {
      ...registry,
      ...(prov.baseUrl !== undefined ? { baseUrl: prov.baseUrl } : {}),
      ...(prov.chatPath !== undefined ? { chatPath: prov.chatPath } : {}),
      ...(prov.modelsPath !== undefined ? { modelsPath: prov.modelsPath } : {}),
    };
    const result = await fetchOpenAiCompatModelsDetailed(fetchFn, compat, raw ?? compat.apiKey ?? "", {
      timeoutMs: MODELS_FETCH_TIMEOUT_MS,
    });
    if (result.source !== "live" || result.models.length === 0) {
      continue;
    }

    connected.push({ ...prov, models: result.models });
  }
  return connected;
}

/** Slug used by the picker's synthetic "add custom provider" entry. */
const CUSTOM_PROVIDER_ADD_ID = "__add_custom_provider__";

/** The picker's synthetic "add custom provider" row. */
const CUSTOM_ADD_ENTRY: DetectedProvider = {
  name: CUSTOM_PROVIDER_ADD_ID,
  models: [],
  label: "＋ Add custom provider (OpenAI-compatible)",
  note: "name · URL · key · models → saved to llm-providers.json",
};

/** Result of one custom-provider field step: a value, or Esc (back). */
type CustomFieldStepResult = { kind: "value"; value: string } | { kind: "back" };

/** One text-input step of the "add custom provider" wizard (name/url/key/models). */
function promptCustomFieldStep(
  otui: OpenTui,
  target: StepTarget,
  opts: { title: string; note?: string; value?: string },
): Promise<CustomFieldStepResult> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "custom-field-picker",
      title: opts.title,
      tab: "Custom provider",
      hint: "(Enter · Esc to go back)",
      footer: inputStepFooter("back"),
      contentRows: opts.note !== undefined ? 4 : 2,
      onEscape: () => {
        input.blur();
        resolve({ kind: "back" });
      },
    });
    if (opts.note !== undefined) {
      surface.body.add(new otui.TextRenderable(r, { id: "cf-note", content: otui.t`${dimChunk(otui, opts.note)}`, marginTop: 1 }));
    }
    const input = new otui.InputRenderable(r, { id: "cf-input", value: opts.value ?? "", marginTop: 1 });
    surface.body.add(input);
    input.focus();
    // Blur before detaching: a delayed duplicate ENTER can otherwise still reach
    // this input after the box is removed (see promptSearchFieldStep).
    const cleanup = (): void => { input.blur(); surface.close(); };
    input.on(otui.InputRenderableEvents.ENTER, () => {
      const entered = input.value.trim();
      cleanup();
      resolve({ kind: "value", value: entered });
    });
  });
}

/** The definition the "add custom provider" wizard collects before persisting. */
interface CustomProviderWizardResult {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  /** flow 268: optional per-provider defaults, all skippable (empty = unset). */
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** One optional numeric wizard step's outcome: Esc (back) or a value (`undefined` = skipped, never saved). */
type WizardNumberStepResult = { kind: "back" } | { kind: "value"; value: number | undefined };

/**
 * Parse one optional numeric wizard field. Empty = skipped (`undefined` — the
 * key is left out of `llm-providers.json` entirely, never written with a
 * default). A non-empty entry that does not parse is INVALID and re-opens the
 * step (via {@link promptOptionalNumberStep}) instead of being silently
 * dropped: a mistyped `4096x` used to save nothing and never say so.
 *
 * `positive` (maxOutputTokens/timeoutMs) requires a positive SAFE INTEGER —
 * matching `isCustomCompatProvider`'s `OPTIONAL_POSITIVE_NUMBER_FIELDS` guard,
 * which drops the WHOLE entry for a zero/fractional value the old parser
 * accepted: `0` here is not a setting — it would request a budget of zero
 * output tokens (the `?? DEFAULT_MAX_OUTPUT_TOKENS` request fallback only
 * triggers on `undefined`, not `0`) or abort every stream instantly, and a
 * saved `0.5` was rejected at load time along with the entire provider.
 * `temperature` takes any finite number (`0` is meaningful there).
 */
export function validateOptionalWizardNumber(
  raw: string,
  positive: boolean,
): { kind: "skip" } | { kind: "invalid" } | { kind: "value"; value: number } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "skip" };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { kind: "invalid" };
  }
  if (positive && !(Number.isSafeInteger(parsed) && parsed > 0)) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: parsed };
}

/**
 * {@link promptCustomFieldStep} + {@link validateOptionalWizardNumber}: empty
 * skips the parameter (the key is never written), an invalid entry re-opens
 * the SAME step with a `✗ must be …` suffix appended to the note, and Esc
 * still backs out to the caller.
 */
async function promptOptionalNumberStep(
  otui: OpenTui,
  target: StepTarget,
  opts: { title: string; note: string; positive?: boolean; invalidNote: string },
): Promise<WizardNumberStepResult> {
  let retried = false;
  for (;;) {
    const step = await promptCustomFieldStep(otui, target, {
      title: opts.title,
      note: retried ? `${opts.note} · ✗ ${opts.invalidNote}` : opts.note,
    });
    if (step.kind === "back") {
      return step;
    }
    const verdict = validateOptionalWizardNumber(step.value, opts.positive === true);
    if (verdict.kind === "invalid") {
      retried = true;
      continue;
    }
    return { kind: "value", value: verdict.kind === "value" ? verdict.value : undefined };
  }
}

/**
 * The "add custom provider" mini-wizard: name → base URL → API key (optional) →
 * models (optional). Saves nothing itself — returns the definition for the
 * caller to persist. Esc at any step backs up one step; Esc at the first step
 * cancels the whole wizard. Invalid input re-opens the same step.
 */
async function promptCustomProviderWizard(otui: OpenTui, target: StepTarget): Promise<CustomProviderWizardResult | undefined> {
  while (true) {
    const nameStep = await promptCustomFieldStep(otui, target, {
      title: "Provider name",
      note: "unique id used in /provider (letters, digits, - _)",
    });
    if (nameStep.kind === "back") {
      return undefined; // Esc at the first step → cancel the wizard
    }
    const name = nameStep.value;
    if (name.length === 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || providerByName(name) !== undefined) {
      continue; // invalid or colliding with an existing provider → re-prompt
    }
    while (true) {
      const urlStep = await promptCustomFieldStep(otui, target, {
        title: "Base URL",
        note: "before the chat path — /v1/chat/completions is appended, e.g. http://10.110.43.19:8080",
        value: "http://localhost:8000",
      });
      if (urlStep.kind === "back") {
        break; // → back to the name step
      }
      const baseUrlRaw = urlStep.value;
      if (baseUrlRaw.length === 0) {
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(baseUrlRaw);
      } catch {
        continue;
      }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username.length > 0 || parsed.password.length > 0) {
        continue; // only plain http(s) URLs, no embedded credentials
      }
      const baseUrl = baseUrlRaw.replace(/\/+$/, "");
      const keyStep = await promptCustomFieldStep(otui, target, {
        title: "API key (optional)",
        note: "empty = no key · saved owner-only (0600) in your keryx config dir",
      });
      if (keyStep.kind === "back") {
        continue; // → re-edit the base URL
      }
      const apiKey = keyStep.value.length > 0 ? keyStep.value : undefined;
      const modelsStep = await promptCustomFieldStep(otui, target, {
        title: "Models (optional)",
        note: "comma-separated ids · empty = fetch the live /v1/models list",
      });
      if (modelsStep.kind === "back") {
        continue; // → re-enter the key
      }
      const models = modelsStep.value.split(",").map((m) => m.trim()).filter((m) => m.length > 0);
      // flow 268: optional, skippable model-param defaults. Same "restart this
      // card from the URL step" back-navigation the key/models steps above
      // already use — not a per-field back-stack. Empty = the key is never
      // written to `llm-providers.json`; an invalid entry re-asks the step.
      const temperatureStep = await promptOptionalNumberStep(otui, target, {
        title: "Temperature (optional)",
        note: "empty = not written · e.g. 0.2",
        invalidNote: "must be a number (or leave empty to skip)",
      });
      if (temperatureStep.kind === "back") {
        continue;
      }
      const temperature = temperatureStep.value;
      const maxOutputTokensStep = await promptOptionalNumberStep(otui, target, {
        title: "Max output tokens (optional)",
        note: "empty = not written · session default 8192 · e.g. 16384",
        positive: true,
        invalidNote: "must be a positive whole number (or leave empty to skip)",
      });
      if (maxOutputTokensStep.kind === "back") {
        continue;
      }
      const maxOutputTokens = maxOutputTokensStep.value;
      const timeoutMsStep = await promptOptionalNumberStep(otui, target, {
        title: "Request timeout ms (optional)",
        note: "empty = not written · no engine timeout · e.g. 180000",
        positive: true,
        invalidNote: "must be a positive whole number (or leave empty to skip)",
      });
      if (timeoutMsStep.kind === "back") {
        continue;
      }
      const timeoutMs = timeoutMsStep.value;
      return {
        name,
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
        models,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
  }
}

/** The `@opentui/core` module shape, referenced structurally (type-only import). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type StyledContent = string | ReturnType<OpenTui["t"]>;

// `markdownToChunks` now lives in `./transcript-blocks` (flow 109) so the render
// rules are unit-testable and shared with the block bodies.

/**
 * Build an `AgentIO` that renders into an OpenTUI `transcript` box with chrome
 * parity: streamed tokens (`write`) go through `createStreamSegmenter` and paint
 * one `SegmentView` per markdown segment (prose via `markdownToChunks`, a fence
 * as a framed language-tagged box — no `MarkdownRenderable`, D-2); tool
 * calls/results, reasoning, usage, and system lines append styled one-liners.
 * Exported so the headless test can drive the same render path through
 * `runAgentTurn` without a real TTY. Pass the reasoning/tool hooks through
 * {@link attachBlockIo} to upgrade those one-liners into retained blocks (AC1).
 */
export type TuiAgentIo = AgentIO & {
  /** Drop an in-flight assistant stream so the next turn starts a new container. */
  resetStream(): void;
  /**
   * The most recently rendered fenced-code segment in the reply text. A fence
   * inside the reply has no block-registry entry of its own (unlike a
   * `thought`/`tool` block), so `/copy` and `y` fall back to this when there is
   * no registered block to copy instead.
   */
  lastCodeSegment(): { lang: string; body: string } | undefined;
};

export function createTuiAgentIo(otui: OpenTui, renderer: Renderer, transcript: Box): TuiAgentIo {
  let seq = 0;
  const append = (content: StyledContent): void => {
    transcript.add(new otui.TextRenderable(renderer, { id: `n${seq++}`, content }));
  };

  // An assistant message is a COLUMN of sibling renderables — one per markdown
  // segment (flow 109 / AC5) — so a fenced block can be framed with its language
  // tag instead of being flattened into one dim `TextRenderable`. The mechanism
  // itself lives in `transcript-blocks.ts` (flow 112) so the chat driver renders
  // replies through the SAME object rather than a lookalike.
  const messages = createAssistantMessageStream(otui, renderer, transcript);

  return {
    // Assistant text streams into per-segment renderables: worker-free markdown
    // chunks for prose (parity with the readline `renderMarkdown`) and a framed
    // language-tagged box per fence.
    write: (s) => {
      messages.push(s);
    },
    onAssistantText: (text) => {
      messages.finalize(text);
    },
    // Reasoning is COLLAPSED to a one-line marker (grok/opencode style) instead of
    // dumping the whole chain-of-thought; `line count` hints at its length.
    //
    // flow 268 T17 (AC16): built from `onReasoningEnd`, not the older
    // `onReasoning`, so the line carries duration when the provider/clock
    // made one available (`◆ thought for 12s (3 lines)`) — see
    // `formatReasoningOneLiner`'s doc comment for the exact format, including
    // the redacted-with-no-text variant. `attachBlockIo` REPLACES this with
    // its own block-based `onReasoningEnd` in the shipped TUI wiring (same
    // "replaced, not chained" rule as `onReasoning` always followed) — this
    // default is reached only when a caller uses `createTuiAgentIo` without
    // it (every current production call site DOES call `attachBlockIo`; this
    // is what a headless test exercises directly).
    onReasoningEnd: (info) => {
      const lineCount = info.text.trim().split("\n").filter((l) => l.trim().length > 0).length;
      append(
        otui.t`${dimChunk(
          otui,
          formatReasoningOneLiner({
            lineCount,
            redacted: info.redacted,
            hasText: info.text.length > 0,
            ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
          }),
        )}`,
      );
    },
    onUsage: (usage) => {
      const parts: string[] = [];
      if (usage.inputTokens !== undefined) {
        parts.push(`↑${usage.inputTokens}`);
      }
      if (usage.outputTokens !== undefined) {
        parts.push(`↓${usage.outputTokens}`);
      }
      if (parts.length > 0) {
        append(otui.t`${dimChunk(otui, `${parts.join(" ")} tokens`)}`);
      }
    },
    onToolCall: (name, input) => {
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      append(otui.t`${roleChunk(otui, "accent", `⚙ ${call}`)}`);
    },
    onToolResult: (_name, result) => {
      const { summary, hidden } = collapseToolOutput(result.output);
      const more = hidden > 0 ? ` · +${hidden} more` : "";
      const line = `${result.isError ? "✗" : "↳"} ${summary}${more}`;
      append(result.isError ? otui.t`${roleChunk(otui, "error", line)}` : otui.t`${dimChunk(otui, line)}`);
    },
    onSystem: (text) =>
      append(text.includes("[error]") ? otui.t`${roleChunk(otui, "error", text)}` : otui.t`${dimChunk(otui, text)}`),
    resetStream: () => {
      messages.reset();
    },
    lastCodeSegment: () => messages.lastCodeSegment(),
  };
}

/** Registers a block and mounts its view; returns the new block id. */
export type BlockSink = (
  input: { kind: string; summary: string; fullText: string; lineCount: number },
  options?: BlockViewOptions,
) => string;

/** Shell chrome that runs BEFORE each block is registered (busy phase, fleet). */
export interface BlockIoChrome {
  /**
   * flow 268 T17 (AC16): fires once per round, on the round's FIRST reasoning
   * delta — replaces the old `onReasoning`-based trigger, which fired only
   * once the whole reasoning span had already finished (see the module's
   * flow-268-T17 doc note this replaces).
   */
  onReasoningStart?: () => void;
  /**
   * flow 268 T17 (AC16): a throttled (≤10 Hz, see `attachBlockIo`) live
   * preview of the streaming reasoning — the last 1–3 non-empty lines seen so
   * far, width-bounded (`reasoningLivePreviewLines`). `undefined` `lines`
   * clears whatever preview is currently shown (the round ended).
   */
  onReasoningPreview?: (lines: string[] | undefined) => void;
  onToolCall?: (name: string, input: string) => void;
  onToolResult?: AgentIO["onToolResult"];
}

/** ≤10 Hz, per the AC16 spec's throttle bound. */
const REASONING_PREVIEW_THROTTLE_MS = 100;

/**
 * Upgrade the reasoning / tool-call / tool-result hooks of `io` so each one is
 * registered as a RETAINED, addressable block instead of a one-line renderable
 * whose text is discarded (AC1). This is the real wiring the shell installs —
 * it lives here, exported, so a headless test can drive `runAgentTurn` through
 * it and assert the recovered payload, rather than proving a replica.
 *
 * The `createTuiAgentIo` defaults are REPLACED, not chained: they append their
 * own line and would double-print. `chrome` keeps the shell's per-event side
 * effects (busy phase, fleet status) out of this mapping.
 *
 * flow 268 T17 (AC16): reasoning block registration moved from `onReasoning`
 * to `onReasoningEnd` — `onReasoning` is left UNTOUCHED here (not assigned at
 * all) so `runAgentTurn`'s unconditional `io.onReasoning?.(text)` call stays a
 * harmless no-op rather than a SECOND block registration for the same round.
 * `onReasoningDelta`/`onReasoningEnd` are the two hooks this function now
 * owns for reasoning; `thinkDisplay` (default `"auto"`, matching today's
 * behaviour) is a live getter — like `AgentIO.permissionMode` — so a `/think`
 * mode change takes effect on the very next round without re-wiring `io`.
 *
 * flow 268 T26: the per-round `liveText`/`hasStarted`/`lastPreviewAt`
 * closure state below is normally reset by `onReasoningEnd` alone. An
 * abort/error path that skips `onReasoningEnd` (fixed at its source in
 * `commands/agent.ts`'s `flushReasoning` call sites) used to leak it into
 * the NEXT round: stale `liveText` got appended to instead of replaced, and
 * `onReasoningStart` never re-fired since `hasStarted` was still `true`.
 * The returned `resetReasoningLiveState()` is a defensive second line: the
 * shell calls it at the START of every new turn (before `startBusy`/
 * `runAgentTurn`), so a missed `onReasoningEnd` from ANY cause can never
 * leak past the turn boundary.
 */
export function attachBlockIo(
  io: AgentIO,
  addBlock: BlockSink,
  chrome: BlockIoChrome = {},
  thinkDisplay: () => ThinkDisplayMode = () => "auto",
): AgentIO & { resetReasoningLiveState: () => void } {
  // Per-round streaming state. Reset in `onReasoningEnd` so a later round
  // starts clean; `hasStarted` distinguishes "no deltas yet this round" from
  // "deltas arrived but were all empty" (a redacted delta has no `text`).
  let liveText = "";
  let hasStarted = false;
  let lastPreviewAt = 0;
  io.onReasoningDelta = (delta) => {
    if (!hasStarted) {
      hasStarted = true;
      chrome.onReasoningStart?.();
    }
    if (delta.text !== undefined) {
      liveText += delta.text;
    }
    // `hide` mode shows no live preview at all (AC16) — still tracks
    // `liveText` above so a later mode switch mid-round is not half-broken,
    // but never paints it.
    if (thinkDisplay() === "hide") {
      return;
    }
    const nowMs = Date.now();
    if (nowMs - lastPreviewAt < REASONING_PREVIEW_THROTTLE_MS) {
      return;
    }
    lastPreviewAt = nowMs;
    chrome.onReasoningPreview?.(reasoningLivePreviewLines(liveText));
  };
  io.onReasoningEnd = (info) => {
    hasStarted = false;
    liveText = "";
    lastPreviewAt = 0;
    chrome.onReasoningPreview?.(undefined); // clear the live preview unconditionally
    const mode = thinkDisplay();
    if (mode === "hide") {
      // flow 268 T17 (AC16): deliberately NOT retained anywhere — no block,
      // no live preview. Threading a hidden-but-copyable payload through the
      // block registry (so `/copy` still worked right after a hidden round)
      // would mean giving `hide` its own invisible block kind and teaching
      // every `/think`/`ctrl+o`/nav-mode consumer to skip it — real cost for
      // a mode whose whole point is "I do not want to see this", so the
      // payload is simply dropped. Documented here per the spec's own
      // "if cheap, otherwise just hidden" allowance.
      return;
    }
    const body = info.text.trim();
    const lineCount = body.split("\n").filter((l) => l.trim().length > 0).length;
    const hasText = info.text.length > 0;
    addBlock(
      {
        kind: "thought",
        summary: formatReasoningBlockSummary({
          hasText,
          redacted: info.redacted,
          ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
          ...(info.tokens !== undefined ? { tokens: info.tokens } : {}),
        }),
        fullText: hasText ? body : "(hidden by provider)",
        lineCount,
      },
      {
        hint: "/think · ctrl+o",
        expandedHint: "/think collapse · y copy",
        dim: true,
        maxLines: MAX_THOUGHT_LINES,
        ...(mode === "expand" ? { startExpanded: true } : {}),
      },
    );
  };
  io.onToolCall = (name, input) => {
    debugEvent("tool.call", { name, inputChars: input.length });
    chrome.onToolCall?.(name, input);
    const args = summarizeToolArgs(input);
    // The block retains the RAW input json; the header keeps the compact call.
    addBlock(
      {
        kind: "tool",
        summary: `⚙ ${args.length > 0 ? `${name}(${args})` : `${name}()`}`,
        fullText: input,
        lineCount: input.split("\n").length,
      },
      { hint: "ctrl+o", tone: "cyan" },
    );
  };
  io.onToolResult = (name, result) => {
    debugEvent("tool.result", { name, isError: result.isError === true, outputChars: result.output.length });
    chrome.onToolResult?.(name, result);
    const { summary, lineCount, hidden } = collapseToolOutput(result.output);
    const more = hidden > 0 ? ` · +${hidden} more` : "";
    addBlock(
      {
        kind: "output",
        summary: `${result.isError ? "✗" : "↳"} ${summary}${more}`,
        fullText: result.output,
        lineCount,
      },
      { hint: "/expand · ctrl+o", ...(result.isError ? { tone: "red" as const } : {}) },
    );
  };
  const resetReasoningLiveState = (): void => {
    hasStarted = false;
    liveText = "";
    lastPreviewAt = 0;
  };
  return Object.assign(io, { resetReasoningLiveState });
}

/**
 * Mount the sidebar's title row: bold "keryx" + the running `packageJson.version`
 * in dim/secondary style (flow 266 P3, AC11/AC12).
 *
 * Exported — same reason as {@link mountCwdPanel} just below: a headless test
 * mounts the SHIPPED panel instead of a replica, so a future edit to the id or
 * the wording is caught here rather than in a test that re-typed it.
 */
export function mountTitlePanel(otui: OpenTui, r: Renderer, sidebarTop: Box): void {
  sidebarTop.add(
    new otui.TextRenderable(r, {
      id: "sb-title",
      content: otui.t`${boldChunk(otui, "keryx")} ${dimChunk(otui, `v${packageJson.version}`)}`,
    }),
  );
}

/**
 * Mount the sidebar's `Directory` panel — the working directory the agent's
 * `shell_exec` and write tools actually act on (gap G-2).
 *
 * The readline header prints it (`src/commands/shell.ts`, `◆ keryx … · <cwd>`);
 * the TUI showed model / context / tools / status and no directory at all, so an
 * operator approving a shell command could not see where it would run. That is
 * the reason this exists — not symmetry with the old header.
 *
 * It goes in the SIDEBAR rather than the header because the header is a single
 * row already carrying the session title, the short id, the compaction count and
 * the provider/model on the left with the token counter on the right, all inside
 * `terminal width - 30`; a path there would either push that identity line out or
 * be truncated to nothing. The sidebar's panels are exactly the persistent facts
 * about the session, its width is a known constant, and one more label/value pair
 * costs two rows in a column that has spare height.
 *
 * Exported so the headless test mounts the SHIPPED panel — including the budget
 * it is shortened to — instead of a replica.
 */
export function mountCwdPanel(
  otui: OpenTui,
  r: Renderer,
  sidebarTop: Box,
  cwd: string,
  metadata: SidebarRepoMetadata = resolveSidebarMetadata(cwd),
): void {
  sidebarTop.add(new otui.TextRenderable(r, { id: "sb-cwd-k", content: otui.t`${dimChunk(otui, "Directory")}`, marginTop: 1 }));
  sidebarTop.add(
    new otui.TextRenderable(r, {
      id: "sb-cwd-v",
      content: otui.t`${dimChunk(otui, shortenCwd(cwd, SIDEBAR_TEXT_WIDTH))}`,
    }),
  );

  if (metadata.branch !== undefined) {
    sidebarTop.add(new otui.TextRenderable(r, { id: "sb-branch-k", content: otui.t`${dimChunk(otui, "Branch")}`, marginTop: 1 }));
    sidebarTop.add(
      new otui.TextRenderable(r, {
        id: "sb-branch-v",
        content: otui.t`${dimChunk(otui, shortenCwd(metadata.branch, SIDEBAR_TEXT_WIDTH))}`,
      }),
    );
  }

  if (metadata.prUrl !== undefined) {
    sidebarTop.add(new otui.TextRenderable(r, { id: "sb-pr-k", content: otui.t`${dimChunk(otui, "PR")}`, marginTop: 1 }));
    sidebarTop.add(
      new otui.TextRenderable(r, {
        id: "sb-pr-v",
        content: otui.t`${dimChunk(otui, shortenCwd(metadata.prUrl, SIDEBAR_TEXT_WIDTH))}`,
      }),
    );
  }
}

/** Cumulative-counter sinks the shell owns; `attachUsageIo` drives them. */
export interface UsageChrome {
  /** Header right slot, e.g. `↑1.2K ↓340`. */
  setHeaderMeta: (text: string) => void;
  /** Sidebar Context panel: the running in+out total. */
  setContextTotal: (total: number) => void;
  /** Called once a provider reports real numbers (retires the estimate). */
  onExactUsage?: () => void;
  /** Sidebar Usage row: running in/out tokens, e.g. `↑1.2K ↓340`. */
  setUsage?: (input: number, output: number) => void;
}

/**
 * Add the shell's CUMULATIVE token counter on top of `io.onUsage` without
 * destroying the per-turn transcript line underneath it (gap G-1).
 *
 * The shell used to ASSIGN `io.onUsage`, which silently deleted the per-turn
 * `↑in ↓out tokens` line flow 050 shipped. The two are not alternatives and
 * neither replaces the other: the cumulative counter tracks the CONTEXT BUDGET
 * across a session, while the per-turn line is the only place an operator can
 * see what THIS turn cost — flow 050's stated motivation (a metered provider).
 * So the base hook is called through, not over-written.
 *
 * Two guards, and both are load-bearing:
 *
 *  - A `0/0` report is dropped BEFORE either sink. It is not usable for the
 *    counter (it would retire a working estimate in favour of zero) and it is
 *    not worth a transcript line reading `↑0 ↓0 tokens`, so the guard is placed
 *    ahead of the call-through rather than duplicated inside it.
 *  - The base hook's own guard — print only the fields the provider actually
 *    reported — survives untouched, so a usage event carrying just
 *    `inputTokens` still renders `↑5 tokens` and never `↓undefined`.
 *
 * Exported, and the shell's ONLY wiring for this, so a headless test can drive
 * `runAgentTurn` through the real composition and see both outputs in one frame
 * rather than proving a replica.
 */
export function attachUsageIo(io: AgentIO, chrome: UsageChrome): AgentIO & { resetUsage(): void } {
  const base = io.onUsage?.bind(io);
  let totalIn = 0;
  let totalOut = 0;
  io.onUsage = (usage) => {
    if ((usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0) {
      return; // a 0/0 report is not usable — keep the estimate, print nothing
    }
    base?.(usage); // per-turn `↑in ↓out tokens` transcript line (flow 050)
    chrome.onExactUsage?.();
    totalIn += usage.inputTokens ?? 0;
    totalOut += usage.outputTokens ?? 0;
    chrome.setHeaderMeta(`↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`);
    chrome.setContextTotal(totalIn + totalOut);
    chrome.setUsage?.(totalIn, totalOut);
  };
  return Object.assign(io, {
    resetUsage(): void {
      totalIn = 0;
      totalOut = 0;
      chrome.setHeaderMeta("↑0 ↓0");
      chrome.setContextTotal(0);
      // The sidebar's `Usage` row is the THIRD sink, and it has no other
      // writer: `/clear`|`/new` reset the session surface through
      // `resetSessionSurface`, whose only usage-side call is this one — so a
      // sink skipped here keeps showing the PREVIOUS session's cumulative
      // `↑in ↓out` while the header (`↑0 ↓0`) and the Context row
      // (`0 tokens`) have already gone to zero. Optional chaining, matching
      // the `setUsage` call above: a caller that renders no such row
      // (`--chat`, the headless tests) is unaffected.
      chrome.setUsage?.(0, 0);
    },
  });
}

/**
 * True only for an explicit `y`/`yes` (case-insensitive). Default-deny otherwise.
 * The TUI itself no longer has a typed y/N approval path — every approval goes
 * through the interactive dock picker — so this is kept as the shared
 * default-deny predicate (and its test) rather than as live shell wiring.
 */
export function isShellApproved(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/** Outcomes of the interactive shell_exec approval picker (OpenCode-style). */
export type ShellApprovalChoice = "once" | "always-exact" | "always-prefix" | "deny";

/** Outcomes of the wiki-enrich pre-router picker. */
export type WikiEnrichChoice = "drafts" | "force" | "cancel";

/**
 * Ask how to run wiki enrich (composer-dock menu, above the input).
 * drafts = batch drafts only; force = all statuses; cancel = do nothing.
 */
async function pickWikiEnrichMode(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  plan: { draftCount: number; acceptedCount: number; total: number },
): Promise<WikiEnrichChoice> {
  const id = await showComposerChoice(otui, r, dock, {
    title: "Wiki enrich",
    subtitle: `drafts: ${plan.draftCount} · accepted: ${plan.acceptedCount} · total: ${plan.total}`,
    cancelId: "cancel",
    options: [
      {
        id: "drafts",
        label: `Enrich ${plan.draftCount} draft page(s)`,
        description: "Default batch — Status: draft only",
        recommended: true,
      },
      {
        id: "force",
        label: `Force enrich all ${plan.total} page(s)`,
        description: `Includes ${plan.acceptedCount} accepted (+ other statuses)`,
      },
      {
        id: "cancel",
        label: "Skip / cancel",
        description: "Do not run enrich",
      },
    ],
  });
  return id === "drafts" || id === "force" || id === "cancel" ? id : "cancel";
}

/** Resolves the short advisory approval context for a proposed shell command. */
export type ApprovalContextLoader = (command: string) => Promise<string>;

/**
 * The default loader: the flow-041 advisory context (graph blast radius + the top
 * memory note) for `cwd`, the same string the readline shell prints above its
 * `Run …? [y/N]` prompt. The metaproject adapter is built LAZILY on first use and
 * then reused, so an operator who never hits an approval never pays for it.
 */
export function createApprovalContextLoader(cwd: string): ApprovalContextLoader {
  let port: MetaprojectPort | undefined;
  return async (command) => {
    port ??= createMetaprojectAdapter(cwd);
    return buildApprovalContext(port, command);
  };
}

/**
 * Shell permission menu (composer-dock, above input — same band as `/` commands).
 *
 * `loadContext` is REQUIRED rather than optional so the flow-041 context cannot be
 * dropped from a call site without changing this signature (the readline shell had
 * it; the TUI is now the default surface and must not be less informative). It is
 * started here and NOT awaited: the menu renders on the first frame and the dim
 * context line appears later, if at all. A throwing loader, a rejected promise, or
 * one that never settles therefore costs nothing — the user can still answer, and
 * Esc / cancel still means deny.
 */
export async function pickShellApproval(
  otui: OpenTui,
  r: Renderer,
  dock: Box,
  command: string,
  loadContext: ApprovalContextLoader,
  destructive = false,
  credentials = false,
  ui: { onOpen?: () => void; signal?: AbortSignal } = {},
  // Flow 275 T7 (specification §4.4): a peer's `git-publish` pause lease
  // applies to this command (`ShellApprovalEval.publishLease`,
  // `../commands/shell-approval.ts`). Positional and defaulted like
  // `destructive`/`credentials` above it, so every existing call site (this
  // file's own headless tests included) keeps compiling unchanged.
  publishLease = false,
  // Flow 275 F1 (specification §4.4): `ShellApprovalEval.publishLeaseDetail`
  // carried through unchanged — "held by @name — \"reason\"" — so the title
  // can name the lease instead of just flagging that one applies. Optional
  // and trailing like `publishLease`, so existing call sites keep compiling.
  publishLeaseDetail?: string,
): Promise<ShellApprovalChoice> {
  let context: Promise<string> | undefined;
  try {
    context = loadContext(command);
  } catch {
    context = undefined; // a loader that throws synchronously simply has no context
  }
  const { exact, prefix, offerExact, offerPrefix } = suggestShellPatterns(command);
  // A grant that cannot be given safely is not shown at all: an "always" option
  // the user picks and that is then silently refused would be worse than absent.
  // Destructive commands offer neither (ADR-0009) — `suggestShellPatterns`
  // itself accounts for that from the command text alone. `publishLease` is
  // NOT a property of the command text (a `git push` is ordinary otherwise)
  // — it is ambient bus state read at the call site — so it is excluded here
  // instead, mirroring readline's `rememberExactShellGrant`/
  // `formatShellApprovalHints` (`../commands/shell-approval.ts`): while the
  // lease applies, neither grant is offered, whatever `suggestShellPatterns`
  // says.
  const canOfferExact = offerExact && !publishLease;
  const canOfferPrefix = offerPrefix && !publishLease;
  const options = [
    {
      id: "once",
      label: "Allow once",
      description: "Run only this time",
      recommended: true,
    },
    ...(canOfferExact
      ? [
          {
            id: "always-exact",
            label: `Always allow “${exact.length > 40 ? `${exact.slice(0, 37)}…` : exact}”`,
            description: "Remember exact command (permissions.json)",
          },
        ]
      : []),
    ...(canOfferPrefix
      ? [
          {
            id: "always-prefix",
            label: `Always allow “${prefix}”`,
            description: "Remember this prefix (permissions.json)",
          },
        ]
      : []),
    {
      id: "deny",
      label: "Deny",
      description: "Do not run",
    },
  ];
  const id = await showComposerChoice(otui, r, dock, {
    title: credentials
      ? "⚠ touches keryx's OWN permissions/credentials — allow?"
      : publishLease
        ? publishLeaseDetail !== undefined
          ? `⚠ git-publish lease ${publishLeaseDetail} — allow?`
          : "⚠ a peer's git-publish lease applies — allow?"
        : destructive
          ? "⚠ DESTRUCTIVE command — allow?"
          : "Allow shell command?",
    // Untruncated: `showComposerChoice` renders this in a scrollable, ctrl+o-
    // focusable box (its own defensive char cap), not a single collapsed line.
    subtitle: command,
    ...(context !== undefined ? { context } : {}),
    cancelId: "deny",
    options,
    ...(ui.onOpen !== undefined ? { onOpen: ui.onOpen } : {}),
    ...(ui.signal !== undefined ? { signal: ui.signal } : {}),
  });
  if (id === "once" || id === "always-exact" || id === "always-prefix" || id === "deny") {
    return id;
  }
  return "deny";
}

/**
 * SLATE-2a `/model`-switch Anchors auto-inject (AC4). The `/model` handler
 * (`command.name === "/model"`, below) is a giant closure inline in
 * `launchTuiAgentShell` with no headless test harness — every OTHER helper
 * in this file is either a PURE function or renders through the scripted
 * `runAgentTurn`/`createTuiAgentIo` harness, and neither shape fits "drive
 * the real OpenTUI model picker". This is the extracted, independently
 * testable seam instead: everything the `/model` handler needs to do to
 * update Anchors, with the picker UI itself left in the closure.
 *
 * Reuses the SAME `recordSlateTouch` touched-tracking + change-detection
 * helper (`src/session/slate-lifecycle.ts`) the per-tool-call injection path
 * in `commands/agent.ts` uses — a `/model` switch is just another harness
 * effect that can change `anchors.runtime`, so it goes through the identical
 * "only inject when something actually changed" path rather than a bespoke
 * one that could drift from it.
 *
 * A no-op (`false`, `params.history` untouched) when there is no open slate
 * to update at all — `slateSession` absent or `slateSession.opened ===
 * false` — mirroring `closeSlateSession`'s own `undefined`-safe contract:
 * `/model` is usable before any slate has ever opened this attempt (no
 * action-intent turn has run yet), and that must cost nothing. `changed ===
 * false` (picking the SAME provider/model again) is also a no-op: `history`
 * is shared, provider-bound state, and re-announcing information the model
 * has already seen is exactly the history-bloat failure mode flow 161's
 * plan.md Risks section calls out.
 *
 * `params.onHistoryChange` (review finding 6): this function used to push
 * its Anchors-block message into `history` and stop there, unlike both other
 * Anchors-injection sites in `agent.ts` (its per-tool-call and fresh-open
 * triggers), which call `io.onHistoryChange?.("tool")` immediately after
 * their own push. `onHistoryChange` drives `syncArchive()`/session-
 * checkpoint persistence (this file's `launchTuiAgentShell`, where
 * `io.onHistoryChange` is assigned) — without it, the `/model`-switch
 * Anchors entry was not archived/persisted until some UNRELATED later event
 * happened to fire `onHistoryChange`, so a session that ended/crashed before
 * that lost the entry from the persisted archive. Optional (not `io`
 * itself) so this function stays testable in isolation the way it already
 * is above, with no IO dependency required when a caller does not need it;
 * `"tool"` matches the `kind` used at the sibling harness-written-history-
 * push call sites in `agent.ts`.
 */
export async function applyRuntimeSwitchToSlate(params: {
  slateSession: SlateSessionRef | undefined;
  runtime: { provider: string; model: string };
  history: NormalizedMessage[];
  onHistoryChange?: ((kind: "user" | "assistant_delta" | "assistant_final" | "tool") => void) | undefined;
}): Promise<boolean> {
  if (params.slateSession === undefined || !params.slateSession.opened) {
    return false;
  }
  const result = await recordSlateSessionTouch(params.slateSession, [], { runtime: params.runtime });
  if (result === undefined || !result.changed) {
    return false;
  }
  params.history.push({
    role: "user",
    content: renderAnchorsBlock(result.slate.anchors),
    provenance: "project",
  });
  params.onHistoryChange?.("tool");
  return true;
}

/**
 * The slate ref for a session the TUI has just switched to: that session's
 * own dir, never opened in this process yet. Every switch (startup, `/new`,
 * `/clear`, `/resume`, `/sessions`) must build a new ref through this. A
 * switch that kept the previous ref sent every slate read and write, including
 * `/goal`, tool touches and runtime-switch Anchors, into the session the
 * operator had just left.
 *
 * `opened: false` also makes the new session's first action turn go through
 * `openSlate`, which archives an unclosed `slate.json` a previous process left
 * in that dir (AC3), the same as a fresh process resuming it.
 */
export function freshSlateSessionRef(sessionDir: string, cwd: string): SlateSessionRef {
  return { dir: sessionDir, cwd, opened: false };
}

/** Compact token count for the header counter: 1234 → "1.2K", else the number. */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * Fit a working directory into `max` columns for the sidebar's Directory panel.
 *
 * Two reductions, in order, both of which discard the LEAST identifying part
 * first:
 *
 *  1. `$HOME` → `~` (the shared `collapseHome`, so the TUI and the readline
 *     header spell the same path the same way).
 *  2. Drop whole leading segments behind a `…/` marker until the rest fits. The
 *     TAIL is what identifies a directory — `…/keryx/src/tui` tells an operator
 *     where the agent's `shell_exec` will land; `/Users/someone/dev/proj…` tells
 *     them almost nothing. Middle-truncation (what `formatStatusBar` does for a
 *     much wider bar) would keep a useless head at the cost of the tail, so it is
 *     deliberately not reused here.
 *
 * A pathological single segment longer than the budget has no separator to cut
 * at, so its own tail is kept behind the same marker. Never returns more than
 * `max` chars; `max <= 0` returns "". Pure.
 */
export function shortenCwd(cwd: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  const full = collapseHome(cwd);
  if (full.length <= max) {
    return full;
  }
  const segments = full.split("/").filter((s) => s.length > 0);
  for (let i = 1; i < segments.length; i++) {
    const candidate = `…/${segments.slice(i).join("/")}`;
    if (candidate.length <= max) {
      return candidate;
    }
  }
  // Even the last segment alone overflows (no separator left to cut at): keep
  // its tail, which is still the most specific thing available.
  const last = segments[segments.length - 1] ?? full;
  return `…${last.slice(last.length - (max - 1))}`;
}

/**
 * Rough token estimate of the conversation (≈ 4 chars/token) — a fallback for the
 * context counter when the provider does not report exact `usage` (e.g. local
 * Ollama models). Pure.
 *
 * Flow 267: delegates to `estimateRequestTokens` (`harness/provider/
 * context-guard.ts`) with no system instruction / tool defs, rather than
 * summing `content` itself — ONE estimator for the codebase instead of two
 * divergent ones. `/status`'s callers all pass bare `{ content }` history
 * (never `systemInstruction`/tool defs), and threading those through every
 * `/status` call site would be invasive for a display-only estimate that
 * already carries a "rough"/"≈" disclaimer; the real guard in `agent.ts`
 * calls `estimateRequestTokens` directly with the full request shape.
 */
export function estimateContextTokens(history: readonly { content: string }[]): number {
  return estimateRequestTokens(history, "", []);
}

/**
 * Box height (rows) for a `SelectRenderable` so ALL `count` items stay visible.
 * OpenTUI renders each item across `linesPerItem` rows — 2 when descriptions are
 * shown, 1 otherwise — and `maxVisibleItems = floor(height / linesPerItem)`. So a
 * height of `count` rows shows only `count/2` described items (the "only the first
 * provider is listed" bug, flow 084). Height is `count * per`, capped at `max`
 * (overflow then scrolls). Pure.
 */
export function selectBoxHeight(count: number, withDescription: boolean, max = 16): number {
  const per = withDescription ? 2 : 1;
  return Math.min(max, Math.max(per, count * per));
}

/** Current wall-clock time as `h:mm AM/PM` (UI-only; the core stays clock-free). */
function hhmm(): string {
  const d = new Date();
  const h = d.getHours();
  const hour = h % 12 || 12;
  return `${hour}:${d.getMinutes().toString().padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A full-screen absolute overlay box (covers the running shell for a picker). */
function overlayBox(otui: OpenTui, r: Renderer, id: string): Box {
  return new otui.BoxRenderable(r, {
    id,
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: getTheme().bg,
    flexDirection: "column",
    padding: 1,
  });
}

/** OpenTUI keypress event fields the overlay steps read. */
export type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Subscribe `handler` to OpenTUI's internal keypress stream and return an unsubscribe
 * fn. The single place that reaches into the private `_internalKeyInput` API, so the
 * overlay steps don't each duplicate the on/off wiring (flow 086).
 *
 * Exported for the flow-109 headless nav-mode tests: they subscribe the REAL
 * `createBlockNavController` through this exact wrapper and drive real keys, so
 * the test exercises the shell's own subscription path rather than a replica.
 */
export function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  r._internalKeyInput.onInternal("keypress", handler);
  return () => r._internalKeyInput.offInternal("keypress", handler);
}

/**
 * Where a wizard step renders: the shell chrome once it exists (a ModalHost
 * dialog, so the header and sidebar stay on screen — flow 270), or a bare
 * renderer before it does (the startup picker) and in the chat shell, which
 * keep the full-screen overlay.
 */
type StepTarget = Renderer | ModalChrome;

/** The pickers take either a bare renderer (full-screen overlay) or the shell chrome (ModalHost). */
function isModalChrome(target: unknown): target is ModalChrome {
  return (
    target !== null &&
    typeof target === "object" &&
    "renderer" in target &&
    "focusComposer" in target
  );
}

function stepRenderer(target: StepTarget): Renderer {
  return isModalChrome(target) ? (target.renderer as Renderer) : target;
}

/** One wizard step's screen: its content goes into `body`. */
interface StepSurface {
  body: Box;
  /** True in a ModalHost dialog; a step sizes its select to the body there. */
  modal: boolean;
  /** Remove the screen WITHOUT running `onEscape`. Idempotent. */
  close(): void;
}

/**
 * Open one wizard step's screen. On the overlay the title line carries
 * `hint`, exactly as the steps always printed it; in a dialog the same keys go
 * to the footer instead. Esc runs `onEscape` either way — in the dialog it is
 * ModalHost that sees Esc first, closes, and reports it through `onClose`.
 */
function openStepSurface(
  otui: OpenTui,
  target: StepTarget,
  opts: {
    id: string;
    title: string;
    /** Short tab label for the dialog's tab strip. */
    tab: string;
    hint: string;
    footer: readonly ModalFooterAction[];
    /** Content rows below the title, so the dialog fits them (flow 269 AC7). */
    contentRows: number;
    onEscape: () => void;
  },
): StepSurface {
  const r = stepRenderer(target);
  if (!isModalChrome(target)) {
    const box = overlayBox(otui, r, opts.id);
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: `${opts.id}-title`, content: otui.t`${boldChunk(otui, opts.title)} ${dimChunk(otui, opts.hint)}` }));
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      unsub();
      r.root.remove(box);
    };
    const unsub = onKeypress(r, (key) => {
      if (key.name === "escape") {
        close();
        opts.onEscape();
        key.preventDefault();
        key.stopPropagation();
      }
    });
    return { body: box, modal: false, close };
  }

  let body: Box | undefined;
  let closedByStep = false;
  const handle = openModal(otui, target, {
    title: opts.title,
    tabs: [{ id: opts.id, label: opts.tab }],
    footer: opts.footer,
    contentRows: opts.contentRows,
    renderTab: (_tabId, tabBody) => {
      body = tabBody as Box;
    },
    onClose: () => {
      if (!closedByStep) opts.onEscape();
    },
  });
  if (handle === undefined || body === undefined) {
    // No host could open (no OpenTUI at runtime): fall back to the overlay
    // rather than leaving the step with nowhere to render.
    return openStepSurface(otui, r, opts);
  }
  return {
    body,
    modal: true,
    close: () => {
      if (closedByStep) return;
      closedByStep = true;
      // A step that finished is followed by more of the wizard — often a
      // network call first (models, device login). Handing focus back to the
      // composer here let the operator type and submit a turn mid-wizard; the
      // caller refocuses the composer once the whole wizard resolves.
      handle.close({ restoreFocus: false });
    },
  };
}

/** Footer for a list step: the keys the overlay hint names, in the dialog's footer. */
function selectStepFooter(escLabel: "back" | "cancel"): ModalFooterAction[] {
  return [
    { key: "↑/↓", label: "select" },
    { key: "Enter", label: "confirm" },
    { key: "esc", label: escLabel },
  ];
}

/** Footer for a text-entry step. */
function inputStepFooter(escLabel: "back" | "cancel"): ModalFooterAction[] {
  return [
    { key: "Enter", label: "confirm" },
    { key: "esc", label: escLabel },
  ];
}

/** Result of the API-key step: a key to save, skip (proceed keyless), or go back. */
type KeyStepResult = { kind: "key"; value: string } | { kind: "skip" } | { kind: "back" };

type SearchProviderConfigInput = {
  providerId: string | undefined;
  fields: Record<string, string>;
  credential: string | undefined;
};

function parseSearchProviderArgs(line: string): SearchProviderConfigInput {
  const parts = line.trim().length === 0 ? [] : line.trim().split(/\s+/);
  const [providerId, ...tail] = parts;
  const fields: Record<string, string> = {};
  let credential: string | undefined;
  for (const token of tail) {
    const splitAt = token.indexOf("=");
    if (splitAt <= 0) {
      continue;
    }
    const key = token.slice(0, splitAt).trim();
    const value = token.slice(splitAt + 1).trim();
    if (key === "key" || key === "credential" || key === "token" || key === "apiKey") {
      credential = value;
      continue;
    }
    fields[key] = value;
  }
  return { providerId, fields, credential };
}

function describeSearchProviderList(
  title: string,
  providers: readonly SearchProviderDescriptor[],
): string {
  const rows = providers.map((provider) => `  ${provider.id} (${provider.displayName})`);
  return `${title}${rows.length > 0 ? `\n${rows.join("\n")}` : "\n  (none)"}\n`;
}

/**
 * `controller.select(id)` plus the existing success/failure messages — the
 * exact call and copy `/search-connect <id>` already used, now shared with
 * the bare-arg picker (flow 180 AC2, AC4) so the 3 result branches are not
 * duplicated between the two entry points.
 */
export async function selectSearchProviderAndReport(
  controller: SearchProviderController,
  onSystem: ((text: string) => void) | undefined,
  providerId: SearchProviderId,
): Promise<void> {
  const result = await controller.select(providerId);
  if (!result.ok) {
    if (result.reason === "not-configured") {
      onSystem?.(`Cannot select '${providerId}': provider is not configured.\n`);
    } else if (result.reason === "not-connected") {
      onSystem?.(
        `Cannot select '${providerId}': provider is not connected (run /search-provider ${providerId} <params> to test).\n`,
      );
    } else {
      onSystem?.(`Cannot select '${providerId}': ${result.reason}.\n`);
    }
    return;
  }
  onSystem?.(`Search provider '${providerId}' selected.\n`);
}

/** Result of a search-provider field prompt: entered value, or `back` (Esc). */
type SearchFieldStepResult = { kind: "value"; value: string } | { kind: "back" };

/** One `descriptor.fields` entry, seeded with its current/default value. */
function promptSearchFieldStep(
  otui: OpenTui,
  target: StepTarget,
  field: SearchFieldDescriptor,
  value: string,
): Promise<SearchFieldStepResult> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "search-field-picker",
      title: field.label,
      tab: field.required ? "Required" : "Optional",
      hint: `${field.required ? "required" : "optional"} · Enter · Esc to go back`,
      footer: inputStepFooter("back"),
      contentRows: 2,
      onEscape: () => {
        input.blur();
        resolve({ kind: "back" });
      },
    });
    const input = new otui.InputRenderable(r, { id: "sf-input", value, marginTop: 1 });
    surface.body.add(input);
    input.focus();
    // Blur before detaching: a delayed duplicate ENTER can otherwise still
    // reach this input after the box is removed (see promptSetActiveProviderStep).
    const cleanup = (): void => { input.blur(); surface.close(); };
    input.on(otui.InputRenderableEvents.ENTER, () => {
      const entered = input.value.trim();
      cleanup();
      resolve({ kind: "value", value: entered });
    });
  });
}

/** Credential entry for `descriptor.credentialSchema`; same result shape as `promptApiKeyStep`. */
function promptSearchCredentialStep(otui: OpenTui, target: StepTarget, opts: { label: string }): Promise<KeyStepResult> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "search-credential-picker",
      title: `Paste your ${opts.label}`,
      tab: "Credential",
      hint: "(Enter · Esc to go back)",
      footer: inputStepFooter("back"),
      contentRows: 4,
      onEscape: () => {
        keyInput.blur();
        resolve({ kind: "back" });
      },
    });
    surface.body.add(
      new otui.TextRenderable(r, {
        id: "sc-note",
        content: otui.t`${dimChunk(otui, "Saved to your keryx config dir (owner-only, 0600)")}`,
        marginTop: 1,
      }),
    );
    const keyInput = new otui.InputRenderable(r, { id: "sc-input", placeholder: "...", marginTop: 1 });
    surface.body.add(keyInput);
    keyInput.focus();
    // Blur before detaching: a delayed duplicate ENTER can otherwise still
    // reach this input after the box is removed (see promptSetActiveProviderStep).
    const cleanup = (): void => { keyInput.blur(); surface.close(); };
    keyInput.on(otui.InputRenderableEvents.ENTER, () => {
      const value = keyInput.value.trim();
      cleanup();
      resolve(value.length > 0 ? { kind: "key", value } : { kind: "skip" });
    });
  });
}

/** "Set as active provider after a successful test?" toggle; `undefined` on Esc (back). */
function promptSetActiveProviderStep(otui: OpenTui, target: StepTarget): Promise<boolean | undefined> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "search-active-picker",
      title: "Set as active provider after a successful test?",
      tab: "Active",
      hint: "(↑/↓, Enter · Esc to go back)",
      footer: selectStepFooter("back"),
      contentRows: selectBoxHeight(2, true),
      onEscape: () => {
        select.blur();
        resolve(undefined);
      },
    });
    const select = new otui.SelectRenderable(r, {
      id: "sa-select",
      width: surface.modal ? "100%" : 60,
      height: selectBoxHeight(2, true),
      options: [
        { name: "Yes", description: "select it once the test passes" },
        { name: "No", description: "leave it configured but inactive" },
      ],
      ...selectThemeColors(getTheme()),
    });
    surface.body.add(select);
    select.focus();
    // Step 3 awaits `controller.test()` right after this step resolves, long
    // enough for a delayed duplicate ITEM_SELECTED to reach this already-removed
    // select if it stays the renderer's focus target — blur before detaching.
    const cleanup = (): void => { select.blur(); surface.close(); };
    select.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = select.getSelectedOption();
      cleanup();
      resolve(chosen === null ? undefined : chosen.name === "Yes");
    });
  });
}

/** Step 1: select a provider from `controller.configurable()`. `undefined` on Esc (cancel, AC4). */
export function pickSearchProviderStep(
  otui: OpenTui,
  target: StepTarget,
  providers: readonly SearchProviderDescriptor[],
): Promise<SearchProviderDescriptor | undefined> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "search-provider-picker",
      title: "Select a search provider",
      tab: "Search providers",
      hint: "(↑/↓, Enter · Esc to cancel)",
      footer: selectStepFooter("cancel"),
      contentRows: selectBoxHeight(providers.length, true),
      onEscape: () => {
        select.blur();
        resolve(undefined);
      },
    });
    // Match by the composed label (unique via `id`), mirroring `pickProviderStep`.
    const labelOf = (p: SearchProviderDescriptor): string => `${p.id} (${p.displayName})`;
    const select = new otui.SelectRenderable(r, {
      id: "spp-select",
      width: surface.modal ? "100%" : 60,
      height: selectBoxHeight(providers.length, true),
      showScrollIndicator: true,
      options: providers.map((p) => ({ name: labelOf(p), description: p.kind })),
      ...selectThemeColors(getTheme()),
    });
    surface.body.add(select);
    select.focus();
    // Blur before detaching: a delayed duplicate ITEM_SELECTED can otherwise
    // still reach this select after the box is removed (see promptSetActiveProviderStep).
    const cleanup = (): void => { select.blur(); surface.close(); };
    select.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = select.getSelectedOption();
      cleanup();
      resolve(chosen === null ? undefined : providers.find((p) => labelOf(p) === chosen.name));
    });
  });
}

type SearchProviderFieldsSeed = { fields: Record<string, string>; credential: string | undefined; setActive: boolean };

type SearchProviderStep2Result = { kind: "back" } | ({ kind: "done" } & SearchProviderFieldsSeed);

/**
 * Step 2 (AC5): `descriptor.fields` in order, then a credential prompt (only
 * when `credentialSchema.required` — keyed remotes skip straight to it;
 * DuckDuckGo has no fields and no key), then the active-provider toggle.
 * Esc at any sub-step goes back one; off the front sub-step it reports
 * `back` (up to step 1) rather than closing the modal.
 */
async function runSearchProviderFieldsStep(
  otui: OpenTui,
  r: StepTarget,
  provider: SearchProviderDescriptor,
  seed: SearchProviderFieldsSeed,
): Promise<SearchProviderStep2Result> {
  type SubStep = { kind: "field"; field: SearchFieldDescriptor } | { kind: "credential" } | { kind: "toggle" };
  const subSteps: SubStep[] = [
    ...provider.fields.map((field): SubStep => ({ kind: "field", field })),
    ...(provider.credentialSchema.required ? [{ kind: "credential" } as const] : []),
    { kind: "toggle" },
  ];
  const fields: Record<string, string> = { ...seed.fields };
  let credential = seed.credential;
  let setActive = seed.setActive;
  let index = 0;
  while (index < subSteps.length) {
    const step = subSteps[index];
    if (step === undefined) break;
    if (step.kind === "field") {
      const result = await promptSearchFieldStep(otui, r, step.field, fields[step.field.id] ?? step.field.defaultValue ?? "");
      if (result.kind === "back") {
        index -= 1;
        if (index < 0) return { kind: "back" };
        continue;
      }
      fields[step.field.id] = result.value;
      index += 1;
      continue;
    }
    if (step.kind === "credential") {
      const result = await promptSearchCredentialStep(otui, r, {
        label: provider.credentialSchema.label ?? `${provider.displayName} credential`,
      });
      if (result.kind === "back") {
        index -= 1;
        if (index < 0) return { kind: "back" };
        continue;
      }
      credential = result.kind === "key" ? result.value : undefined;
      index += 1;
      continue;
    }
    const toggle = await promptSetActiveProviderStep(otui, r);
    if (toggle === undefined) {
      index -= 1;
      if (index < 0) return { kind: "back" };
      continue;
    }
    setActive = toggle;
    index += 1;
  }
  return { kind: "done", fields, credential, setActive };
}

/**
 * Step 3 (AC6): `configure()` then `test()`. On success, `select()` too when
 * the toggle was Yes — the exact call `/search-connect` already makes. `retry`
 * (Esc on the failure screen) sends the caller back to step 2 without closing
 * the modal.
 */
function runSearchProviderTestStep(
  otui: OpenTui,
  target: StepTarget,
  controller: SearchProviderController,
  provider: SearchProviderDescriptor,
  fields: Record<string, string>,
  credential: string | undefined,
  setActive: boolean,
): Promise<"done" | "retry"> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    let settled: "success" | "failure" | undefined;
    // Set once the step is gone. The test below keeps running after an Esc in
    // the dialog, and must neither make the provider active behind the
    // operator's back nor write to a status line that no longer exists.
    let left = false;
    const modal = isModalChrome(target);
    let surface: StepSurface | undefined;
    if (modal) {
      // In the dialog ModalHost owns Esc and always closes. Closing mid-test or
      // on a failure is a retry (back to the fields); after a success the result
      // is already saved, so it is simply done.
      surface = openStepSurface(otui, target, {
        id: "search-test-picker",
        title: `Test '${provider.id}'`,
        tab: "Test",
        hint: "",
        footer: [
          { key: "Enter", label: "close after success" },
          { key: "esc", label: "back" },
        ],
        contentRows: 2,
        onEscape: () => {
          left = true;
          unsub();
          resolve(settled === "success" ? "done" : "retry");
        },
      });
    }
    // The overlay keeps its own box: its Esc only acts on a failure and its
    // Enter only on a success, which the generic surface cannot express.
    const box = surface?.body ?? overlayBox(otui, r, "search-test-picker");
    if (surface === undefined) r.root.add(box);
    const status = new otui.TextRenderable(r, { id: "st-title", content: otui.t`${boldChunk(otui, `Testing '${provider.id}'`)} ${dimChunk(otui, "...")}` });
    box.add(status);
    const cleanup = (): void => {
      left = true;
      unsub();
      if (surface !== undefined) surface.close();
      else r.root.remove(box);
    };
    const unsub = onKeypress(r, (key) => {
      if (!modal && settled === "failure" && key.name === "escape") {
        cleanup();
        resolve("retry");
        key.preventDefault();
        key.stopPropagation();
      } else if (settled === "success" && (key.name === "return" || key.name === "linefeed" || key.name === "kpenter")) {
        cleanup();
        resolve("done");
        key.preventDefault();
        key.stopPropagation();
      }
    });
    void (async () => {
      controller.configure(provider.id, { ...provider.defaults, ...fields }, credential);
      const tested = await controller.test(provider.id);
      if (left) {
        return; // backed out mid-test: nothing to show, and no select()
      }
      if (!tested.ok) {
        settled = "failure";
        const reason = describeConnectionFailure(tested.reason);
        status.content = otui.t`${roleChunk(otui, "error", "✗")} ${boldChunk(otui, `'${provider.id}' test failed: ${reason}`)} ${dimChunk(otui, "(Esc to go back and retry)")}`;
        return;
      }
      settled = "success";
      if (!setActive) {
        status.content = otui.t`${roleChunk(otui, "ok", "✓")} ${boldChunk(otui, `'${provider.id}' configured and tested successfully`)} ${dimChunk(otui, "(Enter to close)")}`;
        return;
      }
      const selected = await controller.select(provider.id);
      if (left) {
        return;
      }
      status.content = selected.ok
        ? otui.t`${roleChunk(otui, "ok", "✓")} ${boldChunk(otui, `'${provider.id}' configured, tested, and set as active`)} ${dimChunk(otui, "(Enter to close)")}`
        : otui.t`${roleChunk(otui, "ok", "✓")} ${boldChunk(otui, `'${provider.id}' configured and tested`)} ${dimChunk(otui, `but could not be set active (${selected.reason ?? "unknown"})`)} ${dimChunk(otui, "(Enter to close)")}`;
    })();
  });
}

/**
 * The `/search-provider` bare-arg wizard (AC1): provider select → fields/
 * credential/active-toggle → test result. Mirrors `selectProviderModelInTui`'s
 * step/Esc-back shape but drives `SearchProviderController` instead of the
 * LLM-provider picker; `/search-provider <id> ...` and `/search-connect` stay
 * on their existing text-parsing paths (AC2, AC3) — this is only wired into
 * the bare-arg branch.
 */
export async function searchProviderWizardInTui(
  otui: OpenTui,
  r: StepTarget,
  controller: SearchProviderController,
): Promise<void> {
  const providers = controller.configurable();
  providerLoop: while (true) {
    const provider = await pickSearchProviderStep(otui, r, providers);
    if (provider === undefined) {
      return; // Esc at step 1: cancel, no state mutated (AC4)
    }
    let seed: SearchProviderFieldsSeed = { fields: { ...provider.defaults }, credential: undefined, setActive: false };
    while (true) {
      const step2 = await runSearchProviderFieldsStep(otui, r, provider, seed);
      if (step2.kind === "back") {
        continue providerLoop;
      }
      seed = { fields: step2.fields, credential: step2.credential, setActive: step2.setActive };
      const result = await runSearchProviderTestStep(otui, r, controller, provider, seed.fields, seed.credential, seed.setActive);
      if (result === "done") {
        return;
      }
      // "retry": Esc on the failure screen loops back into step 2 with the
      // just-entered values preserved so a typo'd field/credential can be fixed.
    }
  }
}

/**
 * Ask for a local provider endpoint, keeping its configured value editable.
 *
 * `notice` is set only on the retry, after a probe of this endpoint already
 * failed: same shape as `promptApiKeyStep`'s, and for the same reason — the
 * operator is being asked a second time and deserves the provider's own words
 * for why.
 */
function promptBaseUrlStep(
  otui: OpenTui,
  target: StepTarget,
  label: string,
  baseUrl: string,
  notice?: string,
): Promise<string | undefined> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "base-url-picker",
      title: `${label} endpoint URL`,
      tab: "Endpoint",
      hint: "(Enter · Esc to go back)",
      footer: inputStepFooter("back"),
      contentRows: notice !== undefined ? 6 : 4,
      onEscape: () => {
        input.blur();
        resolve(undefined);
      },
    });
    const box = surface.body;
    if (notice !== undefined) {
      box.add(new otui.TextRenderable(r, { id: "bp-notice", content: otui.t`${roleChunk(otui, "error", "✗")} ${notice}`, marginTop: 1 }));
    }
    box.add(new otui.TextRenderable(r, { id: "bp-note", content: otui.t`${dimChunk(otui, "Edit host and port before discovering models")}`, marginTop: 1 }));
    const input = new otui.InputRenderable(r, { id: "bp-input", value: baseUrl, marginTop: 1 });
    box.add(input);
    input.focus();
    const cleanup = (): void => { input.blur(); surface.close(); };
    input.on(otui.InputRenderableEvents.ENTER, () => { const value = input.value.trim(); cleanup(); resolve(value.length > 0 ? value : undefined); });
  });
}

/**
 * API-key entry step. Enter with text → `key`; empty Enter → `skip` (proceed without
 * a key); Esc → `back` (return to the previous step). Absolute overlay; removes its
 * key handler on close.
 */
function promptApiKeyStep(otui: OpenTui, target: StepTarget, opts: { label: string; envKey: string; placeholder?: string; notice?: string }): Promise<KeyStepResult> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "key-picker",
      title: `Paste your ${opts.label} API key`,
      tab: "API key",
      hint: "(Enter · Esc to go back)",
      footer: [
        { key: "Enter", label: "save (empty = skip)" },
        { key: "esc", label: "back" },
      ],
      contentRows: opts.notice !== undefined ? 6 : 4,
      onEscape: () => {
        keyInput.blur();
        resolve({ kind: "back" });
      },
    });
    const box = surface.body;
    if (opts.notice !== undefined) {
      // Why they are being asked again, in the provider's own words.
      box.add(new otui.TextRenderable(r, { id: "kp-notice", content: otui.t`${roleChunk(otui, "error", "✗")} ${opts.notice}`, marginTop: 1 }));
    }
    box.add(
      new otui.TextRenderable(r, {
        id: "kp-note",
        content: otui.t`${dimChunk(otui, `Set as ${opts.envKey} · saved to your keryx config dir (owner-only, 0600)`)}`,
        marginTop: 1,
      }),
    );
    const keyInput = new otui.InputRenderable(r, { id: "kp-input", placeholder: opts.placeholder ?? "sk-...", marginTop: 1 });
    box.add(keyInput);
    keyInput.focus();
    const cleanup = (): void => {
      keyInput.blur();
      surface.close();
    };
    keyInput.on(otui.InputRenderableEvents.ENTER, () => {
      const value = keyInput.value.trim();
      cleanup();
      resolve(value.length > 0 ? { kind: "key", value } : { kind: "skip" });
    });
  });
}

type AuthMethodChoice = "device-code" | "api-key";

function pickAuthMethodStep(
  otui: OpenTui,
  target: StepTarget,
  providerLabel: string,
  methods: readonly AuthMethodChoice[],
): Promise<AuthMethodChoice | undefined> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "auth-method-picker",
      title: `How to connect ${providerLabel}`,
      tab: "Sign-in",
      hint: "(↑/↓, Enter · Esc to go back)",
      footer: selectStepFooter("back"),
      contentRows: selectBoxHeight(methods.length, true),
      onEscape: () => {
        select.blur();
        resolve(undefined);
      },
    });
    const descriptions: Record<AuthMethodChoice, string> = {
      "device-code": deviceCodeMethodLabel(providerLabel === "GitHub Copilot" ? "github-copilot" : providerLabel === "OpenAI" ? "openai" : "grok"),
      "api-key": "Manually enter API Key",
    };
    const select = new otui.SelectRenderable(r, {
      id: "amp-select",
      width: surface.modal ? "100%" : 60,
      height: selectBoxHeight(methods.length, true),
      showScrollIndicator: true,
      options: methods.map((m) => ({ name: m, description: descriptions[m] })),
      ...selectThemeColors(getTheme()),
    });
    surface.body.add(select);
    select.focus();
    const cleanup = (): void => {
      select.blur();
      surface.close();
    };
    select.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = select.getSelectedOption();
      cleanup();
      resolve(chosen === null ? undefined : (chosen.name as AuthMethodChoice));
    });
  });
}

function runDeviceLoginInTui(otui: OpenTui, target: StepTarget, provider: string, dir?: string): Promise<boolean> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const controller = new AbortController();
    const surface = openStepSurface(otui, target, {
      id: "device-login",
      title: deviceCodeMethodLabel(provider),
      tab: "Device login",
      hint: "(Esc to cancel)",
      footer: [{ key: "esc", label: "cancel" }],
      contentRows: 4,
      onEscape: () => {
        // Stops the authorization poll: closing the screen must not leave it running.
        controller.abort();
        resolve(false);
      },
    });
    const status = new otui.TextRenderable(r, { id: "dl-status", content: otui.t`${dimChunk(otui, "Requesting a device code…")}`, marginTop: 1 });
    surface.body.add(status);
    const cleanup = (): void => {
      surface.close();
    };
    void loginDeviceCode({
      provider,
      fetch: (input, init) => globalThis.fetch(input, init),
      signal: controller.signal,
      ...(dir !== undefined ? { dir } : {}),
      onChallenge: (challenge) => {
        status.content = otui.t`${boldChunk(otui, challenge.userCode)}\n${dimChunk(otui, challenge.verificationUri)}\n${dimChunk(otui, "Open that URL on any device and enter the code. Waiting for authorization…")}`;
        openVerificationUrl(challenge.verificationUriComplete ?? challenge.verificationUri);
      },
    }).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      if (result.ok) {
        cleanup();
        applyOAuthAccessToEnv();
        resolve(true);
        return;
      }
      status.content = otui.t`${roleChunk(otui, "error", "✗")} ${boldChunk(otui, result.error)} ${dimChunk(otui, "(Esc to go back)")}`;
    }).catch((err) => {
      if (controller.signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : "device authorization failed";
      status.content = otui.t`${roleChunk(otui, "error", "✗")} ${boldChunk(otui, message)} ${dimChunk(otui, "(Esc to go back)")}`;
    });
  });
}

/**
 * Resolve models for the picker: always probe the live `/models` endpoint when
 * the provider is OpenAI-compat (network available + optional Bearer key);
 * curated registry list is offline/401 fallback only.
 */
export async function modelsForPicker(
  prov: DetectedProvider,
  deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ModelsResolveResult> {
  return await resolveModelsForPicker(deps.fetch ?? globalThis.fetch, prov, deps.env ?? process.env);
}

/**
 * Is this empty model list plausibly the endpoint's fault, rather than the
 * credential's or the provider's?
 *
 * A typo'd base URL reaches the picker as `unreachable` (DNS, TLS, timeout —
 * nothing answered at all) or as `http` (something answered, but not a model
 * list: a wrong host, or a path that is not this provider's). Both are worth
 * re-opening the endpoint step for.
 *
 * The other two kinds deliberately are not. `rejected` is the credential's
 * business — the endpoint was found and it spoke, it just refused the key — and
 * the picker fixes that by asking for the key instead. `empty` means the
 * endpoint was correct and answered honestly that it has no models; re-asking
 * for a URL there sends the operator hunting a fault that is not theirs.
 *
 * Pure and exported so the decision is asserted without a terminal, the same
 * way `modelsFailureLine` makes the wording testable.
 *
 * Declared as a type guard because a `true` answer necessarily means there IS
 * a failure — the caller needs exactly that to hand it to `modelsFailureLine`
 * for the notice.
 */
export function endpointMayBeAtFault(failure: ModelsFailure | undefined): failure is ModelsFailure {
  return failure?.kind === "unreachable" || failure?.kind === "http";
}

/**
 * The line the model picker shows when the list is empty.
 *
 * `undefined` when there are models, or when the emptiness carries no
 * explanation (an offline `fake`/`ollama` entry that never probed).
 */
export function modelPickerNotice(label: string, result: ModelsResolveResult): string | undefined {
  if (result.models.length > 0 || result.failure === undefined) {
    return undefined;
  }
  return modelsFailureLine(label, result.failure);
}

/** Provider-selection step. Resolves the chosen provider, or `undefined` on Esc/cancel. */
function pickProviderStep(otui: OpenTui, target: StepTarget, detected: DetectedProvider[]): Promise<DetectedProvider | undefined> {
  const r = stepRenderer(target);
  return new Promise((resolve) => {
    const surface = openStepSurface(otui, target, {
      id: "picker",
      title: "Select a provider",
      tab: "Providers",
      hint: "(↑/↓, Enter · Esc to cancel)",
      footer: selectStepFooter("cancel"),
      contentRows: selectBoxHeight(detected.length, true),
      onEscape: () => {
        provSelect.blur();
        resolve(undefined);
      },
    });
    const box = surface.body;
    // Match by the displayed label (unique) so registry ids stay hidden but resolvable.
    const labelOf = (d: DetectedProvider): string => d.label ?? d.name;
    const provSelect = new otui.SelectRenderable(r, {
      id: "picker-provider",
      width: surface.modal ? "100%" : 60,
      // Descriptions are shown → 2 rows per item, so height must be 2× the count
      // or only half the providers stay visible (flow 084 fix).
      height: selectBoxHeight(detected.length, true),
      showScrollIndicator: true,
      options: detected.map((d) => ({ name: labelOf(d), description: d.note ?? `${d.models.length} model(s)` })),
      ...selectThemeColors(getTheme()),
    });
    box.add(provSelect);
    provSelect.focus();
    const cleanup = (): void => {
      provSelect.blur();
      surface.close();
    };
    provSelect.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = provSelect.getSelectedOption();
      cleanup();
      resolve(chosen === null ? undefined : detected.find((d) => labelOf(d) === chosen.name));
    });
  });
}

/**
 * In-TUI provider → model → key wizard with BACK navigation. `/provider` and
 * startup prompt + persist a key and may edit a local endpoint. `/connect`
 * (`onlyConnected`) only lists live providers and their live `/models` list —
 * no key or URL setup. Every step renders in ModalHost given the shell chrome
 * (flow 270), or as a full-screen overlay given a bare renderer (the startup
 * picker, the chat shell). Resolves the selection or `undefined`.
 *
 * Exported since flow 112 so the CHAT shell injects this very wizard as
 * `ShellDeps.selectProviderModel`: `/provider` must open an overlay instead of
 * `pickProviderModel`'s numbered text menu, which would read the next composer
 * submissions as its answers.
 */
export function selectProviderModelInTui(
  otui: OpenTui,
  rOrChrome: StepTarget,
  detected: DetectedProvider[],
  options: SelectProviderModelOptions = {},
): Promise<TuiSelection | undefined> {
  return new Promise((resolve) => {
    if (detected.length === 0) {
      resolve(undefined);
      return;
    }
    const candidatesPromise = options.onlyConnected
      ? filterConnectedDetectedProviders(detected, {
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        })
      : Promise.resolve(detected);
    void (async () => {
      const candidates = await candidatesPromise;
      if (candidates.length === 0) {
        resolve(undefined);
        return;
      }

      // Non-`/connect` selection also offers the synthetic "add custom provider"
      // entry: choosing it runs the mini-wizard, persists llm-providers.json,
      // and appends the new provider so it is selectable this session too.
      const allCandidates: DetectedProvider[] = options.onlyConnected
        ? candidates
        : [...candidates, CUSTOM_ADD_ENTRY];

      // Provider ← Esc cancels.
      // Key (when required) ← Esc backs to provider.
      // Model ← Esc backs to provider.
      // IMPORTANT: prompt for the API key BEFORE fetching /models — Z.AI and most
      // OpenAI-compat gateways return 401 without a Bearer key, and we would
      // otherwise show only the short curated fallback (e.g. stale glm-4.5/4.6).
      while (true) {
        const prov = await pickProviderStep(otui, rOrChrome, allCandidates);
        if (prov === undefined) {
          resolve(undefined);
          return;
        }

        // Synthetic "add custom provider" entry — run the mini-wizard, persist,
        // and loop back so the fresh provider appears in the picker.
        if (prov.name === CUSTOM_PROVIDER_ADD_ID) {
          const created = await promptCustomProviderWizard(otui, rOrChrome);
          if (created !== undefined) {
            saveCustomCompatProvider({
              name: created.name,
              label: created.name,
              baseUrl: created.baseUrl,
              ...(created.apiKey !== undefined ? { apiKey: created.apiKey } : {}),
              models: created.models,
              requiresApiKey: false,
              ...(created.temperature !== undefined ? { temperature: created.temperature } : {}),
              ...(created.maxOutputTokens !== undefined ? { maxOutputTokens: created.maxOutputTokens } : {}),
              ...(created.timeoutMs !== undefined ? { timeoutMs: created.timeoutMs } : {}),
            });
            allCandidates.push({
              name: created.name,
              models: created.models,
              baseUrl: created.baseUrl,
              label: created.name,
              note: "custom",
            });
          }
          continue; // Esc inside the wizard or after a save → re-pick the provider
        }

        // `/connect` only switches: never edit the endpoint or collect a key.
        // Copilot's API host comes from the token exchange (`endpoints.api`),
        // not from typing api.githubcopilot.com — that origin 404s on /v1/models.
        const lockDiscoveredHost = prov.name === "github-copilot";
        let selectedBaseUrl =
          options.onlyConnected || prov.baseUrl === undefined || lockDiscoveredHost
            ? prov.baseUrl
            : await promptBaseUrlStep(otui, rOrChrome, prov.label ?? prov.name, prov.baseUrl);
        if (!options.onlyConnected && !lockDiscoveredHost && prov.baseUrl !== undefined && selectedBaseUrl === undefined) {
          continue;
        }
        if (!options.onlyConnected && !lockDiscoveredHost && selectedBaseUrl !== undefined) {
          saveProviderBaseUrl(prov.name, selectedBaseUrl, options.configDir);
        }
        let selectedProvider = selectedBaseUrl === undefined ? prov : { ...prov, baseUrl: selectedBaseUrl };

        const envKey = prov.envKey;
        const label = prov.label ?? prov.name;

        /**
         * The credential step. `notice` is set only on the retry, where the
         * provider has already refused what we hold: a value in `env` is then
         * proof of nothing, so the "we already have one" shortcut is skipped
         * and the operator finally gets asked.
         */
        const collectCredential = async (notice?: string): Promise<"ok" | "back"> => {
          if (options.onlyConnected || envKey === undefined) {
            return "ok";
          }
          if (notice === undefined) {
            const existingKey = (options.env ?? process.env)[envKey];
            const hasOauth = oauthAccessToken(prov.name, options.configDir) !== undefined;
            if ((existingKey !== undefined && existingKey.length > 0) || hasOauth) {
              return "ok";
            }
          }
          const offered: AuthMethodChoice[] = [];
          if (catalogAllows(prov.name, "device-code")) offered.push("device-code");
          if (catalogMethods(prov.name).includes("api-key")) offered.push("api-key");
          let method: AuthMethodChoice | undefined = offered.length === 1 ? offered[0] : undefined;
          if (offered.length > 1) {
            method = await pickAuthMethodStep(otui, rOrChrome, label, offered);
            if (method === undefined) {
              return "back";
            }
          }
          if (method === "device-code") {
            if (!(await runDeviceLoginInTui(otui, rOrChrome, prov.name, options.configDir))) {
              return "back";
            }
            const saved = loadShellConfig(options.configDir).baseUrls?.[prov.name];
            if (typeof saved === "string" && saved.length > 0) {
              selectedBaseUrl = saved;
              selectedProvider = { ...prov, baseUrl: saved };
            }
            return "ok";
          }
          const kr = await promptApiKeyStep(otui, rOrChrome, {
            label,
            envKey,
            ...(notice === undefined ? {} : { notice }),
          });
          if (kr.kind === "back") {
            return "back"; // Esc at the key step → re-pick the provider
          }
          if (kr.kind === "key") {
            process.env[envKey] = kr.value;
            // Set here, not exported by the operator: `shell_exec` withholds it (K-015).
            noteSavedCredentialEnv([envKey]);
            saveApiKey(envKey, kr.value, options.configDir); // persist (0600), opencode-style
          }
          // kind === "skip" → proceed without a key (curated fallback models)
          return "ok";
        };

        if ((await collectCredential()) === "back") {
          continue;
        }

        const modelDeps = {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.env === undefined ? {} : { env: options.env }),
        };
        // Fetch AFTER key is available so live GET /models can authenticate.
        let models = await modelsForPicker(selectedProvider, modelDeps);
        // A refused credential is the one failure that is fixable from right
        // here, and the old code could not offer the fix: the dead value in
        // `env` was itself the reason the key step never ran, so an expired
        // grok login produced an empty model list and no way out of it.
        if (models.failure?.kind === "rejected") {
          if ((await collectCredential(modelsFailureLine(label, models.failure))) === "back") {
            continue;
          }
          models = await modelsForPicker(selectedProvider, modelDeps);
        }
        // The endpoint is the other failure fixable from right here — see
        // `endpointMayBeAtFault` for which kinds re-open the URL step and why.
        if (
          !options.onlyConnected
          && selectedProvider.baseUrl !== undefined
          && endpointMayBeAtFault(models.failure)
        ) {
          const corrected = await promptBaseUrlStep(
            otui,
            rOrChrome,
            label,
            selectedProvider.baseUrl,
            modelsFailureLine(label, models.failure),
          );
          if (corrected === undefined) {
            continue; // Esc at the endpoint step → re-pick the provider
          }
          if (corrected !== selectedProvider.baseUrl) {
            saveProviderBaseUrl(prov.name, corrected, options.configDir);
            selectedBaseUrl = corrected;
            selectedProvider = { ...prov, baseUrl: corrected };
            models = await modelsForPicker(selectedProvider, modelDeps);
          }
        }
        // Esc here returns to the provider step, so the modal footer says "back".
        const model = await pickModelInTui(otui, rOrChrome, models.models, modelPickerNotice(label, models), {
          escLabel: "back",
        });
        if (model === undefined) {
          continue; // Esc at the model step → re-pick the provider
        }
        resolve(
          selectedBaseUrl === undefined
            ? { provider: prov.name, model }
            : { provider: prov.name, model, baseUrl: selectedBaseUrl },
        );
        return;
      }
    })();
  });
}

/**
 * Adaptive height (rows) for a `SelectRenderable`: when the item `count` is small
 * the box is at least a quarter of the available `per`-rows budget; when the list is
 * large it stretches up to the full available height (overflow then scrolls). This
 * replaces the fixed model-picker height so a big OpenRouter list uses the whole
 * overlay instead of a small window.
 */
export function adaptiveSelectHeight(count: number, available: number, per = 1): number {
  const min = Math.max(1, Math.floor(available / 4));
  return Math.min(available, Math.max(min, count * per));
}

/**
 * In-TUI model picker with TYPE-TO-FILTER (search by name, e.g. `free`). Given the
 * shell chrome it opens in ModalHost (flow 269 AC3); given a bare renderer, as a
 * full-screen overlay. The SelectRenderable is focused (↑/↓/Enter native) while printable keys
 * and Backspace edit a live filter over the (potentially large) model list. Resolves
 * the chosen model, or `undefined` on Esc / no match. Removes its key handler on close.
 * Exported since flow 112: chat's `/models` opens this same picker.
 *
 * `notice` is the reason the list is empty. Without it the picker said
 * "(no models found)" to an operator whose token had expired, which reads as
 * "this provider has no models" — the one thing it did not mean.
 */
export function pickModelInTui(
  otui: OpenTui,
  rOrChrome: Renderer | ModalChrome,
  models: string[],
  notice?: string,
  options: PickModelOptions = {},
): Promise<string | undefined> {
  const chrome = isModalChrome(rOrChrome) ? rOrChrome : undefined;
  const r = chrome !== undefined ? (chrome.renderer as Renderer) : (rOrChrome as Renderer);
  const showNotice = models.length === 0 && notice !== undefined;
  const noticeText = (): InstanceType<OpenTui["TextRenderable"]> =>
    new otui.TextRenderable(r, { id: "mp-notice", content: otui.t`${roleChunk(otui, "error", "✗")} ${notice ?? ""}` });
  const listSpec = {
    idPrefix: "mp",
    items: models,
    toOption: (m: string) => ({ name: m, description: "" }),
    matches: (m: string, q: string) => m.toLowerCase().includes(q),
    emptyLabel: notice ?? "(no models found)",
    filterHint: (filter: string, shown: number, total: number) => `filter: ${filter}  (${shown}/${total})`,
    showDescription: false,
  };
  // The filter line (+ the notice line, when shown) sits above the list.
  const fixedRows = 1 + (showNotice ? 1 : 0);

  if (chrome !== undefined) {
    return new Promise((resolve) => {
      let chosen: string | undefined;
      const handle = openModal(otui, chrome, {
        title: "Select a model",
        tabs: [{ id: "models", label: "Models" }],
        footer: [
          { key: "↑/↓", label: "select" },
          { key: "Enter", label: "confirm" },
          { key: "esc", label: options.escLabel ?? "close" },
        ],
        contentRows: fixedRows + Math.max(1, models.length),
        renderTab: (_tabId, body, ctx) => {
          const parent = body as Box;
          if (showNotice) {
            parent.add(noticeText());
          }
          const list = mountFilterList(otui, r, parent, {
            ...listSpec,
            idleHint: "type to filter by name",
            width: "100%",
            height: adaptiveSelectHeight(models.length, Math.max(1, ctx.height - fixedRows)),
            onPick: (m) => {
              chosen = m;
              handle?.close();
            },
          });
          return onKeypress(r, list.onKey);
        },
        onClose: () => resolve(chosen),
      });
      if (handle === undefined) {
        resolve(undefined);
      }
    });
  }

  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "model-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "mp-title", content: otui.t`${boldChunk(otui, "Select a model")}` }));
    if (showNotice) {
      box.add(noticeText());
    }
    // Adaptive height: the overlay is full-screen (overlayBox), so "parent height"
    // = renderer height minus the title + filter + padding rows it consumes.
    const rHeight = (r as { height?: number }).height;
    const available = typeof rHeight === "number" && rHeight > 0 ? Math.max(4, rHeight - 4) : 16;
    let unsub = (): void => {};
    const finish = (m: string | undefined): void => {
      unsub();
      r.root.remove(box);
      resolve(m);
    };
    const list = mountFilterList(otui, r, box, {
      ...listSpec,
      idleHint: "type to filter · ↑/↓ Enter · Esc to go back",
      width: 72,
      height: adaptiveSelectHeight(models.length, available),
      onPick: finish,
    });
    unsub = onKeypress(r, (key) => {
      if (key.name === "escape") {
        finish(undefined);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      list.onKey(key);
    });
  });
}

/** Options for {@link pickModelInTui}. */
export type PickModelOptions = {
  /** Footer label for Esc in the modal form: "back" when Esc returns to a previous step. */
  escLabel?: string;
};

/** What {@link mountFilterList} renders: `items`, narrowed by a typed filter. */
interface FilterListSpec<T> {
  idPrefix: string;
  items: readonly T[];
  toOption: (item: T) => { name: string; description: string };
  /** `query` is already trimmed and lower-cased. */
  matches: (item: T, query: string) => boolean;
  /** The placeholder row when `items` itself is empty. */
  emptyLabel: string;
  /** Filter-line text while no filter is typed. */
  idleHint: string;
  filterHint: (filter: string, shown: number, total: number) => string;
  showDescription: boolean;
  width: number | "100%";
  height: number;
  /** Enter on a row: the item, or `undefined` on a placeholder row. */
  onPick: (item: T | undefined) => void;
}

/**
 * The type-to-filter list both pickers share, in either host (the full-screen
 * overlay or a ModalHost tab body): a filter line over a focused
 * `SelectRenderable`. ↑/↓/Enter stay native to the select; the returned `onKey`
 * edits the filter on printable keys and Backspace. Esc belongs to the host.
 */
function mountFilterList<T>(
  otui: OpenTui,
  r: Renderer,
  parent: Box,
  spec: FilterListSpec<T>,
): { onKey: (key: KeypressEvent) => void } {
  const filterLine = new otui.TextRenderable(r, { id: `${spec.idPrefix}-filter`, content: "" });
  parent.add(filterLine);
  const sel = new otui.SelectRenderable(r, {
    id: `${spec.idPrefix}-sel`,
    width: spec.width,
    showDescription: spec.showDescription,
    height: spec.height,
    showScrollIndicator: true,
    wrapSelection: true,
    options: [],
    ...selectThemeColors(getTheme()),
  });
  parent.add(sel);
  sel.focus();

  let filter = "";
  let shown: readonly T[] = spec.items;
  const apply = (): void => {
    const q = filter.trim().toLowerCase();
    shown = q.length > 0 ? spec.items.filter((item) => spec.matches(item, q)) : spec.items;
    sel.options =
      shown.length > 0
        ? shown.map(spec.toOption)
        : [{ name: spec.items.length === 0 ? spec.emptyLabel : "(no match)", description: "" }];
    sel.selectedIndex = 0;
    filterLine.content = otui.t`${dimChunk(otui, 
      q.length > 0 ? spec.filterHint(filter, shown.length, spec.items.length) : spec.idleHint,
    )}`;
  };
  apply();

  sel.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
    spec.onPick(shown[sel.getSelectedIndex()]);
  });

  return {
    onKey: (key) => {
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        apply();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      const ch = key.sequence;
      if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
        filter += ch;
        apply();
        key.preventDefault();
        key.stopPropagation();
      }
    },
  };
}

interface SessionPickerOption {
  value: string;
  label: string;
  description: string;
  search: string;
}

function formatSessionDate(iso: string): string {
  const short = iso.trim().replace("T", " ");
  return short.length >= 16 ? short.slice(0, 16) : short;
}

/**
 * In-TUI session picker with TYPE-TO-FILTER. Shows title / id / activity
 * in one list, and resolves the selected session id, or `undefined` on Esc / no match.
 * Given the shell chrome it opens in ModalHost (flow 269 AC4); given a bare renderer, as a
 * full-screen overlay.
 */
/**
 * The Session Switcher rows (flow 271, AC4): a session another shell holds is
 * marked `● live` or `◌ stale`; this shell's own and free sessions are not.
 */
export function sessionPickerOptions(
  sessions: SessionSummary[],
  leaseState: LeaseStateLookup = () => "free",
): SessionPickerOption[] {
  return sessions.map((s) => {
    const created = formatSessionDate(s.createdAt);
    const updated = formatSessionDate(s.updatedAt);
    const short = shortSessionId(s.id);
    const title = s.title.length > 52 ? `${s.title.slice(0, 49)}…` : s.title;
    const label = withLeaseMarker(`${title}  ·  ${short}`, leaseState(s.id));
    const messages = `${s.messageCount} ${s.messageCount === 1 ? "message" : "messages"}`;
    // Flow 300 (AC9): a session `keryx agents external run` wrote is another
    // agent's run record — say so, and let the filter find it by `acp:`.
    const external = isExternalRunSession(s) ? `${s.provider} · ` : "";
    return {
      value: s.id,
      label,
      description: `${external}updated ${updated} · created ${created} · ${messages}`,
      search: `${s.id} ${label} ${s.projectPath} ${s.title} ${created} ${updated} ${external}`.toLowerCase(),
    };
  });
}

/**
 * The startup resume picker's rows (flow 271, AC4): "New session" first, then
 * the sessions, held ones marked `● live` or `◌ stale`.
 */
export function startupSessionChoices(
  rows: SessionSummary[],
  leaseState: LeaseStateLookup = () => "free",
): ChoiceOption[] {
  return [
    {
      id: "__new__",
      label: "New session",
      description: "Start fresh (old sessions stay on disk)",
      recommended: true,
    },
    ...rows.map((s) => ({
      id: s.id,
      label: withLeaseMarker(s.title.length > 40 ? `${s.title.slice(0, 37)}…` : s.title, leaseState(s.id)),
      description: `${shortSessionId(s.id)} · ctx ${s.messageCount} · ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
    })),
  ];
}

export function pickSessionInTui(
  otui: OpenTui,
  rOrChrome: Renderer | ModalChrome,
  sessions: SessionSummary[],
  leaseState?: LeaseStateLookup,
): Promise<string | undefined> {
  const chrome = isModalChrome(rOrChrome) ? rOrChrome : undefined;
  const r = chrome !== undefined ? (chrome.renderer as Renderer) : (rOrChrome as Renderer);
  const all: SessionPickerOption[] = sessionPickerOptions(sessions, leaseState);
  const listSpec = {
    idPrefix: "sp",
    items: all,
    toOption: (row: SessionPickerOption) => ({ name: row.label, description: row.description }),
    matches: (row: SessionPickerOption, q: string) => row.search.includes(q),
    emptyLabel: "(no match)",
    filterHint: (filter: string, shown: number) => `filter: ${filter}  (${shown})`,
    showDescription: true,
  };
  // A row with its description line takes two rows.
  const ROWS_PER_SESSION = 2;

  if (chrome !== undefined) {
    return new Promise((resolve) => {
      let chosen: string | undefined;
      const handle = openModal(otui, chrome, {
        title: "Session Switcher",
        tabs: [{ id: "sessions", label: "Sessions" }],
        footer: [
          { key: "↑/↓", label: "select" },
          { key: "Enter", label: "open" },
          { key: "esc", label: "cancel" },
        ],
        contentRows: 1 + Math.max(1, all.length) * ROWS_PER_SESSION,
        renderTab: (_tabId, body, ctx) => {
          const list = mountFilterList(otui, r, body as Box, {
            ...listSpec,
            idleHint: "type to filter · title, id, date",
            width: "100%",
            height: adaptiveSelectHeight(all.length, Math.max(1, ctx.height - 1), ROWS_PER_SESSION),
            onPick: (row) => {
              chosen = row?.value;
              handle?.close();
            },
          });
          return onKeypress(r, list.onKey);
        },
        onClose: () => resolve(chosen),
      });
      if (handle === undefined) {
        resolve(undefined);
      }
    });
  }

  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "session-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "sp-title", content: otui.t`${boldChunk(otui, "Open session")} ${dimChunk(otui, "↑/↓ Enter · Esc to cancel")}` }));
    let unsub = (): void => {};
    const finish = (row: SessionPickerOption | undefined): void => {
      unsub();
      r.root.remove(box);
      resolve(row?.value);
    };
    const list = mountFilterList(otui, r, box, {
      ...listSpec,
      idleHint: "type to filter · ↑/↓ Enter · Esc to cancel",
      width: "100%",
      height: 14,
      onPick: finish,
    });
    unsub = onKeypress(r, (key) => {
      if (key.name === "escape") {
        finish(undefined);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      list.onKey(key);
    });
  });
}

/**
 * The sidebar's Mode row (flow 270 AC9): the permission mode, plus a separate
 * read-only part while `/plan on` holds, so it can be painted in its own colour.
 */
export function describeModeRow(mode: PermissionMode, readOnly: boolean): { mode: string; readOnly?: string } {
  return readOnly ? { mode, readOnly: "· read-only" } : { mode };
}

/** `/mode` picker copy — one line per {@link PermissionMode}, kept beside the type it describes. */
const MODE_PICKER_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  ask: "Every mutating action asks first (today's default)",
  trust: "Auto-approves safe actions; still asks for destructive/credential ones",
  auto: "Skips confirmation for everything except credential-touching commands",
};

/**
 * Run the OpenTUI agent shell. OpenTUI owns the terminal from the START — there is
 * NO concurrent readline (that leaked terminal query responses, flows 065/066).
 * The provider/model is taken from `opts.initial` (flags) or an in-TUI picker over
 * `opts.detected`; `opts.makeAgentDeps` then builds the driver deps. Returns `true`
 * once the user exits, `false` if it declined/failed (no TTY / absent optional dep)
 * so the caller can fall back to the readline shell. Never throws.
 */
export async function launchTuiAgentShell(opts: {
  detected: DetectedProvider[];
  initial?: TuiSelection;
  /**
   * Widened from a bare `getSessionDir: () => string | undefined` (fix
   * round, code review of PR #306, Finding 1): `createSpawnSubagentTool`'s
   * `SpawnSubagentToolDeps.getSlateSession` needs the FULL live
   * `SlateSessionRef`, not just its `.dir` string, to fold a dispatched
   * child's ephemeral slate into `parent.slate.childDispatches`. Exposing
   * only `.dir` here (the old shape) meant `commands/shell.ts`'s
   * `makeAgentDeps` closure had no way to hand a real `SlateSessionRef`
   * through to `createSpawnSubagentTool` at all — SLATE-6's fold mechanism
   * silently never fired for any real `keryx shell` TUI session. Both real
   * call sites below (around lines 1419/2203) already hold the full
   * `slateSession` local — this just widens the contract to pass it
   * through instead of narrowing it to `.dir` first.
   */
  /**
   * Flow 274 (agent bus P3, T6/T7 contract): a LIVE getter for this
   * session's bus client (never a captured value — the join resolves
   * asynchronously, well after the FIRST `makeAgentDeps` call, and every
   * `/model`/`/connect` rebuild must see whatever the join settled to by
   * then). `commands/shell.ts`'s `makeAgentDeps` reads `bus?.client() !==
   * undefined` to decide `AgentInstructionContext.busJoined` and whether to
   * pass a `bus` option through to `buildInteractiveAgentTools` at all
   * (never for a session that never even attempts to join). Optional so
   * every existing caller (tests) that predates the bus is unaffected.
   */
  makeAgentDeps: (
    sel: TuiSelection,
    getSlateSession: () => SlateSessionRef | undefined,
    bus?: { client: () => BusClient | undefined },
  ) => Promise<AgentDeps>;
  /**
   * Flow 268 T16 (AC11): update the CALLER's `/reasoning` session-override
   * state (`commands/shell.ts`'s `reasoningSessionOverride`) so the NEXT
   * `makeAgentDeps` rebuild (`/model`/`/connect`) — and a fresh `keryx shell`
   * process, via the `ShellConfig.reasoningEffort` the `/reasoning` handler
   * ALSO persists — resolve the same level this session just chose. Optional
   * so every existing caller (only `commands/shell.ts`'s real one exists
   * today) that predates this stays unaffected; when absent, `/reasoning`
   * still mutates the live `deps.reasoningEffort` in this file directly (see
   * the `/reasoning` command handler below), which is enough for the CURRENT
   * session even without this callback.
   */
  setReasoningOverride?: (level: string | undefined) => void;
  /** Re-probe providers for `/connect` and `/model` (fresh detection). */
  redetect?: () => Promise<DetectedProvider[]>;
  versionCheck?: Promise<VersionCheckResult>;
  /**
   * Per-project session bootstrap. Sessions never cross git-root/cwd boundaries.
   * `pickOnStart` opens the resume menu when `-r` is given without an id.
   */
  session?: {
    cwd: string;
    continueLast?: boolean;
    resumeId?: string;
    pickOnStart?: boolean;
    /** `--fork` (with `resumeId`): open a fork of the session and lease the fork (flow 271). */
    fork?: boolean;
    /** `--take-over` (with `resumeId`): reclaim a STALE holder's lease (flow 271). */
    takeOver?: boolean;
    /**
     * Flow 273 (specification §5.1, §7.4): `keryx shell --name <name>`. Takes
     * priority over the persisted `bus.name` shell config, which `joinBus`
     * falls back to on its own when this is absent. Declared here (not on
     * `commands/shell.ts`'s own opts type) so this TUI wiring needs no import
     * from that file — `runShell`/`runAgentRepl` spread the same field in.
     */
    busName?: string;
  };
  /**
   * The CLI-flag override only (`--permission-mode` / `--ask`/`--trust`/
   * `--auto`, see `parseShellCliFlags` in `commands/shell.ts`). `undefined`
   * means no flag was passed — the session then falls back to the project's
   * stored default (`getProjectPermissionMode(sessionCwd)`) and finally
   * `DEFAULT_PERMISSION_MODE`.
   */
  initialPermissionMode?: PermissionMode;
}): Promise<boolean> {
  if (!process.stdout.isTTY) {
    return false;
  }
  applyThemeId(loadPersistedThemeId());
  let otui: OpenTui;
  try {
    otui = await import("@opentui/core"); // optional dep; absent → fall back
  } catch {
    return false;
  }

  let renderer: Renderer | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let uid = 0;
  // Surfaces this pane's lifecycle to a herdr workspace (working/idle/blocked).
  // No-op unless the shell was launched inside a herdr pane.
  const herdr = createHerdrReporter();
  /** Session-scoped allow patterns (plus persisted permissions.json). */
  const sessionShellAllow = new Set<string>(loadShellPermissions().allow);
  /** The stored-permission migration warning is shown at most once per session. */
  let permissionMigrationShown = false;
  /**
   * Fingerprint of permissions.json as it was when the session started. If it
   * changes mid-session the allowlist was rewritten by something other than the
   * approval UI — the self-grant path — and the user is told before the next
   * auto-approve acts on it.
   */
  let permissionsFingerprintAtStart = shellPermissionsFingerprint();
  let permissionTamperShown = false;
  const searchProviderController = createDefaultSearchProviderController();
  // The chrome can only be mounted once a provider/model is chosen (the startup
  // picker runs on the bare renderer), yet `onDestroy` may fire before that —
  // Ctrl+C at the picker. A nullable handle is the honest shape for that window;
  // it is never rebound to a placeholder no-op (flow 112, AC2).
  let mountedChrome: ShellChrome | undefined;
  // Flow 173 F-002: `onDestroy` (Ctrl+C — `exitOnCtrlC: true` below) is a
  // real, common exit path and must ALSO sweep background jobs (process-
  // group SIGTERM→SIGKILL) and purge the sidebar/store list, same as
  // `/exit`. It can fire before `deps`/`jobs` are ever assigned (Ctrl+C
  // during the provider/model picker, well before either exists) — the
  // exact same TDZ hazard `mountedChrome` above exists to avoid, solved the
  // same way: a nullable ref set once real, read through optional chaining
  // so an early Ctrl+C degrades to a safe no-op (there is nothing to sweep
  // that early — no JobRegistry/BackgroundJobStore exists yet either).
  let liveDeps: AgentDeps | undefined;
  let liveJobs: BackgroundJobStore | undefined;
  let disposeExecutionPlanPanel: (() => void) | undefined;
  // Flow 300: same nullable-ref idiom — the Governance/Triggers sections own a
  // poller and possibly a running `keryx trigger run` child to stop on exit.
  let liveOps: OpsSidebar | undefined;
  let liveSchedules: SchedulesSidebar | undefined;
  // Flow 176 T18: same nullable-ref/TDZ idiom as `liveJobs` above — `onDestroy`
  // is installed before the operator exists, and leaving the module-level
  // external bridge pointing at a destroyed shell would let a still-settling
  // vendor run repaint a renderer that is gone.
  let detachExternal: (() => void) | undefined;
  // Flow 273 (agent bus P2, T7): same nullable-ref/TDZ idiom as `liveJobs` and
  // `detachExternal` above — `onDestroy` is installed before the session (and
  // so the bus join, which needs the session id) exists, and every exit path
  // must call `leave()` even when Ctrl+C lands before the join ever ran.
  let liveBus: BusClient | undefined;
  // review r1 F6: set ONLY in `onDestroy` (Ctrl+C). `joinBus` is awaited
  // inside a fire-and-forget IIFE, so Ctrl+C can land while it is still in
  // flight; once it resolves after that, the resolved client must be left
  // immediately — never assigned to `liveBus`, never painted into — rather
  // than racing the already-destroyed renderer.
  let destroyed = false;
  // review r1 F10: one "inbox full" notice per overflow episode, not one per
  // dropped message (see `createBusDropNotifier`'s own doc comment).
  // Declared here (before `io` exists) but only ASSIGNED once `io` does,
  // below — same nullable-ref/TDZ idiom as `liveJobs`/`detachExternal`/
  // `liveBus` above: `busInbox`'s own `onDrop` closure only ever fires once a
  // real event is pushed, long after this function's synchronous setup (and
  // so this assignment) completes.
  let busDropNotifier: BusDropNotifier;
  // Flow 274 (agent bus P3, T7; specification §5.3): one inbox per session,
  // fed by `BusClient.onEvent` below regardless of when the join settles —
  // safe to create up front even for a disabled bus (it simply never
  // receives a push).
  const busInbox: BusInbox = createBusInbox({ onDrop: (droppedTotal) => busDropNotifier.onDrop(droppedTotal) });
  // Flow 274 T7 (review r1 F11: now `createBusWakeController`, from
  // `./bus-wake.ts`) — the actual bus-wake check needs `runLine`, `mainQueue`
  // and `consecutiveAutoWakes`, all declared much further down this
  // function — but `onPeers` (which must trigger it once per poll,
  // specification §5.3) is wired into `joinBus` right below, long before any
  // of those exist. Same indirection `deps.jobRegistry?.onCompletion` avoids
  // by being registered textually AFTER `runLine`: a mutable ref, assigned
  // its real implementation next to that registration, so `onPeers` always
  // calls through whatever is current — a safe no-op until then, since a real
  // poll cannot fire until long after this function's synchronous setup (and
  // so this assignment) has completed.
  let busWakeController: BusWakeController | undefined;
  // Flow 275 (agent bus P4, T7; specification §4.3, §5.2): same nullable-ref/
  // TDZ idiom as `busWakeController` right above — the real implementation is
  // built once `mainQueue`/`runLine`/`forceHandoff` exist, further down; a
  // poll landing before that is a safe no-op via optional chaining.
  let leaseHoldController: LeaseHoldController | undefined;
  // review r1 F1: whether the poll CURRENTLY being processed delivered at
  // least one event to `busInbox` — set by `onEvent` (below, per event) and
  // read/reset by `onPeers` once per poll, right after every event of that
  // poll was already routed to `onEvent` (`BusClient`'s own `doPoll`).
  let busPollDeliveredEvent = false;
  // Flow 274 (agent bus P3, T6/T7 contract): the SAME live-getter object
  // passed to every `opts.makeAgentDeps` call (initial build and every
  // `/model`/`/connect`/side-worker rebuild) — `commands/shell.ts`'s
  // `makeAgentDeps` reads `bus.client()` at call time, never a snapshot.
  const busClientRef = { client: (): BusClient | undefined => liveBus };
  // Flow 275 (agent bus P4, T7; specification §4.3): this instance's cached
  // lease reader, or `undefined` before the bus join settles / when the bus
  // is disabled — `BusClient.leaseView()` always returns the SAME object
  // (refreshed on every poll and right after pause/resume/override), so
  // reading through this getter fresh at every call site is cheap and never
  // stale by more than one poll interval.
  const leaseView = (): PauseLeaseView | undefined => liveBus?.leaseView();
  /**
   * Adapts a `BusClient` to `AgentDeps.busLeases` (flow 275 T6/T8 contract,
   * specification §4.4) — same shape as `commands/shell.ts`'s own
   * `busLeasesFromClient` (T8's readline surface): `heldBy` there returns
   * just `{name, reason}`, not the full `PauseLease`, so `executeCall`'s
   * publish-lease floor never needs to import the lease schema itself. Flow
   * 275 F2: `heldBy` reads `appliesToMeLease(scope)` — the SAME scope the
   * caller just passed to `appliesToMe` — never the `turns`-only `heldBy()`
   * accessor, so a `git-publish` floor never gets back an unrelated `turns`
   * lease's holder/reason (or nothing at all when only a `git-publish` lease
   * applies).
   */
  const busLeasesFromClient = (bus: BusClient): NonNullable<AgentDeps["busLeases"]> => ({
    appliesToMe: (scope) => bus.leaseView().appliesToMe(scope),
    heldBy: (scope) => {
      const lease = bus.leaseView().appliesToMeLease(scope);
      return lease === undefined ? undefined : { name: lease.holder.name, reason: lease.reason };
    },
  });
  const foregroundOperation = createForegroundOperationOwner();
  // Flow 271: the session lease this shell holds. Declared before the renderer
  // so `onDestroy` (Ctrl+C) can release it; empty until a session is open, and
  // `release()` is idempotent, so every exit path may call it.
  const sessionLease = createTuiLeaseHolder();
  try {
    // Stable non-nullable handle for the closures below (the outer `renderer`
    // stays `Renderer | undefined` for the `finally` teardown).
    const r = (renderer = await createShellRenderer(otui, {
    onDestroy: () => {
        disposeExecutionPlanPanel?.();
        liveSchedules?.dispose();
        liveOps?.dispose();
        destroyed = true; // review r1 F6: the in-flight join (if any) must leave(), not paint
        foregroundOperation.cancel("renderer destroyed");
        foregroundOperation.dispose();
        // Flow 271/273 (AC7; review r1 F9): leave the bus BEFORE releasing the
        // session lease — specification §5.4's order — synchronously, before
        // anything that may block.
        leaveBusThenRelease({
          leaveBus: () => liveBus?.leave(), // idempotent, synchronous-safe
          releaseLease: () => sessionLease.release(),
        });
        mountedChrome?.destroy(); // stops the live spinner if a turn is mid-flight
        setAskUserHost(undefined);
        setSubagentFleetListener(undefined);
        setBackgroundJobListener(undefined);
        detachExternal?.(); // flow 176 T18: clears the run listener AND the approver

        // Flow 173 F-002: previously Ctrl+C left every tracked background
        // job's process group unswept and the in-memory job list unpurged —
        // an orphan survives indefinitely, unsandboxed, contradicting
        // description.md's "job lifetime is scoped to the session, full
        // stop." `onDestroy`'s signature is strictly `() => void`
        // (@opentui/core's .d.ts, confirmed against its compiled source:
        // `destroy()` calls `this._onDestroy()` synchronously and never
        // awaits it, and neither `destroy()` nor its Ctrl+C/exit-signal
        // handlers ever call `process.exit()` — the process only exits once
        // the event loop drains). So the OS-level sweep is fired here
        // WITHOUT being awaited (this closure cannot `await`), but
        // `resolveDone()` — which unblocks the `await done` this function's
        // own caller sits on, below — is deliberately deferred until the
        // sweep settles, so nothing downstream of `launchTuiAgentShell()`
        // can run (and the process cannot exit) before the sweep actually
        // happened.
        liveJobs?.removeAll(); // store-side purge; synchronous, safe here
        void (async () => {
          try {
            await liveDeps?.sweepBackgroundJobs?.();
          } finally {
            resolveDone();
          }
        })();
      },
    }));
    applyThemeId(getThemeId(), r.themeMode);
    // Review finding: unregistered on destroy, unlike every other renderer-
    // level subscription in this file — named so `.off()` at every exit path
    // below can find the same reference `.on()` registered.
    const onThemeMode = (mode: "dark" | "light"): void => {
      if (getThemeId() === "auto") {
        applyThemeId("auto", mode);
      }
    };
    r.on("theme_mode", onThemeMode);

    // Branded intro (flow 266 P1) — before the picker so it is the FIRST thing
    // shown, matching a launch sequence rather than interrupting one already in
    // progress. `KERYX_SKIP_BOOT=1` bypasses it entirely (see boot-animation.ts).
    await playBootAnimation(otui, r, { onKeypress: (handler) => onKeypress(r, handler) });

    // Resolve the provider/model — from flags, or an in-TUI picker.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.off("theme_mode", onThemeMode);
      r.destroy();
      return true; // could not select; treat as a clean exit (do not fall back)
    }
    // Persist the chosen provider/model (opencode-style) so the next launch reuses it.
    saveShellConfig(sel.baseUrl === undefined ? { provider: sel.provider, model: sel.model } : { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    // Flow 303 (AC14): from here until `createShellChrome` paints the header,
    // transcript and focused composer below, the renderer's root would
    // otherwise be empty — the reported "black screen" gap. Kept up across
    // `opts.makeAgentDeps` (tool registry + MCP wiring), removed the moment
    // the chrome exists.
    const startupIndicator = mountStartupIndicator(otui, r, "Preparing your session…");
    // Mutable: `/connect` and `/model` rebuild these mid-session.
    let currentSel: TuiSelection = sel;
    // AC14 (flow 268): the next-step suggestion's in-flight request gate.
    // `runLine` cancels it the moment a new turn starts, and the composer
    // activity subscription below cancels it the moment the user types —
    // either way a late reply can never reach `chrome.showSuggestion`. See
    // `suggestNextStep` and `next-step-suggestion.ts`.
    const suggestionGate = new NextStepSuggestionGate();
    // Declare the session ref before any consumer can call the getter. The
    // execution-plan panel refreshes immediately when mounted, before the live
    // session is bound, and must observe `undefined` rather than hit the TDZ.
    let slateSession: SlateSessionRef | undefined;
    // Finding 1 fix: pass the FULL live `slateSession` ref through, not just
    // `.dir` — `makeAgentDeps`'s widened contract (see `opts.makeAgentDeps`
    // doc comment above) needs it to wire `createSpawnSubagentTool`'s new
    // `getSlateSession` getter so a dispatched subagent's Seeds actually
    // fold into this session's slate once it opens.
    // Review r2 N1: every slate read goes through this, so once another shell
    // took the session over, slate tools see no session (the check is on disk,
    // at the write) rather than writing into it until the next heartbeat.
    const liveSlateSession = (): SlateSessionRef | undefined =>
      whilePersisting(slateSession, () => sessionLease.canPersist());
    startupIndicator.setStep("Loading agent tools and MCP servers…");
    let deps = await opts.makeAgentDeps(sel, liveSlateSession, busClientRef);
    liveDeps = deps; // F-002: onDestroy reads this ref (TDZ-safe, see above)
    // Flow 268 T16 (AC11): local mirror of `opts.setReasoningOverride`'s
    // target, so the `/reasoning` no-arg status line can name the source
    // ("this session") without needing a getter back from `commands/shell.ts`.
    let reasoningOverride: string | undefined;
    // Flow 268 T17 (AC16): persisted reasoning-display mode, read fresh by
    // `attachBlockIo` on every round (a live getter, same idiom as
    // `AgentIO.permissionMode`) so `/think auto|expand|hide` takes effect on
    // the NEXT round without re-wiring `io`. Loaded once at session start;
    // `/think`'s handler below both updates this and persists it.
    let thinkDisplayMode: ThinkDisplayMode = resolveThinkDisplayMode(loadShellConfig().thinkDisplay);

    const FOOTER_IDLE = "/ commands · Ctrl+O blocks · Ctrl+C to exit";
    const FOOTER_NAV = "blocks · ↑/↓ move · Enter toggle · y copy · Esc exit";

    // The mode-agnostic chrome (flow 112, S1): layout, header, transcript,
    // choice dock, `/`-menu, composer, footer/spinner, toast, overlay guard and
    // copy-on-select. Everything below is agent-specific and mounts ON it.
    const chrome = await createShellChrome(otui, r, {
      title: `keryx · agent · ${sel.provider}/${sel.model}`,
      status: `${sel.provider}/${sel.model}`,
      footerHint: FOOTER_IDLE,
      placeholder: "type a task or / for commands · Enter send · Shift+Enter newline",
      commands: commandsForMode("agent"),
      headerMeta: "↑0 ↓0",
      // Closure-only: `permissionMode` is declared later in this function —
      // TDZ is a call-time concern for a closure (the same pattern as the
      // `() => slateSession` ref documented above).
      permissionMode: () => permissionMode,
      // The shared registry stays the single source of truth for the dropdown,
      // resolved through THIS surface's mode so the wording is agent-mode's.
      filterCommands: (query) => filterCommands(query, "agent"),
      ...(opts.versionCheck !== undefined ? { versionCheck: opts.versionCheck } : {}),
    });
    // Flow 303 (AC14): the chrome (header, transcript, focused composer) is
    // now on screen — the gap the indicator was covering is over.
    startupIndicator.remove();
    mountedChrome = chrome;
    // Flow 170 T6, PRD FR-14: the composer has keyboard focus the moment the
    // shell finishes launching, no click required. `createShellChrome`
    // already calls `textarea.focus()` once internally during construction
    // (see its "/`-menu wiring" section) and this call is therefore a no-op
    // in the common case — `Renderable.focus()` returns immediately when
    // already focused (confirmed against the bundled `@opentui/core`
    // implementation). It stays as an explicit, separately-documented
    // guarantee at THIS call site anyway: AC13 must hold regardless of an
    // internal implementation detail of `shell-chrome.ts` that a future
    // refactor could silently change, and every other overlay/picker that
    // can compete for focus at startup (the resume-picker below, ~550 lines
    // further down, gated on `opts.session?.pickOnStart`) runs well AFTER
    // this point and restores focus itself once it resolves — so there is
    // nothing between here and there for this call to clobber or be
    // clobbered by.
    chrome.input.focus();
    const transcript = chrome.transcript;
    const input = chrome.input;
    // AC14 (flow 268): typing (or pasting) into the composer invalidates any
    // in-flight next-step suggestion request, whether or not a suggestion is
    // currently shown — see `suggestionGate` above.
    chrome.onComposerActivity(() => suggestionGate.cancel("composer activity"));

    // The chrome owns the spinner; the closure mirrors only the phase and the
    // start time, which it still needs for the side-worker context snapshot and
    // which the chrome deliberately does not expose.
    let busyPhase = "waiting for model";
    let busyStartedAt = 0;
    const setBusyPhase = (phase: string): void => {
      busyPhase = phase;
      debugEvent("busy.phase", { phase });
      chrome.setBusyPhase(phase);
    };
    const startBusy = (phase = "waiting for model"): void => {
      busyPhase = phase;
      busyStartedAt = Date.now();
      chrome.startBusy(phase);
    };
    const stopBusy = (): void => {
      chrome.stopBusy();
    };

    // Sidebar panels (model, context, tools, workers) go in `sidebarTop`, NOT
    // `sidebar`: the chrome pins the toast to the bottom with a flexGrow spacer,
    // so anything added to `sidebar` itself would land beside the toast.
    const sidebar = chrome.sidebarTop;
    mountTitlePanel(otui, r, sidebar);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-model-k", content: otui.t`${dimChunk(otui, "Model")}`, marginTop: 1 }));
    const sbModelV = new otui.TextRenderable(r, { id: "sb-model-v", content: otui.t`${dimChunk(otui, `${sel.provider}/${sel.model}`)}` });
    sidebar.add(sbModelV);
    // Mode line (flow 270 AC9): the permission mode and the /plan read-only
    // posture were only ever toasts. One line under the model, not a labelled
    // block of its own: three more rows pushed Status off a 24-row terminal
    // (the macOS pty smoke leg). Painted by `paintModeRow` once both are known.
    const sbModeV = new otui.TextRenderable(r, { id: "sb-mode-v", content: "" });
    sidebar.add(sbModeV);
    // Flow 275 (agent bus P4, T7; specification §4.3): a persistent banner
    // while a `turns` pause lease holds this instance — holder, reason,
    // remaining TTL, right below the mode line (same "one more row" budget
    // concern the comment above documents). Empty (nothing painted) whenever
    // no lease holds this instance; `paintHoldBanner` is the only writer.
    const sbHoldV = new otui.TextRenderable(r, { id: "sb-hold-v", content: "" });
    sidebar.add(sbHoldV);
    const paintHoldBanner = (): void => {
      const banner = leaseView()?.banner();
      sbHoldV.content = banner === undefined ? "" : otui.t`${roleChunk(otui, "attention", banner)}`;
    };
    // Usage row under Model: cumulative in/out tokens this session, fed by
    // `attachUsageIo`'s setUsage chrome. Starts "↑0 ↓0"; real numbers replace
    // it the first time the provider reports usage.
    sidebar.add(new otui.TextRenderable(r, { id: "sb-usage-k", content: otui.t`${dimChunk(otui, "Usage")}`, marginTop: 1 }));
    const sbUsageV = new otui.TextRenderable(r, { id: "sb-usage-v", content: otui.t`${dimChunk(otui, "↑0 ↓0")}` });
    sidebar.add(sbUsageV);
    // Balance row under Usage: live balance for the ACTIVE provider, fetched
    // on mount and on click (mountBalancePanel). "—" when the provider has no
    // balance endpoint (Z.AI/Cerebras/Groq/…).
    // Default fetch + merged shell auth keys; the active provider resolves
    // from `sel.provider`. Clicking the value re-fetches.
    const balancePanel = mountBalancePanel(sidebar, otui, r, {
      provider: sel.provider,
    });
    // The directory the agent's tools act on — directly under Model, matching the
    // readline header's `provider/model … · <cwd>` order (gap G-2).
    mountCwdPanel(otui, r, sidebar, opts.session?.cwd ?? process.cwd());
    // SAC workspace (SLATE-16 resolve-or-create): absent until the session's
    // first action-intent turn binds one, so this row starts empty and is
    // refreshed — not mounted once like Directory/Branch/PR above, which are
    // static for the session's lifetime.
    // Hug-content box, and EMPTY until a workspace binds — the same idiom as the
    // Subagents/Background-Jobs boxes below. `sidebarTop` is a fixed-height
    // column, so a row that only ever says "—" is not free: it is taken from
    // the panels underneath it (`Tools`, `Status`, and the pinned toast), which
    // on an 80x24 terminal simply fall off the bottom of the screen —
    // `shell-pty-launch.smoke.test.ts` is what catches that.
    const sbWorkspace = new otui.BoxRenderable(r, {
      id: "sb-workspace",
      flexDirection: "column",
      flexShrink: 0,
    });
    sidebar.add(sbWorkspace);
    let currentSlates: SlateInspectorItem[] = [];
    /** Rebuild the Workspace panel: no bound workspace ⇒ no rows at all. */
    const paintWorkspaceSidebar = (workspace: WorkspaceInfo | undefined, slates: readonly SlateInspectorItem[]): void => {
      clearTranscriptChildren(sbWorkspace);
      if (workspace === undefined) {
        return;
      }
      sbWorkspace.add(new otui.TextRenderable(r, { id: "sb-workspace-k", content: otui.t`${dimChunk(otui, "Workspace")}`, marginTop: 1 }));
      sbWorkspace.add(
        new otui.TextRenderable(r, {
          id: "sb-workspace-v",
          content: otui.t`${dimChunk(otui, `${shortenCwd(workspace.title, SIDEBAR_TEXT_WIDTH)} · ${workspace.status} · ${slates.length} slate${slates.length === 1 ? "" : "s"}`)}`,
          onMouseDown: () => {
            showWorkspace();
          },
        }),
      );
    };
    const refreshWorkspaceSidebar = async (): Promise<void> => {
      const dir = liveSlateSession()?.dir;
      const workspaceId = dir !== undefined ? (await readSlate(dir).catch(() => undefined))?.workspaceId : undefined;
      if (workspaceId === undefined) {
        currentSlates = [];
        paintWorkspaceSidebar(undefined, currentSlates);
        return;
      }
      const cwd = opts.session?.cwd ?? process.cwd();
      const [workspace, slates] = await Promise.all([
        loadInspectorWorkspace(cwd, workspaceId),
        loadInspectorSlates(cwd, workspaceId),
      ]);
      currentSlates = slates;
      paintWorkspaceSidebar(workspace, slates);
    };
    // SLATE-10 catch-up (RP-13-ish sidebar surface): project-wide, not
    // scoped to this session's own workspace — a human coming back after
    // several sessions needs to see EVERY pending proposal/blocked
    // session/unbound candidate, not just this one's. Yellow (matches the
    // Status row's own "blocked = yellow" convention) once nonzero, so the
    // badge reads as a notification rather than a passive count.
    // A notification, so it is present only when it has something to notify
    // about — nothing pending ⇒ zero rows, same reason as the Workspace box
    // above (a fixed-height column has no spare rows to spend on "nothing").
    const sbReview = new otui.BoxRenderable(r, {
      id: "sb-review",
      flexDirection: "column",
      flexShrink: 0,
    });
    sidebar.add(sbReview);
    const refreshReviewSidebar = async (): Promise<void> => {
      const cwd = opts.session?.cwd ?? process.cwd();
      const count = catchUpItems(await loadInspectorCatchUp(cwd)).length;
      clearTranscriptChildren(sbReview);
      if (count === 0) {
        return;
      }
      sbReview.add(new otui.TextRenderable(r, { id: "sb-review-k", content: otui.t`${dimChunk(otui, "Review")}`, marginTop: 1 }));
      sbReview.add(
        new otui.TextRenderable(r, {
          id: "sb-review-v",
          content: otui.t`${roleChunk(otui, "attention", `${count} item${count === 1 ? "" : "s"} need review`)}`,
          onMouseDown: () => {
            showReview();
          },
        }),
      );
    };
    sidebar.add(new otui.TextRenderable(r, { id: "sb-ctx-k", content: otui.t`${dimChunk(otui, "Context")}`, marginTop: 1 }));
    const sbContext = new otui.TextRenderable(r, { id: "sb-ctx-v", content: otui.t`${dimChunk(otui, "0 tokens")}` });
    sidebar.add(sbContext);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-tools-k", content: otui.t`${dimChunk(otui, "Tools")}`, marginTop: 1 }));
    sidebar.add(
      new otui.TextRenderable(r, {
        id: "sb-tools-v",
        content: otui.t`${dimChunk(otui, `${deps.tools.length} available`)}`,
        onMouseDown: () => {
          showTools();
        },
      }),
    );
    // Multi-agent / page-worker fleet (enrich swarm + future harness subagents).
    // Live activity: main agent phase + optional enrich/subagent fleet.
    // Yellow when blocked (user must act), red on failure — not cryptic glyphs only.
    sidebar.add(new otui.TextRenderable(r, { id: "sb-status-k", content: otui.t`${dimChunk(otui, "Status")}`, marginTop: 1 }));
    const sbWorkers = new otui.TextRenderable(r, {
      id: "sb-status-v",
      content: otui.t`${dimChunk(otui, "○ Ready")}`,
    });
    sidebar.add(sbWorkers);
    // Hug-content box, not a flexGrow ScrollBox: a growing viewport inside
    // flexShrink-0 sidebarTop covers the Model/Tools labels on a real pty
    // (shell-pty-launch O-6). Empty list is zero height; rows add as children spawn.
    const sbSubagents = new otui.BoxRenderable(r, {
      id: "sb-subagents",
      flexDirection: "column",
      flexShrink: 0,
      marginTop: 1,
    });
    sidebar.add(sbSubagents);
    const sbPlan = new otui.BoxRenderable(r, {
      id: "sb-plan",
      flexDirection: "column",
      flexShrink: 0,
    });
    sidebar.add(sbPlan);
    const executionPlanPanel = mountExecutionPlanPanel(otui, r, sbPlan, {
      getSessionDir: () => liveSlateSession()?.dir,
      width: SIDEBAR_TEXT_WIDTH,
      maxRows: 7,
      // Clicking the Plan section opens the full plan in the shared modal host,
      // the same way the Workspace/Review/Tools rows and every subagent or job
      // row do. The sidebar stays a seven-row glance; the modal is where the
      // whole list, the status of each item and the revision are legible.
      onOpen: () => {
        void openExecutionPlanInspector(otui, chrome, {
          getSessionDir: () => liveSlateSession()?.dir,
          readPlan: (dir) => getExecutionPlan(dir),
          renderer: r,
        });
      },
    });
    disposeExecutionPlanPanel = executionPlanPanel.dispose;
    // Flow 173 (AC8): Background Jobs panel, same hug-content-box idiom as
    // sbSubagents above (a growing viewport would cover the Model/Tools
    // labels on a real pty — shell-pty-launch O-6).
    const sbJobs = new otui.BoxRenderable(r, {
      id: "sb-jobs",
      flexDirection: "column",
      flexShrink: 0,
      marginTop: 1,
    });
    sidebar.add(sbJobs);
    // Flow 300: Governance, then Triggers — fixed order after Jobs, at the
    // bottom of the scrollable `sidebarTop`, so neither can push Model/Context/
    // Tools/Status off a 24-row terminal. Flow 295's Schedules section mounts
    // after these and can subscribe to `ops.watcher` rather than poll again.
    const ops = mountOpsSidebar({
      otui,
      chrome,
      parent: sidebar,
      cwd: opts.session?.cwd ?? process.cwd(),
      width: SIDEBAR_TEXT_WIDTH,
      onKeypress: (handler) => onKeypress(r, (key) => handler(key)),
      notice: (text) => io.onSystem?.(text),
    });
    liveOps = ops;
    // Flow 295 (AC10-AC13): Schedules, mounted after Triggers (the fixed order), on
    // the same ledger watcher and run-now as the section above. No second poller.
    const schedules = mountSchedulesSidebar({
      otui,
      chrome,
      parent: sidebar,
      cwd: opts.session?.cwd ?? process.cwd(),
      width: SIDEBAR_TEXT_WIDTH,
      ops,
      onKeypress: (handler) => onKeypress(r, (key) => handler(key)),
      notice: (text) => io.onSystem?.(text),
    });
    liveSchedules = schedules;
    const fleet = new WorkerFleet();
    const sessions = new SubagentSessionStore();
    const jobs = new BackgroundJobStore();
    liveJobs = jobs; // F-002: onDestroy reads this ref (TDZ-safe, see above)
    // Flow 273 (specification §7.2): the bus's own peer list, mapped down to
    // the sidebar's small shape (`onPeers` below repaints on every poll).
    let busFleetPeers: FleetPeer[] = [];
    const paintFleet = (): void => {
      const list = fleet.list();
      const text = formatFleetSidebarWithPeers(list, busFleetPeers, 12);
      const main = list.find((w) => w.id === MAIN_AGENT_ID);
      if (main?.status === "blocked") {
        sbWorkers.content = otui.t`${roleChunk(otui, "attention", text)}`;
      } else if (main?.status === "failed") {
        sbWorkers.content = otui.t`${roleChunk(otui, "error", text)}`;
      } else {
        sbWorkers.content = otui.t`${dimChunk(otui, text)}`;
      }
    };
    const paintSubagents = (hint?: { kind: string }): void => {
      if (hint?.kind === "log") {
        return;
      }
      paintSubagentSidebar(otui, r, sbSubagents, sessions.list(), {
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: (id) => {
          // Flow 176 T18: one list, two inspectors. An external child's Work
          // tab is a vendor transcript and its Meta/Command tabs carry argv,
          // session handle and cost — none of which the native inspector can
          // render, because none of them exist on a `SubagentSession`.
          if (external.has(id)) {
            openExternalInspector(otui, chrome, { store: external.store, id, renderer: r });
            return;
          }
          openSubagentInspector(otui, chrome, { store: sessions, id, renderer: r });
        },
      });
    };
    const paintJobs = (hint?: BackgroundJobStoreHint): void => {
      // F-008: mirror `paintSubagents`'s guard above — a live job's stdout
      // fires an `output` hint on every chunk; repainting (destroying and
      // recreating every row) on each one is wasted work AND can destroy a
      // `TextRenderable` mid-click (a mouse-down landing on a renderable
      // torn down before its dispatch runs).
      if (hint?.kind === "output") {
        return;
      }
      paintBackgroundJobSidebar(otui, r, sbJobs, jobs.list(), {
        width: SIDEBAR_TEXT_WIDTH,
        onOpen: (id) => {
          // `deps.jobRegistry` is `let`-captured live (see `deps` reassignment
          // on `/model`/`/connect` below) — always defined for a real TUI
          // session (`shell.ts`'s `makeAgentDeps` always sets it); guarded
          // here only so a test/driver that omits it degrades to a no-op
          // instead of throwing.
          if (deps.jobRegistry === undefined) {
            return;
          }
          openJobInspector(otui, chrome, { store: jobs, id, registry: deps.jobRegistry, renderer: r });
        },
      });
    };
    fleet.subscribe(paintFleet);
    sessions.subscribe(paintSubagents);
    jobs.subscribe(paintJobs);
    // MAE spawn_subagent → inspectable session list only (never dual-write to fleet).
    setSubagentFleetListener((ev) => {
      sessions.apply(ev);
    });
    // Flow 173 (AC8): shell_exec(background:true)'s JobRegistry → sidebar/inspector.
    setBackgroundJobListener((ev) => {
      jobs.apply(ev);
    });
    // --- Flow 176 T18: the external-agent operator loop --------------------
    // `attachExternalOperator` registers the module-level bridge listener AND
    // the spawn approver. The approver is the load-bearing half:
    // `externalAgents.spawnDecision` defaults to "ask" and the factory fails
    // closed with no approver, so without this line a correctly-configured
    // machine denies every model-initiated external spawn. It reuses
    // `showComposerChoice` — the SAME dock prompt `risk: "delegate"` tools go
    // through below — rather than inventing a second approval surface.
    const external: ExternalOperator = (() => {
      const attached = attachExternalOperator({
        cwd: opts.session?.cwd ?? process.cwd(),
        // A message that waited in a run's queue and then turned out to be
        // undeliverable has no caller to return its reason to, so it is surfaced
        // here instead of dropped (§7.5: an operator who thinks a message landed
        // stops watching for the reply).
        onDelivery: (runId, result) => {
          io.onSystem?.(
            result.ok
              ? `◇ ${runId}: ${result.note}\n`
              : `◇ ${runId}: message not delivered — ${result.reason}\n`,
          );
        },
        ask: async (request) => {
          chrome.hideMenu(); // release menuNav before the dock takes over
          setMainAgent("blocked", "approval");
          const preview = request.task.length > 80 ? `${request.task.slice(0, 77)}…` : request.task;
          const id = await chrome.withOverlay(() =>
            showComposerChoice(otui, r, chrome.dock, {
              title: `Run the external agent ${request.agentId}?`,
              subtitle: preview,
              cancelId: "deny",
              onOpen: () => chrome.blurComposer(),
              signal: foregroundOperation.signal,
              options: [
                {
                  id: "allow",
                  label: `Allow ${request.agentId}`,
                  description: `Spends your ${request.agentId} subscription · sandbox ${request.sandbox ?? "read-only"}`,
                },
                { id: "deny", label: "Deny", description: "Do not start the external agent" },
              ],
            }),
          );
          input.focus();
          setMainAgent("running", id === "allow" ? "external" : "denied");
          return id === "allow"
            ? { ok: true }
            : { ok: false, reason: `you declined the external spawn of ${request.agentId}` };
        },
      });
      detachExternal = attached.detach;
      return attached.operator;
    })();
    // Deliberately NOT subscribed to for repaints. The sidebar rows come from
    // `sessions` (external children emit the same fleet upserts), and an
    // external run fires a store hint per transcript LINE — repainting on each
    // one destroys and recreates every row, which F-008 above records as able to
    // tear down a `TextRenderable` mid-click. The live transcript belongs in the
    // inspector, which subscribes to this store itself.
    /**
     * `/delegate <agent> <task>` (specification §8.2, prd R25).
     *
     * Parsing and every refusal sentence live in `agent-commands.ts` next to the
     * registry entry; this is only the dispatch. Fire-and-forget on purpose — an
     * external run has its own sidebar row and inspector, and awaiting it here
     * would block the composer for the length of a vendor run.
     */
    const runDelegate = (line: string): void => {
      const parsed = parseDelegateCommand(line.trim().replace(/^\/\S+\s*/, ""));
      if (!parsed.ok) {
        io.onSystem?.(`◇ ${parsed.reason}\n`);
        return;
      }
      io.onSystem?.(`◇ delegating to ${parsed.agentId}…\n`);
      void (async () => {
        const outcome = await external.delegate({ agentId: parsed.agentId, task: parsed.task });
        io.onSystem?.(
          outcome.ok
            ? `◇ ${parsed.agentId} ${outcome.result.status}: ${outcome.result.output}\n`
            : `◇ /delegate refused: ${outcome.reason}\n`,
        );
      })();
    };

    // Flow 273 (specification §5.1): the bus join's `status()` callback reads
    // these on every heartbeat/poll rather than re-deriving them — the SAME
    // status/detail the Activity panel and herdr already track, so the bus
    // presence record can never say something different from what the
    // operator's own sidebar shows.
    let lastMainAgentStatus: "queued" | "running" | "done" | "failed" | "blocked" = "queued";
    let lastMainAgentDetail: string | undefined;

    /** Update the pinned main-agent slot (Activity panel). */
    const setMainAgent = (
      status: "queued" | "running" | "done" | "failed" | "blocked",
      detail?: string,
    ): void => {
      debugEvent("main-agent", { status, detail });
      lastMainAgentStatus = status;
      lastMainAgentDetail = detail;
      fleet.upsert({
        id: MAIN_AGENT_ID,
        label: "main",
        status,
        ...(detail !== undefined ? { detail } : {}),
        model: `${currentSel.provider}/${currentSel.model}`,
      });
      herdr.report(herdrStateFor(status));
    };
    // Idle main agent visible from launch.
    setMainAgent("queued", "ready");

    const io = createTuiAgentIo(otui, r, transcript);
    // review r1 F10: now that `io` exists, the drop notifier can actually print.
    busDropNotifier = createBusDropNotifier((droppedTotal) => io.onSystem?.(busInboxFullNotice(droppedTotal)));
    // Cumulative token usage → the header counter + sidebar. Prefer the provider's
    // EXACT `usage`; fall back to an estimate (see the turn `finally` below) for
    // providers that report nothing (e.g. local Ollama models). `attachUsageIo`
    // WRAPS the base hook rather than replacing it, so the per-turn transcript
    // line survives alongside the cumulative counter (gap G-1 — the two answer
    // different questions).
    let hasExactUsage = false;
    const baseWrite = io.write.bind(io);
    const baseOnSystem = io.onSystem?.bind(io);
    // `setBusyPhase` / `setMainAgent` are both defined above, so the hooks below
    // close over live bindings rather than placeholders that get rewired later.

    // --- collapsible transcript blocks (flow 109) --------------------------
    // Reasoning, tool calls and tool results become addressable blocks that
    // RETAIN their full text (bounded — D-4) instead of discarding it, so they
    // can be expanded in place, navigated with the keyboard and copied.
    const blocks = createBlockRegistry({
      onEvict: (dropped) => {
        if (dropped.length === 1) {
          const kind = dropped[0]?.kind ?? "block";
          chrome.showToast(`Dropped oldest ${kind} output`);
          return;
        }
        chrome.showToast(`Dropped ${dropped.length} oldest outputs`);
      },
    });
    const blockMount = createBlockMount(otui, r, transcript, blocks);
    // The whole modal navigation mode (focus guard, key dispatch, sticky-scroll
    // suspension) lives in `transcript-blocks.ts` so it is reachable from a
    // headless test; the closure keeps only wiring (risk R5). Everything the
    // controller needs from the chrome — the menu/overlay guard, the composer,
    // the status repaint — is already mounted above.
    const nav = createBlockNavController({
      registry: blocks,
      view: (id) => blockMount.view(id),
      scroll: chrome.scroll,
      isBlocked: () => chrome.menuActive() || chrome.overlayActive(),
      focusComposer: () => input.focus(),
      blurComposer: () => chrome.blurComposer(),
      copyText: (text) => r.copyToClipboardOSC52(text),
      toast: (message) => chrome.showToast(message),
      onChange: () => chrome.repaintStatus(),
    });
    // Block-nav mode owns the footer hint even mid-turn: the chrome's 120ms
    // spinner interval would otherwise repaint over it.
    chrome.setFooterOverride(() => (nav.active() ? otui.t`${roleChunk(otui, "attention", FOOTER_NAV)}` : undefined));
    const focusComposer = (): void => nav.restoreComposerFocus();
    const newestBlock = (kind?: string): BlockState | undefined => nav.newest(kind);
    const toggleNewestBlock = (kind?: string): BlockState | undefined => nav.toggleNewest(kind);
    const copyBlock = (id: string): boolean => nav.copy(id);
    /**
     * `/copy` and `y` target the newest registered block (thought/tool/output).
     * A fenced code block embedded in the reply text has no registry entry of
     * its own, so with no block to copy this falls back to the last one shown —
     * the same block the segment header's `y copy` hint (`transcript-blocks.ts`)
     * is advertising.
     */
    const copyNewestOrLastCode = (): boolean => {
      const target = newestBlock();
      if (target !== undefined) {
        return copyBlock(target.id);
      }
      const code = io.lastCodeSegment();
      if (code === undefined) {
        return false;
      }
      try {
        r.copyToClipboardOSC52(code.body);
        chrome.showToast("Copied to clipboard");
        return true;
      } catch {
        return false; // clipboard access not permitted — ignore
      }
    };

    /** Register + render a new collapsed block at the end of the transcript. */
    const addBlock: BlockSink = (input, options = {}) => {
      const id = blockMount.add(input, options);
      nav.paint(id);
      return id;
    };

    io.write = (s: string) => {
      if (s.length > 0) {
        setBusyPhase("streaming reply");
        setMainAgent("running", "streaming");
      }
      baseWrite(s);
    };
    const usage = attachUsageIo(io, {
      setHeaderMeta: (text) => chrome.setHeaderMeta(text),
      setContextTotal: (total) => {
        sbContext.content = otui.t`${dimChunk(otui, `${total.toLocaleString()} tokens`)}`;
      },
      onExactUsage: () => {
        hasExactUsage = true;
      },
      setUsage: (input, output) => {
        sbUsageV.content = otui.t`${dimChunk(otui, `↑${fmtTokens(input)} ↓${fmtTokens(output)}`)}`;
      },
    });
    let lastUsage: NormalizedUsage | undefined;
    const recordedUsage = io.onUsage?.bind(io);
    io.onUsage = (usage) => {
      lastUsage = usage;
      recordedUsage?.(usage);
    };
    // Reasoning / tool call / tool result all render as collapsed BLOCKS whose
    // full text is retained (AC1). The event → block mapping itself lives in the
    // exported `attachBlockIo` (headlessly testable); the closure contributes
    // only the busy-phase / fleet chrome that needs these locals.
    const blockIo = attachBlockIo(
      io,
      addBlock,
      {
        // flow 268 T17 (AC16): fires on the round's FIRST reasoning delta —
        // the busy phase used to flip to "thinking" only once the whole
        // reasoning span had already ended (via the old `onReasoning`), so
        // the spinner/footer sat on a stale "waiting for model" phase for
        // the entire duration of a long reasoning round.
        onReasoningStart: () => {
          setBusyPhase("thinking");
          setMainAgent("running", "thinking");
        },
        // Reuses the EXISTING busy line (`startBusy`/`setBusyPhase` — see
        // `shell-chrome.ts`), which already ticks elapsed seconds via its own
        // timer and already renders in-transcript, rather than a second
        // renderable/timer pair. That line is a single row shared with the
        // footer, so the last-1-to-3-lines preview is joined onto ONE row
        // (" / "-separated) instead of wrapping across several — the
        // elapsed-seconds ticking and the "thinking…" phase are the part that
        // must reuse the existing line; the exact line layout is not.
        onReasoningPreview: (lines) => {
          if (lines === undefined || lines.length === 0) {
            setBusyPhase("thinking");
            return;
          }
          const joined = lines.join(" / ");
          const short = joined.length > 72 ? `${joined.slice(0, 69)}…` : joined;
          setBusyPhase(`thinking… ${short}`);
        },
        onToolCall: (name, toolInput) => {
          const args = summarizeToolArgs(toolInput);
          const short = args.length > 40 ? `${args.slice(0, 37)}…` : args;
          setBusyPhase(short.length > 0 ? `running ${name}(${short})` : `running ${name}`);
          // Keep tool names intact for humanFleetPhase ("tool: shell_exec").
          setMainAgent("running", name.length > 20 ? `${name.slice(0, 18)}…` : name);
        },
        onToolResult: (name, result) => {
          setBusyPhase(result.isError ? `tool error · waiting for model` : `waiting for model`);
          // Stay "running" between tools (multi-step turn); only terminal on turn end.
          setMainAgent("running", result.isError ? `err:${name.slice(0, 14)}` : "waiting");
        },
      },
      () => thinkDisplayMode,
    );
    io.onSystem = (text) => {
      // Surface budget/stop/errors on the main agent slot.
      if (/\[error\]|\[budget\]|\[stopped\]/i.test(text)) {
        setMainAgent("failed", text.includes("[budget]") ? "budget" : "error");
      }
      baseOnSystem?.(text);
    };

    // Approval gate: `shell_exec` (remembered patterns) + `spawn_subagent` (MAE).
    // Default-deny for shell on cancel; read_only subagents auto-approve.
    // The flow-041 advisory context (blast radius + memory note) is loaded through
    // this loader — the same information the readline shell shows above its prompt.
    const approvalContext = createApprovalContextLoader(opts.session?.cwd ?? process.cwd());
    // Flow 295 (AC6/AC7): the ONE confirmation dialog for a schedule — used by the
    // `schedule_create` tool's approval and by `/schedule`. Prints the card, then
    // offers exactly two choices; Esc/cancel is "no".
    const confirmScheduleCard = async (card: readonly string[]): Promise<boolean> => {
      for (const line of card) {
        transcript.add(new otui.TextRenderable(r, { id: `ap${uid++}`, content: otui.t`${roleChunk(otui, "attention", line)}` }));
      }
      chrome.hideMenu();
      setMainAgent("blocked", "approval");
      const id = await chrome.withOverlay(() =>
        showComposerChoice(otui, r, chrome.dock, {
          title: "Create this schedule and install its background timer?",
          subtitle: card[0] ?? "",
          cancelId: "cancel",
          onOpen: () => chrome.blurComposer(),
          signal: foregroundOperation.signal,
          options: [
            { id: "create", label: "Create and install", description: "Store it and install the timer shown above" },
            { id: "cancel", label: "Cancel", description: "Nothing is written or installed" },
          ],
        }),
      );
      input.focus();
      setMainAgent("running", id === "create" ? "schedule" : "denied");
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content:
            id === "create"
              ? otui.t`${roleChunk(otui, "ok", "◇ schedule confirmed")}`
              : otui.t`${roleChunk(otui, "error", "◇ schedule not created — nothing written or installed")}`,
        }),
      );
      return id === "create";
    };
    io.requestApproval = async (tool, inputJson, meta) => {
      if (meta?.untrustedOrigin === true) {
        // `agent.ts`'s untrusted-content gate asks the human instead of refusing
        // the call outright — this says why the operator is being asked.
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", "⚠ follows untrusted external content — it cannot authorize this call; your answer does")}`,
          }),
        );
      }

      // Flow 295 (AC6/AC7): an operator-confirmed call (schedule_create). The
      // card is printed verbatim, the only choices are yes/no, and the answer is
      // never remembered — no mode and no saved pattern answers it.
      if (meta?.alwaysAsk === true && meta.card !== undefined) {
        return confirmScheduleCard(meta.card);
      }

      // Multi-agent spawn: auto-allow read_only; ask for general.
      if (tool === "spawn_subagent") {
        let mode = "read_only";
        let taskPreview = inputJson;
        try {
          const parsed: unknown = JSON.parse(inputJson);
          if (parsed !== null && typeof parsed === "object") {
            const o = parsed as { mode?: unknown; task?: unknown; label?: unknown };
            if (o.mode === "general" || o.mode === "read_only") {
              mode = o.mode;
            }
            if (typeof o.task === "string") {
              taskPreview = o.task.length > 80 ? `${o.task.slice(0, 77)}…` : o.task;
            }
          }
        } catch {
          // raw
        }
        if (mode === "read_only") {
          // Auto-approved without a prompt, so the transcript line is the ONLY
          // record that a child was started and at what privilege. It is not
          // dimmed: an auto-approval the user cannot notice is an auto-approval
          // they cannot object to.
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${roleChunk(otui, "accent", "◇ subagent auto-approved")} ${dimChunk(otui, `mode=read_only (no shell) · ${taskPreview}`)}`,
            }),
          );
          return true;
        }
        chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
        setMainAgent("blocked", "approval");
        const id = await chrome.withOverlay(() =>
          showComposerChoice(otui, r, chrome.dock, {
            title: "Spawn general subagent?",
            subtitle: taskPreview,
            cancelId: "deny",
            onOpen: () => chrome.blurComposer(),
            signal: foregroundOperation.signal,
            options: [
              {
                id: "allow",
                label: "Allow subagent",
                description: "Run bounded child (still no shell in v1)",
                recommended: true,
              },
              { id: "deny", label: "Deny", description: "Do not spawn" },
            ],
          }),
        );
        input.focus();
        setMainAgent("running", id === "allow" ? "subagent" : "denied");
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content:
              id === "allow"
                ? otui.t`${roleChunk(otui, "ok", "◇ subagent approved")}`
                : otui.t`${roleChunk(otui, "error", "◇ subagent denied")}`,
          }),
        );
        return id === "allow";
      }

      if (tool === "apply_patch") {
        // ADR-0010/P2: render the actual diff, full — line classification
        // (`classifyDiffLine`) is the SAME pure function `renderDiff` uses in
        // the readline shell and in markdown diff-block rendering, so all
        // three surfaces color a patch identically and cannot drift.
        for (const line of extractPatchText(inputJson).split(/\r?\n/)) {
          const kind = classifyDiffLine(line);
          const rendered =
            kind === "add" ? roleChunk(otui, "ok", line)
            : kind === "del" ? roleChunk(otui, "error", line)
            : kind === "hunk" ? roleChunk(otui, "accent", line)
            : kind === "meta" ? dimChunk(otui, line)
            : line;
          transcript.add(new otui.TextRenderable(r, { id: `ap${uid++}`, content: otui.t`${rendered}` }));
        }
        if (meta?.destructive === true) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${roleChunk(otui, "attention", "deletes a file, touches .git/, or touches many files in one call")}`,
            }),
          );
        }
        if (meta?.credentials === true) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${roleChunk(otui, "attention", "touches the agent's own permission/credential files")}`,
            }),
          );
        }
        chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
        setMainAgent("blocked", "approval");
        const id = await chrome.withOverlay(() =>
          showComposerChoice(otui, r, chrome.dock, {
            title: "Approve apply_patch?",
            subtitle: "Diff shown above · Esc denies",
            cancelId: "deny",
            onOpen: () => chrome.blurComposer(),
            signal: foregroundOperation.signal,
            options: [
              { id: "allow", label: "Approve", description: "Write the patch to disk", recommended: true },
              { id: "deny", label: "Deny", description: "Do not write anything" },
            ],
          }),
        );
        input.focus();
        setMainAgent("running", id === "allow" ? "write" : "denied");
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content:
              id === "allow" ? otui.t`${roleChunk(otui, "ok", "◇ apply_patch approved")}` : otui.t`${roleChunk(otui, "error", "◇ apply_patch denied")}`,
          }),
        );
        return id === "allow";
      }

      if (isMcpToolCall(tool)) {
        // F-032, deferred from P0 to P2 by operator decision.
        //
        // `use_tool` fell through to `evaluateShellApproval` below, which
        // drew a third party's tool call as a SHELL COMMAND and offered
        // "Always allow" with an exact match. The reviewer established it
        // was not an approval bypass — auto-approve gates on
        // `!destructive`, and `use_tool` is unconditionally destructive —
        // but the permission store would then hold a grant pattern the
        // MODEL wrote.
        //
        // `apply_patch` above and the elicitation below each already had
        // their own branch. This is the one `use_tool` was missing, and
        // the description comes from the same module the readline shell
        // uses, so the two surfaces cannot drift.
        // Resolved against the catalog that will execute the call, so
        // the prompt's attribution and the dispatch cannot disagree.
        const described = describeUseToolApproval(
          inputJson,
          catalogResolver(deps.mcpRuntime?.()?.catalog()),
        );
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", `⚙ ${described.server} wants to run ${described.tool}`)}`,
          }),
        );
        for (const line of described.argumentLines) {
          transcript.add(new otui.TextRenderable(r, { id: `ap${uid++}`, content: otui.t`${dimChunk(otui, `  ${line}`)}` }));
        }
        if (described.argumentsTruncated) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${dimChunk(otui, `  … arguments truncated at ${MAX_ARGUMENT_CHARS} characters`)}`,
            }),
          );
        }
        chrome.hideMenu();
        setMainAgent("blocked", "approval");
        const id = await chrome.withOverlay(() =>
          showComposerChoice(otui, r, chrome.dock, {
            title: described.title,
            // Names the tool and the server and NOTHING the model supplied,
            // so no payload prefix can occupy the line read first.
            subtitle: summariseUseToolApproval(described),
            cancelId: "deny",
            onOpen: () => chrome.blurComposer(),
            signal: foregroundOperation.signal,
            options: [
              // No "always" option. `described.rememberable` is typed
              // `false` so this cannot be added back by forgetting to check.
              { id: APPROVAL_ALLOW_ID, label: "Approve", description: `run ${described.tool} on ${described.server}` },
              { id: "deny", label: "Deny", description: "the tool call is refused", recommended: true },
            ],
          }),
        );
        input.focus();
        // `isDockApproval`, not an inline `id === "allow"`, and not three
        // copies of it. A reviewer inverted this comparison — so "Deny"
        // approved — and the full suite stayed green.
        const allowed = isDockApproval(id);
        setMainAgent("running", allowed ? "write" : "denied");
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: allowed
              ? otui.t`${roleChunk(otui, "ok", `◇ ${described.fqn} approved`)}`
              : otui.t`${roleChunk(otui, "error", `◇ ${described.fqn} denied`)}`,
          }),
        );
        return allowed;
      }

      if (tool.startsWith(MCP_ELICITATION_TOOL_PREFIX)) {
        // T12 (specification.md §8): render the elicitation's own human-readable
        // `message` (and vendor command, when present) rather than falling
        // through to `evaluateShellApproval`, which would treat the raw
        // `{message, vendor}` JSON as a shell command and show it verbatim —
        // exactly the raw-escaped-JSON prompt this task exists to avoid.
        const described = describeElicitationPrompt(tool, inputJson) ?? { message: inputJson, command: undefined };
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", "⚙ codex is requesting approval")}`,
          }),
        );
        transcript.add(
          new otui.TextRenderable(r, { id: `ap${uid++}`, content: otui.t`${dimChunk(otui, described.message)}` }),
        );
        if (described.command !== undefined) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${dimChunk(otui, `command: ${described.command}`)}`,
            }),
          );
        }
        if (meta?.destructive === true) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${roleChunk(otui, "attention", "deletes a file, touches .git/, or touches many files in one call")}`,
            }),
          );
        }
        if (meta?.credentials === true) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${roleChunk(otui, "attention", "touches the agent's own permission/credential files")}`,
            }),
          );
        }
        chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
        setMainAgent("blocked", "approval");
        const elicitationSubtitle =
          described.message.length > 80 ? `${described.message.slice(0, 77)}…` : described.message;
        const id = await chrome.withOverlay(() =>
          showComposerChoice(otui, r, chrome.dock, {
            title: "Approve codex elicitation?",
            subtitle: elicitationSubtitle,
            cancelId: "deny",
            onOpen: () => chrome.blurComposer(),
            signal: foregroundOperation.signal,
            options: [
              { id: "allow", label: "Approve", description: "codex proceeds with this action", recommended: true },
              { id: "deny", label: "Deny", description: "codex's action is refused" },
            ],
          }),
        );
        input.focus();
        setMainAgent("running", id === "allow" ? "write" : "denied");
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content:
              id === "allow"
                ? otui.t`${roleChunk(otui, "ok", "◇ codex elicitation approved")}`
                : otui.t`${roleChunk(otui, "error", "◇ codex elicitation denied")}`,
          }),
        );
        return id === "allow";
      }

      const ev = evaluateShellApproval({
        inputJson,
        ...(meta !== undefined ? { meta } : {}),
        sessionAllow: sessionShellAllow,
        fingerprintAtStart: permissionsFingerprintAtStart,
      });
      const cmd = ev.command;
      const destructive = ev.destructive;
      if (!permissionMigrationShown && ev.rejected.length > 0) {
        permissionMigrationShown = true;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", 
              `⚠ ${ev.rejected.length} saved shell permission(s) are no longer honoured — they granted arbitrary execution:`,
            )}`,
          }),
        );
        for (const rej of ev.rejected) {
          transcript.add(
            new otui.TextRenderable(r, {
              id: `ap${uid++}`,
              content: otui.t`${dimChunk(otui, `    “${rej.pattern}” — ${rej.reason}`)}`,
            }),
          );
        }
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${dimChunk(otui, 
              `    They are still in ${shellPermissionsPath()} — edit or remove them there.`,
            )}`,
          }),
        );
      }
      if (!permissionTamperShown && ev.tampered) {
        permissionTamperShown = true;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${roleChunk(otui, "error", 
              "⚠ the saved shell permissions changed outside this approval UI — review them before trusting an auto-approve",
            )}`,
          }),
        );
      }
      if (ev.autoApprove) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `ap${uid++}`,
            content: otui.t`${dimChunk(otui, `✓ auto-approved shell: ${cmd}`)}`,
          }),
        );
        return true;
      }

      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content: otui.t`${roleChunk(otui, "attention", `⚙ shell_exec needs approval`)} ${dimChunk(otui, "(menu above input)")}`,
        }),
      );
      setMainAgent("blocked", "approval");
      setBusyPhase("waiting for your approval (menu above input)");
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
      const choice = await chrome.withOverlay(() =>
        pickShellApproval(
          otui,
          r,
          chrome.dock,
          cmd,
          approvalContext,
          destructive,
          meta?.credentials === true,
          {
            onOpen: () => chrome.blurComposer(),
            signal: foregroundOperation.signal,
          },
          // Flow 275 T7 (specification §4.4): never offer to remember while a
          // peer's `git-publish` lease applies to this command.
          ev.publishLease,
          // Flow 275 F1: name the lease's holder/reason in the title when resolved.
          ev.publishLeaseDetail,
        ),
      );
      input.focus();

      if (choice === "deny") {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content: otui.t`${roleChunk(otui, "error", "denied")}`,
          }),
        );
        setMainAgent("running", "denied");
        setBusyPhase("shell denied · continuing");
        return false;
      }

      if (choice === "always-exact" || choice === "always-prefix") {
        const { exact, prefix } = suggestShellPatterns(cmd);
        const pattern = choice === "always-exact" ? exact : prefix;
        // Refused grants return "" — the command still runs this once, but the
        // transcript must never claim a grant that was not stored.
        const stored = allowShellPattern(pattern);
        if (stored.length > 0) {
          sessionShellAllow.add(stored);
          permissionsFingerprintAtStart = shellPermissionsFingerprint();
        }
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content:
              stored.length > 0
                ? otui.t`${roleChunk(otui, "ok", `approved · remembered “${stored}”`)}`
                : otui.t`${roleChunk(otui, "attention", `approved once · “${pattern}” cannot be remembered`)}`,
          }),
        );
        setMainAgent("running", "shell");
        setBusyPhase("running approved shell");
        return true;
      }

      // once
      transcript.add(
        new otui.TextRenderable(r, {
          id: `av${uid++}`,
          content: otui.t`${roleChunk(otui, "ok", "approved (once)")}`,
        }),
      );
      setMainAgent("running", "shell");
      setBusyPhase("running approved shell");
      return true;
    };

    /** Host for ask_user — Claude-style options docked above the composer. */
    const askUserInteractive = async (req: {
      question: string;
      options: Array<{ id: string; label: string; description: string; recommended?: boolean }>;
    }): Promise<string> => {
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
      setMainAgent("blocked", "ask");
      setBusyPhase("waiting for your answer (menu above input)");
      // Keep a short transcript breadcrumb; the interactive picker is at the input.
      const qShort = req.question.length > 100 ? `${req.question.slice(0, 97)}…` : req.question;
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ask${uid++}`,
          content: otui.t`${roleChunk(otui, "attention", "? ")} ${dimChunk(otui, qShort)}`,
        }),
      );
      const chosen = await chrome.withOverlay(() =>
        showComposerChoice(otui, r, chrome.dock, {
          title: req.question.length > 72 ? `${req.question.slice(0, 69)}…` : req.question,
          subtitle: "Pick an option · Esc cancels",
          cancelId: "__cancel__",
          onOpen: () => chrome.blurComposer(),
          signal: foregroundOperation.signal,
          options: req.options.map(
            (o): ChoiceOption => ({
              id: o.id,
              label: o.label,
              description: o.description.length > 0 ? o.description : " ",
              ...(o.recommended === true ? { recommended: true } : {}),
            }),
          ),
        }),
      );
      input.focus();
      if (chosen !== "__cancel__") {
        const picked = req.options.find((o) => o.id === chosen);
        transcript.add(
          new otui.TextRenderable(r, {
            id: `aska${uid++}`,
            content: otui.t`${roleChunk(otui, "ok", "→")} ${dimChunk(otui, picked?.label ?? chosen)}`,
          }),
        );
      } else {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `askc${uid++}`,
            content: otui.t`${dimChunk(otui, "→ cancelled")}`,
          }),
        );
      }
      setMainAgent("running", "waiting");
      return chosen;
    };
    setAskUserHost(askUserInteractive);

    // `/help` wraps to the transcript's text width (AC9): the main column (or,
    // before its first layout, the terminal less the sidebar) minus the
    // transcript's left/right padding, its scrollbar and one spare column.
    const TRANSCRIPT_CHROME_COLS = 4;
    const HELP_MIN_COLS = 40;
    const helpText = (): string => {
      const mainWidth = chrome.main.width > 0 ? chrome.main.width : r.width - SIDEBAR_WIDTH;
      return renderCommandHelp("agent", undefined, Math.max(HELP_MIN_COLS, mainWidth - TRANSCRIPT_CHROME_COLS));
    };
    // Flow 303 (AC6): `/help` opens the grouped, tabbed modal — one tab per
    // onboarding group, ↑/↓ selects a command, Enter shows its detail, ←/→
    // and Esc are `modal-host.ts`'s own. `initialGroupSlug` lets AC8's
    // first-run wiring (below) open straight to "Connect a model provider".
    const openHelp = (initialGroupSlug?: string): void => {
      openHelpModal(otui, chrome, {
        onKeypress: (handler) => onKeypress(r, (key) => handler(key)),
        inputBlocked: () => chrome.keyboardOwnedElsewhere(),
        ...(initialGroupSlug !== undefined ? { initialGroupSlug } : {}),
      });
    };

    // Flow 303 (AC8): first-run onboarding. Opens `/help` on the "Connect a
    // model provider" tab exactly once — only when no provider is connected
    // yet — and never again. `alreadyShown` short-circuits the (network-
    // touching) connected-provider check on every later launch;
    // `shouldOpenFirstRunHelp` itself is the pure decision (see its own
    // tests for both cases AC8 names).
    const alreadyShownFirstRunHelp = helpFirstRunShown();
    const connectedProviders = alreadyShownFirstRunHelp
      ? []
      : await filterConnectedDetectedProviders(opts.detected, { env: process.env });
    if (shouldOpenFirstRunHelp(alreadyShownFirstRunHelp, connectedProviders.length)) {
      markHelpFirstRunShown();
      openHelp("connect");
    }

    // --- Per-project session (isolated by git root / cwd) --------------------
    const sessionCwd = opts.session?.cwd ?? process.cwd();

    // Fallback chain: CLI flag > this project's stored default > the global
    // default (`ask`, unchanged behavior for anyone who never opts in) —
    // parity with `runAgentRepl` in `commands/shell.ts`. `/mode` below only
    // ever reassigns the `let`, never re-derives this chain.
    let permissionMode: PermissionMode =
      opts.initialPermissionMode ?? getProjectPermissionMode(sessionCwd) ?? DEFAULT_PERMISSION_MODE;
    io.permissionMode = () => permissionMode;
    // Read-only ("plan") posture — orthogonal to `permissionMode` (see
    // `permission-mode.ts`'s `ApprovalGateInput.readOnly` docstring). Never
    // persisted; every session starts `false`, toggled only by `/plan [on|off]`.
    let readOnly = false;
    io.readOnly = () => readOnly;
    const paintModeRow = (): void => {
      const row = describeModeRow(permissionMode, readOnly);
      // Read-only is the state an operator must not forget they are in.
      sbModeV.content = row.readOnly === undefined
        ? otui.t`${dimChunk(otui, `mode ${row.mode}`)}`
        : otui.t`${dimChunk(otui, `mode ${row.mode}`)} ${roleChunk(otui, "attention", row.readOnly)}`;
    };
    paintModeRow();
    io.onAutoApproved = (tool, input, meta) => {
      // NOT dimmed — same principle as the read_only subagent auto-approval
      // above: a mode-driven auto-approval was never okayed action-by-action,
      // only the mode itself was chosen, once, so the transcript line is the
      // only record of it.
      const preview = tool === "shell_exec" ? parseShellExecCommand(input) : tool;
      // `meta.credentials` never reaches here — resolveApprovalDecision's hard
      // floor means a credentials-touching call is never `auto`, in any mode.
      const label = meta.destructive
        ? `◇ auto-approved (${permissionMode}) [destructive]`
        : `◇ auto-approved (${permissionMode})`;
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content: otui.t`${roleChunk(otui, "attention", label)} ${dimChunk(otui, preview)}`,
        }),
      );
    };

    // Definite assignment: every control-flow path calls `applyOpened` before
    // paint/save; `!` satisfies TS2454 (assignments inside nested closures are
    // invisible to control-flow analysis).
    let liveSession!: SessionHandle;
    let history: NormalizedMessage[] = [];
    let archive: NormalizedMessage[] = [];
    let nextArchiveIndex = 0;
    let sessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * SLATE-5 open/close wiring (parity with `runAgentRepl` in
     * `src/commands/shell.ts`) — a fresh, never-opened ref per live session
     * dir, reassigned on every session switch through `bindSlateToLiveSession`.
     * The TUI always has a live session (no sessions-off path here, unlike the
     * REPL), so this is unconditional once `liveSession` is set below.
     */
    const bindSlateToLiveSession = (): void => {
      slateSession = freshSlateSessionRef(liveSession.dir, sessionCwd);
      void executionPlanPanel.refresh();
    };

    /**
     * Flow 267: `agent.ts`'s round-loop guard already ran `compactMessages`
     * itself and spliced the result into `history` IN PLACE before this
     * fires (see `AgentDeps.onContextCompaction`'s doc comment) — this
     * mirrors the `/compact` command handler further below: persist the SAME
     * bookkeeping (`compactCount`, `archive.jsonl`, `context.jsonl`) via
     * `persistCompacted` (the extracted core `compactSession` itself now
     * calls) rather than running compaction a second time, then reset
     * `nextArchiveIndex` so later turns keep syncing `archive` from the new,
     * shorter `history`. A system-stream line replaces a silent swap so the
     * operator sees WHY the transcript just shrank.
     */
    const onContextCompaction = (r: { removed: number; context: NormalizedMessage[]; estimate: number }): void => {
      if (!sessionLease.canPersist()) {
        return; // review F1: another shell has this session now
      }
      const persisted = persistCompacted(liveSession, r.context, archive, {
        provider: currentSel.provider,
        model: currentSel.model,
      });
      liveSession = persisted.handle;
      nextArchiveIndex = history.length;
      paintSessionHeader();
      io.onSystem?.(`context 85% of window — compacted ${r.removed} messages\n`);
    };
    // Flow 267: attach the callback above to the deps this session already
    // built (`onContextCompaction` needs `history`/`archive`/`liveSession`,
    // declared above it — a plain reassignment here, not a merge at the
    // original `makeAgentDeps` call site, which runs before those exist).
    deps = { ...deps, onContextCompaction };
    liveDeps = deps;

    /**
     * The empty-transcript wordmark's lifecycle (flow 270 AC10; flow 277 P2:
     * `createSplashLifecycle`, `./boot-animation.ts`). Assigned once, right
     * after the startup session's history length is known (below); every
     * call to `applyOpened` above that point (during startup) is a safe
     * no-op through the optional chain, exactly as the bare
     * `removeSplash?.()` this replaced was before its own assignment.
     */
    let splash: SplashLifecycle | undefined = undefined;

    const applyOpened = (
      opened: {
        handle: SessionHandle;
        history: NormalizedMessage[];
        archive: NormalizedMessage[];
        resumed: boolean;
      },
      previewHistory?: boolean,
    ): void => {
      if (opened.history.length > 0) {
        splash?.removeIfShown();
      }
      liveSession = opened.handle;
      history = previewHistory === true ? opened.history.slice(-SESSION_PREVIEW_MESSAGE_COUNT) : opened.history;
      archive = opened.archive.length > 0 ? [...opened.archive] : [...opened.history];
      nextArchiveIndex = history.length;
      // Flow 273 (specification §6.2, AC8): every path that lands here — the
      // startup picker (fork/view/cancel included) and `/resume` — is a live
      // session switch. Undefined before the bus has joined (every startup
      // call), so this is a safe no-op until then.
      void liveBus?.setSession(opened.handle.summary.id).catch(() => {}); // review r1 F10: setSession never throws, but never trust that from the call site either
    };

    const pickRecentSession = async (): Promise<SessionSummary | undefined> => {
      const rows = listSessions(sessionCwd);
      if (rows.length === 0) {
        io.onSystem?.("No saved sessions in this project.\n");
        return undefined;
      }
      chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
      const pickId = await chrome.withOverlay(() => pickSessionInTui(otui, chrome, rows, leaseState));
      input.focus();
      if (pickId === undefined) {
        return undefined;
      }
      const found = findSession(sessionCwd, pickId);
      if (found === undefined) {
        io.onSystem?.("Session not found in this project.\n");
        return undefined;
      }
      return found;
    };

    // Flow 271 (specification §6.1, §6.2): every open is leased, through the one
    // holder. `switchTo` takes the target's lease first and only then releases
    // the current one, so a refused target leaves the current session held.
    const leasedOpen = (
      target: { continueLast?: boolean; resumeId?: string; fork?: boolean; takeOver?: boolean } = {},
    ): ReturnType<typeof openLeasedSession> =>
      sessionLease.switchTo(() =>
        openLeasedSession({
          cwd: sessionCwd,
          ...target,
          provider: currentSel.provider,
          model: currentSel.model,
        }),
      );
    // `● live` / `◌ stale` on the picker rows (AC4).
    const leaseState = leaseStateLookup(sessionCwd);

    /** The transcript lines an opened session announces: skipped, degraded, resumed. */
    const showOpenedNotes = (opened: ReturnType<typeof openLeasedSession>): void => {
      if (opened.skipped !== undefined) {
        // `-c` passed over a session another shell holds (§6.1, AC1).
        transcript.add(
          new otui.TextRenderable(r, {
            id: `sessskip${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", describeSkippedSession(opened.skipped).replace(/\n+$/, ""))}`,
            marginTop: 1,
          }),
        );
      }
      if (opened.archiveDegraded !== undefined) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `sessdeg${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", `archive unavailable — resumed from the active context (${opened.archiveDegraded})`)}`,
            marginTop: 1,
          }),
        );
      }
      if (opened.resumed) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `sess${uid++}`,
            content: otui.t`${dimChunk(otui, 
              `session ${shortSessionId(liveSession.summary.id)} · ${liveSession.summary.title} · ctx ${history.length} · archive ${archive.length}`,
            )}`,
            marginTop: 1,
          }),
        );
        for (const m of history.filter((x) => x.role === "user").slice(-5)) {
          const t = m.content.length > 100 ? `${m.content.slice(0, 97)}…` : m.content;
          transcript.add(
            new otui.TextRenderable(r, {
              id: `sessu${uid++}`,
              content: otui.t`${dimChunk(otui, `  ❯ ${t}`)}`,
            }),
          );
        }
      }
    };

    /** Set when the operator cancels at the held-session choice: no session is opened. */
    let startupCancelled = false;
    /** Set when "view" rendered a held session read-only; the splash would cover it. */
    let viewedReadOnly = false;
    try {
      if (opts.session?.pickOnStart === true && opts.session.resumeId === undefined) {
        const rows = listSessions(sessionCwd).slice(0, 12);
        if (rows.length === 0) {
          applyOpened(leasedOpen());
        } else {
          chrome.hideMenu(); // hide the dropdown AND release menuNav before the dock takes over
          const pickId = await showComposerChoice(otui, r, chrome.dock, {
            title: "Resume session (this project)",
            subtitle: "Esc = new session",
            cancelId: "__new__",
            options: startupSessionChoices(rows, leaseState),
          });
          input.focus();
          if (pickId === "__new__") {
            applyOpened(leasedOpen());
          } else {
            // A held pick throws `SessionLeasedError`: the catch below offers the choice.
            const opened = leasedOpen({ resumeId: pickId });
            applyOpened(opened);
            showOpenedNotes(opened);
          }
        }
      } else {
        const opened = leasedOpen({
          ...(opts.session?.continueLast === true ? { continueLast: true } : {}),
          ...(opts.session?.resumeId !== undefined ? { resumeId: opts.session.resumeId } : {}),
          ...(opts.session?.fork === true ? { fork: true } : {}),
          ...(opts.session?.takeOver === true ? { takeOver: true } : {}),
        });
        applyOpened(opened);
        showOpenedNotes(opened);
      }
    } catch (cause) {
      let failure: unknown = cause;
      if (cause instanceof SessionLeasedError) {
        // Another shell holds the session (§6.1, AC3): fork (default), view,
        // cancel, and take over only when the holder is stale. Never a silent
        // new session.
        try {
          const outcome = await resolveLeasedStartup(cause, {
            choose: async (error) => {
              chrome.hideMenu();
              const id = await showComposerChoice(otui, r, chrome.dock, leasedChoiceRequest(error));
              input.focus();
              return toLeasedChoice(error, id);
            },
            open: (target) => leasedOpen(target),
            exportSession: (sessionId) => exportSessionMarkdown(sessionCwd, sessionId),
            showReadOnly: (markdown) => {
              viewedReadOnly = true;
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `sessview${uid++}`,
                  content: otui.t`${dimChunk(otui, `${markdown.replace(/\n+$/, "")}\n\n— read-only view; a new session starts below —`)}`,
                  marginTop: 1,
                }),
              );
            },
            notice: (text) => {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `sesslease${uid++}`,
                  content: otui.t`${roleChunk(otui, "attention", text)}`,
                  marginTop: 1,
                }),
              );
            },
          });
          if (outcome.kind === "cancelled") {
            startupCancelled = true;
          } else {
            applyOpened(outcome.opened);
            showOpenedNotes(outcome.opened);
          }
          failure = undefined;
        } catch (leaseCause) {
          failure = leaseCause;
        }
      }
      if (failure !== undefined) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `sesserr${uid++}`,
            content: otui.t`${roleChunk(otui, "error", failure instanceof Error ? failure.message : String(failure))}`,
            marginTop: 1,
          }),
        );
        applyOpened(leasedOpen());
      }
    }
    if (startupCancelled) {
      // Cancel exits cleanly without opening any session (AC3): the same
      // teardown `/exit` performs, with nothing to save or release.
      r.off("theme_mode", onThemeMode);
      r.destroy();
      await done;
      return true;
    }
    bindSlateToLiveSession();
    splash = createSplashLifecycle({
      mount: () => mountEmptyTranscriptSplash(otui, r, transcript),
      initialHistoryLength: history.length,
    });
    /**
     * A STARTUP notice that belongs to the splash while one is up.
     *
     * On a genuinely empty transcript a system line added to the transcript is
     * full-width by construction, so it can never be centred there and lands
     * flush left under the wordmark — the reported defect. `addStatusIfShown`
     * paints it inside the splash instead, and reports `false` when there is no
     * splash (the session opened with history, or the first operator line
     * already tore it down), in which case the ordinary transcript line IS the
     * right home for it. Used for the startup notices only: a mid-session
     * message has a transcript to belong to.
     */
    const announceStartupNotice = (text: string): void => {
      if (splash?.addStatusIfShown(text) !== true) {
        io.onSystem?.(`${text}\n`);
      }
    };
    if (viewedReadOnly) {
      // The wordmark would sit under the read-only view it just rendered.
      splash.removeIfShown();
    }
    void refreshWorkspaceSidebar(); // resumed session may already have a bound workspace
    void refreshReviewSidebar(); // project-wide, independent of this session's own workspace

    // Flow 273 (agent bus P2, T7; specification §5.1): join right after the
    // leased startup open succeeds. Fire-and-forget, like the two sidebar
    // refreshes above — a bus error must never break the TUI (`joinBus`
    // itself never throws; this `catch` is only for something failing before
    // that, e.g. resolving the bus root).
    void (async () => {
      try {
        // Flow 277 (P2): the onEvent/onPeers bodies used to be inline here,
        // pinned by `tui-bus.test.ts` slicing this file's text into windows
        // and comparing character offsets (see
        // docs/requirements/keryx-shell-split/audits-tui-other.md, "flow 274
        // T7 — TUI bus delivery wiring"). `buildBusJoinCallbacks`
        // (`./bus-join.ts`) is that logic, unit-tested directly in
        // `bus-join.test.ts` against fake deps — every field below is a
        // function so the callbacks still read the CURRENT value of each
        // mutable local (e.g. `busWakeController`, assigned only much later
        // in this closure) exactly as the inline version did.
        const { onEvent, onPeers } = buildBusJoinCallbacks({
          isDestroyed: () => destroyed,
          onSystemLine: (line) => io.onSystem?.(line),
          pushToInbox: (event) => busInbox.push(event),
          markDelivered: () => {
            busPollDeliveredEvent = true;
          },
          setFleetPeers: (peers) => {
            busFleetPeers = peers;
          },
          paintFleet,
          onInboxSizeObserved: () => busDropNotifier.onInboxSizeObserved(busInbox.size),
          paintHoldBanner,
          onLeaseHoldPoll: () => leaseHoldController?.onPoll(),
          onBusWakePoll: (delivered) => busWakeController?.onPoll(delivered),
          getDelivered: () => busPollDeliveredEvent,
          resetDelivered: () => {
            busPollDeliveredEvent = false;
          },
        });
        const joined = await joinBus({
          cwd: sessionCwd,
          sessionId: liveSession.summary.id,
          surface: "tui",
          ...(opts.session?.busName !== undefined ? { requestedName: opts.session.busName } : {}),
          shellConfig: loadShellConfig(),
          env: process.env,
          // review r1 F2: a getter, read at every use (join, each heartbeat,
          // `rename`, `setSession`) — never a value captured once. `/new`
          // swaps `sessionLease.current` to a fresh lease handle; a captured
          // value would keep refreshing the OLD, already-released one and
          // leave the new lease's name null forever.
          sessionLease: () => sessionLease.current,
          status: () => ({
            status: herdrStateFor(lastMainAgentStatus),
            activity: lastMainAgentDetail ?? liveSession.summary.title,
          }),
          onError: makeBusErrorReporter((line) => io.onSystem?.(`${line}\n`)),
          onEvent,
          onPeers,
        });
        if ("disabled" in joined) {
          announceStartupNotice(`bus: off (${joined.disabled})`);
          return;
        }
        // review r1 F6: `decideJoinAdoption` (`./bus-join.ts`) is the pure
        // decision — Ctrl+C landing while this join was still in flight must
        // leave the resolved client immediately rather than adopt it for a
        // renderer that is already gone. The `disabled` branch above already
        // returned, so `disabled: false` here always reflects that.
        if (decideJoinAdoption({ destroyed, disabled: false }) === "leave") {
          joined.leave();
          return;
        }
        liveBus = joined;
        // review r1 F6/F10: a session switch (`/new`, `/resume`, the startup
        // picker) that lands DURING this await calls `liveBus?.setSession`
        // while `liveBus` is still undefined — a safe no-op at the time, but
        // one that leaves the freshly-joined client on its ORIGINAL
        // `sessionId` forever unless it is resynced here, right after
        // `liveBus` is finally assigned, so the switch history lands.
        void joined.setSession(liveSession.summary.id).catch(() => {});
        const renamedNote = joined.nameWasTaken ? " (requested name was taken; renamed)" : "";
        // See `announceStartupNotice`: on an empty transcript this lands inside
        // the splash, centred with the wordmark.
        announceStartupNotice(`bus: joined as @${joined.name} · ${joined.peers().length} peers${renamedNote}`);
        // Flow 274 (agent bus P3, T6/T7 contract): the FIRST `makeAgentDeps`
        // call (well above) necessarily ran before this join settled, so its
        // `busClientRef.client()` read `undefined` and its `systemInstruction`/
        // `tools` cannot yet name `bus_list`/`bus_send` or the conduct block
        // (`AgentInstructionContext.busJoined`). One rebuild, right here,
        // right after the join actually succeeds, folds those in — the same
        // full-rebuild shape `/model`/`/connect` already use below, so a
        // turn already in flight keeps running against the OLD `deps` object
        // (this only replaces the closed-over reference for the NEXT turn).
        //
        // review r1 F7: `currentSel` is captured BEFORE this await as
        // `selAtJoin`, and re-read AFTER it resolves. `switchTo` (below)
        // reassigns `currentSel` synchronously, before its own await, so a
        // `/model`/`/connect` that lands while THIS call is in flight can
        // finish first and set `deps` to the NEW selection's build. Replacing
        // `deps` wholesale here — built for the OLD `selAtJoin` — would
        // silently revert that switch. When a concurrent switch is detected,
        // only `busInbox`/`busAck` are folded onto whatever `deps` currently
        // is; the provider/tools this call resolved for the now-superseded
        // selection are discarded.
        const selAtJoin = currentSel;
        const joinedAgentDeps = await opts.makeAgentDeps(selAtJoin, liveSlateSession, busClientRef);
        deps =
          currentSel === selAtJoin
            ? {
                ...joinedAgentDeps,
                onContextCompaction,
                busInbox,
                busAck: (events) => joined.ack(events),
                // Flow 275 T7 (specification §4.4, agent-protocol.md §2): the
                // SAME live lease view the hold/banner logic reads, so the
                // agent's own `publishLease` gate (T6, `commands/agent.ts`)
                // sees the identical state as the operator surface.
                busLeases: busLeasesFromClient(joined),
              }
            : {
                // A concurrent `/model`/`/connect` already replaced `deps` —
                // keep its provider/tools, only fold the bus wiring on.
                ...deps,
                busInbox,
                busAck: (events) => joined.ack(events),
                busLeases: busLeasesFromClient(joined),
              };
        liveDeps = deps;
      } catch (error) {
        announceStartupNotice(`bus: off (${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    const paintSessionHeader = (): void => {
      const label = `${currentSel.provider}/${currentSel.model}`;
      const sid = shortSessionId(liveSession.summary.id);
      const title =
        liveSession.summary.title.length > 24
          ? `${liveSession.summary.title.slice(0, 21)}…`
          : liveSession.summary.title;
      const cx = liveSession.summary.compactCount > 0 ? ` · c×${liveSession.summary.compactCount}` : "";
      chrome.setTitle(`keryx · ${title} · ${sid}${cx} · ${label}`);
    };

    // Review F1: the one guard in front of every session write in this shell
    // (`saveSession`, both compactions). Once another shell takes the lease,
    // nothing more is written here, the slate ref is dropped (so tools record
    // no slate touches into the session), and the operator is told once.
    sessionLease.onLost((message) => {
      // Flow 271 R3-1: detach the ref itself, not only this variable. A turn or
      // a `/goal --auto` loop that is already running holds the same object,
      // and every slate write through a detached ref refuses.
      detachSlateSession(slateSession);
      slateSession = undefined;
      if (sessionPersistTimer !== undefined) {
        clearTimeout(sessionPersistTimer);
        sessionPersistTimer = undefined;
      }
      io.onSystem?.(message);
    });
    const saveSession = (): void => {
      if (!sessionLease.canPersist()) {
        return;
      }
      liveSession = persistHistory(liveSession, history, {
        archive,
        provider: currentSel.provider,
        model: currentSel.model,
      });
      paintSessionHeader();
    };

    const syncArchive = (): void => {
      while (nextArchiveIndex < history.length) {
        const message = history[nextArchiveIndex];
        if (message !== undefined) {
          archive.push(message);
        }
        nextArchiveIndex += 1;
      }
    };
    const flushSessionCheckpoint = (): void => {
      if (sessionPersistTimer !== undefined) {
        clearTimeout(sessionPersistTimer);
        sessionPersistTimer = undefined;
      }
      syncArchive();
      saveSession();
    };
    io.onHistoryChange = (kind) => {
      syncArchive();
      if (kind === "assistant_delta") {
        if (sessionPersistTimer === undefined) {
          sessionPersistTimer = setTimeout(() => {
            sessionPersistTimer = undefined;
            saveSession();
          }, 300);
        }
        return;
      }
      flushSessionCheckpoint();
    };
    const resetSessionSurface = (): void => {
      nav.exit();
      chrome.stopBusy();
      io.resetStream();
      blockMount.clear();
      clearTranscriptChildren(transcript);
      chrome.scroll.scrollTop = 0;
      chrome.scroll.stickyScroll = true;
      fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID);
      setMainAgent("queued", "ready");
      hasExactUsage = false;
      lastUsage = undefined;
      usage.resetUsage();
    };

    /**
     * `/new` and `/clear`: a fresh leased session (flow 271, §6.2). The new
     * session's lease is taken before the current one is released; if the open
     * fails, the current session stays open and held, and this returns false.
     */
    const startNewSession = (note?: string): boolean => {
      let opened: ReturnType<typeof openLeasedSession>;
      try {
        opened = leasedOpen();
      } catch (cause) {
        io.onSystem?.(
          `Could not start a new session: ${cause instanceof Error ? cause.message : String(cause)}\n` +
            `Staying in the current session.\n`,
        );
        return false;
      }
      resetSessionSurface();
      liveSession = opened.handle;
      history = [];
      archive = [];
      nextArchiveIndex = 0;
      // Flow 273 (specification §6.2, AC8): `/new` and `/clear` switch the
      // live session outside `applyOpened` (they reset the whole transcript
      // surface instead), so this is its own hook.
      void liveBus?.setSession(liveSession.summary.id).catch(() => {}); // review r1 F10
      paintSessionHeader();
      if (note !== undefined && note.length > 0) {
        io.onSystem?.(`${note}\n`);
      }
      return true;
    };

    const resumeSessionInteractive = async (): Promise<void> => {
      const found = await pickRecentSession();
      if (found === undefined) {
        return;
      }
      // Guarded, and deliberately NOT by falling back to a new session the way
      // the startup path does. The operator asked to resume a specific session;
      // losing the live one as a side effect of that request would be a second
      // failure on top of the first. Unguarded, the throw escaped an async
      // handler with no rejection boundary.
      //
      // Flow 271 (§6.2, AC6): the target's lease is taken before the current
      // one is released. A session another shell holds is refused here with the
      // lease error, which names the holder and `--fork`; the current session
      // and its lease stay exactly as they were.
      let opened: ReturnType<typeof openLeasedSession>;
      try {
        opened = leasedOpen({ resumeId: found.id });
      } catch (cause) {
        const hint =
          cause instanceof SessionLeasedError
            ? `To continue it in this shell, start one with: keryx shell -r ${shortSessionId(found.id)} --fork\n`
            : "";
        io.onSystem?.(
          `Could not resume ${shortSessionId(found.id)}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
            hint +
            `Staying in the current session.\n`,
        );
        return;
      }
      applyOpened(opened, true);
      // The previous session's slate is left as it is, not closed: this
      // switch has already moved off it, and an unclosed slate is archived
      // the next time that session opens one (see `freshSlateSessionRef`).
      bindSlateToLiveSession();
      // After the rebind: it reads the bound workspace from the slate ref.
      void refreshWorkspaceSidebar(); // resumed session may already have a bound workspace
      paintSessionHeader();
      if (opened.archiveDegraded !== undefined) {
        io.onSystem?.(`Archive unavailable — resumed from the active context (${opened.archiveDegraded})\n`);
      }
      io.onSystem?.(
        `Resumed ${shortSessionId(liveSession.summary.id)} · ${liveSession.summary.title} (ctx ${history.length} · archive ${archive.length})\n`,
      );
    };

    paintSessionHeader();

    const inspectorKeys = { onKeypress: (handler: (key: { name: string; sequence: string }) => void) => onKeypress(r, (key) => handler(key)) };
    const inspectorCwd = (): string => opts.session?.cwd ?? liveSession.summary.projectPath;
    const showSessionInfo = (): void => {
      void (async () => {
        const cwd = inspectorCwd();
        const [workspaces, flows] = await Promise.all([loadInspectorWorkspaces(cwd), loadInspectorFlows(cwd)]);
        const limits = await loadSessionLimits({
          provider: currentSel.provider,
          model: currentSel.model,
          ...(currentSel.baseUrl !== undefined ? { baseUrl: currentSel.baseUrl } : {}),
        });
        const snapshot = buildSessionInfoSnapshot({
          summary: liveSession.summary,
          selection: currentSel,
          version: packageJson.version,
          usage: lastUsage,
          estimateTokens: estimateContextTokens(history),
          limits,
          sessionText: history.map((message) => message.content).join("\n"),
          workspaces,
          flows,
        });
        openSessionInfo(otui, chrome, {
          snapshot,
          copyText: (text) => r.copyToClipboardOSC52(text),
          toast: (message) => chrome.showToast(message),
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    const showFlows = (): void => {
      void (async () => {
        const items = await loadInspectorFlows(inspectorCwd());
        openFlows(otui, chrome, {
          items,
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    const showGame = (line: string): void => {
      const timeoutMatch = /\/game\s+(\d+)/.exec(line);
      openGamesModal(otui, chrome, {
        renderer: r,
        ...inspectorKeys,
        ...(timeoutMatch !== null ? { timeoutMs: Math.max(1, Number(timeoutMatch[1])) * 1000 } : {}),
      });
    };
    const showWorkspace = (): void => {
      void (async () => {
        const dir = liveSlateSession()?.dir;
        const workspaceId = dir !== undefined ? (await readSlate(dir).catch(() => undefined))?.workspaceId : undefined;
        if (workspaceId === undefined) {
          io.onSystem?.("No workspace bound to this session yet — the agent binds one automatically on its first real task.\n");
          return;
        }
        const cwd = inspectorCwd();
        const [workspace, slates] = await Promise.all([
          loadInspectorWorkspace(cwd, workspaceId),
          loadInspectorSlates(cwd, workspaceId),
        ]);
        if (workspace === undefined) {
          io.onSystem?.(`Workspace ${workspaceId} could not be loaded.\n`);
          return;
        }
        openWorkspace(otui, chrome, {
          workspace,
          slates,
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    const showReview = (): void => {
      void (async () => {
        const cwd = inspectorCwd();
        const items = catchUpItems(await loadInspectorCatchUp(cwd));
        openReview(otui, chrome, {
          items,
          acceptProposal: (item) => acceptProposalViaShell(makeCommandRunner(cwd), item.workspaceId, item.proposalId),
          // `[s]`: the same accept, minted with `--acknowledge-security`. Without
          // it a `needs-approval` proposal (evidence that tripped the scanner)
          // could never be accepted from this modal at all, and with it wired
          // automatically Accept would silently acknowledge findings nobody read.
          acceptProposalWithAcknowledgement: (item) => acceptProposalViaShell(makeCommandRunner(cwd), item.workspaceId, item.proposalId, { acknowledgeSecurity: true }),
          declineProposal: (item) => declineProposalViaShell(makeCommandRunner(cwd), item.workspaceId, item.proposalId),
          onResolved: () => {
            void refreshReviewSidebar();
          },
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    /** `/bus` with no arguments (specification §7.2): Peers/Leases/Log, a snapshot taken at open time. */
    const showBus = (): void => {
      if (liveBus === undefined) {
        io.onSystem?.("bus: off (not joined)\n");
        return;
      }
      const client = liveBus;
      void (async () => {
        try {
          const now = Date.now();
          const presence = await listPresence(client.root);
          const leases = await listActiveLeases(client.root, { now, holderLiveness: holderLivenessFrom(presence, { now }) });
          const { events } = await readEvents(client.root, await cursorAtStart(client.root));
          openBus(otui, chrome, {
            peers: client.peers(),
            leases,
            events,
            renderer: r,
            // Flow 275 T7 (specification §7.2): marks which leases apply to
            // THIS instance in the Leases tab (`formatBusLeasesLines`).
            selfInstanceId: client.instanceId,
            ...inspectorKeys,
          });
        } catch (error) {
          // review r1 F10: reading presence/leases/log for the modal must not
          // throw into the shell — report and leave the modal unopened.
          io.onSystem?.(`bus: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      })();
    };
    /**
     * `/bus` subcommands (specification §7.2): `send`/the `@name` shorthand,
     * `ask`, `reply <id>` and `name <new>`, plus flow 275's
     * `pause`/`resume`/`override` (specification §4.3): creating, ending, or
     * releasing THIS instance from a pause lease, through
     * `BusClient.pause`/`resume`/`override` with origin `"operator"`. The
     * banner and the held/queued state repaint immediately after any of the
     * three succeed, rather than waiting up to one poll interval — an
     * operator who just typed `/bus resume` expects the queue to move NOW.
     */
    const runBusCommand = (line: string): void => {
      const parsed = parseBusCommand(line);
      if (parsed.kind === "error") {
        io.onSystem?.(`bus: ${parsed.reason}\n`);
        return;
      }
      if (parsed.kind === "modal") {
        showBus();
        return;
      }
      if (liveBus === undefined) {
        io.onSystem?.("bus: off (not joined)\n");
        return;
      }
      const client = liveBus;
      const reportRefusal = (error: unknown): void => {
        io.onSystem?.(`bus: ${error instanceof Error ? error.message : String(error)}\n`);
      };
      if (parsed.kind === "name") {
        void client
          .rename(parsed.name)
          .then(() => io.onSystem?.(`bus: renamed to @${client.name}\n`))
          .catch(reportRefusal);
        return;
      }
      if (parsed.kind === "reply") {
        // review r1 F4: `resolveRef`/`reply` (in `../bus/client`) resolve
        // `parsed.id` — a `#seq`, bare seq, or an id/short-id prefix — against
        // the client's own bounded store of rendered events, and address the
        // ORIGINAL sender's instance id even if they renamed since. No local
        // id→name map to keep in sync here any more.
        void client
          .reply(parsed.id, parsed.text)
          .then((result) => io.onSystem?.(`bus: sent (#${result.seq}) to ${result.event.toLabel}\n`))
          .catch(reportRefusal);
        return;
      }
      if (parsed.kind === "pause") {
        void client
          .pause(parsed.toLabel, parsed.scope, parsed.reason, parsed.ttlMs, "operator")
          .then((lease) => {
            io.onSystem?.(
              `bus: pause lease ${lease.leaseId.slice(0, 8)} created — ${lease.scope} → ${parsed.toLabel}\n`,
            );
            paintHoldBanner();
            leaseHoldController?.onPoll();
          })
          .catch(reportRefusal);
        return;
      }
      if (parsed.kind === "resume") {
        // Default (specification §7.2): this instance's OWN lease — at most
        // one can be active per holder (D-12/AC1), so the first is the only one.
        const leaseId = parsed.leaseId ?? client.leaseView().myLeases()[0]?.leaseId;
        if (leaseId === undefined) {
          io.onSystem?.("bus: no active lease held by this instance to resume\n");
          return;
        }
        void client
          .resume(leaseId, "operator")
          .then(() => {
            io.onSystem?.(`bus: lease ${leaseId.slice(0, 8)} resumed\n`);
            paintHoldBanner();
            leaseHoldController?.onPoll();
          })
          .catch(reportRefusal);
        return;
      }
      if (parsed.kind === "override") {
        // Default (specification §7.2): the `turns` lease currently holding
        // this instance — `heldBy()` is exactly that lease, or undefined.
        const leaseId = parsed.leaseId ?? client.leaseView().heldBy()?.leaseId;
        if (leaseId === undefined) {
          io.onSystem?.("bus: no lease is currently held against this instance\n");
          return;
        }
        void client
          .override(leaseId)
          .then(() => {
            io.onSystem?.(`bus: overrode lease ${leaseId.slice(0, 8)} — turns released for this instance\n`);
            paintHoldBanner();
            leaseHoldController?.onPoll();
          })
          .catch(reportRefusal);
        return;
      }
      // send | ask
      void client
        .send(parsed.toLabel, parsed.kind === "ask" ? "question" : "notice", parsed.text)
        .then((result) => io.onSystem?.(`bus: sent (#${result.seq}) to ${parsed.toLabel}\n`))
        .catch(reportRefusal);
    };
    /**
     * `/mcp` — the servers keryx CONNECTS TO.
     *
     * Reads the runtime if the session has one; otherwise the config
     * alone, and says which it did. A read-only view must not spawn
     * anything, so it never creates the runtime.
     */
    const showMcpConsumer = (): void => {
      const cwd = inspectorCwd();
      const snapshot = () => {
        const live = deps.mcpRuntime?.();
        if (live === undefined) return undefined;
        return buildConsumerModel({
          configured: live.configured(),
          states: live.servers(),
          problems: live.problems(),
          userFile: userConfigFile(),
          projectFile: projectConfigFile(cwd),
        });
      };
      openMcpConsumer(otui, chrome, {
        snapshot,
        connect: async (name) => {
          const live = deps.mcpRuntime?.();
          if (live === undefined) return { ok: false, message: "No MCP session yet" };
          return live.connectServer(name);
        },
        disconnect: async (name) => {
          const live = deps.mcpRuntime?.();
          if (live === undefined) return { ok: false, message: "No MCP session yet" };
          return live.disconnectServer(name);
        },
        renderer: r,
        ...inspectorKeys,
      });
    };

    const showTools = (): void => {
      void (async () => {
        const cwd = inspectorCwd();
        const runtimes = await mcpClientStatus(cwd, mcpRuntimeIds());
        openMcpTools(otui, chrome, {
          tools: deps.tools.map((t) => t.definition),
          runtimes,
          connect: async (id) => {
            try {
              const report = await installMcpClient(cwd, [id]);
              const outcome = report.outcomes[0];
              if (outcome !== undefined && outcome.errors.length > 0) {
                return { ok: false, message: outcome.errors.join("; ") };
              }
              return { ok: true };
            } catch (error) {
              return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
          },
          disconnect: async (id) => {
            try {
              await uninstallMcpClient(cwd, [id]);
              return { ok: true };
            } catch (error) {
              return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
          },
          renderer: r,
          ...inspectorKeys,
        });
      })();
    };
    const runModeCommand = (line: string): void => {
      const modeArgs = line.trim().split(/\s+/).slice(1).filter((p) => p.length > 0);
      const wanted = modeArgs[0] ?? "";
      const saveFlag = modeArgs.includes("save");

      const applyMode = async (next: PermissionMode): Promise<void> => {
        if (next === "auto") {
          // `auto` skips confirmation for EVERY action, including
          // destructive ones (only credential-touching commands still
          // ask — a hard floor no mode lifts). One-time explicit
          // confirmation before it takes effect, never a silent flip.
          chrome.hideMenu();
          let blockedByOpenDialog = false;
          const confirmId = await chrome.withOverlay(() =>
            showComposerChoice(otui, r, chrome.dock, {
              title: "Switch to auto mode?",
              subtitle:
                "Skips confirmation for EVERY action, including destructive commands. " +
                "Only credential-touching commands still ask.",
              cancelId: "cancel",
              enqueue: false,
              onBusy: () => {
                blockedByOpenDialog = true;
                chrome.showToast("Answer the open approval first, then retry /mode.");
              },
              options: [
                { id: "confirm", label: "Confirm", description: "I understand the risk" },
                { id: "cancel", label: "Cancel", description: "Keep the current mode", recommended: true },
              ],
            }),
          );
          input.focus();
          if (blockedByOpenDialog) {
            return;
          }
          if (confirmId !== "confirm") {
            chrome.showToast("Cancelled — mode unchanged.");
            return;
          }
        }
        permissionMode = next;
        paintModeRow();
        chrome.showToast(`Permission mode: ${next}`);
        if (saveFlag) {
          const saved = setProjectPermissionMode(sessionCwd, next);
          chrome.showToast(saved ? "Saved as this project's default." : "Could not save the project default.");
        }
      };

      if (wanted === "clear") {
        setProjectPermissionMode(sessionCwd, undefined);
        chrome.showToast(`Cleared project default. Session stays on: ${permissionMode}`);
        return;
      }
      if (wanted.length > 0) {
        if (!isPermissionMode(wanted)) {
          io.onSystem?.(`Unknown mode '${wanted}'. Choose one of: ${PERMISSION_MODES.join(", ")}\n`);
          return;
        }
        void applyMode(wanted);
        return;
      }
      // No arg: a picker, same shape as `/theme`'s.
      const stored = getProjectPermissionMode(sessionCwd);
      chrome.hideMenu();
      void (async () => {
        let blockedByOpenDialog = false;
        const id = await chrome.withOverlay(() =>
          showComposerChoice(otui, r, chrome.dock, {
            title: `Permission mode (current: ${permissionMode})`,
            subtitle: stored !== undefined ? `Project default: ${stored}` : "No project default set.",
            cancelId: permissionMode,
            enqueue: false,
            onBusy: () => {
              blockedByOpenDialog = true;
              chrome.showToast("Answer the open approval first, then retry /mode.");
            },
            options: PERMISSION_MODES.map((m) => ({
              id: m,
              label: m,
              description: MODE_PICKER_DESCRIPTIONS[m],
              recommended: m === permissionMode,
            })),
          }),
        );
        input.focus();
        if (blockedByOpenDialog) {
          return;
        }
        if (isPermissionMode(id) && id !== permissionMode) {
          await applyMode(id);
        }
      })();
    };

    // Read-only ("plan") toggle — mirrors `runModeCommand`'s shape but
    // simpler: no confirmation dialog, no picker overlay (TUI cosmetics are
    // out of scope for this pass). Going read-only is the safe direction, so
    // `on` needs no confirm step, unlike `/mode auto`.
    const runPlanCommand = (line: string): void => {
      const planArgs = line.trim().split(/\s+/).slice(1).filter((p) => p.length > 0);
      const wanted = planArgs[0] ?? "";

      if (wanted.length === 0) {
        chrome.showToast(`Read-only mode: ${readOnly ? "on" : "off"}`);
        return;
      }
      if (wanted === "on") {
        readOnly = true;
        paintModeRow();
        chrome.showToast("Read-only mode: on");
        return;
      }
      if (wanted === "off") {
        readOnly = false;
        paintModeRow();
        chrome.showToast(`Read-only mode: off (permission mode stays: ${permissionMode})`);
        return;
      }
      io.onSystem?.("Usage: /plan [on|off]\n");
    };

    // `/model` and `/connect` rebuild `deps` mid-session and refresh the labels.
    const updateModelLabels = (): void => {
      paintSessionHeader();
      const label = `${currentSel.provider}/${currentSel.model}`;
      sbModelV.content = otui.t`${dimChunk(otui, label)}`;
      chrome.setStatus(label);
    };
    const switchTo = async (ns: TuiSelection): Promise<void> => {
      currentSel = ns;
      // Finding 1 fix: same widened contract as the initial `makeAgentDeps`
      // call above — pass the live `slateSession` ref, not just `.dir`.
      deps = {
        ...(await opts.makeAgentDeps(ns, liveSlateSession, busClientRef)),
        onContextCompaction,
        // Flow 274 T7: a rebuild must not drop the bus-delivery wiring that
        // `opts.makeAgentDeps` itself knows nothing about (it is attached
        // once the join settles, see the `joinBus` callback below).
        ...(deps.busInbox !== undefined ? { busInbox: deps.busInbox } : {}),
        ...(deps.busAck !== undefined ? { busAck: deps.busAck } : {}),
        // Flow 275 T7: same reasoning — `opts.makeAgentDeps` knows nothing
        // about the lease view either.
        ...(deps.busLeases !== undefined ? { busLeases: deps.busLeases } : {}),
      };
      liveDeps = deps; // F-002: keep onDestroy's ref pointed at the current deps
      saveShellConfig(
        ns.baseUrl === undefined ? { provider: ns.provider, model: ns.model } : { provider: ns.provider, model: ns.model, baseUrl: ns.baseUrl },
      );
      updateModelLabels();
      void balancePanel.setProvider(ns.provider);
      input.focus();
      chrome.showToast(`Switched to ${ns.provider}/${ns.model}`);
    };

    // Side workers while main is busy (automatic — no special slash command).
    const SIDE_WORKER_ID = `${SIDE_WORKER_ID_PREFIX}1`;
    const sideWorkerLabelText = sideWorkerLabel(1);
    type QueuedSideQuestion = {
      question: string;
      displayQuestion: string;
    };
    const sideQueue: QueuedSideQuestion[] = [];

    // QueuedMainQuestion type imported from ./main-queue (pure helpers).
    let mainQueue: QueuedMainQuestion[] = [];
    let mainQueueSeq = 0;
    // Set by `editMainQueue`: the NEXT plain-text submit while busy re-queues
    // this item at its original position instead of opening the recipient
    // selector again (AC5 — edit must preserve position).
    let pendingQueueEdit: { id: string; at: number } | undefined;
    // Force can be selected more than once while cancellation is settling.
    // Retain every selection in order; only the first schedules the current
    // operation's settlement handoff (AC3).
    const forceHandoff = createForegroundForceHandoff<QueuedMainQuestion>();
    let sideWorkerRunning = false;
    let sideClearTimeout: ReturnType<typeof setTimeout> | undefined;

    const showSideQueueStatus = (): void => {
      if (sideQueue.length === 0) {
        if (!sideWorkerRunning) {
          return;
        }
        fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "running", detail: "side Q" });
        return;
      }
      fleet.upsert({
        id: SIDE_WORKER_ID,
        label: sideWorkerLabelText,
        status: sideWorkerRunning ? "running" : "queued",
        detail: `queued ×${sideQueue.length}`,
      });
    };

    // Keyboard queue-nav mode (flow 170 T5, PRD FR-8): reaches Force/Edit/
    // Delete without a mouse. Entry: Ctrl+Q -- a grep of this file's other
    // `key.ctrl &&`-guarded bindings at implementation time found none bound
    // to "q" (only Ctrl+O for block-nav), so the TRD's proposed key needed no
    // substitution. While active, up/down move `selectedQueueIndex`,
    // left/right move `selectedQueueAction`, Enter fires it (then exits,
    // mirroring `composer-choice.ts`'s `finish(id)`-on-select), Esc exits
    // without acting (mirrors `composer-choice.ts`'s
    // `finish(request.cancelId)` on escape).
    let queueNavActive = false;
    let selectedQueueIndex = 0;
    let selectedQueueAction: QueueNavAction = "force";
    // Registered once, for the session: the existing cross-file arbitration
    // primitive (`ShellChrome.addOverlaySource`, doc'd as exactly "overlays
    // the caller owns... but the chrome cannot know about them") already
    // folds `queueNavActive` into `chrome.overlayActive()` -- the same
    // boolean block-nav's own `isBlocked()` and the `/`-menu router both
    // already consult -- so entering queue-nav suppresses both with zero
    // edits to shell-chrome.ts's `overlayActive()` body.
    chrome.addOverlaySource(() => queueNavActive);

    let mainQueueBlocks: Array<{
      id: string;
      box: Box;
      setRowActive: (active: boolean) => void;
      buttons: Record<QueueNavAction, { box: Box; setActive: (active: boolean) => void }>;
    }> = [];
    /**
     * Small styled label mimicking a clickable button \u2014 mirrors
     * `composer-choice.ts`'s "small styled label" pattern (bold/colored
     * `TextRenderable`, no border) rather than a bordered box: a bordered
     * child box next to a plain-text label in the same row would need its own
     * explicit height to avoid the row's cross-axis stretch fighting its
     * border rows (see `.metaproject/memory/lessons/
     * tui-alignself-height-collapse.md` \u2014 this file avoids `alignSelf`
     * entirely for exactly that class of bug).
     */
    const mainQueueButton = (
      label: string,
      id: string,
      color: string,
      onMouseDown: () => void,
    ): { box: Box; setActive: (active: boolean) => void } => {
      const box = new otui.BoxRenderable(r, {
        id,
        flexShrink: 0,
        marginLeft: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event: { stopPropagation: () => void }) => {
          // Part A (flow 170 T5 investigation): @opentui/core's
          // Renderable.processMouseEvent fires this handler THEN, unless
          // told otherwise, walks up .parent and fires every ancestor's
          // onMouseDown too (confirmed against the bundled implementation,
          // node_modules/@opentui/core/chunk-bun-tkm837n2.js, the
          // processMouseEvent/onMouseDown setter pair) -- mouse events
          // bubble by default. queueDock (T6) will get its own onMouseDown
          // to enter queue-nav on a background click; without stopping it
          // here, every button click would ALSO re-enter queue-nav as an
          // unwanted bubbled side effect (AC9/AC10 both depend on the button
          // click NOT merely focusing the dock). Stop it at the deepest,
          // most specific handler -- the button itself.
          event.stopPropagation();
          onMouseDown();
        },
      });
      // Theme-driven color, not `otui.red`/`otui.yellow` (fixed ANSI-bright
      // helpers) -- plain content + `.fg` is the same pattern
      // `transcript-blocks.ts`'s block header already uses for theme colors.
      const text = new otui.TextRenderable(r, { id: `${id}-t`, content: `[${label}]` });
      text.fg = color;
      box.add(text);
      const setActive = (active: boolean): void => {
        box.backgroundColor = active ? getTheme().highlight : undefined;
        text.content = active ? otui.t`${boldChunk(otui, `[${label}]`)}` : `[${label}]`;
        text.fg = color;
      };
      return { box, setActive };
    };
    /** Repaint the queue-nav highlight only -- no rebuild, mirrors
     * composer-choice.ts's paintOptions() re-highlight-on-change shape. */
    const applyQueueNavHighlight = (): void => {
      for (let i = 0; i < mainQueueBlocks.length; i++) {
        const entry = mainQueueBlocks[i];
        if (entry === undefined) continue;
        const rowActive = queueNavActive && i === selectedQueueIndex;
        entry.setRowActive(rowActive);
        entry.buttons.force.setActive(rowActive && selectedQueueAction === "force");
        entry.buttons.edit.setActive(rowActive && selectedQueueAction === "edit");
        entry.buttons.delete.setActive(rowActive && selectedQueueAction === "delete");
      }
    };
    const exitQueueNav = (): void => {
      if (!queueNavActive) return;
      queueNavActive = false;
      applyQueueNavHighlight();
    };
    const enterQueueNav = (): void => {
      if (mainQueue.length === 0) return;
      queueNavActive = true;
      selectedQueueIndex = clampQueueNavIndex(selectedQueueIndex, mainQueue.length);
      applyQueueNavHighlight();
    };
    // Flow 170 T6, PRD FR-12/AC10: a click on queueDock's own background/item
    // text (not a button) enters queue-nav — `enterQueueNav` is local to this
    // closure, so this assignment (rather than new `ShellChromeOptions`
    // plumbing) is the simplest wiring, per T5's own recommendation. No
    // anti-bubbling guard is needed here (unlike a naive read of TRD §1.6
    // might suggest): T5's dispatch-order investigation found mouse events
    // bubble child-to-parent by default, and fixed it at the SOURCE — each
    // Force/Edit/Delete button already calls `event.stopPropagation()`
    // before firing its own action, so a click that reaches this handler at
    // all already means it did NOT land on a button. It still defers to
    // `overlayActive()` (FR-15) the same as the sidebar/scroll handlers: an
    // active approval/choice-dock prompt (AC8's coexistence case) must keep
    // owning the keyboard even while queueDock is visible alongside it.
    chrome.queueDock.onMouseDown = () => {
      if (chrome.overlayActive()) return;
      enterQueueNav();
    };
    const paintMainQueue = (): void => {
      // Remove stale blocks (same "remove stale, rebuild all" strategy as before).
      for (const entry of mainQueueBlocks) {
        try {
          chrome.queueDock.remove(entry.box);
        } catch {
          // ignore
        }
      }
      mainQueueBlocks = [];
      selectedQueueIndex = clampQueueNavIndex(selectedQueueIndex, mainQueue.length);
      if (mainQueue.length === 0) {
        // Queue-nav only makes sense while there is something to act on.
        exitQueueNav();
      }
      const theme = getTheme();
      for (let i = 0; i < mainQueue.length; i++) {
        const item = mainQueue[i];
        if (item === undefined) continue;
        const index = i;
        const row = new otui.BoxRenderable(r, {
          id: `mq-${item.id}`,
          width: "100%",
          flexDirection: "row",
        });
        const label = new otui.TextRenderable(r, {
          id: `mq-${item.id}-t`,
          flexGrow: 1,
          minWidth: 0,
          content: otui.t`${dimChunk(otui, `${formatMainQueueMarker(index)} ${item.displayQuestion}`)}`,
        });
        row.add(label);
        const force = mainQueueButton("Force", `mq-force-${item.id}`, theme.focus, () => forceMainQueue(index));
        const edit = mainQueueButton("Edit", `mq-edit-${item.id}`, theme.text, () => editMainQueue(index));
        const del = mainQueueButton("Delete", `mq-del-${item.id}`, theme.error, () => removeMainQueue(index));
        row.add(force.box);
        row.add(edit.box);
        row.add(del.box);
        chrome.queueDock.add(row);
        mainQueueBlocks.push({
          id: item.id,
          box: row,
          setRowActive: (active) => {
            row.backgroundColor = active ? theme.highlight : undefined;
          },
          buttons: { force, edit, delete: del },
        });
      }
      chrome.queueDock.visible = mainQueue.length > 0;
      applyQueueNavHighlight();
      // Fleet/status counter.
      if (mainQueue.length > 0) {
        fleet.upsert({ id: "agent:queue", label: "mainQ", status: "queued", detail: `queued \u00d7${mainQueue.length}` });
      } else {
        fleet.remove("agent:queue");
      }
    };

    const removeMainQueue = (index: number): void => {
      if (index < 0 || index >= mainQueue.length) return;
      mainQueue = removeMainQueueItem(mainQueue, index);
      paintMainQueue();
    };

    const editMainQueue = (index: number): void => {
      const edited = editMainQueueItem(mainQueue, index);
      if (edited === undefined) return;
      mainQueue = edited.rest;
      pendingQueueEdit = { id: edited.removed.id, at: index };
      input.value = edited.text;
      input.focus();
      paintMainQueue();
    };

    const forceMainQueue = (index: number): void => {
      const item = mainQueue[index];
      if (item === undefined) return;
      // Flow 275 T7 (specification §4.3, AC4): "/queue force" — and the
      // Ctrl+Q queue-nav force action and the queue-dock force button, which
      // both call this SAME function — must not be the back door around a
      // `turns` hold. The item stays exactly where it is; only `/bus`
      // (`override`, or the holder's own `resume`) actually lifts a hold.
      if (leaseView()?.held() === true) {
        io.onSystem?.(`◇ held — q${index + 1} stays queued until the lease is released (see /bus).\n`);
        return;
      }
      mainQueue = removeMainQueueItem(mainQueue, index);
      paintMainQueue();
      // Cancellation is cooperative, and only the press that owns the handoff
      // waits for settlement. Both rules live in `forceForegroundQueueItem`
      // rather than here, because this function has no headless seam and the
      // guard was therefore covered only by a source-text audit — which review
      // showed stays green with the guard deleted.
      void forceForegroundQueueItem(foregroundOperation, forceHandoff, item, {
        announce: () => io.onSystem?.(`◇ main turn interrupted — q${index + 1} will run next.\n`),
        run: (next) => runLine(next.question),
      });
    };

    /**
     * Queue-nav keyboard router (flow 170 T5, PRD FR-8) -- mirrors the shape
     * of `nav.handleKey` (`createBlockNavController`, transcript-blocks.ts)
     * and is subscribed the same way, right beside it, further down. Entry
     * (Ctrl+Q) only arms while nothing else already owns the keyboard:
     * `chrome.overlayActive()` covers the choice-dock/`withOverlay`/other
     * registered sources, `chrome.menuActive()` covers the `/`-menu, and
     * `nav.active()` covers block-nav mode -- the same checks block-nav's
     * own `isBlocked()` performs for itself, written out here the other way
     * (querying `nav.active()` from inside `nav`'s own closure isn't
     * possible in reverse).
     */
    const handleQueueNavKey = (key: KeypressEvent): void => {
      if (!queueNavActive) {
        if (
          key.ctrl &&
          key.name === "q" &&
          mainQueue.length > 0 &&
          !chrome.overlayActive() &&
          !chrome.menuActive() &&
          !nav.active()
        ) {
          enterQueueNav();
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }
      if (key.name === "escape") {
        exitQueueNav();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "up") {
        selectedQueueIndex = stepQueueNavIndex(selectedQueueIndex, mainQueue.length, "up");
        applyQueueNavHighlight();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "down") {
        selectedQueueIndex = stepQueueNavIndex(selectedQueueIndex, mainQueue.length, "down");
        applyQueueNavHighlight();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "left") {
        selectedQueueAction = stepQueueNavAction(selectedQueueAction, "left");
        applyQueueNavHighlight();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "right") {
        selectedQueueAction = stepQueueNavAction(selectedQueueAction, "right");
        applyQueueNavHighlight();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
        const index = selectedQueueIndex;
        const action = selectedQueueAction;
        // Fires the SAME functions the mouse buttons call (T2) -- no
        // duplicated logic. Exits queue-nav afterward, mirroring
        // composer-choice.ts's finish(id)-on-select.
        exitQueueNav();
        if (action === "force") forceMainQueue(index);
        else if (action === "edit") editMainQueue(index);
        else removeMainQueue(index);
        key.preventDefault();
        key.stopPropagation();
      }
    };

    const clearSideWorkerSlot = (): void => {
      if (sideClearTimeout !== undefined) {
        clearTimeout(sideClearTimeout);
      }
      sideClearTimeout = setTimeout(() => {
        if (sideWorkerRunning || sideQueue.length > 0) {
          return;
        }
        try {
          fleet.remove(SIDE_WORKER_ID);
        } catch {
          // ignore
        }
      }, 12_000);
    };

    const spawnSideWorker = (question: string, displayQuestion = question): void => {
      sideQueue.push({ question, displayQuestion });
      if (sideQueue.length > 1 || sideWorkerRunning) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `side-max${uid++}`,
            content: otui.t`${roleChunk(otui, "attention", `◦ side-1 queued (${sideQueue.length - 1} pending)`)} ${
              dimChunk(otui, `· while main: ${busyPhase}`)
            }`,
            marginTop: 1,
          }),
        );
        showSideQueueStatus();
        return;
      }

      void (async () => {
        while (sideQueue.length > 0) {
          const next = sideQueue.shift();
          if (next === undefined) {
            break;
          }
          const currentQuestion = next.question;
          sideWorkerRunning = true;
          if (sideClearTimeout !== undefined) {
            clearTimeout(sideClearTimeout);
            sideClearTimeout = undefined;
          }

          const mainSlot = fleet.list().find((w) => w.id === MAIN_AGENT_ID);
          const elapsedSec = busyStartedAt > 0 ? (Date.now() - busyStartedAt) / 1000 : undefined;

          fleet.upsert({
            id: SIDE_WORKER_ID,
            label: sideWorkerLabelText,
            status: "running",
            detail: sideQueue.length > 0 ? `side Q (${sideQueue.length} queued)` : "side Q",
            model: `${currentSel.provider}/${currentSel.model}`,
          });

          transcript.add(
            new otui.TextRenderable(r, {
              id: `side-h${uid++}`,
              content: otui.t`${roleChunk(otui, "side", "──")} ${boldChunk(otui, sideWorkerLabelText)} ${roleChunk(otui, "side", "──")} ${
                dimChunk(otui, `while main: ${busyPhase}`)
              }`,
              marginTop: 1,
            }),
          );

          const prompt = buildSideWorkerPrompt({
            question: currentQuestion,
            snapshot: {
              phase: busyPhase,
              ...(mainSlot?.detail !== undefined ? { mainDetail: mainSlot.detail } : {}),
              ...(elapsedSec !== undefined ? { elapsedSec } : {}),
            },
            recentHistory: history,
          });

          let answer = "";
          try {
            // Finding 1 fix: same widened contract as the other two
            // `opts.makeAgentDeps` call sites in this file — pass the live
            // `slateSession` ref, not just `.dir`.
            //
            // review r1 F9: NOT `busClientRef`. A side worker answers a
            // transient status question with a snapshot and never speaks on
            // the session's own bus identity (`bus_send` is denied by name
            // below regardless), so it has no business being told the
            // session is bus-joined at all — passing `busClientRef` here
            // made `busJoined` true in `base`'s own (unused, but computed)
            // system instruction and `bus_list` show up in `base.tools`
            // purely because the MAIN session happened to be joined, not
            // because this worker needs it.
            const base = await opts.makeAgentDeps(currentSel, liveSlateSession, undefined);
            // Read-only: never allow shell/mutations from a side worker. `bus_send`
            // is excluded by name (`SIDE_WORKER_DENIED_TOOL_NAMES`) even though it
            // is `risk: "read"` — see that list's own doc comment.
            // F-003: `risk === "read"` alone is not enough — see
            // `isToolAvailableToSideWorker`'s doc comment above.
            const tools = base.tools.filter(isToolAvailableToSideWorker);
            const sideDeps: AgentDeps = {
              ...base,
              tools,
              systemInstruction: buildSideWorkerSystemInstruction(currentSel.provider, currentSel.model),
              maxRounds: 4,
              idSeq: () => `${SIDE_WORKER_ID}-${base.idSeq()}`,
            };
            const sideHistory: NormalizedMessage[] = [];
            const sideIo: AgentIO = {
              write: (s) => {
                answer += s;
              },
              onAssistantText: (text) => {
                answer = text;
              },
              onToolCall: (name) => {
                fleet.upsert({
                  id: SIDE_WORKER_ID,
                  label: sideWorkerLabelText,
                  status: "running",
                  detail: name.length > 12 ? `${name.slice(0, 10)}…` : name,
                });
              },
              onToolResult: () => {
                fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "running", detail: "waiting" });
              },
              onSystem: (text) => {
                transcript.add(
                  new otui.TextRenderable(r, {
                    id: `side-sys${uid++}`,
                    content: otui.t`${dimChunk(otui, text.trimEnd())}`,
                  }),
                );
              },
              // Side workers never get shell approval — tools are read-only only.
              requestApproval: async () => false,
            };
            await runAgentTurn(sideIo, sideDeps, sideHistory, prompt);
            const body = answer.trim().length > 0 ? answer.trim() : "(no reply)";
            appendUserEcho(otui, r, transcript, {
              id: `side-a${uid++}`,
              line: body,
              marker: "◇",
              borderColor: getTheme().side,
              marginTop: 0,
            });
            fleet.upsert({
              id: SIDE_WORKER_ID,
              label: sideWorkerLabelText,
              status: sideQueue.length > 0 ? "running" : "done",
              detail: "answered",
            });
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            transcript.add(
              new otui.TextRenderable(r, {
                id: `side-err${uid++}`,
                content: otui.t`${roleChunk(otui, "error", `◇ ${sideWorkerLabelText} failed: ${msg}`)}`,
              }),
            );
            fleet.upsert({ id: SIDE_WORKER_ID, label: sideWorkerLabelText, status: "failed", detail: "error" });
          } finally {
            sideWorkerRunning = false;
          }
          if (sideQueue.length > 0) {
            showSideQueueStatus();
            continue;
          }
          clearSideWorkerSlot();
        }
      })();
    };

    // Run a submitted line: a slash command, an unknown-slash notice, a main turn,
    // or (when main is busy) an automatic side worker — no special command needed.
    // Flow 265 (AC7/AC8): `origin` lets a completion reuse this ONE turn
    // dispatch instead of growing a second one. A notification-started turn
    // carries no operator text, so it skips the empty-line guard and the user
    // echo — there is nobody to echo.
    let consecutiveAutoWakes = 0;
    const runLine = (
      line: string,
      // Flow 274 T7: `"bus-message"` marks a turn started because the
      // busInbox holds a wake-eligible peer message — same shape as
      // `"task-notification"`, and shares the SAME `consecutiveAutoWakes`
      // counter/cap (specification §5.3).
      origin: "operator" | "task-notification" | "bus-message" = "operator",
    ): void => {
      if (line.length === 0 && origin === "operator") {
        return;
      }
      // AC14 (flow 268): a new turn — of any kind this function dispatches,
      // not only the main agent turn — supersedes whatever next-step
      // suggestion request was still in flight from the PREVIOUS one.
      suggestionGate.cancel("new turn started");
      if (origin === "operator") {
        // A human is here: the auto-wake budget starts over.
        consecutiveAutoWakes = 0;
        // ...and the first thing they send replaces the wordmark (AC10).
        splash?.removeIfShown();
      }
      const displayLine = summarizeSubmittedLine(line);

      // While main is in progress: control slash still works; anything else → side worker.
      // "In progress" is the chrome's own spinner state, which `startBusy` /
      // `stopBusy` below are the only things that move.
      if (chrome.isBusy()) {
        const command = findAgentCommand(line, "agent");
        // Reuses `/status`'s and `/flows`'s own single-source-of-truth command
        // matchers instead of a second, separately-maintained name list that
        // could silently drift from them.
        const decision = classifyBusyDispatch({
          line,
          commandName: command?.name,
          isSessionInfo: isSessionInfoCommand(line),
          isFlows: isFlowsCommand(line),
          isWorkspace: isWorkspaceCommand(line),
          isReview: isReviewCommand(line),
          isMcp: isMcpToolsCommand(line),
          isMcpConsumer: isMcpConsumerCommand(line),
        });
        switch (decision) {
          case "demote": {
            // Runs WHILE the main turn is busy, on purpose: a turn blocked on
            // its own command is when an operator wants this. It never touches
            // the turn — the task moves to the background and keeps running.
            const parsed = parseDemoteCommand(line.trim().replace(/^\/\S+\s*/, ""));
            if (!parsed.ok) {
              io.onSystem?.(`${parsed.reason}\n`);
            } else if (deps.jobRegistry === undefined) {
              io.onSystem?.("This session tracks no shell tasks, so there is nothing to demote.\n");
            } else {
              const demoted = demoteTask(deps.jobRegistry, parsed.taskId);
              io.onSystem?.(
                demoted.ok
                  ? `Task ${parsed.taskId} keeps running, now in the background — it was NOT stopped.\n`
                  : `${demoted.error}\n`,
              );
            }
            return;
          }
          case "exit": {
            // Cancel synchronously; close/sweep may block (SLATE-5, F-002).
            foregroundOperation.cancel("shell exit");
            foregroundOperation.dispose();
            void (async () => {
              await performSlateExit({
                closeSlate: () => closeSlateSession(slateSession, mintTimestampAttemptId),
                sweepJobs: async () => {
                  await deps.sweepBackgroundJobs?.();
                },
                purgeJobList: () => jobs.removeAll(),
                leaveBus: () => liveBus?.leave(),
                releaseLease: () => sessionLease.release(),
                detachRenderer: () => r.off("theme_mode", onThemeMode),
                destroyRenderer: () => r.destroy(),
              });
            })();
            return;
          }
          case "help": {
            transcript.add(
              new otui.TextRenderable(r, {
                id: `c${uid++}`,
                content: otui.t`${roleChunk(otui, "accent", `❯ ${line}`)}`,
                marginTop: 1,
              }),
            );
            io.onSystem?.(
              "Main agent is busy. Type a normal question to spawn a side worker " +
                "(sees main status + recent context; read-only). /status и /flows still open info panels. /exit still works.\n",
            );
            return;
          }
          case "interrupt": {
            if (foregroundOperation.isActive) {
              foregroundOperation.cancel("interrupted by user");
              io.onSystem?.("◇ main turn interrupted.\n");
              return;
            }
            io.onSystem?.("◇ no active main turn to interrupt.\n");
            return;
          }
          case "queue": {
            const parsed = parseQueueCommand(line.trim().split(/\s+/).slice(1).join(" "));
            if (parsed === undefined) {
              io.onSystem?.("◇ usage: /queue <remove|edit|force> [N]  (N = qN position, default 1)\n");
              return;
            }
            const index = parsed.position - 1;
            if (index < 0 || index >= mainQueue.length) {
              io.onSystem?.(`◇ queue: no item q${parsed.position}.\n`);
              return;
            }
            if (parsed.action === "remove") {
              removeMainQueue(index);
              io.onSystem?.(`◇ removed q${parsed.position} from the main queue.\n`);
              return;
            }
            if (parsed.action === "edit") {
              editMainQueue(index);
              io.onSystem?.(`◇ q${parsed.position} moved to the composer — edit and submit to re-queue at the same position.\n`);
              return;
            }
            forceMainQueue(index);
            return;
          }
          case "delegate": {
            // Allowed while main is busy: handing a side investigation to a
            // vendor CLI while the main agent works is the point of the command.
            runDelegate(line);
            return;
          }
          case "think": {
            if (toggleNewestBlock("thought") === undefined) {
              io.onSystem?.("No reasoning yet.\n");
            }
            return;
          }
          case "expand": {
            if (toggleNewestBlock("output") === undefined && toggleNewestBlock() === undefined) {
              io.onSystem?.("Nothing to expand — no tool output yet.\n");
            }
            return;
          }
          case "copy": {
            if (!copyNewestOrLastCode()) {
              io.onSystem?.("Nothing to copy yet.\n");
            }
            return;
          }
          case "mode": {
            runModeCommand(line);
            return;
          }
          case "plan": {
            runPlanCommand(line);
            return;
          }
          case "session-info": {
            showSessionInfo();
            return;
          }
          case "flows": {
            showFlows();
            return;
          }
          case "workspace": {
            showWorkspace();
            return;
          }
          case "review": {
            showReview();
            return;
          }
          case "governance":
          case "triggers": {
            routeOpsCommand(line, true, ops);
            return;
          }
          case "schedules": {
            routeSchedulesCommand(line, true, schedules);
            return;
          }
          case "mcp": {
            showTools();
            return;
          }
          case "mcp-consumer": {
            showMcpConsumer();
            return;
          }
          case "game": {
            showGame(line);
            return;
          }
          case "bus": {
            // Flow 273 (specification §7.2): messaging/viewing the project
            // agent bus never waits for the main turn — an operator override
            // of a `turns` lease has to be reachable from a held instance.
            runBusCommand(line);
            return;
          }
          case "deferred": {
            // /new /resume /sessions /compact /model while busy: refuse (avoid racing main session).
            transcript.add(
              new otui.TextRenderable(r, {
                id: `c${uid++}`,
                content: otui.t`${roleChunk(otui, "attention", 
                  `◇ main is busy — command deferred. Ask a normal question for a side worker, or wait.`,
                )}`,
                marginTop: 1,
              }),
            );
            return;
          }
          case "not-a-command":
            break;
        }
        // Recipient selector: post the message to the MAIN queue (default) or
        // the read-only side-1 worker. Shown only while main is busy. `runLine`
        // is sync, so the async choice is run in a detached IIFE (choice is
        // synchronous UI; the callback below stays fire-and-forget).
        // AC5: a pending `/queue edit` re-queues at its ORIGINAL position on
        // the very next busy submit, skipping the recipient selector entirely
        // (the item is already committed to the main queue by definition).
        if (pendingQueueEdit !== undefined) {
          const edit = pendingQueueEdit;
          pendingQueueEdit = undefined;
          mainQueue = reinsertMainQueueItem(mainQueue, edit.at, {
            id: edit.id,
            question: line,
            displayQuestion: displayLine,
          });
          paintMainQueue();
          return;
        }
        // Flow 275 T7 (specification §4.3, AC4): "dispatches no side worker
        // for busy lines" while a `turns` lease holds this instance — a side
        // worker is a way around the hold (it starts its own agent turn,
        // just not the MAIN one), so it is never even offered here. The line
        // goes straight to the main queue, same as the idle-path hold below,
        // skipping the Main-queue/Side-1 choice entirely.
        if (leaseView()?.held() === true) {
          const id = `mq${mainQueueSeq++}`;
          mainQueue.push({ id, question: line, displayQuestion: displayLine });
          paintMainQueue();
          io.onSystem?.(`◇ ${leaseView()?.banner() ?? "held"} — queued as q${mainQueue.length} (no side worker while held).\n`);
          return;
        }
        void (async () => {
          let blockedByOpenDialog = false;
          const chosen = await showComposerChoice(otui, r, chrome.dock, {
            title: "Main agent is busy",
            subtitle: line,
            options: [
              { id: "main", label: "Main queue", description: "queue for the main agent; remove/edit/force later", recommended: true },
              { id: "side", label: "Side-1", description: "read-only answer, outside main history (as before)" },
            ],
            cancelId: "side",
            enqueue: false,
            onBusy: () => {
              blockedByOpenDialog = true;
              chrome.showToast("Answer the open approval first, then resend.");
            },
          });
          if (blockedByOpenDialog) {
            // Don't silently pick "side" for a message the user never routed —
            // hand it back to the composer so nothing is lost.
            input.value = line;
            input.focus();
            return;
          }
          if (chosen === "main") {
            const id = `mq${mainQueueSeq++}`;
            mainQueue.push({ id, question: line, displayQuestion: displayLine });
            paintMainQueue();
          } else {
            appendUserEcho(otui, r, transcript, {
              id: `side-q${uid++}`,
              line: displayLine,
              borderColor: getTheme().side,
              marginTop: 0,
            });
            spawnSideWorker(line, displayLine);
          }
        })();
        return;
      }

      // Echo a slash command so it is clear WHICH command ran (turns echo their
      // own `❯ …` user box below).
      if (line.startsWith("/")) {
        transcript.add(
          new otui.TextRenderable(r, {
            id: `c${uid++}`,
            content: otui.t`${roleChunk(otui, "accent", `❯ ${line}`)}`,
            marginTop: 1,
          }),
        );
      }
      const command = findAgentCommand(line, "agent");
      if (command !== undefined) {
        if (command.name === "/exit") {
          // SLATE-5 close trigger: shell exit (explicit command).
          void (async () => {
            await performSlateExit({
              closeSlate: () => closeSlateSession(slateSession, mintTimestampAttemptId),
              sweepJobs: async () => {
                await deps.sweepBackgroundJobs?.();
              },
              purgeJobList: () => jobs.removeAll(),
              leaveBus: () => liveBus?.leave(),
              releaseLease: () => sessionLease.release(),
              detachRenderer: () => r.off("theme_mode", onThemeMode),
              destroyRenderer: () => r.destroy(),
            });
          })();
          return;
        }
        if (command.name === "/demote") {
          const parsed = parseDemoteCommand(line.trim().replace(/^\/\S+\s*/, ""));
          if (!parsed.ok) {
            io.onSystem?.(`${parsed.reason}\n`);
          } else if (deps.jobRegistry === undefined) {
            io.onSystem?.("This session tracks no shell tasks, so there is nothing to demote.\n");
          } else {
            const demoted = demoteTask(deps.jobRegistry, parsed.taskId);
            io.onSystem?.(
              demoted.ok
                ? `Task ${parsed.taskId} keeps running, now in the background — it was NOT stopped.\n`
                : `${demoted.error}\n`,
            );
          }
          return;
        }
        if (command.name === "/clear" || command.name === "/new") {
          // SLATE-5 close trigger: `/new`/`/clear` abandon the current session
          // dir for a fresh one — archive whatever slate it was building
          // before switching away (parity with runAgentRepl in shell.ts).
          void (async () => {
            await closeSlateSession(slateSession, mintTimestampAttemptId);
            // Creates a NEW session id; previous transcript stays on disk for /resume.
            if (!startNewSession()) {
              return;
            }
            bindSlateToLiveSession();
            void refreshWorkspaceSidebar(); // new session: no bound workspace yet
            // The just-closed session's wrap-up may have just added a new
            // proposal/unbound-candidate — project-wide, so worth a refresh
            // even though this new session has no workspace of its own yet.
            void refreshReviewSidebar();
            // The old session's subagents (sidebar list + inspector) belong to
            // the transcript that just left — a fresh session starts with none.
            sessions.clear();
            // Flow 176 T18: external runs are cleared HERE (a full session
            // reset) and deliberately NOT on each new parent turn like native
            // subagents are. A `/delegate` run is operator-initiated and
            // outlives the turn it was started in — that is the point of
            // delegating while the main agent works — and `ExternalRunStore`
            // drops unknown ids silently, so clearing it per turn would freeze a
            // live vendor transcript mid-run with no visible cause.
            external.clear();
            deps.resetSubagentBudget?.();
            io.onSystem?.(
              `New session ${shortSessionId(liveSession.summary.id)} (previous kept on disk · /resume)\n`,
            );
          })();
          return;
        }
        if (command.name === "/schedule") {
          // Flow 295 (AC6): create a scheduled background task — the same draft,
          // card and confirmation as `keryx schedule add` and `schedule_create`.
          void runScheduleSlashCommand(line.slice(command.name.length).trim(), {
            cwd: sessionCwd,
            defaults: () => ({ provider: deps.providerId ?? "", model: deps.modelId ?? "" }),
            print: (text, tone) => {
              const chunk =
                tone === "ok" ? roleChunk(otui, "ok", text) : tone === "error" ? roleChunk(otui, "error", text) : dimChunk(otui, text);
              transcript.add(new otui.TextRenderable(r, { id: `sch${uid++}`, content: otui.t`${chunk}` }));
            },
            confirm: (card) => confirmScheduleCard(card),
          });
          return;
        }
        if (command.name === "/goal") {
          // SLATE-15 (flow 161, AC1/AC2): deterministic slate-open entry point.
          void (async () => {
            await runGoalCommand({
              raw: line.slice(command.name.length).trim(),
              cwd: sessionCwd,
              io,
              deps,
              history,
              slateSession,
              mintAttemptId: mintTimestampAttemptId,
            });
          })();
          return;
        }
        if (command.name === "/resume" || command.name === "/sessions") {
          void resumeSessionInteractive();
          return;
        }
        if (command.name === "/compact") {
          if (!sessionLease.canPersist()) {
            io.onSystem?.(LOST_LEASE_COMPACT_REFUSAL);
            return;
          }
          const focus = line.trim().split(/\s+/).slice(1).join(" ").trim();
          const packed = compactSession(liveSession, history, archive, {
            keepLastUserTurns: 3,
            ...(focus.length > 0 ? { focus } : {}),
            provider: currentSel.provider,
            model: currentSel.model,
          });
          liveSession = packed.handle;
          history = packed.context;
          nextArchiveIndex = history.length;
          paintSessionHeader();
          if (packed.result.noop) {
            io.onSystem?.("Nothing to compact (context already small).\n");
          } else {
            io.onSystem?.(
              `Compacted −${packed.result.removed} context msgs · archive ${liveSession.summary.archiveMessageCount} · compact×${liveSession.summary.compactCount}\n`,
            );
          }
          return;
        }
        if (command.name === "/search-provider") {
          void (async () => {
            const args = parseSearchProviderArgs(line.slice(16));
            const all = searchProviderController.configurable();
            if (args.providerId === undefined) {
              await chrome.withOverlay(() => searchProviderWizardInTui(otui, chrome, searchProviderController));
              input.focus();
              return;
            }
            const descriptor = all.find((candidate) => candidate.id === args.providerId);
            if (descriptor === undefined) {
              io.onSystem?.(`Unknown provider '${args.providerId}'. Available: ${all.map((provider) => provider.id).join(", ")}\n`);
              return;
            }
            const providerId: SearchProviderId = descriptor.id;
            searchProviderController.configure(
              providerId,
              { ...descriptor.defaults, ...args.fields },
              args.credential,
            );
            const tested = await searchProviderController.test(providerId);
            if (!tested.ok) {
              const reason = describeConnectionFailure(tested.reason);
              io.onSystem?.(
                `Configured '${providerId}' but it is not connected yet: ${reason}. Run /search-provider ${providerId} key=<value> to re-test.\n`,
              );
              return;
            }
            io.onSystem?.(
              `Configured and tested '${providerId}' successfully. Use /search-connect ${providerId} to make it active.\n`,
            );
          })();
          return;
        }
        if (command.name === "/search-connect") {
          void (async () => {
            const args = parseSearchProviderArgs(line.slice(15));
            const providerId = args.providerId;
            if (providerId === undefined) {
              const selectable = searchProviderController.selectable();
              if (selectable.length === 0) {
                // Mirrors `/connect`'s empty-state handling (AC3): no picker
                // for zero candidates, keep the existing list+hint message.
                io.onSystem?.(
                  describeSearchProviderList("Connected search providers (use /search-connect <id> to select):", selectable),
                );
                io.onSystem?.("No connected search providers found. Run /search-provider first.\n");
                return;
              }
              // AC1: single-step overlay picker over exactly `selectable()`,
              // mirroring `/connect`'s `chrome.withOverlay(() => ...)` shape.
              const picked = await chrome.withOverlay(() => pickSearchProviderStep(otui, chrome, selectable));
              input.focus();
              if (picked === undefined) {
                return; // Esc: cancel, no select() call made (AC2)
              }
              await selectSearchProviderAndReport(searchProviderController, io.onSystem, picked.id);
              return;
            }
            const normalizedProviderId = searchProviderController.configurable().find((candidate) => candidate.id === providerId)?.id;
            if (normalizedProviderId === undefined) {
              io.onSystem?.(`Unknown provider '${providerId}'.\n`);
              return;
            }
            await selectSearchProviderAndReport(searchProviderController, io.onSystem, normalizedProviderId);
          })();
          return;
        }
        // `/think` and `/expand` TOGGLE the newest matching block in place
        // (flow 109 expanded it; flow 115 made it reversible — a one-way expand
        // leaves a screenful of reasoning with no advertised way back). `/copy`
        // puts a block's retained payload on the clipboard (AC6).
        //
        // flow 268 T17 (AC16): `/think auto|expand|hide` is a SEPARATE
        // concern layered on top — it sets the PERSISTED display mode for
        // every FUTURE round, never touches the current block, and does not
        // toggle anything. Bare `/think` and `/think collapse` (or any other
        // unrecognized trailing word) fall through unchanged to the original
        // toggle-the-newest-block behaviour below.
        if (command.name === "/think") {
          const arg = line.trim().split(/\s+/).slice(1).join(" ").trim();
          const mode = parseThinkDisplayMode(arg);
          if (arg.length > 0 && mode !== undefined) {
            thinkDisplayMode = mode;
            saveShellConfig({ thinkDisplay: mode });
            io.onSystem?.(`Reasoning display: ${mode}\n`);
            return;
          }
          if (arg.length > 0 && arg !== "collapse") {
            io.onSystem?.(
              `Unknown /think argument '${arg}'. Choose one of: ${THINK_DISPLAY_MODES.join(", ")} — ` +
                "or run /think with no argument to expand/collapse the last reasoning block.\n",
            );
            return;
          }
          if (toggleNewestBlock("thought") === undefined) {
            io.onSystem?.("No reasoning yet.\n");
          }
          return;
        }
        if (command.name === "/expand") {
          if (toggleNewestBlock("output") === undefined && toggleNewestBlock() === undefined) {
            io.onSystem?.("Nothing to expand — no tool output yet.\n");
          }
          return;
        }
        if (isSessionInfoCommand(command.name)) {
          showSessionInfo();
          return;
        }
        if (isFlowsCommand(command.name)) {
          showFlows();
          return;
        }
        if (isWorkspaceCommand(command.name)) {
          showWorkspace();
          return;
        }
        if (isReviewCommand(command.name)) {
          showReview();
          return;
        }
        if (routeOpsCommand(line, false, ops)) {
          return;
        }
        if (routeSchedulesCommand(line, false, schedules)) {
          return;
        }
        if (isMcpConsumerCommand(command.name)) {
          showMcpConsumer();
          return;
        }
        if (isMcpToolsCommand(command.name)) {
          showTools();
          return;
        }
        if (command.name === "/bus") {
          runBusCommand(line);
          return;
        }
        if (command.name === "/copy") {
          // Always the newest block: a slash command can only be submitted from
          // the composer, and in nav mode the composer is blurred — so there is
          // no reachable "focused block wins" case to honor here (`y` covers it).
          // Falls back to the last fenced code block in the reply text when
          // there is no registered block (a fence has no registry entry).
          if (!copyNewestOrLastCode()) {
            io.onSystem?.("Nothing to copy yet.\n");
          }
          return;
        }
        if (command.name === "/theme") {
          const arg = line.trim().split(/\s+/).slice(1).join(" ").trim();
          if (arg.length > 0) {
            const next = parseThemeId(arg);
            if (next === undefined) {
              io.onSystem?.(`Unknown theme '${arg}'.\n${formatThemeList(getThemeId())}`);
              return;
            }
            applyThemeId(next, r.themeMode);
            persistThemeId(next);
            chrome.showToast(`Theme: ${themeLabel(next)}`);
            return;
          }
          openThemePicker(otui, chrome, {
            current: getThemeId(),
            mode: r.themeMode,
            renderer: r,
            ...inspectorKeys,
            onApply: (id) => {
              applyThemeId(id, r.themeMode);
              persistThemeId(id);
              chrome.showToast(`Theme: ${themeLabel(id)}`);
            },
          });
          return;
        }
        if (command.name === "/game") {
          showGame(line);
          return;
        }
        if (command.name === "/mode") {
          runModeCommand(line);
          return;
        }
        if (command.name === "/reasoning") {
          // Flow 268 T16 (AC11). No arg: show the effective level and its
          // precedence source. With an arg: set THIS session's override
          // (mutating the live `deps` directly so the very next turn picks
          // it up — see `AgentDeps.reasoningEffort`'s doc comment on why a
          // plain mutable field, not a getter, is enough here), thread it to
          // `commands/shell.ts` via `opts.setReasoningOverride` so a later
          // `/model`/`/connect` rebuild keeps it, and persist it to
          // `ShellConfig` so a fresh `keryx shell` process keeps it too.
          const wanted = line.trim().split(/\s+/).slice(1).join(" ").trim();
          if (wanted.length === 0) {
            const described = describeReasoningEffortSource({
              sessionOverride: reasoningOverride,
              globalEffort: loadShellConfig().reasoningEffort,
            });
            io.onSystem?.(
              `Reasoning effort: ${described.effort} (${described.source})\n` +
                `Usage: /reasoning <${REASONING_EFFORT_LEVELS.join("|")}>\n`,
            );
          } else if (!isReasoningEffortLevel(wanted)) {
            io.onSystem?.(
              `Unknown reasoning effort '${wanted}'. Choose one of: ${REASONING_EFFORT_LEVELS.join(", ")}\n`,
            );
          } else {
            reasoningOverride = wanted;
            opts.setReasoningOverride?.(wanted);
            deps.reasoningEffort = wanted;
            saveShellConfig({ reasoningEffort: wanted });
            io.onSystem?.(`Reasoning effort: ${wanted}\n`);
            const compatProvider = providerByName(currentSel.provider);
            if (compatProvider !== undefined && compatProvider.reasoning === undefined) {
              io.onSystem?.(
                `Note: ${currentSel.provider} is OpenAI-compatible with no "reasoning" entry — its reasoning ` +
                  "is configured per-provider in llm-providers.json (reasoning.requestParams); this setting has no effect for it.\n",
              );
            }
          }
          return;
        }
        if (command.name === "/plan") {
          runPlanCommand(line);
          return;
        }
        if (command.name === "/model") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const prov = detected.find((d) => d.name === currentSel.provider);
            // Registered providers fetch their live, filterable list; others use detected.
            const models = prov !== undefined ? await modelsForPicker(prov) : undefined;
            const notice =
              prov === undefined || models === undefined
                ? undefined
                : modelPickerNotice(prov.label ?? prov.name, models);
            const chosen = await chrome.withOverlay(() => pickModelInTui(otui, chrome, models?.models ?? [], notice));
            if (chosen !== undefined) {
              await switchTo(
                currentSel.baseUrl === undefined
                  ? { provider: currentSel.provider, model: chosen }
                  : { provider: currentSel.provider, model: chosen, baseUrl: currentSel.baseUrl },
              );
              // SLATE-2a `/model`-switch Anchors auto-inject (AC4). `switchTo`
              // already reassigned `currentSel` above, so it carries the NEW
              // provider/model here. Wrapped so a slate read/write failure
              // degrades silently rather than aborting a model switch that
              // already succeeded (mirrors the `closeSlateSession` close
              // triggers elsewhere in this file, which are similarly
              // best-effort bookkeeping around a real user-visible action).
              try {
                await applyRuntimeSwitchToSlate({
                  slateSession,
                  runtime: { provider: currentSel.provider, model: currentSel.model },
                  history,
                  // Review finding 6: without this, the pushed Anchors-block
                  // message is not archived/persisted until some UNRELATED
                  // later event happens to fire `onHistoryChange`.
                  onHistoryChange: io.onHistoryChange,
                });
              } catch (err) {
                io.onSystem?.(
                  `slate anchors update failed (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
                );
              }
            } else {
              input.focus();
            }
          })();
          return;
        }
        if (command.name === "/interrupt") {
          io.onSystem?.("◇ no active main turn to interrupt.\n");
          return;
        }
        if (command.name === "/queue") {
          // The queue only exists while main is busy (FIFO-drain empties it
          // the instant a turn frees up), so outside a busy turn it is empty.
          io.onSystem?.("◇ main queue is empty.\n");
          return;
        }
        if (command.name === "/delegate") {
          runDelegate(line);
          return;
        }
        if (command.name === "/connect" || command.name === "/provider") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const ns = await chrome.withOverlay(() =>
              command.name === "/connect"
                ? selectProviderModelInTui(otui, chrome, detected, { onlyConnected: true, env: process.env })
                : selectProviderModelInTui(otui, chrome, detected),
            );
            if (ns !== undefined) {
              await switchTo(ns);
            } else if (command.name === "/connect") {
              chrome.showToast("No connected providers found. Run /provider to configure one first.");
            }
            // Wizard steps close without refocusing the composer (flow 270), so
            // it comes back here, once, whichever way the wizard ended.
            input.focus();
          })();
          return;
        }
        openHelp(); // /help
        return;
      }
      if (line.startsWith("/")) {
        // A real command belonging to the OTHER mode (`/models`, `/provider`)
        // says so; only a genuinely unknown token is "unknown" (S4 parity with
        // the readline surfaces).
        io.onSystem?.(describeUnavailableCommand(line, "agent") ?? `Unknown command: ${line}\n`);
        io.onSystem?.(helpText());
        return;
      }
      // Flow 275 T7 (specification §4.3, AC4): a `turns` lease holding this
      // instance starts no new main-agent turn from an operator line — it
      // goes to the main queue instead, same as the busy-branch hold above,
      // and runs once the lease is released (`leaseHoldController`).
      // `task-notification`/`bus-message` origins are already kept out of
      // this point by their own wake sites' `isIdle` ("not held"); this is a
      // defensive no-op for either, never an empty-line turn or a queue push.
      if (leaseView()?.held() === true) {
        if (origin === "operator") {
          const id = `mq${mainQueueSeq++}`;
          mainQueue.push({ id, question: line, displayQuestion: displayLine });
          paintMainQueue();
          io.onSystem?.(`◇ ${leaseView()?.banner() ?? "held"} — queued as q${mainQueue.length}.\n`);
        }
        return;
      }
      const userEcho = appendUserEcho(otui, r, transcript, {
        id: `ub${uid++}`,
        line: displayLine,
        fullWidth: true,
      });
      chrome.registerUserPrompt(userEcho, displayLine);
      transcript.add(
        new otui.TextRenderable(r, {
          id: `h${uid++}`,
          content: otui.t`${roleChunk(otui, "accent", "●")} ${boldChunk(otui, "keryx")}  ${dimChunk(otui, hhmm())}`,
          marginTop: 1,
        }),
      );

      // Hard pre-router: "обогати вики" → list pages + interactive plan, then run
      // wikiEnrich in-process (no model thrash on search_code).
      if (isWikiEnrichIntent(line)) {
        const startedAt = Date.now();
        const operation = foregroundOperation.begin();
        // The busy flag is `startBusy`/`stopBusy` now (the chrome owns it); the
        // first statement of the IIFE below runs synchronously, so the shell is
        // marked busy before `runLine` returns, exactly as it was.
        void (async () => {
          try {
            startBusy("planning wiki enrich…");
            const plan = await planWikiEnrich(process.cwd());
            if (foregroundOperation.signal.aborted || foregroundOperation.isDisposed) return;
            stopBusy();

            const maxList = 40;
            const draftLines = plan.drafts.slice(0, maxList).map((p) => `  · ${p.relativePath}`);
            const moreDrafts =
              plan.drafts.length > maxList ? `  · … +${plan.drafts.length - maxList} more drafts` : "";
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-list${uid++}`,
                content: otui.t`${dimChunk(otui, 
                  [
                    `Wiki enrich plan: ${plan.drafts.length} draft · ${plan.accepted.length} accepted · ${plan.forceTargets.length} total`,
                    ...(plan.drafts.length > 0 ? ["Drafts:", ...draftLines, ...(moreDrafts ? [moreDrafts] : [])] : ["Drafts: (none)"]),
                    plan.accepted.length > 0
                      ? `Accepted (need --force): ${plan.accepted.length} page(s)`
                      : "Accepted: (none)",
                  ].join("\n"),
                )}`,
                marginTop: 1,
              }),
            );

            if (plan.forceTargets.length === 0) {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-empty${uid++}`,
                  content: otui.t`${roleChunk(otui, "attention", "No wiki pages found. Run `keryx wiki collect` first.")}`,
                }),
              );
              return;
            }

            const choice = await pickWikiEnrichMode(otui, r, chrome.dock, {
              draftCount: plan.drafts.length,
              acceptedCount: plan.accepted.length,
              total: plan.forceTargets.length,
            });
            if (foregroundOperation.signal.aborted || foregroundOperation.isDisposed) return;
            input.focus();

            if (choice === "cancel") {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-cancel${uid++}`,
                  content: otui.t`${dimChunk(otui, "Wiki enrich cancelled.")}`,
                }),
              );
              return;
            }

            if (choice === "drafts" && plan.drafts.length === 0) {
              transcript.add(
                new otui.TextRenderable(r, {
                  id: `we-nodraft${uid++}`,
                  content: otui.t`${roleChunk(otui, "attention", "No draft pages. Choose force enrich all, or collect new drafts.")}`,
                }),
              );
              return;
            }

            const force = choice === "force";
            const targets = force ? plan.forceTargets : plan.drafts;
            // Keep side workers; drop previous enrich page slots only.
            fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !isSideWorkerId(w.id));
            setMainAgent("running", force ? "force-all" : "drafts");
            for (const p of targets) {
              fleet.upsert({
                id: p.relativePath,
                label: shortWorkerLabel(p.relativePath),
                status: "queued",
                detail: "queued",
                model: `${currentSel.provider}/${currentSel.model}`,
              });
            }
            paintFleet();

            startBusy(`wiki enrich ${force ? "(force all)" : "(drafts)"}…`);
            const result = await wikiEnrich({
              cwd: process.cwd(),
              all: true,
              force,
              provider: currentSel.provider,
              model: currentSel.model,
              signal: foregroundOperation.signal,
              concurrency: 2, // small parallel swarm; raise via CLI for larger batches
              onPage: (info) => {
                if (foregroundOperation.signal.aborted || foregroundOperation.isDisposed) return;
                setBusyPhase(`enrich ${info.index}/${info.total} [${info.phase}] ${info.path}`);
                setMainAgent("running", `${info.index}/${info.total}`);
                const status =
                  info.phase === "done" ? "done" : info.phase === "failed" ? "failed" : "running";
                fleet.upsert({
                  id: info.path,
                  label: shortWorkerLabel(info.path),
                  status,
                  detail: info.phase,
                  model: `${currentSel.provider}/${currentSel.model}`,
                });
              },
            });
            if (foregroundOperation.signal.aborted || foregroundOperation.isDisposed) return;
            stopBusy();
            setMainAgent(
              result.failed > 0 && result.enriched === 0 ? "failed" : "done",
              `${result.enriched}ok/${result.failed}fail`,
            );
            // Leave final fleet state visible; clear on next enrich run.

            const lines = [
              `provider: ${result.provider} (${result.model})`,
              `credential: ${result.credentialAvailable ? "yes" : "no"}`,
              `mode: ${force ? "force (all statuses)" : "drafts only"}`,
              `enriched: ${result.enriched}  skipped: ${result.skipped}  failed: ${result.failed}`,
            ];
            for (const entry of result.pages.slice(0, 30)) {
              lines.push(`- ${entry.action}: ${entry.path}${entry.reason ? ` — ${entry.reason}` : ""}`);
            }
            if (result.pages.length > 30) {
              lines.push(`- … +${result.pages.length - 30} more`);
            }
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-res${uid++}`,
                content: otui.t`${dimChunk(otui, lines.join("\n"))}`,
                marginTop: 1,
              }),
            );
            history.push({ role: "user", content: line, provenance: "project" });
            history.push({
              role: "assistant",
              content: lines.join("\n"),
              provenance: "model",
            });
            try {
              saveSession();
            } catch {
              // best-effort
            }
          } catch (cause) {
            if (foregroundOperation.signal.aborted || foregroundOperation.isDisposed) return;
            stopBusy();
            transcript.add(
              new otui.TextRenderable(r, {
                id: `we-err${uid++}`,
                content: otui.t`${roleChunk(otui, "error", `wiki enrich failed: ${cause instanceof Error ? cause.message : String(cause)}`)}`,
              }),
            );
          } finally {
            const operationAborted = foregroundOperation.signal.aborted;
            foregroundOperation.settle(operation);
            finalizeWikiForegroundOperation(
              { aborted: operationAborted, disposed: foregroundOperation.isDisposed },
              {
                stopBusy,
                complete: () => {
                  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
                  transcript.add(
                    new otui.TextRenderable(r, {
                      id: `w${uid++}`,
                      content: otui.t`${dimChunk(otui, `worked for ${secs}s`)}`,
                      marginTop: 1,
                    }),
                  );
                  focusComposer(); // never steal focus from an active block-nav mode (R3)
                  if (!forceHandoff.isAwaitingSettlement) {
                    const next = forceHandoff.takeNext() ?? mainQueue.shift();
                    paintMainQueue();
                    if (next !== undefined) runLine(next.question);
                  }
                },
              },
            );
          }
        })();
        return;
      }

      // Clear enrich/page workers only — keep concurrent side workers visible.
      fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !isSideWorkerId(w.id));
      // A fresh turn starts with a clean subagent sidebar (and a fresh child
      // tool-call/runtime budget) instead of piling this turn's spawns on top
      // of whatever the previous turn(s) left behind.
      sessions.clear();
      deps.resetSubagentBudget?.();
      const operation = foregroundOperation.begin();
      // flow 268 T26: defensive reset — a missed `onReasoningEnd` from a
      // PRIOR turn (abort/error path; the root cause is fixed in
      // `commands/agent.ts`) must never leak stale live-preview text or
      // suppress this turn's own `onReasoningStart`. See `attachBlockIo`'s
      // doc comment.
      blockIo.resetReasoningLiveState();
      setMainAgent("running", "waiting");
      startBusy("waiting for model");
      const startedAt = Date.now();
      let turnFailed = false;
      const prevOnSystem = io.onSystem;
      io.onSystem = (text) => {
        if (/\[error\]|\[budget\]|\[stopped\]/i.test(text)) {
          turnFailed = true;
        }
        prevOnSystem?.(text);
      };
      // --- Claude-style "next step" suggestion (placeholder + Tab accept) ---
      // After a settled main turn with an empty queue, ask the model for ONE
      // short follow-up and show it as the composer placeholder. Fail-closed:
      // no credential, a timeout, an error, a superseded/cancelled request
      // (AC14 — see `suggestionGate`), or a sanitizer-discarded reply simply
      // shows nothing — never blocks the shell, never throws into the turn's
      // finally chain.
      const suggestNextStep = async (): Promise<void> => {
        const { signal, isCurrent } = suggestionGate.start();
        try {
          // Flow 268 T18 (AC12): the advisor must never see reasoning text.
          // `buildNextStepPrompt` reads `role` and `content` and nothing else,
          // so that guarantee is now a property of a tested function rather
          // than of this closure's current text (flow 277).
          const prompt = buildNextStepPrompt(history);
          const result = await runModelTurn({
            // AC14: the CURRENT selection — `/connect`/`/model` may have
            // rebuilt `currentSel` since this turn started.
            provider: currentSel.provider,
            model: currentSel.model,
            system: prompt.system,
            user: prompt.user,
            maxOutputTokens: 40,
            requestId: `suggest-next-step-${Date.now()}`,
            signal,
          });
          // A new turn, a new suggestion request, or composer activity may
          // have superseded/cancelled this one while it was in flight — a
          // late reply must never reach the composer (AC14).
          if (!isCurrent() || !result.credentialAvailable) {
            return;
          }
          const next = sanitizeNextStepSuggestion(result.text);
          if (next === undefined) return;
          chrome.showSuggestion(next);
        } catch {
          // fail-closed: never surface an error for an optional hint
          // (including an aborted request — AbortError lands here too)
        }
      };
      const foregroundIo = createForegroundAgentIoFacade(foregroundOperation, operation, io);
      void runAgentTurn(foregroundIo, deps, history, line, {
        signal: foregroundOperation.signal,
        ...(origin === "operator" ? {} : { origin }),
        ...(slateSession !== undefined ? { slateSession } : {}),
      }).finally(() => {
        foregroundOperation.settle(operation);
        if (foregroundOperation.isDisposed) return;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        stopBusy();
        // SLATE-16 binds a workspace mid-turn, on the action-intent turn's
        // FIRST action — the sidebar can only reflect that once the turn
        // that decided it has actually settled.
        void refreshWorkspaceSidebar();
        // A settled turn may have proposed something, or wrap-up may have
        // just run — the "keryx itself periodically figures out what needs
        // review" behavior this badge exists for.
        void refreshReviewSidebar();
        // Flow 300 (AC7): whatever the turn wrote — a trigger record, a new
        // governance report — reaches the sidebar now, not on the next tick.
        void ops.afterTurn();
        setMainAgent(turnFailed ? "failed" : "done", turnFailed ? "error" : "idle");
        try {
          flushSessionCheckpoint();
        } catch {
          // best-effort persist
        }
        transcript.add(
          new otui.TextRenderable(r, { id: `w${uid++}`, content: otui.t`${dimChunk(otui, `worked for ${secs}s`)}`, marginTop: 1 }),
        );
        // No exact provider usage → show an estimated context size (never stuck at 0).
        if (!hasExactUsage) {
          const est = estimateContextTokens(history);
          chrome.setHeaderMeta(`~${fmtTokens(est)}`);
          sbContext.content = otui.t`${dimChunk(otui, `~${est.toLocaleString()} tokens (est)`)}`;
        }
        focusComposer(); // never steal focus from an active block-nav mode (R3)
        // Only suggest a next step when nothing is already queued — a queued
        // turn is the real next step and would immediately overwrite the hint.
        if (!forceHandoff.hasPending && mainQueue.length === 0 && !turnFailed) {
          void suggestNextStep();
        }
        // A forced item (AC6) wins over FIFO order — it is the reason the
        // turn just settled. Otherwise FIFO-drain the head of the main queue
        // (AC7), once the current one has fully settled (stopBusy/setMainAgent
        // already ran).
        if (!forceHandoff.isAwaitingSettlement) {
          const next = forceHandoff.takeNext() ?? mainQueue.shift();
          paintMainQueue();
          if (next !== undefined) {
            runLine(next.question);
          } else {
            // Flow 274 T7 (specification §5.3): "on turn settle, when
            // busInbox still holds wake-eligible messages" — only once there
            // is no queued operator item to run instead (same FIFO-first
            // rule as the task-notification wake below).
            busWakeController?.onSettle();
          }
        }
      });
    };

    // --- flow 265 (AC7/AC8): wake on a finished task, only when idle ---------
    //
    // Subscribed HERE rather than beside the store's `setBackgroundJobListener`
    // (which runs far earlier): `runLine` is defined above this point, and a
    // listener registered before it would close over a binding that is not
    // initialised yet.
    //
    // Idle means both halves — nothing running in the foreground AND nothing
    // the operator queued. A queued message is the real next step and the
    // settle handlers keep draining it first; a notification that jumped that
    // queue would answer a question nobody asked yet. Flow 275 T7
    // (specification §4.3, AC4): a `turns` lease holding this instance is a
    // third reason to stay "not idle" — same rule the bus-wake controller's
    // own `isIdle` enforces right below.
    deps.jobRegistry?.onCompletion(() => {
      const busy = chrome.isBusy() || foregroundOperation.isActive;
      const idle = !busy && mainQueue.length === 0 && leaseView()?.held() !== true;
      if (!idle) {
        return;
      }
      if (consecutiveAutoWakes >= resolveMaxAutoWake()) {
        io.onSystem?.(
          "◇ a shell task finished; automatic wakes are capped, so it will be reported with your next message.\n",
        );
        return;
      }
      consecutiveAutoWakes += 1;
      runLine("", "task-notification");
    });

    // --- flow 274 (agent bus P3, T7; specification §5.3): wake on a bus
    // message, only when idle — same idle test, same shared
    // `consecutiveAutoWakes` counter/cap as the task-notification wake
    // immediately above. Assigned here (not inline where `onPeers`/the
    // turn-settle site call it) for the SAME reason that wake is subscribed
    // here rather than earlier: `runLine`, `mainQueue` and
    // `consecutiveAutoWakes` are all declared above this point, in scope now.
    //
    // review r1 F11: the decision/print/wake wiring itself now lives in
    // `createBusWakeController` (`./bus-wake.ts`), unit-tested directly there
    // (`bus-wake.test.ts`) instead of only through this file's source text.
    // review r1 F4: `hasBusDeps` guards against waking while a poll lands
    // during the join-success `deps` rebuild's own `await`, before
    // `deps.busInbox`/`deps.busAck` are attached — a wake right then would
    // start a turn with nothing to drain, burning the auto-wake budget on an
    // empty round.
    busWakeController = createBusWakeController({
      // Flow 275 T7 (specification §4.3, AC4): "not held" joins the SAME
      // idle test the task-notification wake uses right below — a `turns`
      // lease holding this instance must block a bus wake exactly like it
      // blocks every other route into a new main-agent turn.
      isIdle: () =>
        !destroyed &&
        !chrome.isBusy() &&
        !foregroundOperation.isActive &&
        mainQueue.length === 0 &&
        leaseView()?.held() !== true,
      inbox: busInbox,
      getWakes: () => consecutiveAutoWakes,
      incWakes: () => {
        consecutiveAutoWakes += 1;
      },
      cap: () => resolveMaxAutoWake(),
      runWake: () => runLine("", "bus-message"),
      printCapped: () => {
        io.onSystem?.(BUS_WAKE_CAPPED_NOTICE);
      },
      hasBusDeps: () => deps.busInbox !== undefined,
    });

    // Flow 275 (agent bus P4, T7; specification §5.2 step 5, AC4): drains the
    // queue the moment a `turns` lease releases this instance — the SAME
    // "forced item first, else FIFO head" rule the turn-settle handler above
    // uses (`forceHandoff.takeNext() ?? mainQueue.shift()`), and skipped
    // outright while a turn is still busy (that turn's own settle drains the
    // queue once it finishes; draining here too would double-dispatch).
    leaseHoldController = createLeaseHoldController({
      isHeld: () => leaseView()?.held() === true,
      onRelease: () => {
        if (chrome.isBusy() || foregroundOperation.isActive || forceHandoff.isAwaitingSettlement) return;
        const drained = forceHandoff.takeNext() ?? mainQueue.shift();
        paintMainQueue();
        if (drained !== undefined) runLine(drained.question);
      },
    });

    // --- block navigation mode (Ctrl+O … Esc) — flow 109 D-3 ----------------
    // The mode itself is `createBlockNavController` (transcript-blocks.ts); all
    // that is left here is subscribing it. Registered through the `onKeypress`
    // wrapper rather than by reaching for the private `_internalKeyInput` symbol
    // directly (risk R2); the chrome's `/`-menu router is the other consumer.
    onKeypress(r, (key) => {
      nav.handleKey(key);
    });

    // --- queue-nav mode (Ctrl+Q ... Esc) -- flow 170 T5 ---------------------
    // Same subscription mechanism as block-nav directly above; the mode's own
    // arbitration is via `chrome.addOverlaySource` (registered next to
    // `queueNavActive`'s declaration), not a new key-routing primitive.
    onKeypress(r, (key) => {
      handleQueueNavKey(key);
    });

    // Both a composer Enter and a `/`-menu selection arrive here: the chrome has
    // already trimmed the line, cleared the composer and closed the dropdown.
    chrome.onSubmit((line) => {
      runLine(line);
    });

    await done;
    return true;
  } catch {
    return false;
  } finally {
    // review r1 F9: leave the bus before releasing the lease (specification
    // §5.4's order) — idempotent either way, the exit paths above usually
    // did both already.
    leaveBusThenRelease({
      leaveBus: () => liveBus?.leave(),
      releaseLease: () => sessionLease.release(),
    });
    await herdr.release(); // hand the pane back to herdr (no-op outside herdr)
    try {
      renderer?.destroy();
    } catch {
      // best-effort teardown
    }
    // Flow 300 review F4: a run-now child is never killed with the shell. Say,
    // once and after the alternate screen is gone, that it keeps running and
    // where its output goes; the ledger watcher shows its outcome next start.
    // Review N6: read what is STILL running at print time, not dispose()'s snapshot.
    liveSchedules?.dispose();
    liveOps?.dispose();
    const detachedNote = describeDetachedRuns(liveOps?.inFlightRuns() ?? []);
    if (detachedNote !== undefined) process.stderr.write(`${detachedNote}\n`);
  }
}
