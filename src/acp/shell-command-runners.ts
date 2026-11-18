// The runners behind `_keryx/command` (Keryx Desktop Client M2a, specification §3.9.1).
//
// Each runner reuses the text function `keryx shell`'s readline REPL (or the TUI's
// one-shot text surface) already prints with, and returns what the shell would print.
// None imports an OpenTUI module: where a text function lived in `src/tui/` next to a
// renderer it was moved to a neutral `*-text.ts` / `*-command.ts` file first.
//
// A runner is not a turn: it takes no prompt slot of its own and appends nothing to the
// model's history. What a command needs from the running server (the session's history,
// mode, shell tasks, lease) arrives through {@link ShellCommandHost}, so this file never
// reaches into `server.ts` state and the table stays testable without a connection.

import type { AcpModelChoice } from "./models";
import { parseDemoteCommand } from "../commands/agent-commands";
import { buildDoctorReport, formatDoctorReport } from "../commands/doctor";
import { approvalsSlashText } from "../commands/approvals";
import { permissionsSlashText } from "../commands/permissions-command";
import { remotePolicyText } from "../commands/remote-policy-command";
import { renderSetupSlash } from "../commands/setup-guide";
import { runJevContractForShell } from "../tui/jev-contract-command";
import { runJevRiskForShell } from "../tui/jev-risk-command";
import { runJevRulesForShell } from "../tui/jev-rules-command";
import { runJevScenariosForShell } from "../tui/jev-scenarios-command";
import { runJevTriageForShell } from "../tui/jev-triage-command";
import { runStaledocsForShell } from "../tui/jev-docs-command";
import { runOpencommentsForShell } from "../tui/jev-comments-command";
import { runFlowOriginForShell } from "../tui/flow-origin-command";
import { runExternalAgentsCommand, renderExternalStatusLines } from "../tui/external-command";
import { runRenderingCommand } from "../tui/rendering-command";
import { runDiagCommand } from "../tui/diag-command";
import { runNotesCommand, runTrailCommand } from "../tui/working-memory-command";
import { runTasksCommand } from "../tui/tasks-command";
import { conversationHistoryText } from "../tui/conversation-history";
import { findFlowItem, formatFlowDetailText, formatFlowListText } from "../tui/flow-inspector-text";
import { loadInspectorFlows } from "../tui/inspector-sources";
import { loadReviewDepth } from "../tui/review-panel";
import {
  isReviewLayersCommand,
  isReviewParityCommand,
  isReviewReadinessCommand,
  renderReviewLayersText,
  renderReviewParityText,
  renderReviewReadinessText,
  readlineReviewsText,
} from "../tui/reviews-inspector-text";
import { readlineRemoteControlText } from "../tui/remote-control-text";
import { loadChannelsSnapshot, readlineChannelsText } from "../tui/channels-text";
import { readlineIntakeText } from "../tui/intake-text";
import { defaultExternalDiffDeps, externalDiffSlashText } from "../tui/external-diff-text";
import { buildSettingsRows, formatSettingsTable } from "../tui/settings-model";
import { loadSettingsSnapshot } from "../tui/settings-state";
import { parseProjectContextCommand } from "../tui/project-context-command";
import { setEditGuardText, setProjectContextText } from "../tui/setting-toggles";
import { ChannelsClient } from "../remote/channels-client";
import { catalogResolver, parseMcpTrustCommand, runMcpTrustCommand } from "../mcp-servers/approval-render";
import { demoteTask, type JobRegistry } from "../harness/tool/builtin/background-job-registry";
import { resolveJevApiKey } from "../harness/decision/jev-client";
import type { SearchProviderController, SearchProviderDescriptor } from "../harness/search";
import { resolveExternalSetting, writeUserExternalSetting } from "../lib/external-switch";
import { loadExternalProvidersConfig } from "../lib/external-providers";
import { loadShellConfig, saveShellConfig, updateShellConfig } from "../lib/shell-config";
import { executePlanCommand } from "../session/commands/plan-command";
import { compactSession } from "../session/compact";
import { LOST_LEASE_COMPACT_REFUSAL } from "../session/lease";
import { persistHistory, type SessionHandle } from "../session";
import { createRewindReadlineCommand, type RewindReadlineCommand } from "../rewind/readline-command";
import { createRewindRecorder, rewindDisabledByEnv, type RewindRecorder } from "../rewind/recorder";
import type { NormalizedMessage } from "../harness/provider/types";
import type { PermissionMode } from "../commands/permission-mode";
import { acpCommandHelpText } from "./commands";
import { syncAcpArchive, type AcpArchiveCursor } from "./session";
import { ACP_SHELL_COMMAND_TABLE, type ShellCommandRow } from "./shell-commands";
import { join as joinPath } from "node:path";
import type { ScheduleSlashDeps } from "../tui/schedule-command";
import type { ShellView } from "./shell-views";
import { runAcpGoal } from "./shell-goal";
import type { DelegateTerminalLaunch, SessionExternalRuns } from "./shell-delegate";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import { busView, editGuardView, guardView, mcpView, projectContextView, runJevProfile, runRouting } from "./shell-views-config";
import { runAc, runCi, runConform, runDecisions, runReadOnlyView, runReview } from "./shell-views-review";
import { runAutoReview, runGovernance, runSchedule, runSchedules, runTask, runTriggers } from "./shell-views-ops";
import { refusal, viewOutcome } from "./shell-views-outcome";

/** What a command changed, so the client refreshes without parsing text (§3.9.1). */
export type ShellCommandEffect = "mode" | "model" | "config" | "plan" | "transcript" | "tasks" | "startTurn" | "openTerminal";

export interface ShellCommandOutcome {
  readonly text: string;
  readonly effects?: readonly ShellCommandEffect[];
  /** A known command refused in the current state: the reason is `text`. */
  readonly refused?: true;
  /** A picker, modal or form command's structured view (§3.9.1 "Views"); `text` is its plain rendering. */
  readonly view?: ShellView;
  /** With the `startTurn` effect: the exact turn text the client sends as `session/prompt` (`/goal`). */
  readonly prompt?: string;
  /** With the `openTerminal` effect: the interactive run the client starts in its terminal (`/delegate`, D-14). */
  readonly terminal?: DelegateTerminalLaunch;
}

/** The session a transcript command works on: the live history (mutated in place) and what persists it. */
export interface ShellCommandSession {
  readonly history: NormalizedMessage[];
  readonly archive: AcpArchiveCursor;
  handle(): SessionHandle;
  setHandle(handle: SessionHandle): void;
  canPersist(): boolean;
  /** Provider and model ids recorded with a persisted transcript. */
  modelIds(): { providerId: string; modelId: string };
}

/** What the running server lends a command. Everything else a runner reads from the project or the user config. */
export interface ShellCommandHost {
  readonly cwd: string;
  /** The user-global config directory the settings commands read and write. `keryxConfigDir()` when absent. */
  readonly configDir?: string | undefined;
  readonly session: ShellCommandSession;
  sessionDir(): string | undefined;
  permissionMode(): PermissionMode;
  reasoningOverride(): string | undefined;
  readOnly(): boolean;
  setReadOnly(on: boolean): void;
  jobs(): JobRegistry;
  searchController(): SearchProviderController;
  /** `/help`'s `/status`-style answers the server owns: `status`, `model`, `reasoning`, `mode`. */
  serverCommand(name: string, args: string): Promise<ShellCommandOutcome>;
  rewind(): RewindReadlineCommand;
  /** The models the session may switch to (the picker's own list of connected providers); the `/schedule` form offers only the ones its usage rule accepts. */
  modelChoices?(): Promise<readonly AcpModelChoice[]>;
  /** `/goal`: the session's slate, kept for its life (a `SlateSessionRef` is per session, as in the shells). */
  slate(): SlateSessionRef | undefined;
  /** `/goal`: the turn text the client is about to send. */
  goalStarted(prompt: string): void;
  /** `/delegate`: this session's external runs, with the approval and the fleet events the server owns. */
  externalRuns(): SessionExternalRuns;
  /** Test seam for `/schedule`: the timer host, clock and credential checks `runScheduleSlashCommand` takes. Production leaves it unset. */
  readonly scheduleOverrides?: Omit<Partial<ScheduleSlashDeps>, "cwd" | "defaults" | "print" | "confirm"> | undefined;
}

type Runner = (host: ShellCommandHost, args: string, row: ShellCommandRow) => Promise<ShellCommandOutcome | undefined>;

const text = (value: string, effects?: readonly ShellCommandEffect[]): ShellCommandOutcome => ({
  text: value,
  ...(effects !== undefined && effects.length > 0 ? { effects } : {}),
});
const refused = (value: string): ShellCommandOutcome => ({ text: value, refused: true });
const failure = (label: string, error: unknown): string =>
  `${label}: ${error instanceof Error ? error.message : String(error)}\n`;
const words = (args: string): string[] => args.split(/\s+/).filter((word) => word.length > 0);

/** `/help`: the whole served table, grouped the way `keryx help` groups it. */
export function shellCommandHelpText(): string {
  return `Commands keryx handles in the desktop client:\n${acpCommandHelpText(ACP_SHELL_COMMAND_TABLE)}`;
}

// ---------------------------------------------------------------------------
// Transcript commands: persist exactly as the readline shell does.
// ---------------------------------------------------------------------------

/** `/compact [focus]`, as `commands/shell.ts` runs it. The caller has already refused it while a turn runs. */
function compact(host: ShellCommandHost, focus: string): ShellCommandOutcome {
  const { session } = host;
  syncAcpArchive(session.archive, session.history);
  if (!session.canPersist()) return refused(LOST_LEASE_COMPACT_REFUSAL.trim());
  const { providerId, modelId } = session.modelIds();
  const packed = compactSession(session.handle(), session.history, session.archive.messages, {
    keepLastUserTurns: 3,
    ...(focus.length > 0 ? { focus } : {}),
    provider: providerId,
    model: modelId,
  });
  session.setHandle(packed.handle);
  if (packed.result.noop) return text("Nothing to compact (context already small).\n");
  // In place: the server holds this array for the session's whole life.
  session.history.splice(0, session.history.length, ...packed.context);
  session.archive.next = session.history.length;
  return text(
    `Compacted −${packed.result.removed} context msgs · archive ${packed.handle.summary.archiveMessageCount} · compact×${packed.handle.summary.compactCount}\n`,
    ["transcript"],
  );
}

/** What `server.ts` builds once per session for `/rewind`: the snapshot recorder and the readline state machine over it. */
export interface AcpSessionRewind {
  readonly recorder: RewindRecorder;
  readonly command: RewindReadlineCommand;
}

export function createAcpSessionRewind(input: {
  readonly root: string;
  readonly session: ShellCommandSession;
  /** The session's own directory in the keryx session store; snapshots live in `rewind/` under it. */
  readonly sessionDir: () => string | undefined;
  readonly onError: (message: string) => void;
}): AcpSessionRewind {
  const { session } = input;
  const recorder = createRewindRecorder({
    workTree: input.root,
    dir: () => {
      const dir = input.sessionDir();
      return dir === undefined ? undefined : joinPath(dir, "rewind");
    },
    enabled: () => !rewindDisabledByEnv() && session.canPersist(),
    onError: input.onError,
  });
  const command = createRewindReadlineCommand({
    recorder,
    hasSession: () => true,
    history: () => session.history,
    archive: () => session.archive.messages,
    syncArchive: () => syncAcpArchive(session.archive, session.history),
    canPersist: () => session.canPersist(),
    persist: (nextHistory, nextArchive) => {
      const { providerId, modelId } = session.modelIds();
      session.setHandle(persistHistory(session.handle(), nextHistory, { archive: nextArchive, provider: providerId, model: modelId }));
    },
    afterHistoryRewind: () => {
      session.archive.next = session.history.length;
    },
  });
  return { recorder, command };
}

// ---------------------------------------------------------------------------
// Text runners
// ---------------------------------------------------------------------------

const RUN_JEV: Readonly<Record<string, { label: string; run: (cwd: string) => Promise<string> }>> = {
  risk: { label: "review-jev-risk", run: (cwd) => runJevRiskForShell(cwd) },
  scenarios: { label: "review-jev-scenarios", run: (cwd) => runJevScenariosForShell(cwd) },
  jevrules: { label: "review-jev-rules", run: (cwd) => runJevRulesForShell(cwd) },
  staledocs: { label: "review-jev-docs", run: (cwd) => runStaledocsForShell(cwd) },
  contract: { label: "review-jev-contract", run: (cwd) => runJevContractForShell(cwd) },
  triage: { label: "review-jev-triage", run: (cwd) => runJevTriageForShell(cwd) },
};

async function reviewSubText(cwd: string, args: string): Promise<string | undefined> {
  const line = `/review ${args}`;
  const render = isReviewLayersCommand(line)
    ? renderReviewLayersText
    : isReviewParityCommand(line)
      ? renderReviewParityText
      : isReviewReadinessCommand(line)
        ? renderReviewReadinessText
        : undefined;
  if (render === undefined) return undefined;
  try {
    return render(await loadReviewDepth(cwd));
  } catch {
    return "The managed reviews could not be read.\n";
  }
}

async function flowsText(cwd: string, args: string): Promise<string> {
  const items = await loadInspectorFlows(cwd);
  if (args.length === 0) return formatFlowListText(items);
  const found = findFlowItem(items, args);
  return found !== undefined ? formatFlowDetailText(found) : `No flow matching '${args}'.\n`;
}

function describeSearchProviders(title: string, providers: readonly SearchProviderDescriptor[]): string {
  const rows = providers.map((provider) => `${provider.id} (${provider.displayName})`);
  return `${title}\n${rows.length > 0 ? rows.join("\n") : "  (none configured)"}\n`;
}

async function searchConnect(controller: SearchProviderController, args: string): Promise<ShellCommandOutcome> {
  const [providerId] = words(args);
  if (providerId === undefined) {
    const selectable = controller.selectable();
    const list = describeSearchProviders("Connected search providers (use /search-connect <id> to select):", selectable);
    return text(selectable.length === 0 ? `${list}No connected search providers found. Run /search-provider first.\n` : list);
  }
  const normalized = controller.configurable().find((candidate) => candidate.id === providerId)?.id;
  if (normalized === undefined) return refused(`Unknown provider '${providerId}'.`);
  const result = await controller.select(normalized);
  if (result.ok) return text(`Search provider '${providerId}' selected.\n`, ["config"]);
  if (result.reason === "not-configured") return refused(`Cannot select '${providerId}': provider is not configured.`);
  if (result.reason === "not-connected") {
    return refused(`Cannot select '${providerId}': provider is not connected (run /search-provider ${providerId} <params> to test).`);
  }
  return refused(`Cannot select '${providerId}': ${result.reason}.`);
}

async function settingsText(host: ShellCommandHost): Promise<string> {
  const rows = buildSettingsRows(
    await loadSettingsSnapshot(
      host.cwd,
      { permissionMode: host.permissionMode(), plan: host.readOnly(), reasoningOverride: host.reasoningOverride() },
      host.configDir,
    ),
  );
  return formatSettingsTable(rows, { available: new Set(ACP_SHELL_COMMAND_TABLE.map((row) => `/${row.name}`)) });
}

function planText(host: ShellCommandHost, args: string): ShellCommandOutcome {
  const [wanted, ...extra] = words(args);
  if (wanted === undefined) return text(`Read-only mode: ${host.readOnly() ? "on" : "off"}\nUsage: /plan [on|off]\n`);
  if ((wanted !== "on" && wanted !== "off") || extra.length > 0) return text("Usage: /plan [on|off]\n");
  executePlanCommand(wanted, { current: host.readOnly(), commit: (enabled) => host.setReadOnly(enabled) });
  return text(
    wanted === "on" ? "Read-only mode: on\n" : `Read-only mode: off (permission mode stays: ${host.permissionMode()})\n`,
    ["plan"],
  );
}

function demoteText(host: ShellCommandHost, args: string): ShellCommandOutcome {
  const parsed = parseDemoteCommand(args);
  if (!parsed.ok) return text(`${parsed.reason}\n`);
  const demoted = demoteTask(host.jobs(), parsed.taskId);
  if (!demoted.ok) return text(`${demoted.error}\n`);
  const overCap = demoted.overCap !== undefined ? ` Background tasks are over the cap; also running: ${demoted.overCap}.` : "";
  return text(`Task ${parsed.taskId} keeps running, now in the background — it was NOT stopped.${overCap}\n`, ["tasks"]);
}

/** `/route`, `/guard`: the user-global opt-ins. The running ACP turn has no classifier or guard, so these only persist. */
function routeText(host: ShellCommandHost, args: string): ShellCommandOutcome {
  const arg = args.trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    updateShellConfig(
      (current) => ({ ...current, routingClassifier: { ...(current.routingClassifier ?? {}), enabled: arg === "on" } }),
      host.configDir,
    );
    return text(`Route: ${arg}\n`, ["config"]);
  }
  if (arg.length > 0) return text(`Unknown /route argument '${arg}'. Usage: /route [on|off]\n`);
  return text(`Route: ${loadShellConfig(host.configDir).routingClassifier?.enabled === true ? "on" : "off"}\n`);
}

function guardText(host: ShellCommandHost, args: string): ShellCommandOutcome | undefined {
  const arg = args.trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    saveShellConfig({ turnGuard: { enabled: arg === "on" } }, host.configDir);
    return text(`Guard: ${arg}\n`, ["config"]);
  }
  if (arg.length > 0) return text(`Unknown /guard argument '${arg}'. Usage: /guard [on|off]\n`);
  return undefined;
}

async function editGuardText(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome | undefined> {
  const arg = args.trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    const done = await setEditGuardText(host.cwd, arg === "on");
    return done.changed === true ? text(done.text, ["config"]) : text(done.text);
  }
  if (arg.length > 0) return text(`Unknown /editguard argument '${arg}'. Usage: /editguard [on|off]\n`);
  return undefined;
}

async function projectContextText(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome | undefined> {
  const parsed = parseProjectContextCommand(`/projectctx ${args}`);
  if (parsed.kind === "invalid") return text(`${parsed.message}\n`);
  if (parsed.kind === "open") return undefined;
  const done = await setProjectContextText(host.cwd, parsed.mode);
  if (done.refused === true) return refused(done.text.trim());
  return done.changed === true ? text(done.text, ["config"]) : text(done.text);
}

async function externalText(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const arg = args.trim().toLowerCase();
  try {
    if (arg === "on" || arg === "off") {
      writeUserExternalSetting(arg, host.configDir);
      const status = await resolveExternalSetting({ cwd: host.cwd, ...(host.configDir !== undefined ? { dir: host.configDir } : {}) });
      return text(
        `External: ${status.value}${status.source === "project" ? " (this project overrides the per-user setting)" : ""}\n`,
        ["config"],
      );
    }
    if (arg.length > 0) return text(`Unknown /external argument '${arg}'. Usage: /external [on|off]\n`);
    const status = await resolveExternalSetting({ cwd: host.cwd, ...(host.configDir !== undefined ? { dir: host.configDir } : {}) });
    const { config } = loadExternalProvidersConfig();
    return text(`${renderExternalStatusLines(status, resolveJevApiKey(process.env) !== undefined, config).join("\n")}\n`);
  } catch (error) {
    return text(failure("external", error));
  }
}

const NO_BUS = "The agent bus is not joined over keryx acp, so /bus send, ask and reply have no peers to reach. Use keryx shell for bus messaging.";

const RUNNERS: Readonly<Record<string, Runner>> = {
  server: (host, args, row) => host.serverCommand(row.name, args),
  help: async () => text(`${shellCommandHelpText()}\n`),
  doctor: async (host) => text(`${formatDoctorReport(await buildDoctorReport(host.cwd))}\n`),
  setup: async (_host, args) => text(renderSetupSlash(args)),
  flows: async (host, args) => text(await flowsText(host.cwd, args)),
  history: async (host) => {
    const { archive, history } = host.session;
    return text(conversationHistoryText(archive.messages.length > 0 ? archive.messages : history));
  },
  trail: async (host, args) => text(await runTrailCommand(args, host.sessionDir())),
  notes: async (host, args) => text(await runNotesCommand(args, host.sessionDir())),
  diag: async () => text(runDiagCommand()),
  compact: async (host, args) => compact(host, args),
  rewind: async (host, args) => {
    const before = host.session.history.length;
    const output = await host.rewind().run(args);
    // Only a confirmed history rollback moves the transcript; a files-only rewind leaves it as it was.
    return text(output, host.session.history.length !== before ? ["transcript"] : undefined);
  },
  plan: async (host, args) => planText(host, args),
  tasks: async (host, args) =>
    text(await runTasksCommand(args, host.jobs()), words(args)[0] === "kill" ? ["tasks"] : undefined),
  demote: async (host, args) => demoteText(host, args),
  reviews: async (host) => text(await readlineReviewsText(host.cwd)),
  review: async (host, args) => {
    const sub = await reviewSubText(host.cwd, args);
    return sub === undefined ? undefined : text(sub);
  },
  "remote-control": async (_host, args) => text(readlineRemoteControlText(`/remote-control ${args}`.trim())),
  channels: async (_host, args) =>
    text(readlineChannelsText(`/channels ${args}`.trim(), await loadChannelsSnapshot(new ChannelsClient()))),
  intake: async (host, args) => text(await readlineIntakeText(`/intake ${args}`.trim(), { root: host.cwd })),
  rendering: async (host, args) =>
    text(runRenderingCommand(args, host.configDir), args.trim().length > 0 ? ["config"] : undefined),
  "remote-policy": async (host, args) =>
    text(
      remotePolicyText(args, { ...(host.configDir !== undefined ? { dir: host.configDir } : {}) }),
      args.trim().length > 0 ? ["config"] : undefined,
    ),
  permissions: async (_host, args) => text(permissionsSlashText(args)),
  approvals: async (_host, args) => text(approvalsSlashText(args)),
  "external-diff": async (host) => text(externalDiffSlashText(defaultExternalDiffDeps(host.cwd))),
  mcp: async (_host, args) => {
    const trust = parseMcpTrustCommand(`/mcp ${args}`);
    // Over ACP a tool call is asked on the client each time; there are no session grants to list or revoke.
    return trust === undefined ? undefined : text(`${runMcpTrustCommand(trust, new Map(), catalogResolver(undefined)).join("\n")}\n`);
  },
  settings: async (host) => text(await settingsText(host)),
  "search-connect": async (host, args) => searchConnect(host.searchController(), args),
  jev: async (host, _args, row) => {
    const jev = RUN_JEV[row.name];
    if (jev === undefined) return undefined;
    try {
      return text(`${await jev.run(host.cwd)}\n`);
    } catch (error) {
      return text(failure(jev.label, error));
    }
  },
  flow: async (host, args) => {
    try {
      return text(`${await runFlowOriginForShell(host.cwd, `/flow ${args}`.trim())}\n`);
    } catch (error) {
      return text(failure("flow origin", error));
    }
  },
  opencomments: async (host, args) => {
    const [repo, prArg] = words(args);
    const pr = prArg !== undefined ? Number(prArg) : Number.NaN;
    if (repo === undefined || !Number.isInteger(pr) || pr <= 0) return text("Usage: /opencomments <owner/repo> <pr>\n");
    try {
      return text(`${await runOpencommentsForShell(host.cwd, repo, pr)}\n`);
    } catch (error) {
      return text(failure("review-jev-comments", error));
    }
  },
  route: async (host, args) => routeText(host, args),
  guard: async (host, args) => guardText(host, args),
  editguard: (host, args) => editGuardText(host, args),
  projectctx: (host, args) => projectContextText(host, args),
  external: (host, args) => externalText(host, args),
  "external-agents": async (host, args) => text(await runExternalAgentsCommand(args, host.cwd, host.configDir)),
  goal: async (host, args) => {
    const answer = await runAcpGoal(
      {
        cwd: host.cwd,
        history: host.session.history,
        slate: () => host.slate(),
        modelIds: () => host.session.modelIds(),
        onHistoryChange: () => syncAcpArchive(host.session.archive, host.session.history),
        goalStarted: (prompt) => host.goalStarted(prompt),
      },
      args,
    );
    if (answer.refused === true) return refused(answer.text.trim());
    return { text: answer.text, ...(answer.prompt !== undefined ? { effects: ["startTurn" as const], prompt: answer.prompt } : {}) };
  },
  delegate: async (host, args) => {
    const answer = await host.externalRuns().delegate(args);
    if (answer.refused === true) return refused(answer.text.trim());
    return answer.terminal !== undefined ? { text: answer.text, effects: ["openTerminal" as const], terminal: answer.terminal } : text(answer.text);
  },
  bus: async (_host, args) => {
    const sub = words(args)[0];
    return sub === "send" || sub === "ask" || sub === "reply" || sub === "name" || (sub !== undefined && sub.startsWith("@"))
      ? refused(NO_BUS)
      : undefined;
  },
};

/** The view commands: bare, or with the text subcommands their actions send back. */
const VIEW_RUNNERS: Readonly<Record<string, (host: ShellCommandHost, args: string) => Promise<ShellCommandOutcome>>> = {
  routing: runRouting,
  ci: runCi,
  conform: runConform,
  task: runTask,
  review: runReview,
  product: (host, args) => runReadOnlyView(host, "product", args),
  governance: runGovernance,
  triggers: runTriggers,
  schedule: runSchedule,
  schedules: runSchedules,
  autoreview: runAutoReview,
  jevprofile: runJevProfile,
  ac: runAc,
  workspace: (host, args) => runReadOnlyView(host, "workspace", args),
  decisions: runDecisions,
  guard: async (host) => viewOutcome(guardView(host)),
  editguard: async (host) => viewOutcome(await editGuardView(host)),
  projectctx: async (host, args) => viewOutcome(await projectContextView(host, args.trim() === "refs" ? "references" : undefined)),
  mcp: async (host, args) =>
    args.trim().length === 0 ? viewOutcome(mcpView(host)) : refusal(`Unknown /mcp argument '${args.trim()}'. Usage: /mcp [trust list | trust revoke <server__tool> | all]`),
  bus: async (_host, args) => (args.trim().length === 0 ? viewOutcome(busView()) : refusal(NO_BUS)),
};

/**
 * Runs one served command. A text subcommand answers text; a view command answers its view.
 * `undefined` = neither covers these arguments: the caller answers with `viewNotServedText`.
 */
export async function runShellTextCommand(host: ShellCommandHost, row: ShellCommandRow, args: string): Promise<ShellCommandOutcome | undefined> {
  const runner = RUNNERS[row.runner];
  const answered = runner === undefined ? undefined : await runner(host, args, row);
  if (answered !== undefined || row.surface !== "view") return answered;
  return VIEW_RUNNERS[row.name]?.(host, args);
}
