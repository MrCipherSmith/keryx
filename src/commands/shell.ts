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
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import { makeKeryxRunner, builtinMetaprojectTools } from "../harness/tool/builtin/metaproject-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { buildApprovalContext } from "./agent-approval-context";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { collapseHome } from "../lib/statusbar";
import { LiveMarkdownBlock } from "../lib/live-render";
import { colorEnabled, renderMarkdown, style, summarizeToolArgs } from "../lib/ui";
import { type AgentDeps, type AgentIO, buildAgentSystemInstruction, runAgentTurn } from "./agent";
import { detectProviders, pickAgentMode, pickProviderModel } from "./select";

/** Async line source + write sink; no real stdio is reached by `runShell`. */
export interface ShellIO {
  lines: AsyncIterable<string>;
  write: (s: string) => void;
  /**
   * OPTIONAL rich-rendering hooks (flow 031). They let a TTY wrapper tell
   * assistant token deltas (still `write`) apart from system text and see turn
   * boundaries, so it can render a spinner + markdown. When a hook is ABSENT the
   * core's behavior is byte-identical to before: every non-token write falls
   * back to `write` and the turn callbacks are no-ops.
   *
   * - `onTurnStart` fires once just before a model turn streams (after the user
   *   line is recorded), e.g. to show an "assistant …" label + spinner.
   * - `onTurnEnd` fires after a turn that produced assistant content, carrying
   *   the FULL accumulated reply for a markdown re-render.
   * - `onSystem` receives every NON-token line the core emits (errors, `/help`,
   *   `/connect`, unknown-command, "not available" notices).
   */
  onTurnStart?: () => void;
  onTurnEnd?: (full: string) => void;
  onSystem?: (text: string) => void;
}

/** Injected dependencies keeping `runShell` deterministic + offline. */
export interface ShellDeps {
  makeProvider: (name: string, model: string, baseUrl?: string) => ProviderPort;
  clock: () => string;
  idSeq: () => string;
  initial: { provider: string; model: string; baseUrl?: string };
  /**
   * Bundled detect+pick selector for the `/models` and `/provider` (no-arg)
   * slash commands. `/models` passes `{ onlyProvider: <current provider> }` to
   * offer only the current provider's models; `/provider` passes no opts (a
   * full re-selection across all providers). When omitted, both commands
   * write a "not available" message and no-op (they NEVER crash the loop).
   */
  selectProviderModel?: (
    io: ShellIO,
    opts?: { onlyProvider?: string },
  ) => Promise<{ provider: string; model: string; baseUrl?: string }>;
}

/** A short, trusted system instruction assembled by the (trusted) shell itself. */
const SYSTEM_INSTRUCTION = "You are the keryx interactive shell assistant. Answer concisely.";

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

/** Help text listing the slash commands (must mention /model, /clear, /exit). */
const HELP_TEXT = [
  "Commands:",
  "  /help              Show this help",
  "  /model <name>      Switch the active model for subsequent turns",
  "  /models            Pick a model for the current provider (numbered menu)",
  "  /provider [name]   Switch provider by name, or (no arg) re-run full selection",
  "  /connect           Show how to set ANTHROPIC_API_KEY for anthropic models",
  "  /clear             Clear the conversation history",
  "  /exit, /quit       Leave the shell",
  "",
].join("\n");

/**
 * The injectable REPL core. Iterates `io.lines`; slash commands are handled
 * inline (never call `provider.stream`), every other non-blank line is one
 * streaming turn whose request carries the FULL accumulated history.
 */
export async function runShell(io: ShellIO, deps: ShellDeps): Promise<void> {
  const history: NormalizedMessage[] = [];
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
    // Slash commands FIRST — a slash line NEVER reaches `provider.stream`.
    if (line.startsWith("/")) {
      const parts = line.trim().split(/\s+/);
      const command = parts[0] ?? "";
      const argument = parts[1] ?? "";

      if (command === "/exit" || command === "/quit") {
        return;
      }
      if (command === "/help") {
        system(HELP_TEXT);
        continue;
      }
      if (command === "/clear") {
        history.length = 0;
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
        system(CONNECT_GUIDANCE);
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
    } else if (accumulated.length > 0) {
      // A partial reply streamed before the error: keep it so the history stays
      // strictly alternating (user → assistant).
      history.push({ role: "assistant", content: accumulated, provenance: "model" });
    } else {
      // No reply at all: drop the just-pushed user message so a failed turn leaves
      // no dangling user message (two consecutive user-role messages are rejected
      // by strict providers like the Anthropic Messages API).
      history.pop();
    }

    // Terminate the streamed reply with a blank line so consecutive turns are
    // visually separated instead of running together on one line.
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
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
    const filtered =
      opts?.onlyProvider !== undefined ? detected.filter((d) => d.name === opts.onlyProvider) : detected;
    const list = filtered.length > 0 ? filtered : detected;
    return pickProviderModel(io, list);
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT_MARK = "❯ ";

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
}

/**
 * Build the rich-inline renderer (NOT unit-tested): a `ShellIO` whose optional
 * hooks drive a role label + spinner, live token streaming, and a post-turn
 * markdown re-render, plus styled system notices and a colored prompt marker.
 * All styling is confined here (the spinner timer included — the `runShell` core
 * stays timer/`Date.now`/`Math.random`-free) and degrades to plain, uncorrupted
 * output when `NO_COLOR` is set or the sink is not a TTY.
 */
function createRichIo(lines: AsyncIterable<string>): RichIo {
  const stdout = process.stdout;
  const rich = colorEnabled() && Boolean(stdout.isTTY);
  const out = (s: string): void => {
    stdout.write(s);
  };

  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let awaitingFirstToken = false;
  let raw = "";

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
    out(rich ? style.cyan(PROMPT_MARK) : PROMPT_MARK);
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
    // Minimal one-line header (codex/grok/pi aesthetic) — no double rules.
    if (rich) {
      out(`\n${style.cyan("◆")} ${style.bold(title)}  ${style.dim(subtitle)}\n`);
      out(`${style.dim("type a task · /help for commands · /exit to quit")}\n\n`);
    } else {
      out(`${title} — ${subtitle}\n`);
      out("Type a message, or /help for commands.\n\n");
    }
    printPrompt();
  };

  const io: ShellIO = { lines, write, onTurnStart, onTurnEnd, onSystem: emitSystem };
  return { io, emitSystem, printHeader, printPrompt };
}

/** One-line summary of a tool result for the agent-mode transcript. */
function summarizeToolOutput(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const clipped = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
  return text.includes("\n") ? `${clipped} …` : clipped;
}

/** A dim, terminal-width-agnostic separator between agent turns. */
function turnSeparator(): string {
  return style.dim("─".repeat(24));
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
  rich: { printPrompt: () => void },
  deps: AgentDeps,
  metaprojectPort: MetaprojectPort,
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
      out(`${clearLine}${style.dim(`${glyph} thinking…`)}`);
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

  // Live differential markdown rendering (flow 051): stream + repaint in place on
  // a TTY with color; otherwise fall back to the flow-050 render-once behavior so
  // piped/redirected output stays clean and deterministic.
  const liveEnabled = colorEnabled() && Boolean(process.stdout.isTTY);
  const liveBlock = liveEnabled
    ? new LiveMarkdownBlock({
        out,
        cols: () => process.stdout.columns ?? 80,
        render: (md) => renderMarkdown(md.trimEnd()),
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
        out(`${renderMarkdown(text.trimEnd())}\n`);
      }
    },
    onUsage: (usage) => {
      lastUsage = usage;
    },
    requestApproval: async (_tool, input) => {
      stopSpinner();
      let command = input;
      try {
        const parsed: unknown = JSON.parse(input);
        if (parsed !== null && typeof parsed === "object" && typeof (parsed as { command?: unknown }).command === "string") {
          command = (parsed as { command: string }).command;
        }
      } catch {
        // show the raw input if it is not JSON
      }
      // MP-6: advisory metaproject context (blast radius + related memory) before
      // the prompt. Best-effort — never blocks or changes the default-deny gate.
      const context = await buildApprovalContext(metaprojectPort, command);
      if (context.length > 0) {
        out(`\n${style.dim(context)}`);
      }
      out(`\n${style.yellow(`Run: ${command}`)} ${style.dim("[y/N] ")}`);
      const answer = (await readLine()) ?? "";
      const approved = /^y(es)?$/i.test(answer.trim());
      out(approved ? style.green("approved\n") : style.red("denied\n"));
      return approved;
    },
    onToolCall: (name, input) => {
      stopSpinner();
      endBlock(); // defensive: close any live block before the tool line
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      out(`\n${style.cyan(`⚙ ${call}`)}\n`);
    },
    onToolResult: (name, result) => {
      const marker = result.isError ? style.red("  ✗ ") : style.gray("  ↳ ");
      out(`${marker}${style.dim(summarizeToolOutput(result.output))}\n`);
      startSpinner(); // a tool finished; wait for the model's next round
    },
    onSystem: (text) => {
      stopSpinner();
      endBlock(); // close the live block before printing a system/error line over it
      out(colorEnabled() ? (text.includes("[error]") ? style.red(text) : style.dim(text)) : text);
    },
  };

  const history: NormalizedMessage[] = [];
  // `printHeader` already emitted the first prompt — do NOT print another here
  // (that produced the duplicate `❯ ❯`). Only re-prompt after turns/commands.
  for (;;) {
    const line = await readLine();
    if (line === undefined) {
      return; // end of input
    }
    if (line.startsWith("/")) {
      const command = line.trim().split(/\s+/)[0] ?? "";
      if (command === "/exit" || command === "/quit") {
        return;
      }
      if (command === "/help") {
        agentIo.onSystem?.(
          "Agent mode — describe a task; the agent uses read-only tools (get_cwd, list_dir, read_file, search_code, graph_affected, memory_search) and shell_exec (asks approval) on the real project. /exit to leave.\n",
        );
      } else {
        agentIo.onSystem?.(`Unknown command: ${command}. Type /help.\n`);
      }
      rich.printPrompt();
      continue;
    }
    if (line.trim().length === 0) {
      rich.printPrompt();
      continue;
    }
    out(`\n${style.cyan("●")} ${style.bold("keryx")}\n`);
    lastUsage = undefined;
    startSpinner();
    try {
      await runAgentTurn(agentIo, deps, history, line);
    } finally {
      endBlock(); // close any still-open live block (e.g. on a mid-turn throw)
      stopSpinner();
    }
    const usageLine = formatUsage(lastUsage);
    if (usageLine.length > 0) {
      out(`\n${usageLine}\n`);
    }
    out(`\n${turnSeparator()}\n\n`);
    rich.printPrompt();
  }
}

/**
 * Thin TTY wrapper (NOT unit-tested): parses `--provider` / `--model` /
 * `--base-url` / `--agent` / `--chat`, wires a real `node:readline` stdin line
 * source + a rich `process.stdout` renderer, and runs the deterministic core.
 * Mode defaults to agent; the interactive picker asks agent/chat when no flag is
 * given.
 *
 * When `--provider` is ABSENT, it first detects the available providers and
 * runs the interactive numbered picker (replacing any hardcoded default). When
 * `--provider X` is given, the picker is skipped: the model is `--model Y` if
 * given, otherwise that provider's first detected model.
 */
export async function shellCommand(args: string[]): Promise<void> {
  let providerArg: string | undefined;
  let modelArg: string | undefined;
  let baseUrl: string | undefined;
  // Mode precedence: an explicit `--agent`/`--chat` flag wins; otherwise the
  // interactive picker asks (agent-default), and the non-interactive path
  // defaults to agent. `undefined` = "no explicit flag given".
  let modeFlag: boolean | undefined;
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
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  // A SINGLE shared line iterator so the picker and the REPL consume stdin in
  // sequence (two independent iterators would race over the same readline).
  const lineIterator = rl[Symbol.asyncIterator]();
  const sharedLines: AsyncIterable<string> = { [Symbol.asyncIterator]: () => lineIterator };

  const { io, emitSystem, printHeader, printPrompt } = createRichIo(sharedLines);

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
      const agentDeps: AgentDeps = {
        provider: agentProvider,
        providerId: provider,
        modelId: model,
        tools: [
          ...builtinReadOnlyTools(process.cwd()),
          ...builtinMetaprojectTools(process.cwd(), makeKeryxRunner(process.cwd()), metaprojectPort),
          shellExecTool(process.cwd()),
        ],
        systemInstruction: buildAgentSystemInstruction(orient),
        idSeq: () => randomUUID(),
      };
      await runAgentRepl(sharedLines, { printPrompt }, agentDeps, metaprojectPort);
    } else {
      await runShell(io, deps);
    }
  } finally {
    rl.close();
  }
}
