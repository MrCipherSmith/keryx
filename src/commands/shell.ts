// Interactive `keryx` shell REPL (flow 021, T6 / AC1-AC4).
//
// `runShell(io, deps)` is the injectable, deterministic REPL core: it reaches NO
// real `process.stdin`/`process.stdout`/TTY. `io` supplies an async line source
// + a write sink; `deps` supplies a `ProviderPort` factory + `clock`/`idSeq` +
// the initial provider/model selection. It keeps an in-memory
// `history: NormalizedMessage[]` (empty at start) and turns each non-slash line
// into one provider streaming turn — see `.metaproject/flows/
// 021-2026-07-13-keryx-interactive-shell/acceptance-criteria.md` (AC1-AC2).
//
// `shellCommand(args)` is the thin TTY wrapper (NOT unit-tested): it wires a real
// `node:readline` line source over `process.stdin`, a `process.stdout` write
// sink, a wall-clock `clock`, a uuid `idSeq`, and a `makeProvider` factory that
// mirrors `harness.ts`'s provider selection (fake / ollama loopback grant /
// anthropic-with-ANTHROPIC_API_KEY). It writes NO managed flow state.
//
// Determinism: `runShell` uses ONLY `deps.clock`/`deps.idSeq` (never `Date.now`
// / `Math.random`). Offline: the core never imports a provider SDK or touches
// the network directly; all provider I/O flows through the injected port.

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { joinBus, type BusClient, type BusPeer } from "../bus/client";
import { displaySafe, formatBusEventLine, makeBusErrorReporter } from "../bus/display";
import { isBusRefusal } from "../bus/errors";
import { isAssignableBusName } from "../bus/schema";
// Flow 274 (agent bus P3, T7; specification §5.3): delivery to the agent —
// `createBusInbox`/`BusInbox` are T5's (`../bus/inbox.ts`).
import { createBusInbox, type BusInbox } from "../bus/inbox";
import { loadOAuthGrant } from "../lib/oauth/grants";
import { providerByName, resolveProviderModelParamsByName } from "./providers";
import { makeProvider } from "../harness/provider/make-provider";
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedUsage,
  ProviderPort,
} from "../harness/provider/types";
import { buildOrientation } from "../ctx/orient";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { buildApprovalContext } from "./agent-approval-context";
import { buildInteractiveAgentTools, interactiveAgentToolNames } from "./interactive-agent-tools";
import { createFileEventSink, type ShellEvent, type ShellEventSink } from "./shell-events";
import { evaluateShellApproval, formatShellApprovalHints, rememberExactShellGrant } from "./shell-approval";
import { catalogResolver, isMcpToolCall, promptUseToolApproval } from "../mcp-servers/approval-render";
import { createDefaultSearchProviderController } from "../harness/search";
import type { SearchProviderDescriptor, SearchProviderId } from "../harness/search";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import { createLazyRunExternal } from "../harness/run-external-factory";
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import { resolveProjectRoot } from "../lib/contained-path";
import { createMcpRuntime, type McpRuntime } from "../mcp-servers/runtime";

/**
 * Say so when an MCP config file could not be read.
 *
 * On stderr, once, at session start. A malformed `mcp-servers.json` yields
 * zero servers, and zero servers is indistinguishable from "MCP was never
 * configured" — the operator then looks for a bug in the server they just
 * added rather than a comma in the file they just wrote. `createMcpRuntime`
 * carries these instead of throwing precisely so the shell can still open;
 * carrying them and never printing them would be the worse half of that
 * bargain.
 */
function reportMcpProblems(runtime: McpRuntime): void {
  for (const problem of runtime.problems()) {
    console.error(`keryx mcp: ${problem.file} ${problem.message}`);
  }
}
import { emitBackgroundJob } from "../tui/job-bridge";
import { emitSubagentFleet } from "../tui/subagent-bridge";
import { approveExternalSpawn, externalRunBridgeObserver } from "../tui/external-bridge";
import { exportCallerSession } from "../lib/caller-session";
import { collapseHome } from "../lib/statusbar";
import { LiveMarkdownBlock } from "../lib/live-render";
import { applyThemeId, formatThemeList, getThemeId, parseThemeId, persistThemeId, themeLabel } from "../tui/theme";
import { estimateContextTokens, launchTuiAgentShell } from "../tui/tui-shell";
import { launchTuiChatShell } from "../tui/chat-shell";
import { findFlowItem, formatFlowDetailText, formatFlowListText, isFlowsCommand } from "../tui/flow-inspector";
import { loadInspectorFlows, loadInspectorWorkspaces } from "../tui/inspector-sources";
import {
  buildSessionInfoSnapshot,
  formatSessionInfoText,
  isSessionInfoCommand,
} from "../tui/session-info";
import { loadSessionLimits } from "./model-limits";
import { applySavedApiKeys, envWithSavedApiKeys, loadShellConfig, saveShellConfig } from "../lib/shell-config";
import { formatReasoningOneLiner, resolveThinkDisplayMode } from "../tui/reasoning-display";
import { loadShellPermissions, parseShellExecCommand, shellPermissionsFingerprint } from "../lib/shell-permissions";
import { extractPatchText } from "../lib/patch-risk";
import { describeElicitationPrompt, MCP_ELICITATION_TOOL_PREFIX } from "../mcp-client/elicitation";
import { getProjectPermissionMode, setProjectPermissionMode } from "../lib/permission-mode-config";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from "./permission-mode";
import {
  collapseToolOutput,
  colorEnabled,
  indentBlock,
  renderDiff,
  renderMarkdown,
  style,
  summarizeToolArgs,
} from "../lib/ui";
import { blockLabel, looksLikeUnifiedDiff } from "../lib/md-blocks";
import {
  checkVersion,
  formatVersionUpdateAdvisory,
  type VersionCheckResult,
} from "../lib/version-check";
import packageJson from "../../package.json" with { type: "json" };
import { describeUnavailableCommand, parseDemoteCommand, renderCommandHelp } from "./agent-commands";
// Flow 266 (AC8): the demote EFFECT lives with the registry, not with either
// shell, so both dispatch into the same rule instead of growing two.
import { demoteTask } from "../harness/tool/builtin/background-job-registry";
import {
  type AgentDeps,
  type AgentIO,
  buildAgentSystemInstruction,
  describeReasoningEffortSource,
  isReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
  resolveAgentMaxOutputTokens,
  resolveAgentMaxRounds,
  resolveMaxAutoWake,
  resolveReasoningEffort,
  runAgentTurn,
} from "./agent";
import { type DetectedProvider, detectProviders, pickAgentMode, pickProviderModel } from "./select";
import type { ShellDeps, ShellIO, ShellModelParams, ShellSessionOpts } from "./shell-types";
import {
  compactSession,
  createSession,
  exportSessionMarkdown,
  persistCompacted,
  persistHistory,
  shortSessionId,
  type SessionHandle,
} from "../session";
import {
  latestUnleasedSession,
  openLeasedSession,
  releaseSessionLease,
  SessionLeasedError,
  type SessionLeaseHandle,
  gateBoxByLease,
  LOST_LEASE_COMPACT_REFUSAL,
  switchLeasedSession,
  watchLeaseLoss,
} from "../session/lease";
import {
  describeLeasedSession,
  describeSkippedSession,
  type LeasedChoice,
  leasedChoiceRows,
} from "../session/lease-choice";
import { closeSlateSession, mintTimestampAttemptId, type SlateSessionRef } from "../session/slate-lifecycle";
import { detachSlateSession } from "../session/slate-lifecycle";
import { runGoalCommand } from "./goal-command";
import { invokeAskUserHost } from "../tui/ask-user-bridge";

export type { ShellDeps, ShellIO, ShellSessionOpts } from "./shell-types";

/** A short, trusted system instruction assembled by the (trusted) shell itself. */
const SYSTEM_INSTRUCTION =
  "You are the keryx interactive shell assistant. Be economical with output tokens: " +
  "lead with the conclusion, give the shortest correct answer, prefer bullet points over " +
  "prose, and omit preamble and restated context.";

/** Static guidance for `/connect` — never reads/echoes an actual credential. */
const CONNECT_GUIDANCE = [
  "To use Anthropic (claude-*) models, set the ANTHROPIC_API_KEY environment",
  "variable before launching keryx, e.g.:",
  "",
  "  export ANTHROPIC_API_KEY=your-anthropic-key",
  "",
  "keryx reads ANTHROPIC_API_KEY from the environment only — it never stores,",
  "logs, or echoes the key. Then run /provider to pick the anthropic provider.",
  "",
].join("\n");

/**
 * Help text for chat mode. The command list is DERIVED from the shared registry
 * (`agent-commands.ts`) rather than duplicated here, so chat's menu and the TUI's
 * can never drift; only the session footer is chat-specific.
 */
const HELP_TEXT = [
  renderCommandHelp("chat"),
  "Sessions are per-project. Resume: keryx shell -c | -r [id]",
  "Context counter is an estimate (~4 chars/token); chat has no provider usage hook.",
  "",
].join("\n");

/**
 * Commands the readline AGENT REPL actually implements. Agent mode as a whole
 * offers more (`/model`, `/connect`, `/think`, `/copy`, `/resume` — all TUI
 * pickers or block operations that have no readline equivalent), so this surface
 * advertises its own subset while still taking the WORDING from the registry.
 */
const READLINE_AGENT_COMMANDS: readonly string[] = [
  "/help",
  "/expand",
  "/search-provider",
  "/search-connect",
  "/new",
  "/goal",
  "/clear",
  "/compact",
  "/status",
  "/flows",
  "/theme",
  "/mode",
  "/reasoning",
  "/plan",
  "/exit",
];

/** Agent-REPL help: registry-derived command list + the agent-specific preamble. */
export function readlineAgentHelpText(): string {
  return (
    "Agent mode — describe a task; tools: get_cwd, list_dir, read_file, search_code, " +
    "graph_affected, memory_search, web_fetch, web_search, shell_exec (approval).\n" +
    renderCommandHelp("agent", READLINE_AGENT_COMMANDS) +
    "Sessions are per-project: keryx shell -c | -r [id] | keryx sessions list\n"
  );
}

// ---------------------------------------------------------------------------
// Bus wiring shared by the readline chat and agent REPLs (flow 273 T6,
// specification §5.1, §5.2, §5.4, §7.2's non-pause subset). Both loops join
// with `joinBus` (`../bus/client.ts`) after their session lease is settled,
// render inbound events through their own system-output path, and dispatch
// `/bus` through `runBusSlashCommand`. Neither loop reimplements the
// join/heartbeat/poll sequence itself.
// ---------------------------------------------------------------------------

/** Age formatting for `/bus [list]`; mirrors `keryx bus list`'s own (`src/commands/bus.ts`). */
function formatBusAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** `bus: joined as @<name> · <n> peers` (specification §5.1), with the D-06 rename note when it applies. */
function formatBusJoinLine(bus: BusClient): string {
  const note = bus.nameWasTaken ? " (requested name was already taken)" : "";
  return `bus: joined as @${displaySafe(bus.name)} · ${bus.peers().length} peers${note}\n`;
}

/** The `/bus [list]` peers table, for a surface with no fleet sidebar. */
function formatBusPeersTable(peers: readonly BusPeer[]): string {
  if (peers.length === 0) return "bus: no live or stale peers.\n";
  const rows = peers.map(
    (peer) =>
      `  @${displaySafe(peer.record.name)} · ${peer.state} · ${peer.record.status} · ${formatBusAge(peer.ageMs)} · ${displaySafe(peer.record.activity)}\n`,
  );
  return `bus: ${peers.length} peer(s)\n${rows.join("")}`;
}

/** A `BusRefusal` prints its own named code; anything else prints its message. Never thrown further (§5.2). */
function busErrorLine(error: unknown): string {
  if (isBusRefusal(error)) return `bus: ${error.message}\n`;
  return `bus: ${error instanceof Error ? error.message : String(error)}\n`;
}

type BusSlashCommand =
  | { kind: "list" }
  | { kind: "send"; to: string; text: string }
  | { kind: "ask"; to: string; text: string }
  | { kind: "reply"; ref: string; text: string }
  | { kind: "name"; name: string }
  | { kind: "usage"; message: string };

/** Pure parse of `/bus <argument>` (specification §7.2's non-pause subset). */
function parseBusSlashCommand(argument: string): BusSlashCommand {
  const trimmed = argument.trim();
  if (trimmed.length === 0 || trimmed === "list") {
    return { kind: "list" };
  }
  // `/bus @name text` shorthand for `/bus send @name text`.
  if (trimmed.startsWith("@")) {
    const spaceIndex = trimmed.indexOf(" ");
    const text = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1).trim();
    if (spaceIndex < 0 || text.length === 0) {
      return { kind: "usage", message: "Usage: /bus @name <text>\n" };
    }
    return { kind: "send", to: trimmed.slice(0, spaceIndex), text };
  }
  const spaceIndex = trimmed.indexOf(" ");
  const sub = spaceIndex < 0 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1).trim();
  if (sub === "send") {
    const restSpace = rest.indexOf(" ");
    const text = restSpace < 0 ? "" : rest.slice(restSpace + 1).trim();
    if (!rest.startsWith("@") || restSpace < 0 || text.length === 0) {
      return { kind: "usage", message: "Usage: /bus send @name <text>\n" };
    }
    return { kind: "send", to: rest.slice(0, restSpace), text };
  }
  if (sub === "ask") {
    const restSpace = rest.indexOf(" ");
    const text = restSpace < 0 ? "" : rest.slice(restSpace + 1).trim();
    if (!rest.startsWith("@") || restSpace < 0 || text.length === 0) {
      return { kind: "usage", message: "Usage: /bus ask @name <text>\n" };
    }
    return { kind: "ask", to: rest.slice(0, restSpace), text };
  }
  if (sub === "reply") {
    const restSpace = rest.indexOf(" ");
    const text = restSpace < 0 ? "" : rest.slice(restSpace + 1).trim();
    if (restSpace < 0 || text.length === 0) {
      return { kind: "usage", message: "Usage: /bus reply <#seq|id-prefix> <text>\n" };
    }
    return { kind: "reply", ref: rest.slice(0, restSpace), text };
  }
  if (sub === "name") {
    if (rest.length === 0) {
      return { kind: "usage", message: "Usage: /bus name <new-name>\n" };
    }
    return { kind: "name", name: rest };
  }
  return {
    kind: "usage",
    message: `Unknown /bus subcommand '${sub}'. Usage: /bus [list|send @name|ask @name|reply <#seq|id-prefix>|name] <text>\n`,
  };
}

/**
 * `/bus` dispatch shared by both readline REPLs. `/bus reply <ref> text`
 * resolves `ref` (a `#seq`, bare seq, or an id/short-id prefix — whatever the
 * `⇄ [#seq] @from kind: preview` line showed) and sends to the ORIGINAL
 * sender's instance id through `BusClient.reply` (review r1 F4), so a sender
 * who renamed since is still reached. A bus error — including an unresolved
 * ref, a `BusRefusal("unknown-message")` — is never thrown further: it prints
 * one line and the loop continues (specification §5.2).
 */
async function runBusSlashCommand(bus: BusClient | undefined, argument: string, emit: (text: string) => void): Promise<void> {
  if (bus === undefined) {
    emit("bus: not joined for this session.\n");
    return;
  }
  const parsed = parseBusSlashCommand(argument);
  try {
    if (parsed.kind === "list") {
      emit(formatBusPeersTable(bus.peers()));
    } else if (parsed.kind === "send") {
      await bus.send(parsed.to, "notice", parsed.text);
      emit(`bus: sent to ${parsed.to}\n`);
    } else if (parsed.kind === "ask") {
      await bus.send(parsed.to, "question", parsed.text);
      emit(`bus: asked ${parsed.to}\n`);
    } else if (parsed.kind === "reply") {
      const result = await bus.reply(parsed.ref, parsed.text);
      emit(`bus: replied to ${displaySafe(result.event.toLabel)}\n`);
    } else if (parsed.kind === "name") {
      await bus.rename(parsed.name);
      emit(`bus: renamed to @${parsed.name}\n`);
    } else {
      emit(parsed.message);
    }
  } catch (cause) {
    emit(busErrorLine(cause));
  }
}

// The skipped-session line and the choice list live in `session/lease-choice.ts`
// so the TUI shares them; re-exported here for the existing importers.
export { describeSkippedSession, type LeasedChoice };

/**
 * Bare `-r` without the TUI picker (readline, no TTY): the latest session no
 * other shell has open (specification §6.1, AC4), announcing through `emit`
 * the held session it passed over, as `-c` does. `undefined` when there is no
 * such session; the caller then starts a new one.
 */
export function bareResumeTarget(cwd: string, emit: (text: string) => void): string | undefined {
  const pick = latestUnleasedSession(cwd);
  if (pick.skipped !== undefined) {
    emit(describeSkippedSession(pick.skipped));
  }
  return pick.summary?.id;
}

/** Open options for a leased REPL session, from the caller's session opts. */
function leasedOpenOptions(
  session: ShellSessionOpts | undefined,
  cwd: string,
  provider: string,
  model: string,
): Parameters<typeof openLeasedSession>[0] {
  return {
    cwd,
    ...(session?.continueLast === true ? { continueLast: true } : {}),
    ...(session?.resumeId !== undefined ? { resumeId: session.resumeId } : {}),
    ...(session?.fork === true ? { fork: true } : {}),
    ...(session?.takeOver === true ? { takeOver: true } : {}),
    provider,
    model,
  };
}

/**
 * A brand-new leased session: the fallback after an open that failed for any
 * reason other than a lease. `undefined` when even that fails; the caller then
 * starts an unleased session rather than no session at all.
 */
function openFreshLeasedSession(
  open: typeof openLeasedSession,
  cwd: string,
  provider: string,
  model: string,
): { handle: SessionHandle; lease: SessionLeaseHandle } | undefined {
  try {
    const opened = open({ cwd, provider, model });
    return { handle: opened.handle, lease: opened.lease };
  } catch {
    return undefined;
  }
}

/** The line source and sink `resolveLeasedChoice` prompts through. */
export interface LeasedChoiceIO {
  write: (text: string) => void;
  /** The next line typed, or `undefined` at end of input. */
  readLine: () => Promise<string | undefined>;
}

/**
 * Ask what to do about a `-r <id>` whose session another shell holds: fork
 * (the default), view read-only, cancel, and take over only when the holder is
 * stale (specification §6.1, AC3). End of input cancels. An answer that is not
 * one of the offered rows asks again.
 */
export async function resolveLeasedChoice(io: LeasedChoiceIO, error: SessionLeasedError): Promise<LeasedChoice> {
  const rows = leasedChoiceRows(error);
  io.write(`${describeLeasedSession(error)}\n` + rows.map((row, index) => `  ${index + 1}) ${row.label}\n`).join(""));
  for (;;) {
    io.write(`Choose [1-${rows.length}, default 1]: `);
    const line = await io.readLine();
    if (line === undefined) {
      io.write("\n");
      return "cancel";
    }
    const answer = line.trim().toLowerCase();
    if (answer.length === 0) {
      return "fork";
    }
    const byNumber = /^\d+$/.test(answer) ? rows[Number(answer) - 1] : undefined;
    const byName = rows.find(
      (row) => row.choice === answer || row.choice.replace("-", " ") === answer || row.choice.replace("-", "") === answer,
    );
    const picked = byNumber ?? byName;
    if (picked !== undefined) {
      return picked.choice;
    }
    io.write(`Not one of the choices: ${line.trim()}\n`);
  }
}

/** Runtime seams for `runWithLeaseChoice`; production passes real stdio. */
export interface LeaseChoiceRuntime {
  /** `process.stdin.isTTY`: whether a person can answer the choice. */
  isTty: boolean;
  io: LeasedChoiceIO;
  /** stderr: where the non-interactive refusal goes. */
  writeError: (text: string) => void;
  /** Renders the session for `view` (printed through `io.write`). Default `exportSessionMarkdown`. */
  exportSession?: (cwd: string, sessionId: string) => string;
}

/**
 * Run a readline REPL (`run`) and handle a `SessionLeasedError` from its open
 * (specification §6.1, AC2/AC3):
 *
 * - without a TTY, the error message (it names `--fork`, plus `or --take-over`
 *   when stale) goes to stderr and the result is exit code 1; nothing is
 *   opened, so nothing is written to the held session;
 * - with a TTY, `resolveLeasedChoice` decides: fork or take over re-open the
 *   same id with that flag, view prints the session and then starts a NEW
 *   session, cancel returns exit code 0 having opened nothing.
 *
 * Returns the exit code to set, or `undefined` when the REPL ran.
 */
export async function runWithLeaseChoice(
  session: ShellSessionOpts,
  run: (session: ShellSessionOpts) => Promise<void>,
  runtime: LeaseChoiceRuntime,
): Promise<number | undefined> {
  let current = session;
  for (;;) {
    try {
      await run(current);
      return undefined;
    } catch (error) {
      if (!(error instanceof SessionLeasedError)) {
        throw error;
      }
      if (!runtime.isTty) {
        runtime.writeError(`${error.message}\n`);
        return 1;
      }
      const choice = await resolveLeasedChoice(runtime.io, error);
      const base: ShellSessionOpts = {
        cwd: current.cwd,
        ...(current.enabled !== undefined ? { enabled: current.enabled } : {}),
        ...(current.leaseBox !== undefined ? { leaseBox: current.leaseBox } : {}),
        ...(current.openLeased !== undefined ? { openLeased: current.openLeased } : {}),
        // Flow 273 T6: a lease-conflict retry (fork/view/take-over) re-opens
        // under a NEW `ShellSessionOpts` — without carrying these forward the
        // re-opened REPL would silently lose its requested bus name/surface
        // and the caller's `busBox` handle for the SIGINT/SIGTERM leave().
        ...(current.busName !== undefined ? { busName: current.busName } : {}),
        ...(current.busSurface !== undefined ? { busSurface: current.busSurface } : {}),
        ...(current.busBox !== undefined ? { busBox: current.busBox } : {}),
      };
      if (choice === "cancel") {
        return 0;
      }
      if (choice === "view") {
        // Read-only: the export only reads the held session's files.
        try {
          const render = runtime.exportSession ?? ((cwd: string, id: string) => exportSessionMarkdown(cwd, id));
          runtime.io.write(`${render(current.cwd, error.summary.id)}\n`);
        } catch (cause) {
          runtime.io.write(`Could not render the session: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
        current = base;
      } else if (choice === "fork") {
        current = { ...base, resumeId: error.summary.id, fork: true };
      } else {
        current = { ...base, resumeId: error.summary.id, takeOver: true };
      }
    }
  }
}

/**
 * The chat TUI's driver (flow 271, AC3): `run` (normally `runShell`) behind
 * `runWithLeaseChoice`, so a held `-r <id>` offers fork / view / cancel (/ take
 * over when stale) in the chat transcript instead of ending the shell with an
 * error. The prompt goes out through `onSystem`, and the answer is the next
 * composer line, read from the same `io.lines` the driver reads afterwards.
 * `notes` (the bare `-r` skipped-session line) are shown first.
 *
 * Returns the exit code to set (`0` after cancel), or `undefined` when the
 * driver ran.
 */
export async function runLeasedChatShell(
  io: ShellIO,
  deps: ShellDeps,
  run: (io: ShellIO, deps: ShellDeps) => Promise<void> = runShell,
  notes: readonly string[] = [],
): Promise<number | undefined> {
  const system = (text: string): void => {
    if (io.onSystem !== undefined) {
      io.onSystem(text);
    } else {
      io.write(text);
    }
  };
  for (const note of notes) {
    system(note);
  }
  if (deps.session === undefined) {
    await run(io, deps);
    return undefined;
  }
  let iterator: AsyncIterator<string> | undefined;
  const runtime: LeaseChoiceRuntime = {
    isTty: true,
    io: {
      write: system,
      readLine: async () => {
        iterator ??= io.lines[Symbol.asyncIterator]();
        const next = await iterator.next();
        return next.done === true ? undefined : next.value;
      },
    },
    writeError: system,
  };
  return runWithLeaseChoice(deps.session, (session) => run(io, { ...deps, session }), runtime);
}

/**
 * The injectable REPL core. Iterates `io.lines`; slash commands are handled
 * inline (never call `provider.stream`), every other non-blank line is one
 * streaming turn whose request carries the FULL accumulated history.
 */
export async function runShell(io: ShellIO, deps: ShellDeps): Promise<void> {
  let providerName = deps.initial.provider;
  let modelName = deps.initial.model;
  let baseUrl = deps.initial.baseUrl;
  // flow 268: resolved per-provider `temperature`/`maxOutputTokens`/
  // `timeoutMs` overrides; `{}` (the default) reproduces today's request
  // byte-for-byte (AC3).
  let modelParams = deps.initial.modelParams ?? {};
  const parentRunId = deps.idSeq();

  // Every NON-token line goes through `onSystem` when a rich wrapper supplies it,
  // else falls back to `write` (byte-identical to the pre-flow-031 behavior).
  const system = (text: string): void => {
    if (io.onSystem !== undefined) {
      io.onSystem(text);
    } else {
      io.write(text);
    }
  };

  const sessionCwd = deps.session?.cwd ?? process.cwd();
  const sessionsOn = deps.session !== undefined && deps.session.enabled !== false;
  let live: SessionHandle | undefined;
  let history: NormalizedMessage[] = [];
  let archive: NormalizedMessage[] = [];
  // The session lease this loop holds (specification §6). Mirrored into the
  // caller's `leaseBox` so a signal handler outside the loop can release it.
  let lease: SessionLeaseHandle | undefined;
  // Review F1: once another shell takes this session's lease, this loop stops
  // saving it (every persist below goes through `leaseWatch.canPersist()`) and
  // says so once.
  const leaseWatch = watchLeaseLoss((message) => system(message));
  const holdLease = (next: SessionLeaseHandle | undefined): void => {
    lease = next;
    leaseWatch.track(next);
    if (deps.session?.leaseBox !== undefined) deps.session.leaseBox.current = next;
  };
  const openLeased = deps.session?.openLeased ?? openLeasedSession;
  if (sessionsOn) {
    try {
      const opened = openLeased(leasedOpenOptions(deps.session, sessionCwd, providerName, modelName));
      holdLease(opened.lease);
      if (opened.skipped !== undefined) {
        system(describeSkippedSession(opened.skipped));
      }
      live = opened.handle;
      history = opened.history;
      archive = opened.archive.length > 0 ? [...opened.archive] : [...opened.history];
      if (opened.archiveDegraded !== undefined) {
        // Said out loud. A resume that quietly drops the archive reports a
        // shorter conversation than the session has, and the operator has no
        // way to tell that from a session that was genuinely that short.
        system(`Archive unavailable — resumed from the active context (${opened.archiveDegraded})\n`);
      }
      if (opened.resumed) {
        system(
          `Resumed session ${shortSessionId(live.summary.id)} · ${live.summary.title} (${history.length} context msgs)\n`,
        );
      }
    } catch (cause) {
      // Another shell holds the session: the top level decides (fork, view,
      // cancel, take over, or exit 1 without a TTY). Never a silent new session.
      if (cause instanceof SessionLeasedError) {
        throw cause;
      }
      const fresh = openFreshLeasedSession(openLeased, sessionCwd, providerName, modelName);
      holdLease(fresh?.lease);
      live = fresh?.handle ?? createSession({ cwd: sessionCwd, provider: providerName, model: modelName });
      history = [];
      archive = [];
      system(`${cause instanceof Error ? cause.message : String(cause)}\nStarting a new session.\n`);
    }
  }
  const releaseLease = (): void => {
    releaseSessionLease(lease);
    holdLease(undefined);
  };

  // Flow 273 T6: join the bus once the session lease is settled (specification
  // §5.1). A bus failure of any kind prints one line and never stops the shell
  // (§5.2) — there is no persistent session to join a bus for otherwise.
  let busWorking = false;
  const busStatus = (): { status: "idle" | "working" | "blocked"; activity: string } => ({
    status: busWorking ? "working" : "idle",
    activity: live?.summary.title ?? "keryx chat",
  });
  let bus: BusClient | undefined;
  if (sessionsOn && live !== undefined) {
    try {
      const joined = await joinBus({
        cwd: sessionCwd,
        sessionId: live.summary.id,
        surface: deps.session?.busSurface ?? "readline",
        ...(deps.session?.busName !== undefined ? { requestedName: deps.session.busName } : {}),
        shellConfig: loadShellConfig(),
        env: process.env,
        // review r1 F2: a GETTER, read at every use (join, each heartbeat,
        // after rename, inside setSession) — never a captured value. `/new`
        // swaps `lease` via `holdLease`; reading it here always sees the
        // CURRENT lease, so the new lease's name is never left null.
        sessionLease: () => lease,
        status: busStatus,
        onEvent: (event) => system(`${formatBusEventLine(event)}\n`),
        onPeers: () => {},
        // review r1 F10: a throttled printer, so a persistently failing poll
        // or heartbeat prints at most one line per window instead of once
        // per interval forever.
        onError: makeBusErrorReporter(system),
      });
      if ("disabled" in joined) {
        system(`bus: off (${joined.disabled})\n`);
      } else {
        bus = joined;
        if (deps.session?.busBox !== undefined) deps.session.busBox.current = bus;
        system(formatBusJoinLine(joined));
      }
    } catch (cause) {
      system(busErrorLine(cause));
    }
  }
  const leaveBus = (): void => {
    bus?.leave();
    if (deps.session?.busBox !== undefined) deps.session.busBox.current = undefined;
  };

  const save = (): void => {
    if (live === undefined || !leaseWatch.canPersist()) {
      return;
    }
    try {
      live = persistHistory(live, history, {
        archive,
        provider: providerName,
        model: modelName,
      });
    } catch {
      // best-effort
    }
  };

  const makeActive = (): ProviderPort =>
    baseUrl === undefined
      ? deps.makeProvider(providerName, modelName)
      : deps.makeProvider(providerName, modelName, baseUrl);

  // Create once at start; recreated on `/model` / `/provider` switches below.
  let provider = makeActive();

  /**
   * Apply a `{provider, model, baseUrl?, modelParams?}` selection from the
   * interactive picker (shared by the `/models` and no-arg `/provider`
   * commands): update the active selection and recreate the provider.
   * Behavior-preserving extraction.
   */
  const applySelection = (picked: {
    provider: string;
    model: string;
    baseUrl?: string;
    modelParams?: ShellModelParams;
  }): void => {
    providerName = picked.provider;
    modelName = picked.model;
    baseUrl = picked.baseUrl;
    modelParams = picked.modelParams ?? {};
    provider = makeActive();
  };

  for await (const line of io.lines) {
    io.onSafeBoundary?.();
    // Slash commands FIRST — a slash line NEVER reaches `provider.stream`.
    if (line.startsWith("/")) {
      const parts = line.trim().split(/\s+/);
      const command = parts[0] ?? "";
      const argument = parts.slice(1).join(" ");

      if (command === "/exit" || command === "/quit") {
        leaveBus();
        releaseLease();
        return;
      }
      if (command === "/bus") {
        await runBusSlashCommand(bus, argument, system);
        continue;
      }
      if (command === "/help") {
        system(HELP_TEXT);
        continue;
      }
      if (isSessionInfoCommand(command)) {
        const cwd = deps.session?.cwd;
        const [workspaces, flows] =
          cwd === undefined
            ? [[], []]
            : await Promise.all([loadInspectorWorkspaces(cwd), loadInspectorFlows(cwd)]);
        system(
          formatSessionInfoText(
            buildSessionInfoSnapshot({
              summary: live?.summary,
              selection: { provider: providerName, model: modelName },
              version: packageJson.version,
              estimateTokens: estimateContextTokens(history),
              limits: await loadSessionLimits({
                provider: providerName,
                model: modelName,
                ...(baseUrl !== undefined ? { baseUrl } : {}),
              }),
              sessionText: history.map((message) => message.content).join("\n"),
              workspaces,
              flows,
            }),
          ),
        );
        continue;
      }
      if (isFlowsCommand(command)) {
        const cwd = deps.session?.cwd;
        const items = cwd === undefined ? [] : await loadInspectorFlows(cwd);
        const query = argument.trim();
        if (query.length > 0) {
          const found = findFlowItem(items, query);
          system(found !== undefined ? formatFlowDetailText(found) : `No flow matching '${query}'.\n`);
          continue;
        }
        system(formatFlowListText(items));
        continue;
      }
      if (command === "/theme") {
        const wanted = argument.trim();
        if (wanted.length === 0) {
          system(formatThemeList(getThemeId()));
          continue;
        }
        const next = parseThemeId(wanted);
        if (next === undefined) {
          system(`Unknown theme '${wanted}'.\n${formatThemeList(getThemeId())}`);
          continue;
        }
        applyThemeId(next);
        persistThemeId(next);
        system(`Theme: ${themeLabel(next)}\n`);
        continue;
      }
      if (command === "/clear" || command === "/new") {
        if (sessionsOn) {
          // §6.2: lease the new session first, release the current one after.
          // A refusal keeps the current session and its lease.
          try {
            const next = switchLeasedSession(lease, () =>
              openLeased({ cwd: sessionCwd, provider: providerName, model: modelName }),
            );
            holdLease(next.lease);
            live = next.handle;
          } catch (cause) {
            system(`${cause instanceof Error ? cause.message : String(cause)}\nKept the current session.\n`);
            continue;
          }
          history = [];
          archive = [];
          // AC8: presence.sessionId follows every in-process session switch.
          // review r1 F5: the client already reports a write failure through
          // `onError` and never rejects; this catch is a defensive second
          // layer so a failure can never escape into the REPL regardless.
          try {
            await bus?.setSession(live.summary.id);
          } catch (cause) {
            system(busErrorLine(cause));
          }
          system(`New session ${shortSessionId(live.summary.id)} (previous kept on disk)\n`);
        } else {
          history.length = 0;
        }
        continue;
      }
      if (command === "/compact") {
        if (live === undefined) {
          system("No persistent session in this mode.\n");
          continue;
        }
        if (!leaseWatch.canPersist()) {
          system(LOST_LEASE_COMPACT_REFUSAL);
          continue;
        }
        const focus = argument.trim();
        const packed = compactSession(live, history, archive, {
          keepLastUserTurns: 3,
          ...(focus.length > 0 ? { focus } : {}),
          provider: providerName,
          model: modelName,
        });
        live = packed.handle;
        history = packed.context;
        if (packed.result.noop) {
          system("Nothing to compact (context already small).\n");
        } else {
          system(
            `Compacted: removed ${packed.result.removed} msgs from context · archive ${live.summary.archiveMessageCount} · compact×${live.summary.compactCount}\n`,
          );
        }
        continue;
      }
      if (command === "/model") {
        if (argument.length > 0) {
          modelName = argument;
          provider = makeActive();
        }
        continue;
      }
      if (command === "/models") {
        if (deps.selectProviderModel === undefined) {
          system("Interactive model selection is not available in this session.\n");
          continue;
        }
        const picked = await deps.selectProviderModel(io, { onlyProvider: providerName });
        applySelection(picked);
        continue;
      }
      if (command === "/provider") {
        if (argument.length > 0) {
          // Explicit by-name switch (keeps the model + baseUrl selection).
          providerName = argument;
          provider = makeActive();
          continue;
        }
        if (deps.selectProviderModel === undefined) {
          system("Interactive provider selection is not available in this session.\n");
          continue;
        }
        // Pass an empty opts object (no `onlyProvider`) → full re-selection.
        const picked = await deps.selectProviderModel(io, {});
        applySelection(picked);
        continue;
      }
      if (command === "/connect") {
        if (deps.selectProviderModel === undefined) {
          system(CONNECT_GUIDANCE);
          continue;
        }
        const picked = await deps.selectProviderModel(io, { onlyConnected: true });
        applySelection(picked);
        continue;
      }
      // A real command that belongs to the OTHER mode (`/expand`, `/think`,
      // `/copy`, `/resume`) fails with a reason, not a bare "unknown command".
      const wrongMode = describeUnavailableCommand(command, "chat");
      if (wrongMode !== undefined) {
        system(wrongMode);
        continue;
      }
      system(`Unknown command: ${command}. Type /help for commands.\n`);
      continue;
    }

    // A blank line is a no-op (never an empty model turn).
    if (line.trim().length === 0) {
      continue;
    }

    // A normal line is one turn: push the user message, then stream a reply.
    history.push({ role: "user", content: line, provenance: "project" });

    // flow 268: absent `modelParams` (the default) reproduces today's request
    // byte-for-byte (AC3).
    const resolvedMaxOutputTokens = modelParams.maxOutputTokens ?? 1024;
    const request: NormalizedRequest = {
      providerId: providerName,
      modelId: modelName,
      systemInstruction: SYSTEM_INSTRUCTION,
      messages: [...history],
      budget: { maxOutputTokens: resolvedMaxOutputTokens, runReservation: resolvedMaxOutputTokens },
      ...(modelParams.temperature !== undefined ? { options: { temperature: modelParams.temperature } } : {}),
      stream: true,
      requestId: deps.idSeq(),
      parentRunId,
    };

    let accumulated = "";
    let errored = false;
    // A turn is now running: the bus heartbeat reports `working` until this
    // one settles, cleared right before the loop's trailing blank line below.
    busWorking = true;
    // Signal the start of a streamed reply so a rich wrapper can show a role
    // label + spinner; a no-op (no output) when no wrapper is attached.
    io.onTurnStart?.();
    try {
      const streamOptions = {
        attemptId: deps.idSeq(),
        ...(modelParams.timeoutMs !== undefined ? { timeoutMs: modelParams.timeoutMs } : {}),
      };
      for await (const event of provider.stream(request, streamOptions)) {
        if (event.kind === "text_delta") {
          const text = event.text ?? "";
          io.write(text);
          accumulated += text;
        } else if (event.kind === "provider_error") {
          const detail = event.error?.message ?? event.error?.kind ?? "provider error";
          system(`\n[error] ${detail}\n`);
          errored = true;
          break;
        } else if (event.kind === "model_end") {
          break;
        }
      }
    } catch (cause) {
      // A reused adapter emits `provider_error` events rather than throwing, but
      // guard against an unexpected throw so one bad turn never ends the session.
      system(`\n[error] ${cause instanceof Error ? cause.message : String(cause)}\n`);
      errored = true;
    }

    // Hand the FULL accumulated reply to a rich wrapper for a markdown re-render
    // (any turn that streamed content, errored or not). No-op when unattached.
    if (accumulated.length > 0) {
      io.onTurnEnd?.(accumulated);
    }

    if (!errored) {
      history.push({ role: "assistant", content: accumulated, provenance: "model" });
      archive.push({ role: "user", content: line, provenance: "project" });
      archive.push({ role: "assistant", content: accumulated, provenance: "model" });
      save();
    } else if (accumulated.length > 0) {
      // A partial reply streamed before the error: keep it so the history stays
      // strictly alternating (user → assistant).
      history.push({ role: "assistant", content: accumulated, provenance: "model" });
      archive.push({ role: "user", content: line, provenance: "project" });
      archive.push({ role: "assistant", content: accumulated, provenance: "model" });
      save();
    } else {
      // No reply at all: drop the just-pushed user message so a failed turn leaves
      // no dangling user message (two consecutive user-role messages are rejected
      // by strict providers like the Anthropic Messages API).
      history.pop();
    }

    busWorking = false;
    // Terminate the streamed reply with a blank line so consecutive turns are
    // visually separated instead of running together on one line.
    io.onSafeBoundary?.();
    io.write("\n\n");
  }
  // End of input: the normal return releases the bus and the lease (AC7).
  leaveBus();
  releaseLease();
}

/**
 * Build the `makeProvider` factory mirroring `harness.ts`'s provider selection.
 * Construction is delegated to the shared `makeProvider` factory (review-polish
 * item B); the shell adds ONLY its own UX note when anthropic is selected
 * without a credential (before falling back to the offline provider).
 */
function realMakeProvider(write: (s: string) => void): ShellDeps["makeProvider"] {
  return (name: string, model: string, baseUrl?: string): ProviderPort => {
    if (name === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        write(
          "ANTHROPIC_API_KEY is not set: the anthropic provider needs a credential; using an offline no-op provider for this session.\n",
        );
      }
    }
    if (name === "openrouter") {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        write(
          "OPENROUTER_API_KEY is not set: the openrouter provider needs a credential; using an offline no-op provider for this session.\n",
        );
      }
    }
    return makeProvider(name, model, {
      fetch: globalThis.fetch,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...oauthCredentialsFor(name),
    });
  };
}

/**
 * Hand a device-code grant to the provider factory as the credential it looks for.
 *
 * Without this, `keryx auth login <provider>` is a command that stores a token
 * nothing reads. `makeProvider` resolves an OpenAI-compatible provider's key from
 * `env[definition.envKey]` — `XAI_API_KEY` for grok — and this factory passed
 * neither `env` nor `credentials`, so `process.env` was the only source. A user who
 * authenticated by subscription and never exported an API key therefore got
 * `FakeProvider`: an offline stub that answers nothing while the session header
 * still names the provider that was asked for.
 *
 * The grant's access token is passed through `credentials` rather than written into
 * `process.env`, so it reaches the one construction that needs it and does not leak
 * into every child process the session later spawns. An explicit environment key
 * still wins: an operator who exported one is making a choice.
 */
function oauthCredentialsFor(name: string): { credentials?: Record<string, string | undefined> } {
  const definition = providerByName(name);
  const envKey = definition?.envKey;
  if (envKey === undefined) return {};

  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv.length > 0) return {};

  const grant = loadOAuthGrant(name);
  if (grant === undefined || grant.access.length === 0) return {};
  return { credentials: { ...process.env, [envKey]: grant.access } };
}

/** Build the bundled detect+pick selector wired to real `fetch` + `process.env`. */
function realSelectProviderModel(
  baseUrl: string | undefined,
  cacheDir: string | undefined,
): NonNullable<ShellDeps["selectProviderModel"]> {
  return async (io, opts) => {
    // Saved keys count toward detection. They used to reach `process.env` only as a
    // side effect of the first `shell_exec`, which no longer loads them (K-015).
    const env = envWithSavedApiKeys(process.env);
    const detected = await detectProviders({
      fetch: globalThis.fetch,
      env,
      platform: process.platform,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
    const filtered =
      opts?.onlyProvider !== undefined ? detected.filter((d) => d.name === opts.onlyProvider) : detected;
    const list = filtered.length > 0 ? filtered : detected;
    // Always re-probe live `/models` (when online) inside pickProviderModel.
    const picked = await pickProviderModel(io, list, { fetch: globalThis.fetch, env });
    // flow 268: resolved once per selection, same moment `baseUrl` above is
    // already fixed for this session — `{}` (every field absent) for a native
    // adapter with no OpenAI-compatible registry entry. `cacheDir` matches
    // every other resolution call site in this file (startup, TUI rebuilds) —
    // omitting it here would silently resolve against the default config dir
    // instead of a caller-supplied one (e.g. `--config-dir`/sandboxed runs).
    const modelParams = resolveProviderModelParamsByName(picked.provider, loadShellConfig(cacheDir), cacheDir);
    return Object.keys(modelParams).length > 0 ? { ...picked, modelParams } : picked;
  };
}

/** How long the start-up grant refresh may hold the shell before it gives up (K-013). */
const GRANT_REFRESH_TIMEOUT_MS = 5_000;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT_MARK = "❯ ";
/** Left gutter applied across the shell chrome (OpenCode/codex aesthetic). */
const GUTTER = "  ";

/** `/expand` shows at most this many lines of the last tool output. */
export const EXPAND_MAX_LINES = 200;

/**
 * The readline shell's `/expand` rendering (AC10). Lifted out of the
 * `runAgentRepl` closure so it is unit-testable, and routed through the SAME
 * `src/lib` helpers the TUI transcript uses so the two shells cannot drift:
 * the header comes from `blockLabel` — the same `▾ <kind> (n lines)` FORM as an
 * expanded TUI block, though the wording differs by design: readline passes the
 * tool name as `kind` (`▾ read_file (3 lines)`) while the TUI passes the block
 * class (`▾ output (3 lines)`) — and a body that sniffs as a unified diff goes
 * through `renderDiff` instead of being flatly dimmed.
 *
 * Returns the gutter-indented, newline-terminated text to print, or `undefined`
 * when there is nothing to expand — the caller keeps owning the "Nothing to
 * expand" system message. Pure apart from the ambient color setting.
 */
export function expandedToolOutput(
  name: string | undefined,
  output: string | undefined,
  maxLines: number = EXPAND_MAX_LINES,
): string | undefined {
  if (output === undefined || output.trim().length === 0) {
    return undefined;
  }
  const allLines = output.replace(/\n+$/, "").split("\n");
  const shown = allLines.slice(0, maxLines).join("\n");
  const header = blockLabel({ kind: name ?? "tool", lineCount: allLines.length, collapsed: false });
  const body = looksLikeUnifiedDiff(shown) ? renderDiff(shown) : style.dim(shown);
  let out = `\n${GUTTER}${style.dim(header)}\n${indentBlock(body, GUTTER)}\n`;
  if (allLines.length > maxLines) {
    out += `${GUTTER}${style.dim(`… (${allLines.length - maxLines} more lines truncated)`)}\n`;
  }
  return out;
}

/** Terminal rows `text` occupies starting at column 0 for the given width. */
function countRows(text: string, columns: number): number {
  let rows = 1;
  let col = 0;
  for (const ch of text) {
    if (ch === "\n") {
      rows += 1;
      col = 0;
    } else {
      col += 1;
      if (col >= columns) {
        rows += 1;
        col = 0;
      }
    }
  }
  return rows;
}

/** The rich TTY renderer wired into `ShellIO`'s optional hooks (flow 031). */
interface RichIo {
  io: ShellIO;
  emitSystem: (text: string) => void;
  printHeader: (title: string, subtitle: string) => void;
  /** Print the colored input prompt marker (used between agent-mode turns). */
  printPrompt: () => void;
  /** Stop accepting a late version result after readline teardown. */
  destroy: () => void;
}

export interface VersionAdvisoryBoundary {
  flush(write: (text: string) => void): void;
  destroy(): void;
}

/**
 * Store asynchronous completion without writing. `flush` is called only by a
 * known prompt/output boundary, so a late registry response cannot corrupt the
 * active readline input buffer.
 */
export function createVersionAdvisoryBoundary(
  versionCheck: Promise<VersionCheckResult>,
): VersionAdvisoryBoundary {
  let active = true;
  let pending: string | undefined;
  let shown = false;
  void versionCheck.then(
    (result) => {
      if (active) pending = formatVersionUpdateAdvisory(result);
    },
    () => {
      // Production resolves typed unavailable; injected rejection is ignored.
    },
  );
  return {
    flush: (write) => {
      if (!active || shown || pending === undefined) return;
      shown = true;
      const advisory = pending;
      pending = undefined;
      write(`\n${advisory}\n`);
    },
    destroy: () => {
      active = false;
      pending = undefined;
    },
  };
}

/**
 * Build the rich-inline renderer (NOT unit-tested): a `ShellIO` whose optional
 * hooks drive a role label + spinner, live token streaming, and a post-turn
 * markdown re-render, plus styled system notices and a colored prompt marker.
 * All styling is confined here (the spinner timer included — the `runShell` core
 * stays timer/`Date.now`/`Math.random`-free) and degrades to plain, uncorrupted
 * output when `NO_COLOR` is set or the sink is not a TTY.
 */
function createRichIo(lines: AsyncIterable<string>, versionCheck: Promise<VersionCheckResult>): RichIo {
  const stdout = process.stdout;
  const rich = colorEnabled() && Boolean(stdout.isTTY);
  const out = (s: string): void => {
    stdout.write(s);
  };

  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let awaitingFirstToken = false;
  let raw = "";
  const advisory = createVersionAdvisoryBoundary(versionCheck);

  const stopSpinner = (): void => {
    if (spinner !== undefined) {
      clearInterval(spinner);
      spinner = undefined;
      out("\r[2K"); // erase the spinner line
    }
  };

  const emitSystem = (text: string): void => {
    stopSpinner();
    if (!rich) {
      out(text);
      return;
    }
    out(text.includes("[error]") ? style.red(text) : style.dim(text));
  };

  const printPrompt = (): void => {
    out(rich ? style.cyan(`${GUTTER}${PROMPT_MARK}`) : `${GUTTER}${PROMPT_MARK}`);
  };

  const write = (s: string): void => {
    if (awaitingFirstToken && s.length > 0) {
      stopSpinner(); // first token lands: drop the spinner, start streaming
      awaitingFirstToken = false;
    }
    // Accumulate the raw stream for the post-turn re-render. The "\n\n" turn
    // separator arrives AFTER onTurnEnd, so it is never part of `raw`.
    if (!awaitingFirstToken && s !== "\n\n") {
      raw += s;
    }
    out(s);
    if (s === "\n\n") {
      printPrompt(); // re-prompt before the next input line
    }
  };

  const onTurnStart = (): void => {
    raw = "";
    if (!rich) {
      return;
    }
    out(`\n${style.cyan("●")} ${style.bold("keryx")}\n`);
    awaitingFirstToken = true;
    frame = 0;
    spinner = setInterval(() => {
      const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
      out(`\r[2K${style.dim(`${glyph} thinking…`)}`);
      frame += 1;
    }, 80);
  };

  const onTurnEnd = (full: string): void => {
    stopSpinner();
    if (!rich) {
      return;
    }
    const rendered = renderMarkdown(full);
    if (rendered === full || raw.length === 0) {
      return; // nothing to restyle: leave the streamed raw text in place
    }
    const columns = stdout.columns ?? 80;
    const rows = countRows(raw, columns);
    if (rows > 1) {
      out(`[${rows - 1}A`); // up to the first row of the streamed block
    }
    out("\r[0J"); // column 0, clear downward, then reprint rendered
    out(rendered);
  };

  const printHeader = (title: string, subtitle: string): void => {
    // Minimal one-line header (codex/grok/pi aesthetic) — no double rules, with
    // the shared left gutter.
    if (rich) {
      out(`\n${GUTTER}${style.cyan("◆")} ${style.bold(title)}  ${style.dim(subtitle)}\n`);
      out(`${GUTTER}${style.dim("type a task · /help for commands · /exit to quit")}\n\n`);
    } else {
      out(`${GUTTER}${title} — ${subtitle}\n`);
      out(`${GUTTER}Type a message, or /help for commands.\n\n`);
    }
    advisory.flush(emitSystem);
    printPrompt();
  };

  const io: ShellIO = {
    lines,
    write,
    onTurnStart,
    onTurnEnd,
    onSystem: emitSystem,
    onSafeBoundary: () => advisory.flush(emitSystem),
  };
  return { io, emitSystem, printHeader, printPrompt, destroy: advisory.destroy };
}

/** A dim, terminal-width-agnostic separator between agent turns. */
function turnSeparator(): string {
  return style.dim("─".repeat(24));
}

type SearchProviderConfigInput = {
  providerId: string | undefined;
  fields: Record<string, string>;
  credential: string | undefined;
};

function parseSearchProviderArgs(tokens: string[]): SearchProviderConfigInput {
  const [providerId, ...tail] = tokens;
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

function describeSearchProviders(
  title: string,
  providers: readonly SearchProviderDescriptor[],
): string {
  const rows = providers.map((provider) => `${provider.id} (${provider.displayName})`);
  return `${title}\n${rows.length > 0 ? rows.join("\n") : "  (none configured)"}\n`;
}

/** A dim `↑in ↓out tokens` summary, or "" when the provider reported nothing. */
function formatUsage(usage: NormalizedUsage | undefined): string {
  if (usage === undefined) {
    return "";
  }
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`↑${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`↓${usage.outputTokens}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return style.dim(`${parts.join(" ")} tokens`);
}

/**
 * Agent-mode REPL (NOT unit-tested): reads lines and drives the `runAgentTurn`
 * driver. Assistant text is buffered under the "thinking…" spinner and rendered
 * as markdown once per round (via the driver's `onAssistantText` hook) — no
 * fragile in-place re-render (flow 048). Renders a styled assistant header, tool
 * calls (`⚙ name(args)`), dim tool-result summaries, a per-turn token line, and a
 * dim turn separator. `runShell`'s chat core is untouched.
 */
async function runAgentRepl(
  lines: AsyncIterable<string>,
  rich: { printPrompt: () => void; safeBoundary: (() => void) | undefined },
  deps: AgentDeps,
  metaprojectPort: MetaprojectPort,
  sessionOpts?: ShellSessionOpts,
  /**
   * The CLI-flag override only (`--permission-mode` / `--ask`/`--trust`/
   * `--auto`, see `parseShellCliFlags`). `undefined` means "no flag was
   * passed" — the session then falls back to the project's stored default
   * (`getProjectPermissionMode(sessionCwd)`) and finally
   * `DEFAULT_PERMISSION_MODE`. That fallback chain is resolved once, inside
   * this function, so it lives in exactly one place.
   */
  initialPermissionMode?: PermissionMode,
  /**
   * SLATE-3a (flow 161, AC5) side-channel: the caller's `slateSessionBox`
   * (declared in `shellCommand`'s agent-mode branch, BEFORE the readline
   * `buildInteractiveAgentTools({..., getSessionDir})` call that reads it).
   * Every `slateSession = ...` reassignment below also syncs
   * `slateSessionBox.current` immediately after, so that getter's closure —
   * created once, outside this function, before any session is open — always
   * observes this function's CURRENT `slateSession`, not a stale snapshot.
   * Defaults to a throwaway box so ad hoc callers (tests) that do not care
   * about Slate tool wiring need not pass one.
   */
  slateSessionBox: { current: SlateSessionRef | undefined } = { current: undefined },
  /**
   * Optional machine-readable transcript (`--events-file`). Written BESIDE the
   * human output, never instead of it: a headless mode that renders differently
   * is a different code path, and then what is measured is not what people run.
   */
  events?: ShellEventSink,
  /**
   * flow 268 T26: the SAME `ShellConfig` directory `agentDepsBase` already
   * resolves this session's `reasoningEffort`/`maxOutputTokens` from
   * (`loadShellConfig(runtime.cacheDir)`, at this function's own call site in
   * `shellCommand`) — every `loadShellConfig`/`saveShellConfig` call
   * INSIDE this function (the `/reasoning` handler, and the read-only
   * `onReasoningEnd` `/think`-display check) must resolve/persist against
   * that SAME directory, not silently fall back to the default config dir
   * (`undefined` here) and disagree with what `agentDepsBase` already read.
   * `undefined` preserves the pre-existing default-dir behaviour for any
   * caller (tests) that does not pass one.
   */
  configDir?: string,
  /**
   * Flow 274 (agent bus P3, T6/T7 contract): the SAME `orient` block the
   * caller already resolved for `deps.systemInstruction`'s FIRST build
   * (`buildOrientation`, resolved once before this function is even called).
   * Needed here ONLY to rebuild `deps.systemInstruction` with
   * `busJoined: true` once the bus join actually settles — this REPL has no
   * `/model`-style rebuild point to piggy-back on otherwise (see the bus-join
   * block below). `undefined` reproduces the pre-flow-274 instruction text
   * for any caller (tests) that omits it.
   */
  orient?: string,
): Promise<void> {
  const out = (s: string): void => {
    process.stdout.write(s);
  };
  const clearLine = `\r${String.fromCharCode(27)}[2K`;
  const spinnable = colorEnabled() && Boolean(process.stdout.isTTY);
  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  const startSpinner = (): void => {
    if (!spinnable || spinner !== undefined) {
      return;
    }
    frame = 0;
    spinner = setInterval(() => {
      const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
      out(`${clearLine}${GUTTER}${style.dim(`${glyph} thinking…`)}`);
      frame += 1;
    }, 80);
  };
  const stopSpinner = (): void => {
    if (spinner !== undefined) {
      clearInterval(spinner);
      spinner = undefined;
      out(clearLine);
    }
  };
  const searchProviderController = createDefaultSearchProviderController();
  const sessionShellAllow = new Set<string>(loadShellPermissions().allow);
  let fingerprintAtStart = shellPermissionsFingerprint();
  let permissionMigrationShown = false;
  let permissionTamperShown = false;

  // A SINGLE line consumer shared by the main loop and the approval prompt, so an
  // approval read (mid-turn, while the main loop is suspended) never races it.
  const iterator = lines[Symbol.asyncIterator]();
  const readLine = async (): Promise<string | undefined> => {
    const next = await iterator.next();
    return next.done ? undefined : next.value;
  };

  // Flow 265 (AC7): the MAIN loop's consumer — the next operator line OR the
  // next finished task, whichever comes first, so an idle REPL reports a
  // completion without a keystroke. The approval prompts keep calling the bare
  // `readLine` above: a finished task must never answer a y/N question.
  type LoopInput = { kind: "line"; line: string } | { kind: "eof" } | { kind: "completion" };
  let completionWaiters: Array<() => void> = [];
  // The in-flight line read SURVIVES a lost race — `iterator.next()` consumes
  // from stdin when called, so re-reading would drop what was typed meanwhile.
  let pendingLine: Promise<{ kind: "line"; line: string } | { kind: "eof" }> | undefined;
  const readLineOrCompletion = async (): Promise<LoopInput> => {
    pendingLine ??= readLine().then((line) =>
      line === undefined ? ({ kind: "eof" } as const) : ({ kind: "line", line } as const),
    );
    if (deps.jobRegistry === undefined) {
      const settled = await pendingLine;
      pendingLine = undefined;
      return settled;
    }
    const completion = new Promise<{ kind: "completion" }>((resolve) => {
      completionWaiters.push(() => resolve({ kind: "completion" }));
    });
    const winner = await Promise.race([pendingLine, completion]);
    if (winner.kind !== "completion") {
      pendingLine = undefined;
    }
    return winner;
  };
  let consecutiveAutoWakes = 0;
  deps.jobRegistry?.onCompletion(() => {
    const waiters = completionWaiters;
    completionWaiters = [];
    for (const wake of waiters) wake();
  });

  // Per-turn token usage (last `usage_update` the provider reported), printed
  // once when the turn ends.
  let lastUsage: NormalizedUsage | undefined;
  // Per-turn, for the machine-readable transcript. Reset with `lastUsage`.
  let turnToolCalls = 0;
  let turnText: string | undefined;
  let turnError: string | undefined;
  // Full output of the most recent tool call, retained for `/expand` (the
  // transcript shows only a collapsed one-line summary — flow 055).
  let lastToolOutput: string | undefined;
  let lastToolName: string | undefined;

  // Live differential markdown rendering (flow 051): stream + repaint in place on
  // a TTY with color; otherwise fall back to the flow-050 render-once behavior so
  // piped/redirected output stays clean and deterministic.
  const liveEnabled = colorEnabled() && Boolean(process.stdout.isTTY);
  const liveBlock = liveEnabled
    ? new LiveMarkdownBlock({
        out,
        cols: () => process.stdout.columns ?? 80,
        render: (md) => indentBlock(renderMarkdown(md.trimEnd()), GUTTER),
        sync: true,
      })
    : undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let blockActive = false;
  const startBlock = (): void => {
    if (liveBlock === undefined || blockActive) {
      return;
    }
    blockActive = true;
    flushTimer = setInterval(() => liveBlock.flush(), 50); // coalesce repaints (~20/s)
  };
  const endBlock = (): void => {
    if (liveBlock === undefined || !blockActive) {
      return;
    }
    if (flushTimer !== undefined) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    liveBlock.finalize();
    blockActive = false;
  };

  const agentIo: AgentIO = {
    // Live path: append the token to the differential block (a coalescing timer
    // repaints it). Non-live path: no-op — `onAssistantText` renders once. Either
    // way the first token drops the spinner.
    write: (s) => {
      if (s.length === 0) {
        return;
      }
      if (liveBlock !== undefined) {
        if (!blockActive) {
          stopSpinner();
          startBlock();
        }
        liveBlock.append(s);
      }
    },
    onAssistantText: (text) => {
      turnText = text;
      events?.emit({ type: "assistant", text });
      stopSpinner();
      if (liveBlock !== undefined) {
        endBlock(); // final repaint + line break + reset
      } else {
        out(`${indentBlock(renderMarkdown(text.trimEnd()), GUTTER)}\n`);
      }
    },
    // flow 268 T17 (AC16): moved from `onReasoning` to `onReasoningEnd` so the
    // header line carries duration when known (`formatReasoningOneLiner` —
    // same format `createTuiAgentIo`'s one-line default uses) and so
    // `/think hide` (persisted to `ShellConfig`, the readline shell's only
    // reasoning-display surface) can suppress the whole block, not just the
    // TUI's live preview.
    onReasoningEnd: (info) => {
      stopSpinner();
      endBlock(); // reasoning precedes the answer block
      if (resolveThinkDisplayMode(loadShellConfig(configDir).thinkDisplay) === "hide") {
        return;
      }
      const lineCount = info.text.trim().split("\n").filter((l) => l.trim().length > 0).length;
      out(
        `\n${GUTTER}${style.dim(
          formatReasoningOneLiner({
            lineCount,
            redacted: info.redacted,
            hasText: info.text.length > 0,
            ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
          }),
        )}\n`,
      );
      if (info.text.length > 0) {
        out(`${indentBlock(style.dim(info.text.trimEnd()), GUTTER)}\n`);
      }
    },
    onUsage: (usage) => {
      lastUsage = usage;
      events?.emit({ type: "usage", usage });
    },
    requestApproval: async (tool, input, meta) => {
      stopSpinner();
      if (tool === "apply_patch") {
        // ADR-0010/P2: render the actual diff (full, never truncated — the
        // 120-char preview below is fine for a shell command, not for a
        // multi-file patch a human needs to actually read) instead of the
        // raw JSON tool input. Shares `renderDiff`/`classifyDiffLine` with
        // the TUI and with markdown diff-block rendering, so this cannot
        // drift from either.
        const patch = extractPatchText(input);
        out(`\n${GUTTER}${style.yellow("Approve apply_patch?")}\n`);
        out(`${indentBlock(renderDiff(patch), GUTTER)}\n`);
        if (meta?.destructive === true) {
          out(`${GUTTER}${style.yellow("deletes a file, touches .git/, or touches many files in one call")}\n`);
        }
        if (meta?.credentials === true) {
          out(`${GUTTER}${style.yellow("touches the agent's own permission/credential files")}\n`);
        }
        out(`\n${GUTTER}${style.dim("[y/N] ")}`);
        const answer = ((await readLine()) ?? "").trim();
        const approved = /^y(es)?$/i.test(answer);
        out(approved ? style.green("approved\n") : style.red("denied\n"));
        if (!approved) {
          return false;
        }
        return meta?.fingerprint !== undefined
          ? { approved: true, fingerprint: meta.fingerprint }
          : true;
      }
      if (tool.startsWith(MCP_ELICITATION_TOOL_PREFIX)) {
        // T12 (specification.md §8): render the elicitation's own human-readable
        // `message` (and vendor command, when present) — never the raw escaped
        // JSON `input` string `supervise-mcp.ts` actually sends, which the
        // generic `tool !== "shell_exec"` branch below would otherwise show.
        const described = describeElicitationPrompt(tool, input) ?? { message: input, command: undefined };
        out(`\n${GUTTER}${style.yellow("Approve codex elicitation?")}\n`);
        out(`${indentBlock(described.message, GUTTER)}\n`);
        if (described.command !== undefined) {
          out(`${GUTTER}${style.dim(`command: ${described.command}`)}\n`);
        }
        if (meta?.destructive === true) {
          out(`${GUTTER}${style.yellow("deletes a file, touches .git/, or touches many files in one call")}\n`);
        }
        if (meta?.credentials === true) {
          out(`${GUTTER}${style.yellow("touches the agent's own permission/credential files")}\n`);
        }
        out(`\n${GUTTER}${style.dim("[y/N] ")}`);
        const answer = ((await readLine()) ?? "").trim();
        const approved = /^y(es)?$/i.test(answer);
        out(approved ? style.green("approved\n") : style.red("denied\n"));
        if (!approved) {
          return false;
        }
        return meta?.fingerprint !== undefined
          ? { approved: true, fingerprint: meta.fingerprint }
          : true;
      }
      if (isMcpToolCall(tool)) {
        // F-032/F-033, deferred from P0 to P2 by operator decision.
        //
        // The WHOLE prompt — printing, reading the answer, and the
        // verdict — lives in the shared module with its IO injected. An
        // earlier version kept the decision here and a reviewer showed
        // it had no coverage whatsoever: inverting `if (!approved)`, so
        // that `y` denies and anything else approves and RUNS, left the
        // full suite green. Extracting only the line building was not
        // enough, because the part that decides whether a third party
        // acts was the part still out of reach.
        return await promptUseToolApproval(
          { out, readLine: async () => await readLine() },
          input,
          meta,
          catalogResolver(deps.mcpRuntime?.()?.catalog()),
          style,
          GUTTER,
        );
      }
      if (tool !== "shell_exec") {
        const preview = input.length > 120 ? `${input.slice(0, 117)}…` : input;
        out(`\n${GUTTER}${style.yellow(`Approve ${tool}?`)} ${style.dim(preview)}\n`);
        out(`${GUTTER}${style.dim("[y/N] ")}`);
        const answer = ((await readLine()) ?? "").trim();
        const approved = /^y(es)?$/i.test(answer);
        out(approved ? style.green("approved\n") : style.red("denied\n"));
        if (!approved) {
          return false;
        }
        return meta?.fingerprint !== undefined
          ? { approved: true, fingerprint: meta.fingerprint }
          : true;
      }
      const evaled = evaluateShellApproval({
        inputJson: input,
        ...(meta !== undefined ? { meta } : {}),
        sessionAllow: sessionShellAllow,
        fingerprintAtStart,
      });
      if (!permissionMigrationShown && evaled.rejected.length > 0) {
        permissionMigrationShown = true;
        out(
          `${GUTTER}${style.yellow(
            `⚠ ${evaled.rejected.length} saved shell permission(s) are no longer honoured`,
          )}\n`,
        );
        for (const rej of evaled.rejected) {
          out(`${GUTTER}${style.dim(`    “${rej.pattern}” — ${rej.reason}`)}\n`);
        }
      }
      if (!permissionTamperShown && evaled.tampered) {
        permissionTamperShown = true;
        out(
          `${GUTTER}${style.red(
            "⚠ saved shell permissions changed outside this approval UI — review before trusting auto-approve",
          )}\n`,
        );
      }
      if (evaled.autoApprove) {
        out(`${GUTTER}${style.dim(`✓ auto-approved shell: ${evaled.command}`)}\n`);
        return meta?.fingerprint !== undefined
          ? { approved: true, fingerprint: meta.fingerprint }
          : true;
      }
      const context = await buildApprovalContext(metaprojectPort, evaled.command);
      if (context.length > 0) {
        out(`\n${indentBlock(style.dim(context), GUTTER)}`);
      }
      for (const hint of formatShellApprovalHints(evaled)) {
        out(`${GUTTER}${style.yellow(hint)}\n`);
      }
      const rememberable = !evaled.destructive && !evaled.credentials && !evaled.sacReviewConfirmation;
      const prompt = rememberable ? "[y/N/A=always] " : "[y/N] ";
      out(`\n${GUTTER}${style.yellow(`Run: ${evaled.command}`)} ${style.dim(prompt)}`);
      const answer = ((await readLine()) ?? "").trim();
      const always = rememberable && /^a(lways)?$/i.test(answer);
      const approved = always || /^y(es)?$/i.test(answer);
      if (always && approved) {
        const stored = rememberExactShellGrant(evaled.command, sessionShellAllow);
        if (stored.length > 0) {
          fingerprintAtStart = shellPermissionsFingerprint();
        }
        out(
          stored.length > 0
            ? style.green(`approved · remembered “${stored}”\n`)
            : style.yellow("approved once · pattern cannot be remembered\n"),
        );
      } else {
        out(approved ? style.green("approved\n") : style.red("denied\n"));
      }
      if (!approved) {
        return false;
      }
      return meta?.fingerprint !== undefined
        ? { approved: true, fingerprint: meta.fingerprint }
        : true;
    },
    onToolCall: (name, input) => {
      turnToolCalls += 1;
      events?.emit({ type: "tool_call", name, input });
      stopSpinner();
      endBlock(); // defensive: close any live block before the tool line
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      out(`\n${GUTTER}${style.cyan(`⚙ ${call}`)}\n`);
    },
    onToolResult: (name, result) => {
      events?.emit({ type: "tool_result", name, isError: result.isError === true, output: result.output });
      const marker = result.isError ? style.red("✗ ") : style.gray("↳ ");
      const { summary, hidden } = collapseToolOutput(result.output);
      const more = hidden > 0 ? style.dim(` · +${hidden} more (/expand)`) : "";
      out(`${GUTTER}${marker}${style.dim(summary)}${more}\n`);
      lastToolName = name;
      lastToolOutput = result.output;
      startSpinner(); // a tool finished; wait for the model's next round
    },
    onSystem: (text) => {
      // A provider failure arrives here, not as a thrown error: the driver
      // reports it and the turn ends normally. Without this, `turn_end` records
      // an empty answer and zero tool calls — the exact shape of a model that
      // searched and found nothing — and a reader scores a failure as a result.
      // Observed on the first live run of this flag, against a provider with no
      // credentials configured.
      if (text.includes("[error]")) {
        turnError = turnError === undefined ? text.trim() : `${turnError}\n${text.trim()}`;
      }
      stopSpinner();
      endBlock(); // close the live block before printing a system/error line over it
      const styled = colorEnabled() ? (text.includes("[error]") ? style.red(text) : style.dim(text)) : text;
      out(indentBlock(styled, GUTTER));
    },
  };

  const sessionCwd = sessionOpts?.cwd ?? process.cwd();
  const sessionsOn = sessionOpts !== undefined && sessionOpts.enabled !== false;

  // Fallback chain: CLI flag > this project's stored default > the global
  // default (`ask`, unchanged behavior for anyone who never opts in). Resolved
  // once, here — `/mode` below only ever reassigns the `let`, never re-derives
  // this chain, so a session that clears its project default mid-run does not
  // retroactively change.
  let permissionMode: PermissionMode =
    initialPermissionMode ?? getProjectPermissionMode(sessionCwd) ?? DEFAULT_PERMISSION_MODE;
  agentIo.permissionMode = () => permissionMode;
  // Flow 268 T16 (AC11): this readline session's own `/reasoning` override —
  // local to THIS function (unlike the TUI, readline agent mode has no
  // `/model`-style deps rebuild, so there is no second `AgentDeps` build that
  // would need to see it; the `/reasoning` handler below mutates `deps.
  // reasoningEffort` directly for the live object instead).
  let reasoningSessionOverride: string | undefined;
  // Read-only ("plan") posture — orthogonal to `permissionMode` (see
  // `permission-mode.ts`'s `ApprovalGateInput.readOnly` docstring). Never
  // persisted; every session starts `false`, toggled only by `/plan [on|off]`.
  let readOnly = false;
  agentIo.readOnly = () => readOnly;
  agentIo.onAutoApproved = (tool, input, meta) => {
    stopSpinner();
    // NOT dimmed (see `AgentIO.onAutoApproved`'s docstring): unlike the shell
    // "Always"-remembered grant below, which the user explicitly opted into
    // for that exact command, a mode-driven auto-approval was never okayed
    // action-by-action — only the mode itself was chosen, once.
    const preview = tool === "shell_exec" ? parseShellExecCommand(input) : tool;
    // `meta.credentials` never reaches here — resolveApprovalDecision's hard
    // floor means a credentials-touching call is never `auto`, in any mode.
    // Only `destructive` is worth flagging: it means `auto` mode (not `trust`,
    // which always asks for a destructive command) just bypassed it.
    const flag = meta.destructive ? style.yellow(" [destructive]") : "";
    out(`${GUTTER}${style.yellow(`◇ auto-approved (${permissionMode})`)}${flag} ${style.dim(preview)}\n`);
  };

  let live: SessionHandle | undefined;
  let history: NormalizedMessage[] = [];
  let archive: NormalizedMessage[] = [];
  let nextArchiveIndex = 0;
  let sessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * SLATE-5 open/close wiring: a fresh, never-opened ref per live session dir
   * (reassigned on `/new`; see below). `undefined` whenever `live` is —
   * sessions disabled, no dir to anchor a slate to, so `runAgentTurn` skips
   * all slate lifecycle work (see `RunAgentTurnOptions.slateSession`).
   */
  let slateSession: SlateSessionRef | undefined;
  // Flow 267: fetch the provider's real context window ONCE for this session.
  // Unlike the chat REPL above, this readline AGENT REPL has no `/model`/
  // `/provider`/`/connect` command to react to (confirmed: those branches only
  // exist in the chat loop above) — `deps.providerId`/`deps.modelId` never
  // change for the lifetime of one `runAgentRepl` call — so there is no
  // rebuild point to re-fetch this at. Best-effort: an unreachable gateway or
  // unrecognized provider just leaves the guard off, same as `/status`'s own
  // "never invent a window" contract.
  try {
    const limits = await loadSessionLimits({ provider: deps.providerId, model: deps.modelId });
    if (limits.contextWindow !== undefined) {
      deps = { ...deps, contextWindow: limits.contextWindow };
    }
  } catch {
    // best-effort — the guard simply stays off for this session.
  }
  deps = {
    ...deps,
    // Flow 267: mirrors the `/compact` command handler below — persist the
    // SAME bookkeeping (`compactCount`, `archive.jsonl`, `context.jsonl`) via
    // `persistCompacted` instead of letting the shrink exist only in memory.
    // `live === undefined` (sessions off) just skips persistence; `history`
    // was already spliced in place by the guard regardless.
    onContextCompaction: (r) => {
      if (live === undefined || !leaseWatch.canPersist()) {
        return;
      }
      const persisted = persistCompacted(live, r.context, archive, {
        provider: deps.providerId,
        model: deps.modelId,
      });
      live = persisted.handle;
      nextArchiveIndex = history.length;
      agentIo.onSystem?.(`context 85% of window — compacted ${r.removed} messages\n`);
    },
  };
  // The session lease this REPL holds (specification §6), mirrored into the
  // caller's `leaseBox` for the SIGINT/SIGTERM handler.
  let lease: SessionLeaseHandle | undefined;
  // Review F1: once another shell takes this session's lease, nothing more is
  // written to it: `save`, both compaction paths check `leaseWatch.canPersist()`,
  // and the slate ref is dropped so no tool or turn records into it.
  const leaseWatch = watchLeaseLoss((message) => {
    // Flow 271 R3-1: detach the ref itself, not only these variables. A turn or
    // a `/goal --auto` loop that is already running holds the same object, and
    // every slate write through a detached ref refuses.
    detachSlateSession(slateSession);
    slateSession = undefined;
    slateSessionBox.current = undefined;
    agentIo.onSystem?.(message);
  });
  // Review r2 N1: the slate getters built in `shellCommand` read this box, so
  // gating its reads makes the slate tools themselves check the lease (on disk)
  // before every write, instead of waiting for the next heartbeat or save.
  gateBoxByLease(slateSessionBox, () => leaseWatch.canPersist());
  const holdLease = (next: SessionLeaseHandle | undefined): void => {
    lease = next;
    leaseWatch.track(next);
    if (sessionOpts?.leaseBox !== undefined) sessionOpts.leaseBox.current = next;
  };
  const openLeased = sessionOpts?.openLeased ?? openLeasedSession;
  /**
   * `/new` (specification §6.2): lease a new session BEFORE anything of the
   * current one is touched, and release the current lease only after. On a
   * refusal, say so and return false: the current session and lease stay.
   */
  const switchNewSession = (): SessionHandle | false => {
    try {
      const next = switchLeasedSession(lease, () =>
        openLeased({ cwd: sessionCwd, provider: deps.providerId, model: deps.modelId }),
      );
      holdLease(next.lease);
      return next.handle;
    } catch (cause) {
      agentIo.onSystem?.(`${cause instanceof Error ? cause.message : String(cause)}\nKept the current session.\n`);
      return false;
    }
  };
  const releaseLease = (): void => {
    releaseSessionLease(lease);
    holdLease(undefined);
  };
  if (sessionsOn) {
    try {
      const opened = openLeased(leasedOpenOptions(sessionOpts, sessionCwd, deps.providerId, deps.modelId));
      holdLease(opened.lease);
      if (opened.skipped !== undefined) {
        agentIo.onSystem?.(describeSkippedSession(opened.skipped));
      }
      live = opened.handle;
      history = opened.history;
      archive = opened.archive.length > 0 ? [...opened.archive] : [...opened.history];
      nextArchiveIndex = history.length;
      if (opened.resumed) {
        agentIo.onSystem?.(
          `Resumed session ${shortSessionId(live.summary.id)} · ${live.summary.title} (${history.length} context · archive ${archive.length})\n`,
        );
      } else {
        agentIo.onSystem?.(
          `Session ${shortSessionId(live.summary.id)} · per-project (keryx shell -c to continue)\n`,
        );
      }
    } catch (cause) {
      // Another shell holds the session: the top level decides. Never a
      // silent new session (AC2).
      if (cause instanceof SessionLeasedError) {
        throw cause;
      }
      const fresh = openFreshLeasedSession(openLeased, sessionCwd, deps.providerId, deps.modelId);
      holdLease(fresh?.lease);
      live =
        fresh?.handle ??
        createSession({
          cwd: sessionCwd,
          provider: deps.providerId,
          model: deps.modelId,
        });
      history = [];
      archive = [];
      nextArchiveIndex = 0;
      agentIo.onSystem?.(
        `${cause instanceof Error ? cause.message : String(cause)}\nNew session ${shortSessionId(live.summary.id)}.\n`,
      );
    }
  }

  // Flow 273 T6: join the bus once the session lease is settled (specification
  // §5.1). A bus failure of any kind prints one line and never stops the REPL
  // (§5.2) — there is no persistent session to join a bus for otherwise.
  let busWorking = false;
  const busStatus = (): { status: "idle" | "working" | "blocked"; activity: string } => ({
    status: busWorking ? "working" : "idle",
    activity: live?.summary.title ?? "keryx agent",
  });
  // Flow 274 (agent bus P3, T7; specification §5.3): one inbox for this REPL,
  // fed below regardless of whether the join ever succeeds (a disabled or
  // never-attempted bus just never pushes into it).
  const busInbox: BusInbox = createBusInbox();
  let bus: BusClient | undefined;
  if (sessionsOn && live !== undefined) {
    try {
      const joined = await joinBus({
        cwd: sessionCwd,
        sessionId: live.summary.id,
        surface: "readline",
        ...(sessionOpts?.busName !== undefined ? { requestedName: sessionOpts.busName } : {}),
        shellConfig: loadShellConfig(configDir),
        env: process.env,
        // review r1 F2: a getter, read at every use — see the matching
        // comment in `runShell`.
        sessionLease: () => lease,
        status: busStatus,
        onEvent: (event) => {
          agentIo.onSystem?.(`${formatBusEventLine(event)}\n`);
          // Flow 274 T7 (specification §4.2): every event `onEvent` sees is
          // already not `ack`/`override`/`lease-expired` (`BusClient`'s own
          // `isRenderable` filter) — `body` is optional only on the type
          // (pre-flow-274 fixtures); the real poll path always sets it.
          busInbox.push({ ...event, body: event.body ?? "" });
        },
        onPeers: () => {},
        // review r1 F10: throttled failure printer (see `runShell`).
        onError: makeBusErrorReporter((text) => agentIo.onSystem?.(text)),
      });
      if ("disabled" in joined) {
        agentIo.onSystem?.(`bus: off (${joined.disabled})\n`);
      } else {
        bus = joined;
        if (sessionOpts?.busBox !== undefined) sessionOpts.busBox.current = bus;
        agentIo.onSystem?.(formatBusJoinLine(joined));
        // Flow 274 T7: `deps` (this function's parameter) was built by the
        // CALLER before this join even started — its `tools`/
        // `systemInstruction` cannot yet reflect `bus_list`/`bus_send` or the
        // conduct block (`AgentInstructionContext.busJoined`). `busInbox`/
        // `busAck` are plain fields with no such baking problem, so they are
        // just merged on; `systemInstruction` needs an actual rebuild (T6/T7
        // contract — no `/model`-style rebuild point exists in THIS REPL to
        // piggy-back on, so this runs once, right here, right after the join
        // actually succeeds).
        deps = {
          ...deps,
          busInbox,
          busAck: (events) => joined.ack(events),
          systemInstruction: buildAgentSystemInstruction(orient, {
            providerId: deps.providerId,
            modelId: deps.modelId,
            toolNames: interactiveAgentToolNames(deps.tools),
            busJoined: true,
          }),
        };
      }
    } catch (cause) {
      agentIo.onSystem?.(busErrorLine(cause));
    }
  }
  const leaveBus = (): void => {
    bus?.leave();
    if (sessionOpts?.busBox !== undefined) sessionOpts.busBox.current = undefined;
  };
  // Flow 274 (agent bus P3, T7; specification §5.3): "no idle wake in v1" for
  // the readline surface — `busInbox` is drained only from INSIDE a turn
  // (`runAgentTurn`'s own three drain sites, via `deps.busInbox`/`busAck`
  // above), never used here to start one. This just announces what is
  // waiting, right before the prompt a human would otherwise type into.
  const printPromptWithBusNotice = (): void => {
    if (busInbox.size > 0) {
      agentIo.onSystem?.(`bus: ${busInbox.size} message(s) pending — delivered with your next message\n`);
    }
    rich.printPrompt();
  };

  slateSession = live !== undefined ? { dir: live.dir, cwd: sessionCwd, opened: false } : undefined;
  slateSessionBox.current = slateSession;

  const save = (): void => {
    if (live === undefined || !leaseWatch.canPersist()) {
      return;
    }
    try {
      live = persistHistory(live, history, {
        archive,
        provider: deps.providerId,
        model: deps.modelId,
      });
    } catch {
      // best-effort
    }
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
    save();
  };
  agentIo.onHistoryChange = (kind) => {
    syncArchive();
    if (kind === "assistant_delta") {
      if (sessionPersistTimer === undefined) {
        sessionPersistTimer = setTimeout(() => {
          sessionPersistTimer = undefined;
          save();
        }, 300);
      }
      return;
    }
    flushSessionCheckpoint();
  };
  // `printHeader` already emitted the first prompt — do NOT print another here
  // (that produced the duplicate `❯ ❯`). Only re-prompt after turns/commands.
  for (;;) {
    const input = await readLineOrCompletion();
    if (input.kind === "completion") {
      // A task finished while nobody was typing. The cap is what keeps a chain
      // of task-starts-task from running the machine unattended; an operator
      // line resets it below.
      if (consecutiveAutoWakes >= resolveMaxAutoWake()) {
        agentIo.onSystem?.(
          "◇ a shell task finished; automatic wakes are capped, so it will be reported with your next message.\n",
        );
        continue;
      }
      consecutiveAutoWakes += 1;
      out(`\n${GUTTER}${style.cyan("●")} ${style.bold("keryx")}\n`);
      startSpinner();
      busWorking = true;
      try {
        await runAgentTurn(agentIo, deps, history, "", {
          origin: "task-notification",
          ...(slateSession !== undefined ? { slateSession } : {}),
        });
      } finally {
        busWorking = false;
        endBlock();
        stopSpinner();
      }
      flushSessionCheckpoint();
      out(`\n${GUTTER}${turnSeparator()}\n\n`);
      printPromptWithBusNotice();
      continue;
    }
    const line = input.kind === "line" ? input.line : undefined;
    // An operator line means a human is here: the auto-wake budget starts over.
    consecutiveAutoWakes = 0;
    if (line === undefined) {
      // SLATE-5 close trigger: shell exit (end of input / Ctrl-D).
      await closeSlateSession(slateSession, mintTimestampAttemptId);
      // Flow 173 (AC7): sweep every tracked background job (process-group
      // SIGTERM→SIGKILL) on real session exit.
      await deps.sweepBackgroundJobs?.();
      leaveBus(); // flow 273 AC7-equivalent: the normal return leaves the bus too
      releaseLease(); // AC7: the normal return releases the session lease
      return; // end of input
    }
    rich.safeBoundary?.();
    if (line.startsWith("/")) {
      const parts = line.trim().split(/\s+/);
      const command = parts[0] ?? "";
      const rest = parts.slice(1).join(" ").trim();
      if (command === "/exit" || command === "/quit") {
        // SLATE-5 close trigger: shell exit (explicit command).
        await closeSlateSession(slateSession, mintTimestampAttemptId);
        await deps.sweepBackgroundJobs?.(); // flow 173 AC7: sweep on exit
        leaveBus(); // flow 273 T6: /exit leaves the bus too
        releaseLease(); // flow 271 AC7: `/exit` releases the session lease
        return;
      }
      if (command === "/bus") {
        await runBusSlashCommand(bus, rest, (text) => agentIo.onSystem?.(text));
      } else if (command === "/help") {
        agentIo.onSystem?.(readlineAgentHelpText());
      } else if (isSessionInfoCommand(command)) {
        const cwd = sessionCwd;
        const [workspaces, flows] = await Promise.all([
          loadInspectorWorkspaces(cwd),
          loadInspectorFlows(cwd),
        ]);
        agentIo.onSystem?.(
          formatSessionInfoText(
            buildSessionInfoSnapshot({
              summary: live?.summary,
              selection: { provider: deps.providerId, model: deps.modelId },
              version: packageJson.version,
              usage: lastUsage,
              estimateTokens: estimateContextTokens(history),
              limits: await loadSessionLimits({
                provider: deps.providerId,
                model: deps.modelId,
              }),
              sessionText: history.map((message) => message.content).join("\n"),
              workspaces,
              flows,
            }),
          ),
        );
      } else if (isFlowsCommand(command)) {
        const items = await loadInspectorFlows(sessionCwd);
        if (rest.length > 0) {
          const found = findFlowItem(items, rest);
          agentIo.onSystem?.(
            found !== undefined ? formatFlowDetailText(found) : `No flow matching '${rest}'.\n`,
          );
        } else {
          agentIo.onSystem?.(formatFlowListText(items));
        }
      } else if (command === "/expand") {
        const expanded = expandedToolOutput(lastToolName, lastToolOutput);
        if (expanded !== undefined) {
          stopSpinner();
          out(expanded);
        } else {
          agentIo.onSystem?.("Nothing to expand — no tool output yet.\n");
        }
      } else if (command === "/new" || command === "/clear") {
        // SLATE-5 close trigger: `/new` (and `/clear`, which is the same
        // command under sessions-off — no session dir there, so nothing to
        // close). Archive whatever slate the ABOUT-TO-BE-ABANDONED session
        // was building before switching away from it. Flow 271 (§6.2): lease
        // the new session first; a refusal keeps session, slate and lease.
        const nextLive = sessionsOn ? switchNewSession() : undefined;
        if (nextLive === false) {
          printPromptWithBusNotice();
          continue;
        }
        await closeSlateSession(slateSession, mintTimestampAttemptId);
        if (nextLive !== undefined) {
          live = nextLive;
          history = [];
          archive = [];
          nextArchiveIndex = 0;
          slateSession = { dir: live.dir, cwd: sessionCwd, opened: false };
          slateSessionBox.current = slateSession;
          // AC8: presence.sessionId follows every in-process session switch.
          // review r1 F5: defensive second layer — see the matching comment
          // in `runShell`.
          try {
            await bus?.setSession(live.summary.id);
          } catch (cause) {
            agentIo.onSystem?.(busErrorLine(cause));
          }
          agentIo.onSystem?.(
            `New session ${shortSessionId(live.summary.id)} (previous kept on disk)\n`,
          );
        } else {
          history = [];
          archive = [];
          agentIo.onSystem?.("Conversation cleared.\n");
        }
      } else if (command === "/compact") {
        if (live === undefined) {
          agentIo.onSystem?.("No persistent session.\n");
        } else if (!leaseWatch.canPersist()) {
          agentIo.onSystem?.(LOST_LEASE_COMPACT_REFUSAL);
        } else {
          const packed = compactSession(live, history, archive, {
            keepLastUserTurns: 3,
            ...(rest.length > 0 ? { focus: rest } : {}),
            provider: deps.providerId,
            model: deps.modelId,
          });
          live = packed.handle;
          history = packed.context;
          nextArchiveIndex = history.length;
          if (packed.result.noop) {
            agentIo.onSystem?.("Nothing to compact (context already small).\n");
          } else {
            agentIo.onSystem?.(
              `Compacted −${packed.result.removed} context msgs · archive ${live.summary.archiveMessageCount} · compact×${live.summary.compactCount}\n`,
            );
          }
        }
      } else if (command === "/demote") {
        // Flow 266 (AC8). Parse and effect are both shared with the TUI; only
        // the reporting is this shell's own. Demote never stops the command —
        // that is the difference between this and killing it, and the message
        // says so, because an operator who thought they had stopped a build
        // would not go looking for its output later.
        const parsed = parseDemoteCommand(rest);
        if (!parsed.ok) {
          agentIo.onSystem?.(`${parsed.reason}\n`);
        } else if (deps.jobRegistry === undefined) {
          agentIo.onSystem?.("This session tracks no shell tasks, so there is nothing to demote.\n");
        } else {
          const demoted = demoteTask(deps.jobRegistry, parsed.taskId);
          if (!demoted.ok) {
            agentIo.onSystem?.(`${demoted.error}\n`);
          } else {
            const overCap =
              demoted.overCap !== undefined ? ` Background tasks are over the cap; also running: ${demoted.overCap}.` : "";
            agentIo.onSystem?.(
              `Task ${parsed.taskId} keeps running, now in the background — it was NOT stopped.${overCap}\n`,
            );
          }
        }
      } else if (command === "/mode") {
        const modeArgs = rest.split(/\s+/).filter((p) => p.length > 0);
        const wanted = modeArgs[0] ?? "";
        const saveFlag = modeArgs.includes("save");

        if (wanted.length === 0) {
          const stored = getProjectPermissionMode(sessionCwd);
          agentIo.onSystem?.(
            `Permission mode: ${permissionMode}` +
              (stored !== undefined ? ` (project default: ${stored})\n` : " (no project default set)\n") +
              `Usage: /mode <${PERMISSION_MODES.join("|")}> [save] · /mode clear\n`,
          );
        } else if (wanted === "clear") {
          setProjectPermissionMode(sessionCwd, undefined);
          agentIo.onSystem?.(`Cleared the stored project default. This session stays on: ${permissionMode}\n`);
        } else if (!isPermissionMode(wanted)) {
          agentIo.onSystem?.(`Unknown mode '${wanted}'. Choose one of: ${PERMISSION_MODES.join(", ")}\n`);
        } else {
          // `auto` skips confirmation for EVERY action, including destructive
          // ones (only credential-touching commands still ask — a hard floor
          // no mode lifts). One-time explicit confirmation before it takes
          // effect, on the same shared line-iterator `requestApproval` already
          // uses mid-turn — never a silent flip.
          let confirmed = true;
          if (wanted === "auto") {
            agentIo.onSystem?.(
              "⚠ auto mode skips confirmation for EVERY action, including destructive commands.\n" +
                "Only credential-touching commands still ask. Type 'yes' to confirm: ",
            );
            const answer = ((await readLine()) ?? "").trim();
            confirmed = /^y(es)?$/i.test(answer);
          }
          if (!confirmed) {
            agentIo.onSystem?.("Cancelled — mode unchanged.\n");
          } else {
            permissionMode = wanted;
            agentIo.onSystem?.(`Permission mode: ${permissionMode}\n`);
            if (saveFlag) {
              const saved = setProjectPermissionMode(sessionCwd, permissionMode);
              agentIo.onSystem?.(saved ? "Saved as this project's default.\n" : "Could not save the project default.\n");
            }
          }
        }
      } else if (command === "/reasoning") {
        // Flow 268 T16 (AC11). No arg: show the effective level and which
        // precedence tier it came from. With an arg: set the SESSION
        // override (outranks env/global for the rest of this process) and
        // persist it to `ShellConfig` so it survives a restart too — same
        // "session + persisted" shape as `/mode ... save`, minus the opt-in
        // flag, since there is no per-project default to distinguish here.
        const wanted = rest.trim();
        if (wanted.length === 0) {
          const described = describeReasoningEffortSource({
            sessionOverride: reasoningSessionOverride,
            globalEffort: loadShellConfig(configDir).reasoningEffort,
          });
          agentIo.onSystem?.(
            `Reasoning effort: ${described.effort} (${described.source})\n` +
              `Usage: /reasoning <${REASONING_EFFORT_LEVELS.join("|")}>\n`,
          );
        } else if (!isReasoningEffortLevel(wanted)) {
          agentIo.onSystem?.(
            `Unknown reasoning effort '${wanted}'. Choose one of: ${REASONING_EFFORT_LEVELS.join(", ")}\n`,
          );
        } else {
          reasoningSessionOverride = wanted;
          // `deps` (this function's own `AgentDeps` parameter) is the SAME
          // object every turn below reads — readline agent mode never
          // rebuilds it (no `/model`-style deps swap), so mutating this one
          // field takes effect starting with the very next turn.
          deps.reasoningEffort = wanted;
          saveShellConfig({ reasoningEffort: wanted }, configDir);
          agentIo.onSystem?.(`Reasoning effort: ${wanted}\n`);
          const compatProvider = providerByName(deps.providerId);
          if (compatProvider !== undefined && compatProvider.reasoning === undefined) {
            agentIo.onSystem?.(
              `Note: ${deps.providerId} is OpenAI-compatible with no "reasoning" entry — its reasoning is ` +
                "configured per-provider in llm-providers.json (reasoning.requestParams); this setting has no effect for it.\n",
            );
          }
        }
      } else if (command === "/plan") {
        const planArgs = rest.split(/\s+/).filter((p) => p.length > 0);
        const wanted = planArgs[0] ?? "";

        if (wanted.length === 0) {
          agentIo.onSystem?.(
            `Read-only mode: ${readOnly ? "on" : "off"}\n` + `Usage: /plan [on|off]\n`,
          );
        } else if (wanted === "on") {
          // Going read-only is the safe direction — no confirmation needed
          // (unlike `/mode auto`, which can skip confirmation for destructive
          // actions).
          readOnly = true;
          agentIo.onSystem?.("Read-only mode: on\n");
        } else if (wanted === "off") {
          readOnly = false;
          agentIo.onSystem?.(`Read-only mode: off (permission mode stays: ${permissionMode})\n`);
        } else {
          agentIo.onSystem?.("Usage: /plan [on|off]\n");
        }
      } else if (command === "/search-provider") {
        const args = parseSearchProviderArgs(parts.slice(1));
        const all = searchProviderController.configurable();
        if (args.providerId === undefined) {
          agentIo.onSystem?.(
            describeSearchProviders("Search providers (use /search-provider <id> [key=...]):", all),
          );
          continue;
        }
        const descriptor = all.find((candidate) => candidate.id === args.providerId);
        if (descriptor === undefined) {
          agentIo.onSystem?.(
            `Unknown provider '${args.providerId}'. Available: ${all.map((provider) => provider.id).join(", ")}\n`,
          );
          continue;
        }
        const providerId: SearchProviderId = descriptor.id;
        searchProviderController.configure(providerId, { ...descriptor.defaults, ...args.fields }, args.credential);
        const tested = await searchProviderController.test(providerId);
        if (!tested.ok) {
          const reason = tested.reason === "missing-credential" ? "missing credential" : "connection validation failed";
          agentIo.onSystem?.(
            `Configured '${providerId}' but it is not connected yet: ${reason}. Run /search-provider ${providerId} key=<value> to re-test.\n`,
          );
          continue;
        }
        agentIo.onSystem?.(
          `Configured and tested '${providerId}' successfully. Use /search-connect ${providerId} to make it active.\n`,
        );
      } else if (command === "/search-connect") {
        const providerId = parts[1];
        if (providerId === undefined) {
          const selectable = searchProviderController.selectable();
          agentIo.onSystem?.(
            describeSearchProviders("Connected search providers (use /search-connect <id> to select):", selectable),
          );
          if (selectable.length === 0) {
            agentIo.onSystem?.("No connected search providers found. Run /search-provider first.\n");
          }
          continue;
        }
        const available = searchProviderController.configurable();
        const normalizedProviderId = available.find((candidate) => candidate.id === providerId)?.id;
        if (normalizedProviderId === undefined) {
          agentIo.onSystem?.(`Unknown provider '${providerId}'.\n`);
          continue;
        }
        const result = await searchProviderController.select(normalizedProviderId);
        if (!result.ok) {
          if (result.reason === "not-configured") {
            agentIo.onSystem?.(`Cannot select '${providerId}': provider is not configured.\n`);
          } else if (result.reason === "not-connected") {
            agentIo.onSystem?.(
              `Cannot select '${providerId}': provider is not connected (run /search-provider ${providerId} <params> to test).\n`,
            );
          } else {
            agentIo.onSystem?.(`Cannot select '${providerId}': ${result.reason}.\n`);
          }
          continue;
        }
        agentIo.onSystem?.(`Search provider '${providerId}' selected.\n`);
      } else if (command === "/goal") {
        // SLATE-15 (flow 161, AC1/AC2): deterministic slate-open entry point.
        await runGoalCommand({
          raw: rest,
          cwd: sessionCwd,
          io: agentIo,
          deps,
          history,
          slateSession,
          mintAttemptId: mintTimestampAttemptId,
        });
      } else if (command === "/theme") {
        // Agent-mode readline theme dispatch (flow 196, AC1-AC2): list available
        // themes if no argument, or apply the specified theme if provided.
        // Reuses the same theme persistence logic as chat mode.
        //
        // MANUAL VERIFICATION TRANSCRIPT (AC3):
        // Typing `/theme` in agent-mode readline now lists available themes instead of
        // falling through to "Unknown command". Typing `/theme <name>` applies the theme.
        // Example session:
        //   ❯ /theme
        //   Available themes: auto, light, dark
        //   Usage: /theme <name>
        //   ❯ /theme dark
        //   Theme: dark
        //
        // Note: `runAgentRepl` is not unit-tested directly (see shell.ts comment at
        // line 832), so this dispatch handler is tested indirectly through:
        // - shell-slash-registry.test.ts (ensures all listed commands are handled)
        // - shell.test.ts (ensures the chat REPL core still works)
        // - Functional verification in live sessions (this transcript)
        const wanted = rest.trim();
        if (wanted.length === 0) {
          agentIo.onSystem?.(formatThemeList(getThemeId()));
        } else {
          const next = parseThemeId(wanted);
          if (next === undefined) {
            agentIo.onSystem?.(`Unknown theme '${wanted}'.\n${formatThemeList(getThemeId())}`);
          } else {
            applyThemeId(next);
            persistThemeId(next);
            agentIo.onSystem?.(`Theme: ${themeLabel(next)}\n`);
          }
        }
      } else {
        // `/models` / `/provider` are chat-mode commands: say so instead of
        // calling them unknown. Anything else falls back to the old message.
        agentIo.onSystem?.(
          describeUnavailableCommand(command, "agent") ??
            `Unknown command: ${command}. Type /help.\n`,
        );
      }
      printPromptWithBusNotice();
      continue;
    }
    if (line.trim().length === 0) {
      printPromptWithBusNotice();
      continue;
    }
    out(`\n${GUTTER}${style.cyan("●")} ${style.bold("keryx")}\n`);
    lastUsage = undefined;
    turnToolCalls = 0;
    turnText = "";
    turnError = undefined;
    events?.emit({ type: "turn_start", prompt: line, provider: deps.providerId, model: deps.modelId });
    deps.resetSubagentBudget?.();
    startSpinner();
    busWorking = true;
    try {
      await runAgentTurn(agentIo, deps, history, line, slateSession !== undefined ? { slateSession } : {});
    } catch (error) {
      // Recorded before it is rethrown. A turn that threw and a turn that
      // answered nothing produce the same empty text in the transcript, and a
      // reader that cannot tell them apart will score a crash as an answer.
      turnError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      busWorking = false;
      endBlock(); // close any still-open live block (e.g. on a mid-turn throw)
      stopSpinner();
      const end: ShellEvent = {
        type: "turn_end",
        text: turnText ?? "",
        toolCalls: turnToolCalls,
        ...(lastUsage === undefined ? {} : { usage: lastUsage }),
        ...(turnError === undefined ? {} : { errorMessage: turnError }),
      };
      events?.emit(end);
    }
    flushSessionCheckpoint();
    const usageLine = formatUsage(lastUsage);
    if (usageLine.length > 0) {
      out(`\n${GUTTER}${usageLine}\n`);
    }
    out(`\n${GUTTER}${turnSeparator()}\n\n`);
    rich.safeBoundary?.();
    printPromptWithBusNotice();
  }
}

/** Persisted defaults + provider detection resolved once for a TUI launch. */
export interface TuiStartup {
  /** The initial provider/model, from flags or the persisted config. */
  initial?: { provider: string; model: string; baseUrl?: string };
  /** Detected providers — populated ONLY when there is nothing to reuse. */
  detected: DetectedProvider[];
  /** Env var names populated from the persisted `auth.json` (never the values). */
  appliedKeys: string[];
}

/**
 * The persisted-credential + last-selection bootstrap for a TUI launch.
 *
 * Until flow 112 this lived inside the agent-only TUI branch, so `keryx shell
 * --chat` never called `loadShellConfig()` / `applySavedApiKeys()` at all: a
 * provider key entered through `/connect` was written to `auth.json` and then
 * invisible to chat, which fell back to the offline no-op provider (AC12). It is
 * now shared by BOTH modes.
 *
 * `detect` and `configDir` are injected so the credential path is testable
 * against a temp config directory without touching the user's real one.
 */
export async function resolveTuiStartup(opts: {
  providerArg?: string | undefined;
  modelArg?: string | undefined;
  baseUrl?: string | undefined;
  detect: () => Promise<DetectedProvider[]>;
  configDir?: string | undefined;
}): Promise<TuiStartup> {
  // Saved keys populate the env (env always wins); the saved provider+model
  // become the default selection when no `--provider` flag is given.
  const savedCfg = loadShellConfig(opts.configDir);
  // Stored grants are refreshed by the shell command before it picks a surface
  // (`refreshSavedGrants`, K-013), so the readline surface gets it too.
  const appliedKeys = applySavedApiKeys(opts.configDir);
  const { providerArg, modelArg, baseUrl } = opts;
  if (providerArg !== undefined && modelArg !== undefined) {
    return {
      initial:
        baseUrl === undefined
          ? { provider: providerArg, model: modelArg }
          : { provider: providerArg, model: modelArg, baseUrl },
      detected: [],
      appliedKeys,
    };
  }
  if (
    typeof savedCfg.provider === "string" &&
    savedCfg.provider.length > 0 &&
    typeof savedCfg.model === "string" &&
    savedCfg.model.length > 0
  ) {
    const savedBase = savedCfg.baseUrl ?? baseUrl;
    return {
      initial:
        savedBase === undefined
          ? { provider: savedCfg.provider, model: savedCfg.model }
          : { provider: savedCfg.provider, model: savedCfg.model, baseUrl: savedBase },
      detected: [],
      appliedKeys,
    };
  }
  const detected = await opts.detect();
  return {
    detected: detected.map((provider) => {
      const savedBaseUrl = savedCfg.baseUrls?.[provider.name];
      return typeof savedBaseUrl === "string" && savedBaseUrl.length > 0
        ? { ...provider, baseUrl: savedBaseUrl }
        : provider;
    }),
    appliedKeys,
  };
}

/** Parsed flags for the interactive shell entrypoint. */
export interface ShellCliFlags {
  help?: boolean;
  providerArg?: string;
  modelArg?: string;
  baseUrl?: string;
  /** `true` = agent, `false` = chat, `undefined` = no explicit flag. */
  modeFlag?: boolean;
  /** Prefer OpenTUI when a TTY is available (default true). */
  wantTui: boolean;
  /** Continue the most recent session in this project. */
  continueLast?: boolean;
  /** Resume a session id / short id / title in this project. */
  resumeId?: string;
  /** `-r` without id → open resume picker (TUI) or latest unleased (non-TUI). */
  resumePick?: boolean;
  /** `--fork` (only with `-r <id>`): fork the session and lease the fork. */
  fork?: boolean;
  /** `--take-over` (only with `-r <id>`): reclaim a STALE holder's lease. */
  takeOver?: boolean;
  /**
   * `--permission-mode <ask|trust|auto>` or the `--ask`/`--trust`/`--auto`
   * shorthands. `undefined` means no flag was passed — `runAgentRepl` then
   * falls back to the project's stored default, then `DEFAULT_PERMISSION_MODE`.
   * Agent-mode only (chat mode has no tools to gate); silently ignored on the
   * `tui-chat`/readline-chat surfaces for that reason, not rejected — a
   * leftover flag from a shell alias should not fail the whole launch.
   */
  permissionModeFlag?: PermissionMode;
  /**
   * `--deny-tools <a,b>` — tool names this session must not have.
   *
   * There was no way to say "this session does not need the web". Both other
   * agent CLIs offer one (`claude --disallowedTools`,
   * `grok --disable-web-search`), and keryx already treats egress as a product
   * concern elsewhere — `keryx harness exec --allowed-domains`, `sandbox.json` —
   * so a session-level roster that could not be narrowed was the inconsistent
   * part.
   *
   * Distinct from `--permission-mode`, which governs whether a tool call is
   * APPROVED. A denied tool is not offered to the model at all, so it cannot be
   * attempted, reasoned about, or approved by mistake.
   *
   * An unknown name is refused rather than ignored: `--deny-tools web_serch`
   * must not leave the session with web search and a clear conscience.
   */
  denyTools?: readonly string[];
  /**
   * `--print <prompt>` / `-p`: run exactly one agent turn on this prompt and
   * exit, instead of reading turns from stdin.
   *
   * Agent mode only, and non-interactive by construction: it supplies the one
   * line the REPL would otherwise have read, so the turn goes through the same
   * loop a person drives rather than through a second implementation of it.
   */
  printPrompt?: string;
  /**
   * `--events-file <path>`: append a machine-readable NDJSON transcript of the
   * session — turn boundaries, tool calls and results, and provider-reported
   * usage. Written beside the rendered output, never instead of it.
   */
  eventsFile?: string;
  /**
   * `--events-max-field <n>`: the per-field character cap in that transcript.
   *
   * Raised by callers that need whole tool outputs — a reader looking for a
   * particular path in a long result cannot tell a clipped output from one that
   * never contained it. Redaction still runs first at any limit.
   */
  eventsMaxField?: number;
  /**
   * `--debug`: record the session to `<keryx config dir>/debug/<run>/` —
   * terminal-input state and every call that can stop it (with stacks), keys
   * (names only, never typed text), dialogs, overlays, tool calls, agent state
   * — and start a detached watcher process that checks from outside whether the
   * shell is still reading its terminal, and re-arms input if it is not.
   */
  debug?: boolean;
  /**
   * `--name <name>` (flow 273 T6, decision D-06): the requested bus instance
   * name. Validated against `isAssignableBusName` at parse time — a reserved
   * name (`all`, `cli`, `system`) or one outside `^[a-z0-9][a-z0-9-]{0,31}$`
   * is refused here (`ShellFlagError`, exit 2) rather than reaching `joinBus`,
   * which would otherwise silently fall back to `agent-<n>`.
   */
  name?: string;
}

/**
 * A refused combination of the session-lease flags (`--fork`, `--take-over`),
 * or of `--name` (flow 273 T6).
 * Carries exit code 2, the usage-error code, which `cli.ts` honours.
 */
export class ShellFlagError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(`${message}. See keryx shell --help.`);
    this.name = "ShellFlagError";
  }
}

/**
 * Parse shell CLI flags. Defaults: TUI on, agent mode implied (modeFlag
 * undefined). `--no-tui` opts out of TUI; `--chat` selects chat mode.
 * Session flags (`-c`/`-r`) are per-project only.
 */
export function parseShellCliFlags(args: string[]): ShellCliFlags {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, wantTui: true };
  }
  const invalid = (message: string): never => {
    throw new Error(`${message}. See keryx shell --help. Example: keryx shell --provider ollama --model llama3.1:latest`);
  };
  const valueAfter = (index: number): string => {
    const value = args[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("-")) {
      return invalid(`Missing value for ${args[index]}`);
    }
    return value;
  };
  let providerArg: string | undefined;
  let modelArg: string | undefined;
  let baseUrl: string | undefined;
  let modeFlag: boolean | undefined;
  let wantTui = true;
  let continueLast: boolean | undefined;
  let resumeId: string | undefined;
  let resumePick: boolean | undefined;
  let fork: boolean | undefined;
  let takeOver: boolean | undefined;
  let permissionModeFlag: PermissionMode | undefined;
  let denyTools: string[] | undefined;
  let printPromptArg: string | undefined;
  let eventsFile: string | undefined;
  let eventsMaxField: number | undefined;
  let debug: boolean | undefined;
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      providerArg = valueAfter(i++);
    } else if (arg === "--model") {
      modelArg = valueAfter(i++);
    } else if (arg === "--base-url") {
      baseUrl = valueAfter(i++);
    } else if (arg === "--agent") {
      if (modeFlag === false) invalid("--agent and --chat cannot be combined");
      modeFlag = true;
    } else if (arg === "--chat") {
      if (modeFlag === true) invalid("--agent and --chat cannot be combined");
      modeFlag = false;
    } else if (arg === "--tui") {
      wantTui = true;
    } else if (arg === "--no-tui") {
      wantTui = false;
    } else if (arg === "-c" || arg === "--continue") {
      continueLast = true;
    } else if (arg === "-r" || arg === "--resume") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        resumeId = next;
        i += 1;
      } else {
        resumePick = true;
      }
    } else if (arg === "--fork") {
      fork = true;
    } else if (arg === "--take-over") {
      takeOver = true;
    } else if (arg === "--name") {
      // D-06: a reserved or malformed name is refused HERE (exit 2) rather
      // than reaching `joinBus`, which treats an unusable requested name as
      // simply absent and falls back to `agent-<n>` — a silent fallback would
      // be the wrong outcome for a flag the operator typed on purpose.
      const next = valueAfter(i++);
      if (!isAssignableBusName(next)) {
        throw new ShellFlagError(
          `--name "${next}" must match ^[a-z0-9][a-z0-9-]{0,31}$ and not be "all", "cli" or "system"`,
        );
      }
      name = next;
    } else if (arg === "--permission-mode") {
      const next = valueAfter(i++);
      if (!isPermissionMode(next)) invalid("--permission-mode must be ask, trust or auto");
      permissionModeFlag = next as PermissionMode;
    } else if (arg === "--ask" || arg === "--trust" || arg === "--auto") {
      permissionModeFlag = arg.slice(2) as PermissionMode;
    } else if (arg === "--deny-tools") {
      // Comma-separated, like every other value-taking flag here. Repeated use
      // ACCUMULATES rather than replacing, so `--deny-tools a --deny-tools b`
      // denies both — silently dropping the first would be the worse surprise
      // for a flag whose whole job is removing a capability.
      const names = valueAfter(i++)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length === 0) invalid("--deny-tools needs at least one tool name");
      denyTools = [...(denyTools ?? []), ...names];
    } else if (arg === "-p" || arg === "--print") {
      // `valueAfter` rejects a value starting with `-`, which a prompt legitimately
      // may. Read it directly and reject only an absent or blank one.
      const next = args[i + 1];
      if (next === undefined || next.trim() === "") invalid("Missing value for --print");
      printPromptArg = next;
      i += 1;
    } else if (arg === "--events-file") {
      eventsFile = valueAfter(i++);
    } else if (arg === "--debug") {
      debug = true;
    } else if (arg === "--events-max-field") {
      const raw = valueAfter(i++);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) invalid("--events-max-field must be a positive integer");
      eventsMaxField = parsed;
    } else {
      invalid("Unknown shell argument");
    }
  }
  if (continueLast && (resumeId !== undefined || resumePick)) {
    invalid("--continue and --resume cannot be combined");
  }
  // `--fork` / `--take-over` act on ONE named session (specification §6.1).
  // `-r --take-over` is a bare `-r` (the peek stops at a flag) plus the flag,
  // so it lands in the "needs an id" refusal too. Exit code 2: usage error.
  const leaseFlag = fork === true ? "--fork" : takeOver === true ? "--take-over" : undefined;
  if (leaseFlag !== undefined) {
    if (continueLast === true) {
      throw new ShellFlagError(`${leaseFlag} cannot be combined with --continue; use -r <id> ${leaseFlag}`);
    }
    if (fork === true && takeOver === true) {
      throw new ShellFlagError("--fork and --take-over cannot be combined; choose one");
    }
    if (resumeId === undefined) {
      throw new ShellFlagError(`${leaseFlag} needs an explicit session id; use -r <id> ${leaseFlag}`);
    }
  }
  if (printPromptArg !== undefined && modeFlag === false) {
    // Chat mode has no tools and no turn loop worth driving headlessly. Saying
    // so beats running something that looks like the agent and is not.
    invalid("--print is agent-mode only and cannot be combined with --chat");
  }
  return {
    ...(providerArg !== undefined ? { providerArg } : {}),
    ...(modelArg !== undefined ? { modelArg } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(modeFlag !== undefined ? { modeFlag } : {}),
    wantTui,
    ...(continueLast === true ? { continueLast: true } : {}),
    ...(resumeId !== undefined ? { resumeId } : {}),
    ...(resumePick === true ? { resumePick: true } : {}),
    ...(fork === true ? { fork: true } : {}),
    ...(takeOver === true ? { takeOver: true } : {}),
    ...(permissionModeFlag !== undefined ? { permissionModeFlag } : {}),
    ...(denyTools !== undefined ? { denyTools } : {}),
    ...(printPromptArg !== undefined ? { printPrompt: printPromptArg } : {}),
    ...(eventsFile !== undefined ? { eventsFile } : {}),
    ...(eventsMaxField !== undefined ? { eventsMaxField } : {}),
    ...(debug === true ? { debug: true } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** Which surface `shellCommand` should run for a given set of flags. */
export type ShellSurface =
  /** The OpenTUI agent shell (`launchTuiAgentShell`). */
  | "tui-agent"
  /** The OpenTUI chat shell (`launchTuiChatShell`) — flow 112. */
  | "tui-chat"
  /** The classic readline shell (also the fallback when a TUI launch declines). */
  | "readline";

/**
 * Pure: pick the surface from the parsed flags and whether stdout is a TTY.
 *
 * Extracted from the launch guard because the guard's own shape is the AC12
 * change: it used to read `flags.wantTui && isTty && modeFlag !== false`, so
 * `--chat` never reached the TUI at all. `parseShellCliFlags` was never the
 * thing that excluded chat — it always returned `wantTui: true` for `--chat` —
 * so asserting on its output cannot tell the old behaviour from the new one.
 * This function can.
 */
export function chooseShellSurface(
  flags: Pick<ShellCliFlags, "wantTui" | "modeFlag" | "printPrompt">,
  isTty: boolean,
): ShellSurface {
  // `--print` is one turn on a supplied prompt with no terminal to own. It goes
  // to the readline surface even on a TTY, and even with `--tui`, because the
  // TUI has no way to be handed a line and exit.
  if (flags.printPrompt !== undefined) {
    return "readline";
  }
  if (!flags.wantTui || !isTty) {
    return "readline";
  }
  return flags.modeFlag === false ? "tui-chat" : "tui-agent";
}

/**
 * Thin TTY wrapper (NOT unit-tested end-to-end): parses flags, wires IO, and
 * runs the deterministic core.
 *
 * Defaults: **TUI + agent** when stdout is a TTY. Escape hatches:
 * - `--no-tui` → classic readline shell
 * - `--chat` → chat mode (no tools) — in the TUI too since flow 112
 * - `--tui` is accepted for compatibility (TUI is already the default)
 *
 * When `--provider` is ABSENT, providers are detected and the user picks one
 * (in-TUI picker, or readline picker on fallback). When `--provider X` is
 * given, the picker is skipped: the model is `--model Y` if given, otherwise
 * that provider's first detected model.
 */
export interface ShellCommandRuntime {
  checkVersion?: () => Promise<VersionCheckResult>;
  cacheDir?: string;
  isTty?: boolean;
  launchAgent?: typeof launchTuiAgentShell;
  launchChat?: typeof launchTuiChatShell;
}

export async function shellCommand(args: string[], runtime: ShellCommandRuntime = {}): Promise<void> {
  // Internal: the detached watcher `--debug` starts. Not a user-facing flag.
  if (args[0] === "--debug-watcher") {
    const { runDebugWatcher } = await import("../tui/debug-watcher");
    await runDebugWatcher(args.slice(1));
    return;
  }
  const flags = parseShellCliFlags(args);
  if (flags.help) {
    console.log(`Usage: keryx shell [options]

  --help, -h                    Show this help without starting a session
  --provider <name>             Use this provider (otherwise choose interactively)
  --model <name>                Use this model
  --base-url <url>              Override the provider endpoint
  --agent | --chat              Choose agent (default) or chat mode
  --tui | --no-tui              Prefer TUI (default) or readline; last flag wins
  --continue, -c                Continue the most recent session no other shell has open
  --resume, -r [id-or-title]     Resume a session, or open the session picker
  --fork                        With -r <id>: continue in a fork of that session
  --take-over                   With -r <id>: take the session from a stale holder
  --name <name>                 Join the agent bus under this name (lowercase, digits, -; not all/cli/system)
  --permission-mode <mode>      Agent permissions: ask, trust or auto
  --deny-tools <a,b>            Withhold these tools from the session entirely
  --ask | --trust | --auto       Permission shortcuts; last flag wins
  --print, -p <prompt>          Run one agent turn on this prompt and exit
  --events-file <path>          Append an NDJSON transcript (turns, tools, usage)
  --events-max-field <n>        Per-field character cap in that transcript (default 4000)
  --debug                       Log the session (input, keys, dialogs, tools) and start a watcher
                                that re-arms terminal input if it stops; see debug/latest.txt

Session continuation and resume are mutually exclusive. Permission flags
are ignored in chat mode. Without a TTY, resume without an ID uses the latest
session no other shell has open. A session open in another shell is refused;
--fork and --take-over (stale holders only) need an explicit -r <id> and
cannot be combined with each other or with --continue.

A shell that stops reacting to keys can be recovered from another terminal
with: kill -USR2 <keryx pid>

Example: keryx shell --provider ollama --model llama3.1:latest`);
    return;
  }
  if (flags.debug === true) {
    const { startDebugRun, debugEvent } = await import("../tui/debug-log");
    const { spawnDebugWatcher } = await import("../tui/debug-watcher");
    const run = startDebugRun(runtime.cacheDir !== undefined ? { configDir: runtime.cacheDir } : {});
    const watcherPid = spawnDebugWatcher(run);
    debugEvent("session.start", {
      version: packageJson.version,
      argv: args,
      bun: typeof Bun !== "undefined" ? Bun.version : undefined,
      platform: process.platform,
      execPath: process.execPath,
      cwd: process.cwd(),
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      env: Object.fromEntries(
        ["TERM", "TERM_PROGRAM", "COLORTERM", "TMUX", "HERDR_ENV", "HERDR_PANE_ID", "SSH_TTY", "LANG"].map((k) => [k, process.env[k]]),
      ),
      watcherPid,
      dir: run.dir,
    });
    process.on("exit", (code) => {
      debugEvent("session.exit", { code });
      process.stderr.write(`keryx debug log: ${run.dir}\n`);
    });
  }
  // Start exactly once, before provider detection, renderer creation, or
  // readline. Nothing below awaits this promise during startup.
  const versionCheck = (runtime.checkVersion ?? (() => checkVersion({
    currentVersion: packageJson.version,
    ...(runtime.cacheDir !== undefined ? { cacheDir: runtime.cacheDir } : {}),
  })))();
  const providerArg = flags.providerArg;
  const modelArg = flags.modelArg;
  let baseUrl = flags.baseUrl;
  // Mode precedence: an explicit `--agent`/`--chat` flag wins; otherwise the
  // interactive picker asks (agent-default), and the non-interactive path
  // defaults to agent. `undefined` = "no explicit flag given".
  let modeFlag = flags.modeFlag;
  // `--fork` / `--take-over` (flow 271): passed to every surface's session opts.
  const leaseFlagOpts: { fork?: boolean; takeOver?: boolean } = {
    ...(flags.fork === true ? { fork: true } : {}),
    ...(flags.takeOver === true ? { takeOver: true } : {}),
  };

  // OpenTUI path (default when TTY): OpenTUI owns the terminal from the START —
  // NO readline is created here, so it cannot consume the terminal's responses
  // to OpenTUI's capability queries (the flows 065/066 corruption).
  // Provider/model come from flags, the persisted config, or an in-TUI picker.
  // On no-TTY / absent optional dep / init failure / `--no-tui` it falls through
  // to the readline shell below.
  //
  // BOTH modes since flow 112 (AC12): the guard no longer excludes `--chat`, it
  // dispatches on the mode — agent → `launchTuiAgentShell`, chat → the chat
  // driver, which renders `ShellIO` through the same chrome and is driven by the
  // very `runShell` the readline fallback runs.
  // Before any surface builds a provider from a stored grant (K-013). This ran
  // only inside the TUI's start-up, so the readline surface — `--no-tui`,
  // `--print`, every scripted run — sent an access token hours past its expiry.
  //
  // Bounded, because it runs before anything else and a network that drops
  // packets silently would otherwise hang a scripted run for good. Only the
  // provider the flags name, when they name one — the TUI picker may choose any.
  {
    const { refreshSavedGrants } = await import("../lib/oauth/login");
    const oauthFetch = (input: string, init?: RequestInit) => globalThis.fetch(input, init);
    const http = { fetch: oauthFetch, signal: AbortSignal.timeout(GRANT_REFRESH_TIMEOUT_MS) };
    const warnings = await refreshSavedGrants(http, runtime.cacheDir, providerArg === undefined ? undefined : [providerArg]);
    for (const warning of warnings) process.stderr.write(`keryx: ${warning}\n`);
  }
  // flow 268 T16 (AC11): the `/reasoning <level>` shell command's session
  // override — shared between the TUI (`makeAgentDeps` below, and the
  // `setReasoningOverride` threaded through `opts` to `tui-shell.ts`) and the
  // readline agent REPL (`agentDepsBase` below), since both branches are
  // sequential code in THIS function, not two separate closures. Outranks
  // `KERYX_REASONING_EFFORT` and the persisted global setting (see
  // `resolveReasoningEffort`'s precedence doc) for as long as THIS process
  // runs; a fresh process instead reads the persisted
  // `ShellConfig.reasoningEffort` the command also writes, so the choice
  // survives a restart even though this in-memory override does not.
  let reasoningSessionOverride: string | undefined;
  const surface = chooseShellSurface(flags, runtime.isTty ?? process.stdout.isTTY === true);
  if (surface !== "readline") {
    const cwd = process.cwd();
    const tuiProviderFactory = realMakeProvider(() => {});
    // Search credentials stay inside the controller/transport boundary. The
    // model only sees the read-only `web_search` tool and its redacted result.
    const searchProviderController = createDefaultSearchProviderController();
    // Flow 173 (AC7): ONE session-scoped JobRegistry, created here — OUTSIDE
    // `makeAgentDeps` — and closed over by every call. `makeAgentDeps` is
    // invoked multiple times per TUI session (initial launch, `/model`/
    // `/connect` rebuild, a read-only side-worker rebuild); without this, each
    // rebuild would fall through to `buildInteractiveAgentTools`'s own
    // internal `jobRegistry ?? createJobRegistry(...)` fallback and mint a
    // fresh, unreachable registry, orphaning any job started before a switch.
    // `onEvent: emitBackgroundJob` feeds the TUI's Background Jobs sidebar/
    // inspector live (flow 173, AC8) via `job-bridge.ts`'s module-level
    // listener; a safe no-op whenever no TUI is mounted to register one.
    const jobRegistry = createJobRegistry({ cwd, onEvent: emitBackgroundJob });
    // Session-scoped, and LAZY.
    //
    // Session-scoped for the reason spelled out above for the registry:
    // `makeAgentDeps` runs again on every `/model` or `/connect` rebuild, and
    // a runtime built inside it would spawn a second set of server processes
    // and orphan the first. So it is created at most once and captured.
    //
    // Lazy because `keryx shell --chat` never calls `makeAgentDeps` at all —
    // it has no tool list. Creating eagerly here spawned every configured
    // server for a surface that cannot use one, held them for the session,
    // and closed them at exit having consulted none.
    let mcpRuntime: McpRuntime | undefined;
    const getMcpRuntime = (): McpRuntime => {
      mcpRuntime ??= createMcpRuntime({
        cwd,
        // The PROJECT root, not `cwd`. `projectConfigFiles` walks cwd → the
        // root it is given, so passing `cwd` collapsed the walk to a single
        // directory: a server configured at the repo root was invisible to a
        // shell started in `packages/web`, while `keryx mcp list` — which
        // does resolve the root — listed it. Two surfaces, two answers.
        gitRoot: resolveProjectRoot(cwd),
        ...(runtime.cacheDir === undefined ? {} : { configDir: runtime.cacheDir }),
      });
      return mcpRuntime;
    };
    const makeAgentDeps = async (
      sel: { provider: string; model: string; baseUrl?: string },
      getSlateSession: () => SlateSessionRef | undefined,
      // Flow 274 (agent bus P3, T6/T7 contract): `tui-shell.ts`'s own live
      // getter over ITS `liveBus` — see that file's widened `opts.makeAgentDeps`
      // doc comment. Optional so every existing caller (tests) that predates
      // the bus is unaffected.
      bus?: { client: () => BusClient | undefined },
    ): Promise<AgentDeps> => {
      // Finding 1 fix (fix round, code review of PR #306): this parameter
      // used to be `getSessionDir: () => string | undefined`, matching only
      // what `buildInteractiveAgentTools` needs — but `createSpawnSubagentTool`
      // below never received ANY slate ref at all, so SLATE-6's child-slate
      // fold mechanism silently never fired for a real `keryx shell` TUI
      // session (there was no `slateSession`/`getSlateSession` field passed
      // to it whatsoever). Widened to match `tui-shell.ts`'s own widened
      // `opts.makeAgentDeps` contract (see that file's doc comment); the
      // `.dir`-only shape `buildInteractiveAgentTools` still wants is derived
      // locally right below, not threaded in from the caller.
      const getSessionDir = (): string | undefined => getSlateSession()?.dir;
      // Rebuilt on launch and on every `/model` switch, so this is the live session.
      exportCallerSession(sel.provider, sel.model);
      const agentProvider = tuiProviderFactory(sel.provider, sel.model, sel.baseUrl);
      // flow 268: resolved fresh on every `makeAgentDeps` call (launch,
      // `/model`, `/connect`) — same lifecycle as `agentProvider` above. `{}`
      // for a native adapter with no OpenAI-compatible registry entry.
      const resolvedModelParams = resolveProviderModelParamsByName(
        sel.provider,
        loadShellConfig(runtime.cacheDir),
        runtime.cacheDir,
      );
      let orient: string;
      try {
        orient = await buildOrientation(cwd);
      } catch {
        orient = "";
      }
      const metaprojectPort = createMetaprojectAdapter(cwd);
      // MAE multi-agent: parent can spawn bounded subagents (ledger + fleet events).
      let resetSubagentBudget: (() => void) | undefined;
      const spawnTool = createSpawnSubagentTool({
        cwd,
        onFleetEvent: emitSubagentFleet,
        onLedgerReady: (controls) => {
          resetSubagentBudget = controls.resetBudget;
        },
        getParentModel: () => ({
          providerId: sel.provider,
          modelId: sel.model,
          ...(sel.baseUrl !== undefined ? { baseUrl: sel.baseUrl } : {}),
        }),
        makeProvider: (providerId, modelId, childBaseUrl) =>
          tuiProviderFactory(providerId, modelId, childBaseUrl ?? sel.baseUrl),
        // The allowlist AND the candidate set for tier resolution. `models` is
        // carried through rather than mapped away: `buildTierMap`
        // (src/gdskills/model-tier.ts) ranks exactly these ids to place a
        // child's `model_tier` relative to this session's own model, so
        // flattening a `DetectedProvider` to `{ name }` here starved discovery
        // at the source and made every tier resolve to the session model.
        // Keyed by name so the session's provider is always present (it is the
        // one a child inherits) and a detected entry replaces the placeholder
        // in place, keeping detection order.
        getDetectedProviders: () => {
          const byName = new Map<string, { name: string; models: readonly string[] }>();
          byName.set(sel.provider, { name: sel.provider, models: [] });
          for (const d of tuiDetected) {
            byName.set(d.name, { name: d.name, models: d.models ?? [] });
          }
          return [...byName.values()];
        },
        // Finding 1 fix: thread the LIVE getter through so a dispatched
        // subagent's Seeds/Anchors actually fold into this TUI session's
        // slate once it opens — `createSpawnSubagentTool` calls this at fold
        // time, not once at construction, so it correctly observes a slate
        // that opens AFTER this tool instance is built (see that file's own
        // `SpawnSubagentToolDeps.getSlateSession` doc comment).
        getSlateSession,
        // External agent runtime (flow 176). Lazy: the gate reads config and the
        // project manifest, and this tool is built synchronously. Off by
        // default, so the common path resolves to a `Denied` with a named
        // reason and nothing is ever spawned.
        // The three seams flow 176 T18 added, all of them routed through the
        // module-level bridge in `tui/external-bridge.ts` for the same reason
        // `emitBackgroundJob` above is: this factory is built before any
        // renderer exists and must work identically in a readline session that
        // never mounts one.
        //
        // `approve` is NOT optional-in-practice. `externalAgents.spawnDecision`
        // defaults to "ask" and `createRunExternal` fails closed with no
        // approver, so before this line every model-initiated external spawn was
        // denied on a correctly-configured machine and the feature could not run
        // at all. `approveExternalSpawn` still refuses — with a named reason —
        // whenever no interactive host has registered itself, so a headless or
        // non-interactive session cannot self-approve.
        runExternal: createLazyRunExternal({
          cwd,
          observer: externalRunBridgeObserver,
          approve: approveExternalSpawn,
          // The shell renders the live transcript and offers a per-addressee
          // message queue, so a steerable run pays for its open stdin pipe.
          // Without this every run launches one-shot and the operator's
          // messages can only ever reach the child by resume — which is what
          // §7.5's stdin route existed for.
          steerable: true,
        }),
      });
      // Flow 267: fetch the provider's real context window for the auto-
      // compaction guard (`AgentDeps.contextWindow`). This runs on every
      // `makeAgentDeps` call — the initial launch AND every `/model`/
      // `/connect` rebuild (see this function's own doc comment above) — so
      // the guard's window always matches the CURRENTLY selected model,
      // never a stale one from before a switch. Best-effort: an unreachable
      // gateway or unrecognized provider just leaves `contextWindow`
      // undefined, same as `loadSessionLimits`'s own "never invent a window"
      // contract for `/status`.
      let contextWindow: number | undefined;
      try {
        const limits = await loadSessionLimits({
          provider: sel.provider,
          model: sel.model,
          ...(sel.baseUrl !== undefined ? { baseUrl: sel.baseUrl } : {}),
        });
        contextWindow = limits.contextWindow;
      } catch {
        // best-effort — the guard simply stays off.
      }
      const deps = {
        provider: agentProvider,
        providerId: sel.provider,
        modelId: sel.model,
        tools: buildInteractiveAgentTools({
          cwd,
          metaprojectPort,
          searchController: searchProviderController,
          spawnTool,
          getSessionDir,
          jobRegistry,
          mcp: getMcpRuntime(),
          ...(flags.denyTools !== undefined ? { denyTools: flags.denyTools } : {}),
          // Flow 274 (agent bus P3, T6/T7 contract): passed whenever the
          // caller (`tui-shell.ts`) even attempts to join a bus, regardless
          // of whether `bus.client()` currently resolves — T6's tools refuse
          // `bus-disabled` at call time when it does not.
          ...(bus !== undefined ? { bus } : {}),
        }),
        // The EXISTING runtime, never a new one. `/mcp` is a read-only
        // view; opening it must not be the thing that spawns every
        // configured server, which calling `getMcpRuntime()` here would
        // do for `--chat` sessions that never build a tool list.
        mcpRuntime: () => mcpRuntime,
        // Generous default so multi-step operator prompts do not hit the
        // loop-safety round budget mid-task; override with KERYX_AGENT_MAX_ROUNDS.
        maxRounds: resolveAgentMaxRounds(),
        // Precedence: KERYX_MAX_OUTPUT_TOKENS env > this session's
        // per-provider override (`resolvedModelParams.maxOutputTokens`,
        // resolved above via `resolveProviderModelParamsByName` — an
        // operator-saved `ShellConfig.modelParams[provider]` override, else
        // the provider's own `CustomCompatProvider.maxOutputTokens`; absent
        // for a built-in with no override) > the operator's persisted global
        // setting > DEFAULT_MAX_OUTPUT_TOKENS. Routed through
        // `resolvedModelParams` (rather than a second, independent
        // `providerByName(...).maxOutputTokens` lookup) so there is exactly
        // one computation of the provider's effective override — see
        // `resolveAgentMaxOutputTokens`'s doc comment.
        maxOutputTokens: resolveAgentMaxOutputTokens({
          providerMaxOutputTokens: resolvedModelParams.maxOutputTokens,
          globalMaxOutputTokens: loadShellConfig(runtime.cacheDir).maxOutputTokens,
        }),
        // Precedence: this session's `/reasoning` override (set below, via
        // `setReasoningOverride`) > KERYX_REASONING_EFFORT env > the
        // operator's persisted global setting > "off". See
        // `resolveReasoningEffort`'s doc comment.
        reasoningEffort: resolveReasoningEffort({
          sessionOverride: reasoningSessionOverride,
          globalEffort: loadShellConfig(runtime.cacheDir).reasoningEffort,
        }),
        idSeq: () => randomUUID(),
        askUser: invokeAskUserHost,
        sweepBackgroundJobs: () => jobRegistry.sweepAll(),
        jobRegistry,
        ...(resetSubagentBudget !== undefined ? { resetSubagentBudget } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(Object.keys(resolvedModelParams).length > 0 ? { modelParams: resolvedModelParams } : {}),
      };
      // The instruction is built from the roster it describes, so it never
      // names a tool this session was not given.
      return {
        ...deps,
        systemInstruction: buildAgentSystemInstruction(orient, {
          providerId: sel.provider,
          modelId: sel.model,
          toolNames: interactiveAgentToolNames(deps.tools),
          // Flow 274 (T6/T7 contract): true only once `bus.client()` actually
          // resolves. `tui-shell.ts` rebuilds via this same function right
          // after its own join settles, so a session that starts before the
          // join finishes (always true for the FIRST call) still ends up
          // with the conduct block once that rebuild runs.
          busJoined: bus?.client() !== undefined,
        }),
      };
    };
    const redetect = (): Promise<DetectedProvider[]> =>
      detectProviders({
        fetch: globalThis.fetch,
        env: process.env,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
    // Persisted config (flow 080/085, opencode-style): reuse the last
    // provider/model and every saved provider API key so the user need not
    // re-enter them. Applied in BOTH modes since flow 112 — chat used to skip
    // this entirely (AC12).
    const startup = await resolveTuiStartup({
      providerArg,
      modelArg,
      baseUrl,
      detect: redetect,
      ...(runtime.cacheDir !== undefined ? { configDir: runtime.cacheDir } : {}),
    });
    const tuiInitial = startup.initial;
    const tuiDetected = startup.detected;
    // The chat TUI's session lease (flow 271), written by `runShell` and
    // released in the `finally` below on every exit from the TUI branch.
    const chatLeaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    // The chat TUI's bus client (flow 273 T6), left in that same `finally`.
    const chatBusBox: { current: BusClient | undefined } = { current: undefined };
    // The tui-agent surface's session opts (flow 273 T6: carries `busName`
    // for T7's `joinBus` wiring — see the call site below for why this is a
    // named variable rather than an inline literal).
    const tuiAgentSessionOpts = {
      cwd,
      ...(flags.continueLast === true ? { continueLast: true } : {}),
      ...(flags.resumeId !== undefined ? { resumeId: flags.resumeId } : {}),
      ...(flags.resumePick === true ? { pickOnStart: true } : {}),
      // Flow 271: `--fork` / `--take-over` for the TUI's leased open (T8).
      ...leaseFlagOpts,
      ...(flags.name !== undefined ? { busName: flags.name } : {}),
    };

    try {
    if (surface === "tui-chat") {
      // Chat: the SAME `runShell` the readline fallback below runs, rendered
      // through the shared chrome.
      const chatFactory = realMakeProvider(() => {});
      let chatResumeId = flags.resumeId;
      // Bare `-r` never picks a session another shell holds (§6.1, AC4). The
      // renderer is not up yet, so the skipped-session line is held and shown
      // in the transcript once the chat driver starts.
      const chatNotes: string[] = [];
      if (flags.resumePick === true && chatResumeId === undefined) {
        chatResumeId = bareResumeTarget(cwd, (text) => {
          chatNotes.push(text);
        });
      }
      if (
        await (runtime.launchChat ?? launchTuiChatShell)({
          detected: tuiDetected,
          redetect,
          ...(tuiInitial !== undefined ? { initial: tuiInitial } : {}),
          // A held `-r <id>` makes `runShell` throw `SessionLeasedError`; the
          // chat surface offers fork / view / cancel (/ take over) instead.
          runShell: async (chatIo, chatDeps) => {
            const code = await runLeasedChatShell(chatIo, chatDeps, runShell, chatNotes.splice(0));
            if (code !== undefined) {
              process.exitCode = code;
            }
          },
          makeShellDeps: (sel) => {
            // flow 268: resolved fresh on every chat `/model`/`/connect`
            // rebuild, same as the agent-mode `makeAgentDeps` above.
            const resolvedModelParams = resolveProviderModelParamsByName(
              sel.provider,
              loadShellConfig(runtime.cacheDir),
              runtime.cacheDir,
            );
            return {
              makeProvider: chatFactory,
              clock: () => new Date().toISOString(),
              idSeq: () => randomUUID(),
              initial:
                Object.keys(resolvedModelParams).length > 0 ? { ...sel, modelParams: resolvedModelParams } : sel,
              session: {
                cwd,
                ...(flags.continueLast === true ? { continueLast: true } : {}),
                ...(chatResumeId !== undefined ? { resumeId: chatResumeId } : {}),
                ...leaseFlagOpts,
                ...(flags.name !== undefined ? { busName: flags.name } : {}),
                busSurface: "tui",
                leaseBox: chatLeaseBox,
                busBox: chatBusBox,
              },
            };
          },
          versionCheck,
        })
      ) {
        return;
      }
      // else: optional dep absent / init failed → readline chat below.
    } else if (
      await (runtime.launchAgent ?? launchTuiAgentShell)({
        detected: tuiDetected,
        makeAgentDeps,
        // Flow 268 T16 (AC11): the TUI's `/reasoning` command updates THIS
        // session's override through here, so a later `/model`/`/connect`
        // rebuild (a fresh `makeAgentDeps` call) resolves the same level.
        setReasoningOverride: (level) => {
          reasoningSessionOverride = level;
        },
        // `/connect` and `/model` re-probe providers fresh.
        redetect,
        ...(tuiInitial !== undefined ? { initial: tuiInitial } : {}),
        // `tuiAgentSessionOpts` (below), not an inline literal here: passed as
        // a variable so TS checks it structurally instead of as a fresh
        // object literal. `launchTuiAgentShell`'s own `session` option type
        // (`src/tui/tui-shell.ts`, T7's file) does not (yet) declare
        // `busName` — a fresh literal here would fail an excess-property
        // check that a variable's assignability does not run, so this reaches
        // T7's own `joinBus` wiring there without this file depending on, or
        // needing to touch, that type's shape.
        session: tuiAgentSessionOpts,
        ...(flags.permissionModeFlag !== undefined ? { initialPermissionMode: flags.permissionModeFlag } : {}),
        versionCheck,
      })
    ) {
      return;
    }
    // else: optional dep absent / init failed → fall through to the readline shell.
    } finally {
      // The chat TUI's bus client and lease (flow 273 T6, flow 271, AC7).
      // Idempotent: `runShell` usually released both already on its own
      // return. Bus first, so a peer never sees presence outlive the lease.
      chatBusBox.current?.leave();
      chatBusBox.current = undefined;
      releaseSessionLease(chatLeaseBox.current);
      chatLeaseBox.current = undefined;
      // Runs on every exit from the TUI branch — the two `return`s above and
      // the fall-through to readline alike. Each connected server is a child
      // process holding a pipe; on fall-through the readline path builds its
      // own runtime, so not closing here would leave two sets alive.
      // `mcpRuntime` is undefined when nothing ever asked for it, which is
      // the `--chat` case.
      if (mcpRuntime !== undefined) {
        await mcpRuntime.close();
        // AFTER the alternate screen is gone. Printed at start-up it lands
        // ~170 lines before the renderer mounts and is wiped by it, so the
        // operator never sees "your mcp-servers.json has a trailing comma"
        // — the exact bargain `reportMcpProblems` exists to honour.
        reportMcpProblems(mcpRuntime);
      }
    }
  }

  const rl = readline.createInterface({ input: process.stdin });

  // The readline agent session's MCP runtime, reachable from the signal
  // handler below. Assigned when the agent branch builds one.
  let readlineMcp: McpRuntime | undefined;
  // The session lease the readline REPL holds (flow 271), written by the REPL
  // and released by the signal handler below before `process.exit` (AC7).
  const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
  // The bus client the readline REPL joined (flow 273 T6), released by the
  // same signal handler before the lease (specification §5.4).
  const busBox: { current: BusClient | undefined } = { current: undefined };

  // SIGINT: exit, but CLOSE FIRST.
  //
  // Registered for TTY as well as non-TTY now. `process.exit` runs no
  // `finally`, so Ctrl-C used to skip `mcpRuntime.close()` entirely and
  // leave a child process per connected server behind; on a TTY there was
  // no handler at all, so Node's default disposition did the same thing
  // faster. This interface is created without an `output`, so it is not in
  // terminal mode and readline raises no SIGINT of its own — there is no
  // confirmation flow here to preserve, and the observable outcome is
  // unchanged apart from the cleanup.
  //
  // `close()` is bounded (see `CLOSE_GRACE_MS`), so this cannot turn Ctrl-C
  // into a hang.
  const closeAndExit = (code: number) => (): void => {
    // Synchronously, first: the bus presence and the lease must both be gone
    // even if the close below hangs until the grace timeout (specification
    // §5.4, §6, AC7). Bus first, so a peer never sees presence outlive the
    // lease it names.
    busBox.current?.leave();
    busBox.current = undefined;
    releaseSessionLease(leaseBox.current);
    leaseBox.current = undefined;
    void (async (): Promise<void> => {
      try {
        await readlineMcp?.close();
      } catch {
        // Exiting; a failed close must not become the last thing printed.
      }
      rl.close();
      process.exit(code);
    })();
  };
  process.on("SIGINT", closeAndExit(130));
  // SIGTERM too. Only SIGINT was handled, so `kill <pid>` — what a
  // supervisor, a CI job or a terminal-closing window manager sends — took
  // the default disposition and left one child process per connected
  // server behind.
  process.on("SIGTERM", closeAndExit(143));
  // A SINGLE shared line iterator so the picker and the REPL consume stdin in
  // sequence (two independent iterators would race over the same readline).
  const lineIterator = rl[Symbol.asyncIterator]();
  // `--print` supplies the one line the REPL would have read, so the turn runs
  // through the same loop a person drives. The iterator ends immediately after,
  // which is what makes the process exit rather than wait for a second turn.
  const oneShotPrompt = flags.printPrompt;
  const sharedLines: AsyncIterable<string> =
    oneShotPrompt === undefined
      ? { [Symbol.asyncIterator]: () => lineIterator }
      : {
          async *[Symbol.asyncIterator]() {
            yield oneShotPrompt;
          },
        };

  const { io, emitSystem, printHeader, printPrompt, destroy } = createRichIo(sharedLines, versionCheck);

  // Flow 271 (§6.1): what to do when the session to open is held by another
  // shell. The choice reads from the same shared line iterator as the REPL;
  // `--print` has no one to answer, so it takes the non-interactive refusal.
  const leaseChoiceRuntime: LeaseChoiceRuntime = {
    isTty: process.stdin.isTTY === true && oneShotPrompt === undefined,
    io: {
      write: (text) => {
        io.write(text);
      },
      readLine: async () => {
        const next = await lineIterator.next();
        return next.done === true ? undefined : next.value;
      },
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
  };
  const bareResumeId = (): string | undefined => bareResumeTarget(process.cwd(), emitSystem);
  const finishLeased = (code: number | undefined): void => {
    if (code !== undefined) {
      process.exitCode = code;
    }
  };

  let provider: string;
  let model: string;
  try {
    if (providerArg === undefined) {
      // No provider flag: detect + interactively pick.
      const detected = await detectProviders({
        fetch: globalThis.fetch,
        env: process.env,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      const picked = await pickProviderModel(io, detected);
      provider = picked.provider;
      model = picked.model;
      if (picked.baseUrl !== undefined) {
        baseUrl = picked.baseUrl;
      }
      // Offer the agent/chat choice only when no explicit flag was given.
      if (modeFlag === undefined) {
        modeFlag = await pickAgentMode(io);
        io.write("\n");
      }
    } else {
      provider = providerArg;
      if (modelArg !== undefined) {
        model = modelArg;
      } else {
        // Resolve the provider's first detected model (no hardcoded default).
        const detected = await detectProviders({
          fetch: globalThis.fetch,
          env: process.env,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
        const match = detected.find((d) => d.name === providerArg);
        model = match?.models[0] ?? "fake-echo";
      }
    }

    const baseFactory = realMakeProvider(emitSystem);
    // flow 268: resolved once at readline startup, same as the TUI branches
    // above; re-resolved on every `/model`/`/provider`/`/connect` re-selection
    // by `realSelectProviderModel`'s own wrapping (see its definition).
    const initialModelParams = resolveProviderModelParamsByName(
      provider,
      loadShellConfig(runtime.cacheDir),
      runtime.cacheDir,
    );
    const deps: ShellDeps = {
      makeProvider: baseFactory,
      clock: () => new Date().toISOString(),
      idSeq: () => randomUUID(),
      initial: {
        provider,
        model,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(Object.keys(initialModelParams).length > 0 ? { modelParams: initialModelParams } : {}),
      },
      selectProviderModel: realSelectProviderModel(baseUrl, runtime.cacheDir),
    };

    // Resolve the mode: explicit flag wins; otherwise default to agent.
    const agentMode = modeFlag ?? true;
    const modeLabel = agentMode ? " · agent" : " · chat";
    const cwdLabel = collapseHome(process.cwd());
    printHeader(
      "keryx",
      `${provider}/${model}${baseUrl !== undefined ? ` (${baseUrl})` : ""}${modeLabel} · ${cwdLabel}`,
    );

    if (agentMode) {
      // Agent mode: give the model read-only hands + metaproject orientation.
      exportCallerSession(provider, model);
      const agentProvider = baseFactory(provider, model, baseUrl);
      let orient: string;
      try {
        orient = await buildOrientation(process.cwd());
      } catch {
        orient = ""; // orientation is best-effort; the builder falls back
      }
      // In-process metaproject access (flow 037): the adapter serves graph +
      // memory in-process; search_code still falls back to the subprocess runner.
      const metaprojectPort = createMetaprojectAdapter(process.cwd());
      const agentCwd = process.cwd();
      const jobRegistry = createJobRegistry({ cwd: agentCwd });
      // One MCP runtime per session, for the same reason as `jobRegistry`
      // above: server processes must not be re-spawned and orphaned on every
      // tool-list rebuild. Non-blocking — the dials run behind the prompt.
      const mcpRuntime = createMcpRuntime({
        cwd: agentCwd,
        gitRoot: resolveProjectRoot(agentCwd),
        ...(runtime.cacheDir === undefined ? {} : { configDir: runtime.cacheDir }),
      });
      // Reachable from the SIGINT handler above, which is registered before
      // this point and would otherwise have nothing to close.
      readlineMcp = mcpRuntime;
      reportMcpProblems(mcpRuntime);
      const searchProviderController = createDefaultSearchProviderController();
      // SLATE-3a (flow 161, AC5): `slate_read`/`slate_write_seed` need the
      // CURRENT session dir at tool-invoke time, not whatever was true when
      // `tools` was built (`runAgentRepl`'s own `slateSession` is only known
      // once the REPL loop opens/resumes a session, well after this point).
      // A shared mutable box is the side-channel `runAgentRepl` writes into on
      // every `slateSession` reassignment (see its own body below); the
      // getter here reads the box BY REFERENCE, never a snapshot.
      const slateSessionBox: { current: SlateSessionRef | undefined } = { current: undefined };
      // Same reset-per-turn wiring as the TUI's makeAgentDeps (own spawn_subagent instance).
      let resetSubagentBudget: (() => void) | undefined;
      const spawnTool = createSpawnSubagentTool({
        cwd: agentCwd,
        getParentModel: () => ({
          providerId: provider,
          modelId: model,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        }),
        makeProvider: (providerId, modelId, childBaseUrl) =>
          baseFactory(providerId, modelId, childBaseUrl ?? baseUrl),
        getDetectedProviders: () => [{ name: provider }],
        // Finding 1 fix (fix round, code review of PR #306): read
        // `slateSessionBox.current` BY REFERENCE, at fold time — same
        // "live box" idiom this exact call site already uses for
        // `getSessionDir` below (`slateSessionBox` is only populated once
        // `runAgentRepl` opens/resumes a session, well after this tool is
        // constructed). Before this fix, this call passed no slate ref at
        // all, so a dispatched subagent's Seeds/Anchors silently never
        // folded anywhere in a real readline `keryx shell` agent session.
        getSlateSession: () => slateSessionBox.current,
        onLedgerReady: (controls) => {
          resetSubagentBudget = controls.resetBudget;
        },
      });
      const agentDepsBase = {
        provider: agentProvider,
        providerId: provider,
        modelId: model,
        tools: buildInteractiveAgentTools({
          cwd: agentCwd,
          metaprojectPort,
          searchController: searchProviderController,
          spawnTool,
          getSessionDir: () => slateSessionBox.current?.dir,
          jobRegistry,
          mcp: mcpRuntime,
          ...(flags.denyTools !== undefined ? { denyTools: flags.denyTools } : {}),
          // Flow 274 (agent bus P3, T6/T7 contract): `busBox` (declared above,
          // shared with `runAgentRepl`'s own join below via `sessionOpts.busBox`)
          // is a LIVE box — `client()` reads whatever it currently holds, so
          // this reflects the real join outcome even though the join itself
          // happens later, inside `runAgentRepl`. T6's tools refuse
          // `bus-disabled` at call time whenever `client()` is undefined
          // (not yet joined, disabled, or sessions off).
          bus: { client: () => busBox.current },
        }),
        maxRounds: resolveAgentMaxRounds(),
        // Same precedence as the TUI's `makeAgentDeps` above — routed through
        // `initialModelParams.maxOutputTokens` (resolved once above) rather
        // than a second, independent `providerByName(...).maxOutputTokens`
        // lookup, so there is exactly one computation of the provider's
        // effective override.
        maxOutputTokens: resolveAgentMaxOutputTokens({
          providerMaxOutputTokens: initialModelParams.maxOutputTokens,
          globalMaxOutputTokens: loadShellConfig(runtime.cacheDir).maxOutputTokens,
        }),
        // Same precedence as the TUI's `makeAgentDeps` above. The readline
        // `/reasoning` handler (inside `runAgentRepl`) mutates `agentDeps.
        // reasoningEffort` directly for the CURRENT session (this object is
        // built once and never rebuilt — readline agent mode has no
        // `/model`-style deps-rebuild path), and also updates
        // `reasoningSessionOverride` so a value stays consistent if anything
        // else in this scope ever reads it, plus persists to `ShellConfig`.
        reasoningEffort: resolveReasoningEffort({
          sessionOverride: reasoningSessionOverride,
          globalEffort: loadShellConfig(runtime.cacheDir).reasoningEffort,
        }),
        idSeq: () => randomUUID(),
        askUser: invokeAskUserHost,
        sweepBackgroundJobs: () => jobRegistry.sweepAll(),
        ...(resetSubagentBudget !== undefined ? { resetSubagentBudget } : {}),
        // flow 268: `initialModelParams` is resolved once above (same
        // provider/model this whole readline session was started with — no
        // rebuild-on-switch path exists in this branch, unlike the TUI).
        ...(Object.keys(initialModelParams).length > 0 ? { modelParams: initialModelParams } : {}),
      };
      // The instruction is built from the roster it describes, so it never
      // names a tool this session was not given.
      const agentDeps: AgentDeps = {
        ...agentDepsBase,
        systemInstruction: buildAgentSystemInstruction(orient, {
          providerId: provider,
          modelId: model,
          toolNames: interactiveAgentToolNames(agentDepsBase.tools),
          // Flow 274 (T6/T7 contract): almost always `false` here — the bus
          // join happens later, inside `runAgentRepl` (`busBox.current` is
          // still empty at this point) — `runAgentRepl` rebuilds this exact
          // instruction with `busJoined: true` once its own join succeeds
          // (see its own doc comment on the `orient` parameter below).
          busJoined: busBox.current !== undefined,
        }),
      };
      // OpenTUI is handled EARLIER (default when TTY), before readline is
      // created (flow 067), so it never runs here. This is the readline agent
      // REPL — fallback for `--no-tui`, no-TTY, or TUI init failure.
      // Resume pick without TUI → latest session in this project.
      let resumeId = flags.resumeId;
      if (flags.resumePick === true && resumeId === undefined) {
        resumeId = bareResumeId();
      }
      const events =
        flags.eventsFile === undefined
          ? undefined
          : createFileEventSink(
              flags.eventsFile,
              (message) => {
                emitSystem(`${message}\n`);
              },
              flags.eventsMaxField,
            );
      // One REPL run per session opts: `runWithLeaseChoice` re-runs it with
      // `fork`/`takeOver`, or as a new session, after a leased refusal.
      const runRepl = async (session: ShellSessionOpts): Promise<void> => {
        await runAgentRepl(sharedLines, { printPrompt, safeBoundary: io.onSafeBoundary }, agentDeps, metaprojectPort, session, flags.permissionModeFlag, slateSessionBox, events, runtime.cacheDir, orient);
      };
      try {
        finishLeased(
          await runWithLeaseChoice(
            {
              cwd: process.cwd(),
              ...(flags.continueLast === true ? { continueLast: true } : {}),
              ...(resumeId !== undefined ? { resumeId } : {}),
              ...leaseFlagOpts,
              ...(flags.name !== undefined ? { busName: flags.name } : {}),
              leaseBox,
              busBox,
            },
            runRepl,
            leaseChoiceRuntime,
          ),
        );
      } finally {
        // Each connected server is a child process holding a pipe. Exiting
        // without closing them leaks one per session — and `closeServers`
        // already swallows a close that throws, so this cannot turn a clean
        // exit into an error about exiting.
        await mcpRuntime.close();
      }
    } else {
      let resumeId = flags.resumeId;
      if (flags.resumePick === true && resumeId === undefined) {
        resumeId = bareResumeId();
      }
      finishLeased(
        await runWithLeaseChoice(
          {
            cwd: process.cwd(),
            ...(flags.continueLast === true ? { continueLast: true } : {}),
            ...(resumeId !== undefined ? { resumeId } : {}),
            ...leaseFlagOpts,
            ...(flags.name !== undefined ? { busName: flags.name } : {}),
            leaseBox,
            busBox,
          },
          (session) => runShell(io, { ...deps, session }),
          leaseChoiceRuntime,
        ),
      );
    }
  } finally {
    // Every exit closes the readline session's MCP runtime (K-012). The agent
    // branch creates it before building the tool list, and a start-up refusal
    // thrown while the list is built — an unknown `--deny-tools` name — used to
    // leave before the REPL's own `finally` was reached: a connected server then
    // kept its child and pipe open, the error printed, and the shell never
    // exited. On the normal path the REPL has already closed it, and a second
    // `close()` finds nothing left to close.
    try {
      await readlineMcp?.close();
    } catch {
      // Exiting; a failed close must not become the last thing printed.
    }
    destroy();
    rl.close();
  }
}
