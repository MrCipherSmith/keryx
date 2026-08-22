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
import { buildInteractiveAgentTools } from "./interactive-agent-tools";
import { evaluateShellApproval, formatShellApprovalHints, rememberExactShellGrant } from "./shell-approval";
import { createDefaultSearchProviderController } from "../harness/search";
import type { SearchProviderDescriptor, SearchProviderId } from "../harness/search";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import { createLazyRunExternal } from "../harness/run-external-factory";
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import { emitBackgroundJob } from "../tui/job-bridge";
import { approveExternalSpawn, externalRunBridgeObserver } from "../tui/external-bridge";
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
import { applySavedApiKeys, loadShellConfig } from "../lib/shell-config";
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
import { describeUnavailableCommand, renderCommandHelp } from "./agent-commands";
import {
  type AgentDeps,
  type AgentIO,
  buildAgentSystemInstruction,
  resolveAgentMaxToolCalls,
  runAgentTurn,
} from "./agent";
import { type DetectedProvider, detectProviders, pickAgentMode, pickProviderModel } from "./select";
import type { ShellDeps, ShellIO, ShellSessionOpts } from "./shell-types";
import {
  compactSession,
  createSession,
  latestSession,
  openSession,
  persistHistory,
  shortSessionId,
  type SessionHandle,
} from "../session";
import { closeSlateSession, mintTimestampAttemptId, type SlateSessionRef } from "../session/slate-lifecycle";
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

/**
 * The injectable REPL core. Iterates `io.lines`; slash commands are handled
 * inline (never call `provider.stream`), every other non-blank line is one
 * streaming turn whose request carries the FULL accumulated history.
 */
export async function runShell(io: ShellIO, deps: ShellDeps): Promise<void> {
  let providerName = deps.initial.provider;
  let modelName = deps.initial.model;
  let baseUrl = deps.initial.baseUrl;
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
  if (sessionsOn) {
    try {
      let resumeId = deps.session?.resumeId;
      if (resumeId === undefined && deps.session?.continueLast !== true) {
        // plain new session
      }
      const opened = openSession({
        cwd: sessionCwd,
        ...(deps.session?.continueLast === true ? { continueLast: true } : {}),
        ...(resumeId !== undefined ? { resumeId } : {}),
        provider: providerName,
        model: modelName,
      });
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
      live = createSession({ cwd: sessionCwd, provider: providerName, model: modelName });
      history = [];
      archive = [];
      system(`${cause instanceof Error ? cause.message : String(cause)}\nStarting a new session.\n`);
    }
  }

  const save = (): void => {
    if (live === undefined) {
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
   * Apply a `{provider, model, baseUrl?}` selection from the interactive picker
   * (shared by the `/models` and no-arg `/provider` commands): update the active
   * selection and recreate the provider. Behavior-preserving extraction.
   */
  const applySelection = (picked: { provider: string; model: string; baseUrl?: string }): void => {
    providerName = picked.provider;
    modelName = picked.model;
    baseUrl = picked.baseUrl;
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
        return;
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
          live = createSession({ cwd: sessionCwd, provider: providerName, model: modelName });
          history = [];
          archive = [];
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

    const request: NormalizedRequest = {
      providerId: providerName,
      modelId: modelName,
      systemInstruction: SYSTEM_INSTRUCTION,
      messages: [...history],
      budget: { maxOutputTokens: 1024, runReservation: 1024 },
      stream: true,
      requestId: deps.idSeq(),
      parentRunId,
    };

    let accumulated = "";
    let errored = false;
    // Signal the start of a streamed reply so a rich wrapper can show a role
    // label + spinner; a no-op (no output) when no wrapper is attached.
    io.onTurnStart?.();
    try {
      for await (const event of provider.stream(request, { attemptId: deps.idSeq() })) {
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

    // Terminate the streamed reply with a blank line so consecutive turns are
    // visually separated instead of running together on one line.
    io.onSafeBoundary?.();
    io.write("\n\n");
  }
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
    });
  };
}

/** Build the bundled detect+pick selector wired to real `fetch` + `process.env`. */
function realSelectProviderModel(baseUrl: string | undefined): NonNullable<ShellDeps["selectProviderModel"]> {
  return async (io, opts) => {
    const detected = await detectProviders({
      fetch: globalThis.fetch,
      env: process.env,
      platform: process.platform,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
    const filtered =
      opts?.onlyProvider !== undefined ? detected.filter((d) => d.name === opts.onlyProvider) : detected;
    const list = filtered.length > 0 ? filtered : detected;
    // Always re-probe live `/models` (when online) inside pickProviderModel.
    return pickProviderModel(io, list, { fetch: globalThis.fetch, env: process.env });
  };
}

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

  // Per-turn token usage (last `usage_update` the provider reported), printed
  // once when the turn ends.
  let lastUsage: NormalizedUsage | undefined;
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
      stopSpinner();
      if (liveBlock !== undefined) {
        endBlock(); // final repaint + line break + reset
      } else {
        out(`${indentBlock(renderMarkdown(text.trimEnd()), GUTTER)}\n`);
      }
    },
    onReasoning: (text) => {
      stopSpinner();
      endBlock(); // reasoning precedes the answer block
      out(`\n${GUTTER}${style.dim("⋯ thinking")}\n`);
      out(`${indentBlock(style.dim(text.trimEnd()), GUTTER)}\n`);
    },
    onUsage: (usage) => {
      lastUsage = usage;
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
      stopSpinner();
      endBlock(); // defensive: close any live block before the tool line
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      out(`\n${GUTTER}${style.cyan(`⚙ ${call}`)}\n`);
    },
    onToolResult: (name, result) => {
      const marker = result.isError ? style.red("✗ ") : style.gray("↳ ");
      const { summary, hidden } = collapseToolOutput(result.output);
      const more = hidden > 0 ? style.dim(` · +${hidden} more (/expand)`) : "";
      out(`${GUTTER}${marker}${style.dim(summary)}${more}\n`);
      lastToolName = name;
      lastToolOutput = result.output;
      startSpinner(); // a tool finished; wait for the model's next round
    },
    onSystem: (text) => {
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
  if (sessionsOn) {
    try {
      let resumeId = sessionOpts?.resumeId;
      if (resumeId === undefined && sessionOpts?.continueLast !== true && sessionOpts !== undefined) {
        // if pick flag was mapped to continue by caller, resumeId may be set to latest
      }
      const opened = openSession({
        cwd: sessionCwd,
        ...(sessionOpts?.continueLast === true ? { continueLast: true } : {}),
        ...(resumeId !== undefined ? { resumeId } : {}),
        provider: deps.providerId,
        model: deps.modelId,
      });
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
      live = createSession({
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
  slateSession = live !== undefined ? { dir: live.dir, cwd: sessionCwd, opened: false } : undefined;
  slateSessionBox.current = slateSession;

  const save = (): void => {
    if (live === undefined) {
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
    const line = await readLine();
    if (line === undefined) {
      // SLATE-5 close trigger: shell exit (end of input / Ctrl-D).
      await closeSlateSession(slateSession, mintTimestampAttemptId);
      // Flow 173 (AC7): sweep every tracked background job (process-group
      // SIGTERM→SIGKILL) on real session exit.
      await deps.sweepBackgroundJobs?.();
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
        return;
      }
      if (command === "/help") {
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
        // was building before switching away from it.
        await closeSlateSession(slateSession, mintTimestampAttemptId);
        if (sessionsOn) {
          live = createSession({
            cwd: sessionCwd,
            provider: deps.providerId,
            model: deps.modelId,
          });
          history = [];
          archive = [];
          nextArchiveIndex = 0;
          slateSession = { dir: live.dir, cwd: sessionCwd, opened: false };
          slateSessionBox.current = slateSession;
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
      rich.printPrompt();
      continue;
    }
    if (line.trim().length === 0) {
      rich.printPrompt();
      continue;
    }
    out(`\n${GUTTER}${style.cyan("●")} ${style.bold("keryx")}\n`);
    lastUsage = undefined;
    deps.resetSubagentBudget?.();
    startSpinner();
    try {
      await runAgentTurn(agentIo, deps, history, line, slateSession !== undefined ? { slateSession } : {});
    } finally {
      endBlock(); // close any still-open live block (e.g. on a mid-turn throw)
      stopSpinner();
    }
    flushSessionCheckpoint();
    const usageLine = formatUsage(lastUsage);
    if (usageLine.length > 0) {
      out(`\n${GUTTER}${usageLine}\n`);
    }
    out(`\n${GUTTER}${turnSeparator()}\n\n`);
    rich.safeBoundary?.();
    rich.printPrompt();
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
  /** `-r` without id → open resume picker (TUI) or latest (non-TUI). */
  resumePick?: boolean;
  /**
   * `--permission-mode <ask|trust|auto>` or the `--ask`/`--trust`/`--auto`
   * shorthands. `undefined` means no flag was passed — `runAgentRepl` then
   * falls back to the project's stored default, then `DEFAULT_PERMISSION_MODE`.
   * Agent-mode only (chat mode has no tools to gate); silently ignored on the
   * `tui-chat`/readline-chat surfaces for that reason, not rejected — a
   * leftover flag from a shell alias should not fail the whole launch.
   */
  permissionModeFlag?: PermissionMode;
}

/**
 * Parse shell CLI flags. Defaults: TUI on, agent mode implied (modeFlag
 * undefined). `--no-tui` opts out of TUI; `--chat` selects chat mode.
 * Session flags (`-c`/`-r`) are per-project only.
 */
export function parseShellCliFlags(args: string[]): ShellCliFlags {
  let providerArg: string | undefined;
  let modelArg: string | undefined;
  let baseUrl: string | undefined;
  let modeFlag: boolean | undefined;
  let wantTui = true;
  let continueLast: boolean | undefined;
  let resumeId: string | undefined;
  let resumePick: boolean | undefined;
  let permissionModeFlag: PermissionMode | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      providerArg = args[++i] ?? providerArg;
    } else if (arg === "--model") {
      modelArg = args[++i] ?? modelArg;
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    } else if (arg === "--agent") {
      modeFlag = true;
    } else if (arg === "--chat") {
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
    } else if (arg === "--permission-mode") {
      const next = args[++i];
      if (next !== undefined && isPermissionMode(next)) {
        permissionModeFlag = next;
      }
    } else if (arg === "--ask" || arg === "--trust" || arg === "--auto") {
      permissionModeFlag = arg.slice(2) as PermissionMode;
    }
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
    ...(permissionModeFlag !== undefined ? { permissionModeFlag } : {}),
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
  flags: Pick<ShellCliFlags, "wantTui" | "modeFlag">,
  isTty: boolean,
): ShellSurface {
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
  // Start exactly once, before provider detection, renderer creation, or
  // readline. Nothing below awaits this promise during startup.
  const versionCheck = (runtime.checkVersion ?? (() => checkVersion({
    currentVersion: packageJson.version,
    ...(runtime.cacheDir !== undefined ? { cacheDir: runtime.cacheDir } : {}),
  })))();
  const flags = parseShellCliFlags(args);
  let providerArg = flags.providerArg;
  let modelArg = flags.modelArg;
  let baseUrl = flags.baseUrl;
  // Mode precedence: an explicit `--agent`/`--chat` flag wins; otherwise the
  // interactive picker asks (agent-default), and the non-interactive path
  // defaults to agent. `undefined` = "no explicit flag given".
  let modeFlag = flags.modeFlag;

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
    const makeAgentDeps = async (
      sel: { provider: string; model: string; baseUrl?: string },
      getSlateSession: () => SlateSessionRef | undefined,
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
      const agentProvider = tuiProviderFactory(sel.provider, sel.model, sel.baseUrl);
      let orient = "";
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
        getDetectedProviders: () => {
          const names = new Set<string>([sel.provider]);
          for (const d of tuiDetected) {
            names.add(d.name);
          }
          return [...names].map((name) => ({ name }));
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
      return {
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
        }),
        systemInstruction: buildAgentSystemInstruction(orient, {
          providerId: sel.provider,
          modelId: sel.model,
        }),
        // Generous default (48) so multi-step operator prompts do not hit the
        // loop-safety budget mid-task; override with KERYX_AGENT_MAX_TOOL_CALLS.
        maxToolCalls: resolveAgentMaxToolCalls(),
        idSeq: () => randomUUID(),
        askUser: invokeAskUserHost,
        sweepBackgroundJobs: () => jobRegistry.sweepAll(),
        jobRegistry,
        ...(resetSubagentBudget !== undefined ? { resetSubagentBudget } : {}),
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

    if (surface === "tui-chat") {
      // Chat: the SAME `runShell` the readline fallback below runs, rendered
      // through the shared chrome.
      const chatFactory = realMakeProvider(() => {});
      let chatResumeId = flags.resumeId;
      if (flags.resumePick === true && chatResumeId === undefined) {
        chatResumeId = latestSession(cwd)?.id;
      }
      if (
        await (runtime.launchChat ?? launchTuiChatShell)({
          detected: tuiDetected,
          redetect,
          ...(tuiInitial !== undefined ? { initial: tuiInitial } : {}),
          runShell,
          makeShellDeps: (sel) => ({
            makeProvider: chatFactory,
            clock: () => new Date().toISOString(),
            idSeq: () => randomUUID(),
            initial: sel,
            session: {
              cwd,
              ...(flags.continueLast === true ? { continueLast: true } : {}),
              ...(chatResumeId !== undefined ? { resumeId: chatResumeId } : {}),
            },
          }),
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
        // `/connect` and `/model` re-probe providers fresh.
        redetect,
        ...(tuiInitial !== undefined ? { initial: tuiInitial } : {}),
        session: {
          cwd,
          ...(flags.continueLast === true ? { continueLast: true } : {}),
          ...(flags.resumeId !== undefined ? { resumeId: flags.resumeId } : {}),
          ...(flags.resumePick === true ? { pickOnStart: true } : {}),
        },
        ...(flags.permissionModeFlag !== undefined ? { initialPermissionMode: flags.permissionModeFlag } : {}),
        versionCheck,
      })
    ) {
      return;
    }
    // else: optional dep absent / init failed → fall through to the readline shell.
  }

  const rl = readline.createInterface({ input: process.stdin });
  // A SINGLE shared line iterator so the picker and the REPL consume stdin in
  // sequence (two independent iterators would race over the same readline).
  const lineIterator = rl[Symbol.asyncIterator]();
  const sharedLines: AsyncIterable<string> = { [Symbol.asyncIterator]: () => lineIterator };

  const { io, emitSystem, printHeader, printPrompt, destroy } = createRichIo(sharedLines, versionCheck);

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
    const deps: ShellDeps = {
      makeProvider: baseFactory,
      clock: () => new Date().toISOString(),
      idSeq: () => randomUUID(),
      initial: baseUrl === undefined ? { provider, model } : { provider, model, baseUrl },
      selectProviderModel: realSelectProviderModel(baseUrl),
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
      const agentProvider = baseFactory(provider, model, baseUrl);
      let orient = "";
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
      const agentDeps: AgentDeps = {
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
        }),
        systemInstruction: buildAgentSystemInstruction(orient, {
          providerId: provider,
          modelId: model,
        }),
        maxToolCalls: resolveAgentMaxToolCalls(),
        idSeq: () => randomUUID(),
        askUser: invokeAskUserHost,
        sweepBackgroundJobs: () => jobRegistry.sweepAll(),
        ...(resetSubagentBudget !== undefined ? { resetSubagentBudget } : {}),
      };
      // OpenTUI is handled EARLIER (default when TTY), before readline is
      // created (flow 067), so it never runs here. This is the readline agent
      // REPL — fallback for `--no-tui`, no-TTY, or TUI init failure.
      // Resume pick without TUI → latest session in this project.
      let resumeId = flags.resumeId;
      if (flags.resumePick === true && resumeId === undefined) {
        resumeId = latestSession(process.cwd())?.id;
      }
      await runAgentRepl(sharedLines, { printPrompt, safeBoundary: io.onSafeBoundary }, agentDeps, metaprojectPort, {
        cwd: process.cwd(),
        ...(flags.continueLast === true ? { continueLast: true } : {}),
        ...(resumeId !== undefined ? { resumeId } : {}),
      }, flags.permissionModeFlag, slateSessionBox);
    } else {
      let resumeId = flags.resumeId;
      if (flags.resumePick === true && resumeId === undefined) {
        resumeId = latestSession(process.cwd())?.id;
      }
      await runShell(io, {
        ...deps,
        session: {
          cwd: process.cwd(),
          ...(flags.continueLast === true ? { continueLast: true } : {}),
          ...(resumeId !== undefined ? { resumeId } : {}),
        },
      });
    }
  } finally {
    destroy();
    rl.close();
  }
}
