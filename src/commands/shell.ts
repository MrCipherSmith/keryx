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
  ProviderPort,
} from "../harness/provider/types";
import { formatStatusBar, scrollRegion } from "../lib/statusbar";
import { banner, colorEnabled, note, renderMarkdown, roleLabel, style } from "../lib/ui";
import { detectProviders, pickProviderModel } from "./select";

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

/** Minimum terminal height to enable the pinned status bar (flow 032). */
const MIN_BAR_ROWS = 4;

/** Live provider/model source for the status bar (flow 032). */
type StatusSource = () => { provider: string; model: string };

/** The rich TTY renderer wired into `ShellIO`'s optional hooks (flow 031/032). */
interface RichIo {
  io: ShellIO;
  emitSystem: (text: string) => void;
  printHeader: (title: string, subtitle: string) => void;
  /** Enter the pinned-status-bar scroll region (no-op unless TTY + color). */
  enterBar: () => void;
  /** Reset the scroll region + cursor and remove signal handlers (idempotent). */
  exitBar: () => void;
  /** Redraw the bar with the current cwd/selection (no-op when inactive). */
  redrawBar: () => void;
}

/**
 * Build the rich-inline renderer (NOT unit-tested): a `ShellIO` whose optional
 * hooks drive a role label + spinner, live token streaming, and a post-turn
 * markdown re-render, plus styled system notices and a colored prompt marker.
 * All styling is confined here (the spinner timer included — the `runShell` core
 * stays timer/`Date.now`/`Math.random`-free) and degrades to plain, uncorrupted
 * output when `NO_COLOR` is set or the sink is not a TTY.
 */
function createRichIo(lines: AsyncIterable<string>, getStatus?: StatusSource): RichIo {
  const stdout = process.stdout;
  const rich = colorEnabled() && Boolean(stdout.isTTY);
  const out = (s: string): void => {
    stdout.write(s);
  };

  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let awaitingFirstToken = false;
  let raw = "";

  // --- flow 032: pinned status bar via a reserved-bottom-row scroll region ---
  const barSupported = rich && getStatus !== undefined;
  let barEntered = false;
  const termRows = (): number => stdout.rows ?? 24;
  const termCols = (): number => stdout.columns ?? 80;

  const drawBar = (): void => {
    if (!barEntered || getStatus === undefined) {
      return;
    }
    const rows = termRows();
    const { provider, model } = getStatus();
    const bar = formatStatusBar({ cwd: process.cwd(), provider, model, columns: termCols() });
    out(scrollRegion(rows).drawAt(rows, bar));
  };
  const onResize = (): void => {
    if (!barEntered) {
      return;
    }
    out(scrollRegion(termRows()).enter); // re-arm the region for the new size
    drawBar();
  };
  const onExitReset = (): void => {
    out(scrollRegion(termRows()).exit);
  };
  const exitBar = (): void => {
    if (!barEntered) {
      return;
    }
    barEntered = false;
    process.off("SIGWINCH", onResize);
    process.off("SIGINT", onSigint);
    process.off("exit", onExitReset);
    out(scrollRegion(termRows()).exit);
  };
  // Ctrl-C: restore the terminal before exiting so it is never left broken.
  const onSigint = (): void => {
    exitBar();
    process.exit(130);
  };
  const enterBar = (): void => {
    if (!barSupported || barEntered || termRows() < MIN_BAR_ROWS) {
      return;
    }
    barEntered = true;
    out(scrollRegion(termRows()).enter);
    drawBar();
    process.on("SIGWINCH", onResize);
    process.once("SIGINT", onSigint);
    process.once("exit", onExitReset);
  };
  const redrawBar = (): void => {
    drawBar();
  };

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
      redrawBar(); // keep the pinned bar fresh after each turn
    }
  };

  const onTurnStart = (): void => {
    raw = "";
    if (!rich) {
      return;
    }
    out(`\n${roleLabel("assistant")}\n`);
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
    banner(title, subtitle);
    note("Type a message, or /help for commands.");
    printPrompt();
  };

  const io: ShellIO = { lines, write, onTurnStart, onTurnEnd, onSystem: emitSystem };
  return { io, emitSystem, printHeader, enterBar, exitBar, redrawBar };
}

/**
 * Thin TTY wrapper (NOT unit-tested): parses `--provider` / `--model` /
 * `--base-url`, wires a real `node:readline` stdin line source + a rich
 * `process.stdout` renderer, and runs the deterministic core.
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      providerArg = args[++i] ?? providerArg;
    } else if (arg === "--model") {
      modelArg = args[++i] ?? modelArg;
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  // A SINGLE shared line iterator so the picker and the REPL consume stdin in
  // sequence (two independent iterators would race over the same readline).
  const lineIterator = rl[Symbol.asyncIterator]();
  const sharedLines: AsyncIterable<string> = { [Symbol.asyncIterator]: () => lineIterator };

  // Live selection for the status bar; kept current by the tracking factory below
  // (the core calls makeProvider on init and on every /model /provider switch).
  let currentProvider = "";
  let currentModel = "";
  const { io, emitSystem, printHeader, enterBar, exitBar, redrawBar } = createRichIo(
    sharedLines,
    () => ({ provider: currentProvider, model: currentModel }),
  );

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

    currentProvider = provider;
    currentModel = model;

    // Track the live selection (and refresh the bar) on every provider creation:
    // the core calls this on init and after each /model / /provider switch.
    const baseFactory = realMakeProvider(emitSystem);
    const trackingFactory: ShellDeps["makeProvider"] = (name, providerModel, providerBaseUrl) => {
      currentProvider = name;
      currentModel = providerModel;
      redrawBar();
      return baseFactory(name, providerModel, providerBaseUrl);
    };

    const deps: ShellDeps = {
      makeProvider: trackingFactory,
      clock: () => new Date().toISOString(),
      idSeq: () => randomUUID(),
      initial: baseUrl === undefined ? { provider, model } : { provider, model, baseUrl },
      selectProviderModel: realSelectProviderModel(baseUrl),
    };

    printHeader("keryx shell", `${provider}/${model}${baseUrl !== undefined ? ` (${baseUrl})` : ""}`);
    enterBar();

    await runShell(io, deps);
  } finally {
    exitBar();
    rl.close();
  }
}
