// The OpenTUI CHAT shell (flow 112, plan S3) — the renderer O-1 was missing.
//
// It mounts the same `createShellChrome` the agent shell mounts and renders
// `ShellIO` through it, driven by **the real `runShell`**. That is the whole
// point of path A: TUI chat and readline chat run one driver, so they are
// identical in system instruction, budget and turn semantics by construction
// instead of being two engines behind one flag.
//
// The load-bearing problem is DIRECTION (context.md): `runShell` PULLS
// (`lines: AsyncIterable<string>`) while a composer PUSHES (`chrome.onSubmit`).
// {@link createChatBridge} is the queue adapter between them, and it is also
// where "a turn is in progress" lives (plan R2) — in the agent shell that gating
// sits in `runLine` precisely BECAUSE the TUI owns the loop; with `runShell`
// owning it, the adapter is its only honest home. The bridge learns a turn has
// finished from the driver itself: `runShell` asks for the next line only after
// the previous turn's body has run to completion.
//
// Rendering reuses flow 109 through `createAssistantMessageStream`, the same
// object `createTuiAgentIo` uses, so chat gets fenced-code framing and diff
// colouring without a second implementation.
//
// Deliberately NOT here:
//   - `onUsage` on `ShellIO` (D-A2): chat has no usage hook, so the header shows
//     `estimateContextTokens` and labels it an estimate.
//   - assistant replies as retained blocks (D-A3): they stay segment views, so
//     `Ctrl+O` / `/copy` remain agent-only. Deferred, not dropped.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005): referenced ONLY
// structurally via `typeof import(...)`, loaded ONLY by a dynamic `import()` in
// {@link launchTuiChatShell}. The guard in `src/capability/no-optional-imports`
// is a regex over file TEXT, so the forbidden static form must not appear in a
// comment here either.
//
// `runShell` is INJECTED rather than imported: `src/commands/shell.ts` imports
// this module, so importing its runtime values back would close a module cycle.
// Only its types are imported (erased at compile time).
import type { ShellDeps, ShellIO } from "../commands/shell";
import type { DetectedProvider } from "../commands/select";
import { commandsForMode, filterCommands } from "../commands/agent-commands";
import { saveShellConfig } from "../lib/shell-config";
import { createShellChrome, createShellRenderer, type ShellChrome } from "./shell-chrome";
import { createAssistantMessageStream } from "./transcript-blocks";
import {
  estimateContextTokens,
  fmtTokens,
  modelsForPicker,
  pickModelInTui,
  selectProviderModelInTui,
  type TuiSelection,
} from "./tui-shell";

/** The `@opentui/core` module shape, referenced structurally (type-only). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;

/**
 * `runShell`'s per-turn separator (`io.write("\n\n")` at the end of every turn).
 * `createRichIo` special-cases this exact string too; a TUI `write` that fed it
 * to the segmenter would open an empty trailing message block.
 */
const TURN_SEPARATOR = "\n\n";

const FOOTER_IDLE = "/ commands · Enter send · Ctrl+C to exit";

/** What {@link ChatBridge.submit} did with a submitted line. */
export type ChatSubmitResult =
  /** Handed to the driver, or queued behind the running turn. */
  | "accepted"
  /** `/exit` / `/quit`: the line stream was closed and the shell tears down. */
  | "exit"
  /** A slash command typed mid-turn: refused rather than raced against it. */
  | "deferred"
  /** Blank, or the stream is already closed. */
  | "ignored";

/** Render/lifecycle callbacks the bridge drives; all optional for unit tests. */
export interface ChatBridgeHooks {
  /** A line was accepted (echo it) — before the driver may have consumed it. */
  onAccepted?: (line: string) => void;
  /** `runShell` began a model turn. */
  onTurnStart?: () => void;
  /** A streamed assistant chunk. The turn separator NEVER arrives here. */
  onText?: (chunk: string) => void;
  /** The full accumulated reply, once per turn that produced content. */
  onTurnEnd?: (full: string) => void;
  /**
   * The driver asked for the next line, i.e. the previous turn is fully over —
   * including a turn that errored without producing any text, for which
   * `onTurnEnd` never fires. The reliable "stop the spinner" signal.
   */
  onTurnSettled?: () => void;
  /** A non-token line from the core: `/help`, errors, `/connect` guidance, … */
  onSystem?: (text: string) => void;
}

/** The push→pull adapter between the composer and `runShell`. */
export interface ChatBridge {
  /** The `ShellIO` handed to `runShell`. */
  readonly io: ShellIO;
  /** Offer a composer submission. */
  submit(line: string): ChatSubmitResult;
  /** End the line stream so `runShell` returns and the shell tears down. */
  close(): void;
  /** True between a line reaching the driver and the driver asking for the next. */
  turnActive(): boolean;
  /** Lines accepted but not yet consumed by the driver. */
  pending(): number;
}

/**
 * Build the push→pull adapter (AC11).
 *
 * Backpressure is structural: the queue hands out exactly one line per `next()`
 * and `runShell` calls `next()` only after its turn body has finished, so lines
 * submitted during a turn wait their place in FIFO order instead of interleaving
 * turns. A slash command submitted mid-turn is REFUSED rather than queued: by
 * the time the turn ends the user's intent (`/model`, `/compact`) may no longer
 * match the state it was typed against, and the agent shell already refuses the
 * same case ("main is busy — command deferred").
 *
 * `/exit` is intercepted here rather than left to `runShell`, so it takes effect
 * during a turn instead of waiting for the model to finish.
 */
export function createChatBridge(hooks: ChatBridgeHooks = {}): ChatBridge {
  const queue: string[] = [];
  let closed = false;
  let turn = false;
  let streaming = false;
  /**
   * A `"\n\n"` that arrived before this turn produced anything else, held back
   * because it is ambiguous: it is either the trailing separator of a turn that
   * produced NO text (no `onTurnEnd` fires for those, so "not streaming" cannot
   * tell them apart) or the first chunk of a reply that genuinely opens with a
   * blank line. Anything further in the same turn — another write, or
   * `onTurnEnd` — proves it was content and flushes it; otherwise the next turn
   * drops it.
   */
  let heldSeparator = false;
  /** A `next()` call parked because the queue was empty. */
  let waiting: ((result: IteratorResult<string>) => void) | undefined;

  const deliver = (line: string): void => {
    const resolve = waiting;
    if (resolve !== undefined) {
      waiting = undefined;
      turn = true;
      hooks.onAccepted?.(line);
      resolve({ value: line, done: false });
      return;
    }
    queue.push(line);
    hooks.onAccepted?.(line);
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    queue.length = 0;
    const resolve = waiting;
    waiting = undefined;
    resolve?.({ value: undefined, done: true });
  };

  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string>> => {
        // The driver asking for another line is the ONLY proof that the previous
        // turn's body ran to completion — including its error paths.
        if (turn) {
          turn = false;
          streaming = false;
          heldSeparator = false; // the turn is over; it was the trailing one
          hooks.onTurnSettled?.();
        }
        const next = queue.shift();
        if (next !== undefined) {
          turn = true;
          return Promise.resolve({ value: next, done: false });
        }
        if (closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<string>>((resolve) => {
          waiting = resolve;
        });
      },
      return: (): Promise<IteratorResult<string>> => {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };

  /** Emit a held separator as the content it turned out to be. */
  const flushHeldSeparator = (): void => {
    if (heldSeparator) {
      heldSeparator = false;
      streaming = true;
      hooks.onText?.(TURN_SEPARATOR);
    }
  };

  const io: ShellIO = {
    lines,
    write: (s) => {
      if (s.length === 0) {
        return;
      }
      // The turn separator must never reach the transcript: `runShell` emits it
      // after `onTurnEnd`, and forwarding it would open an empty trailing
      // message block. Mid-reply it is ordinary content, so only a separator
      // arriving OUTSIDE a stream is suspect — and that one is held rather than
      // dropped, because a reply may legitimately open with a blank line.
      if (s === TURN_SEPARATOR && !streaming) {
        heldSeparator = true;
        return;
      }
      flushHeldSeparator();
      streaming = true;
      hooks.onText?.(s);
    },
    onTurnStart: () => {
      // A separator held from the previous turn was that turn's trailing one:
      // nothing followed it. Drop it before the new turn can flush it.
      heldSeparator = false;
      hooks.onTurnStart?.();
    },
    onTurnEnd: (full) => {
      // Reached only for a turn that produced content, so a held separator was
      // the leading blank line of that content, not a trailing separator.
      flushHeldSeparator();
      streaming = false;
      hooks.onTurnEnd?.(full);
    },
    onSystem: (text) => {
      hooks.onSystem?.(text);
    },
  };

  return {
    io,
    submit: (line) => {
      const value = line.trim();
      if (closed || value.length === 0) {
        return "ignored";
      }
      const token = value.split(/\s+/)[0] ?? "";
      if (token === "/exit" || token === "/quit") {
        close();
        return "exit";
      }
      if ((turn || queue.length > 0) && value.startsWith("/")) {
        return "deferred";
      }
      deliver(value);
      return "accepted";
    },
    close,
    turnActive: () => turn,
    pending: () => queue.length,
  };
}

/** A mounted chat shell. */
export interface ChatShellHandle {
  readonly chrome: ShellChrome;
  readonly bridge: ChatBridge;
  /** Resolves when `runShell` returns (the line stream ended). Never rejects. */
  readonly done: Promise<void>;
  /** Drop the chrome's timers/listeners. Does not destroy the renderer. */
  destroy(): void;
}

export interface ChatShellOptions {
  /** Provider factory, clock/ids and the initial selection for `runShell`. */
  deps: ShellDeps;
  /** The driver. Injected to keep `commands/shell.ts` ↔ this module acyclic. */
  runShell: (io: ShellIO, deps: ShellDeps) => Promise<void>;
  /**
   * TUI picker for `/models` (with `onlyProvider`) and `/provider`. Injected as
   * `deps.selectProviderModel` so those commands open an overlay instead of
   * consuming the next composer submissions as text-menu answers. `undefined`
   * from the picker = cancelled: the current selection is kept.
   */
  pickSelection?: (opts?: { onlyProvider?: string }) => Promise<TuiSelection | undefined>;
  /** Persist the provider/model chosen mid-session (opencode-style). Default on. */
  persistSelection?: boolean;
  /** `/exit`: the caller tears the renderer down. */
  onExit?: () => void;
}

/**
 * Mount the chat shell on an existing renderer and start the driver.
 *
 * Split out of {@link launchTuiChatShell} so a headless `createTestRenderer` can
 * drive a real chat turn end to end (AC10) — `launchTuiChatShell` itself needs a
 * TTY and can never be entered from a test.
 */
export async function mountChatShell(
  otui: OpenTui,
  renderer: Renderer,
  opts: ChatShellOptions,
): Promise<ChatShellHandle> {
  const r = renderer;
  let selection: TuiSelection = { ...opts.deps.initial };
  const label = (): string => `${selection.provider}/${selection.model}`;

  const chrome = await createShellChrome(otui, r, {
    title: `keryx · chat · ${label()}`,
    status: label(),
    footerHint: FOOTER_IDLE,
    placeholder: "type a message or / for commands · Enter send · Shift+Enter newline",
    commands: commandsForMode("chat"),
    headerMeta: "~0",
    // The shared registry stays the single source of truth for the dropdown,
    // resolved through THIS surface's mode so the wording is chat-mode's (S4).
    filterCommands: (query) => filterCommands(query, "chat"),
  });

  let uid = 0;
  const transcript = chrome.transcript;
  const append = (content: string | ReturnType<OpenTui["t"]>): void => {
    transcript.add(new otui.TextRenderable(r, { id: `c${uid++}`, content }));
  };

  // Sidebar panels go in `sidebarTop`: the chrome pins the toast to the bottom
  // with a flexGrow spacer, so anything added to `sidebar` itself lands beside it.
  const sidebar = chrome.sidebarTop;
  sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t`${otui.bold("keryx")}` }));
  sidebar.add(new otui.TextRenderable(r, { id: "sb-mode", content: otui.t`${otui.dim("chat · no tools")}` }));
  sidebar.add(new otui.TextRenderable(r, { id: "sb-model-k", content: otui.t`${otui.dim("Model")}`, marginTop: 1 }));
  const sbModel = new otui.TextRenderable(r, { id: "sb-model-v", content: otui.t`${otui.dim(label())}` });
  sidebar.add(sbModel);
  sidebar.add(new otui.TextRenderable(r, { id: "sb-ctx-k", content: otui.t`${otui.dim("Context")}`, marginTop: 1 }));
  const sbContext = new otui.TextRenderable(r, { id: "sb-ctx-v", content: otui.t`${otui.dim("~0 tokens (est)")}` });
  sidebar.add(sbContext);

  const messages = createAssistantMessageStream(otui, r, transcript);

  // D-A2: `ShellIO` has no usage hook and none is added, so the counter is an
  // ESTIMATE over what this surface has seen — labelled as one, never a "0" that
  // looks like a measurement.
  const seen: { content: string }[] = [];
  /**
   * The commands that make `runShell` drop its history (`/clear` aliases
   * `/new`). The estimate is this surface's mirror of that history, so it has to
   * be reset with it or the header's `~N` keeps climbing across a session reset.
   */
  const RESET_COMMANDS = new Set(["/new", "/clear"]);
  const paintContext = (): void => {
    const est = estimateContextTokens(seen);
    chrome.setHeaderMeta(`~${fmtTokens(est)}`);
    sbContext.content = otui.t`${otui.dim(`~${est.toLocaleString()} tokens (est)`)}`;
  };

  const paintLabels = (): void => {
    chrome.setTitle(`keryx · chat · ${label()}`);
    chrome.setStatus(label());
    sbModel.content = otui.t`${otui.dim(label())}`;
  };

  const bridge = createChatBridge({
    onAccepted: (line) => {
      const box = new otui.BoxRenderable(r, {
        id: `ub${uid++}`,
        borderStyle: "rounded",
        border: true,
        borderColor: "#3a4a4a",
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        alignSelf: "flex-start",
      });
      box.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: otui.t`${otui.dim(`❯ ${line}`)}` }));
      transcript.add(box);
      if (!line.startsWith("/")) {
        seen.push({ content: line });
        paintContext();
      } else if (RESET_COMMANDS.has(line.split(/\s+/)[0] ?? "")) {
        seen.length = 0;
        paintContext();
      }
    },
    onTurnStart: () => {
      append(otui.t`${otui.cyan("●")} ${otui.bold("keryx")}`);
      chrome.startBusy("waiting for model");
    },
    onText: (chunk) => {
      chrome.setBusyPhase("streaming reply");
      messages.push(chunk);
    },
    onTurnEnd: (full) => {
      messages.finalize(full);
      seen.push({ content: full });
      paintContext();
    },
    onTurnSettled: () => {
      chrome.stopBusy();
      // Never steal focus from an OPEN `/` dropdown: the user may have opened it
      // while the reply streamed, and the dropdown stays on screen either way —
      // yanking focus to the textarea would leave it swallowing printable keys
      // while Enter submitted the raw filter text instead of selecting the
      // highlighted command. Same shape as the agent shell's block-nav guard
      // (`nav.restoreComposerFocus()`).
      if (!chrome.menuActive()) {
        chrome.focusComposer();
      }
    },
    onSystem: (text) => {
      const body = text.replace(/\n+$/, "");
      if (body.length === 0) {
        return;
      }
      append(body.includes("[error]") ? otui.t`${otui.red(body)}` : otui.t`${otui.dim(body)}`);
    },
  });

  // `/models` and `/provider` route through the TUI picker (inside the chrome's
  // overlay guard, so the `/`-menu key router stays inert while it is up) rather
  // than through `pickProviderModel`, which would read the next composer
  // submissions as answers to a numbered text menu.
  const selectProviderModel: NonNullable<ShellDeps["selectProviderModel"]> = async (_io, pickOpts) => {
    const picked =
      opts.pickSelection === undefined
        ? undefined
        : await chrome.withOverlay(() => opts.pickSelection?.(pickOpts) ?? Promise.resolve(undefined));
    chrome.focusComposer();
    if (picked === undefined) {
      return { ...selection };
    }
    selection = picked;
    paintLabels();
    if (opts.persistSelection !== false) {
      saveShellConfig(
        picked.baseUrl === undefined
          ? { provider: picked.provider, model: picked.model }
          : { provider: picked.provider, model: picked.model, baseUrl: picked.baseUrl },
      );
    }
    chrome.showToast(`Switched to ${label()}`);
    return { ...picked };
  };

  const deps: ShellDeps = { ...opts.deps, selectProviderModel };

  chrome.onSubmit((line) => {
    const result = bridge.submit(line);
    if (result === "exit") {
      opts.onExit?.();
      return;
    }
    if (result === "deferred") {
      append(
        otui.t`${otui.yellow("◇ a reply is still streaming — command deferred. Wait for it to finish.")}`,
      );
    }
  });

  // Started here, not awaited: the driver runs for the life of the shell and
  // resolves only once the line stream ends.
  const done = opts.runShell(bridge.io, deps).catch((cause: unknown) => {
    append(otui.t`${otui.red(`[error] ${cause instanceof Error ? cause.message : String(cause)}`)}`);
  });

  return {
    chrome,
    bridge,
    done,
    destroy: () => {
      bridge.close();
      chrome.destroy();
    },
  };
}

/**
 * Run the OpenTUI chat shell. Mirrors `launchTuiAgentShell`'s contract exactly:
 * returns `true` once the user exits, `false` when it declined or failed (no
 * TTY, absent optional dependency, renderer init failure) so the caller falls
 * back to the readline chat shell. Never throws.
 */
export async function launchTuiChatShell(opts: {
  detected: DetectedProvider[];
  initial?: TuiSelection;
  /** Re-probe providers for `/provider` and `/models` (fresh detection). */
  redetect?: () => Promise<DetectedProvider[]>;
  /** Build `runShell`'s deps once the provider/model is resolved. */
  makeShellDeps: (sel: TuiSelection) => ShellDeps;
  runShell: (io: ShellIO, deps: ShellDeps) => Promise<void>;
}): Promise<boolean> {
  if (!process.stdout.isTTY) {
    return false;
  }
  let otui: OpenTui;
  try {
    otui = await import("@opentui/core"); // optional dep; absent → fall back
  } catch {
    return false;
  }

  let renderer: Renderer | undefined;
  let handle: ChatShellHandle | undefined;
  let resolveDone: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  try {
    const r = (renderer = await createShellRenderer(otui, {
      onDestroy: () => {
        handle?.destroy(); // stops the live spinner if a turn is mid-flight
        resolveDone();
      },
    }));

    // Provider/model from flags or the same in-TUI wizard the agent shell uses.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.destroy();
      return true; // could not select; a clean exit, not a fall-back
    }
    saveShellConfig(
      sel.baseUrl === undefined
        ? { provider: sel.provider, model: sel.model }
        : { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl },
    );

    handle = await mountChatShell(otui, r, {
      deps: opts.makeShellDeps(sel),
      runShell: opts.runShell,
      // `/models` → the model picker for the current provider; `/provider` →
      // the full provider→model→key wizard. Both are the agent shell's pickers,
      // so the two surfaces prompt identically.
      pickSelection: async (pickOpts) => {
        const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
        const only = pickOpts?.onlyProvider;
        if (only === undefined) {
          return await selectProviderModelInTui(otui, r, detected);
        }
        const prov = detected.find((d) => d.name === only);
        const chosen = await pickModelInTui(otui, r, prov !== undefined ? await modelsForPicker(prov) : []);
        if (chosen === undefined) {
          return undefined;
        }
        return prov?.baseUrl === undefined
          ? { provider: only, model: chosen }
          : { provider: only, model: chosen, baseUrl: prov.baseUrl };
      },
      onExit: () => {
        r.destroy();
      },
    });
    // Either the user exits (renderer teardown) or the driver returns on its own.
    await Promise.race([exited, handle.done]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      renderer?.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
