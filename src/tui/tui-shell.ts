// OpenTUI interactive agent shell (flows 060 skeleton + 061 chrome parity).
//
// A new IO implementation of the existing `AgentIO` hook surface (src/commands/
// agent.ts): it renders into an OpenTUI transcript and drives `runAgentTurn` from
// a `split-footer` composer (a fixed footer input over a scrolling main region —
// the Pi/grok layout). Chrome parity with the readline shell: assistant text →
// native `MarkdownRenderable`; `● keryx` role header; `⚙ tool(args)` (via the pure
// `summarizeToolArgs`); collapsed tool output (`collapseToolOutput`); dim
// `⋯ thinking` reasoning; dim `↑in ↓out tokens`. The deterministic driver and the
// pure helpers are unchanged. Gutter = the transcript box `padding`.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005) loaded ONLY via a dynamic
// `import()` — never a top-level import (keryx's zero-`dependencies` floor + lazy
// optional-import guard, src/capability/no-optional-imports). `launchTuiAgentShell`
// is defensive: it returns `false` (caller falls back to the readline shell)
// whenever there is no TTY, the package is absent, or the renderer fails to init.
import type { AgentDeps, AgentIO } from "../commands/agent";
import { runAgentTurn } from "../commands/agent";
import type { NormalizedMessage } from "../harness/provider/types";
import { AGENT_SLASH_COMMANDS, filterCommands, findAgentCommand } from "../commands/agent-commands";
import type { DetectedProvider } from "../commands/select";
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";

/** A resolved provider/model selection. */
export interface TuiSelection {
  provider: string;
  model: string;
  baseUrl?: string;
}

/** The `@opentui/core` module shape, referenced structurally (type-only import). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
type Chunk = ReturnType<OpenTui["bold"]>;
type StyledContent = string | ReturnType<OpenTui["t"]>;

// Lightweight markdown → OpenTUI StyledText, mirroring the readline `renderMarkdown`
// rules (ATX headings, **bold**, `inline code`, fenced blocks, -/* bullets) — but
// emitting `@opentui/core` text chunks instead of ANSI, so it needs no parser
// worker (the native `MarkdownRenderable` spins a WASM worker that is unavailable
// headless) and renders through a plain `TextRenderable`.
function markdownToChunks(otui: OpenTui, md: string): Chunk[] {
  const out: Chunk[] = [];
  const plain = (s: string): void => {
    if (s.length > 0) {
      out.push(...otui.stringToStyledText(s).chunks);
    }
  };
  const inline = (text: string): void => {
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      plain(text.slice(last, m.index));
      if (m[1] !== undefined) {
        out.push(otui.dim(m[1].slice(1, -1))); // `code` → dim
      } else if (m[2] !== undefined) {
        out.push(otui.bold(m[2].slice(2, -2))); // **bold**
      }
      last = m.index + m[0].length;
    }
    plain(text.slice(last));
  };
  const lines = md.split("\n");
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) {
      inCode = !inCode; // drop the fence line
      continue;
    }
    if (i > 0) {
      plain("\n");
    }
    if (inCode) {
      out.push(otui.dim(line));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(otui.cyan(otui.bold(heading[1] ?? "")));
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      plain(`${bullet[1] ?? ""}• `);
      inline(bullet[2] ?? "");
      continue;
    }
    inline(line);
  }
  return out;
}

/**
 * Build an `AgentIO` that renders into an OpenTUI `transcript` box with chrome
 * parity: streamed tokens (`write`) accumulate into a native `MarkdownRenderable`;
 * tool calls/results, reasoning, usage, and system lines append styled blocks.
 * Exported so the headless test can drive the same render path through
 * `runAgentTurn` without a real TTY.
 */
export function createTuiAgentIo(otui: OpenTui, renderer: Renderer, transcript: Box): AgentIO {
  let seq = 0;
  let active: Text | undefined;
  let pending = "";
  const append = (content: StyledContent): void => {
    transcript.add(new otui.TextRenderable(renderer, { id: `n${seq++}`, content }));
  };
  const render = (md: string): InstanceType<OpenTui["StyledText"]> => new otui.StyledText(markdownToChunks(otui, md));
  return {
    // Assistant text streams into a TextRenderable whose StyledText is our
    // worker-free markdown render (bold/headings/lists/code) — parity with the
    // readline `renderMarkdown`.
    write: (s) => {
      if (s.length === 0) {
        return;
      }
      pending += s;
      if (active === undefined) {
        active = new otui.TextRenderable(renderer, { id: `a${seq++}`, content: render(pending) });
        transcript.add(active);
      } else {
        active.content = render(pending);
      }
    },
    onAssistantText: (text) => {
      if (active !== undefined) {
        active.content = render(text);
        active = undefined;
      } else {
        append(render(text));
      }
      pending = "";
    },
    onReasoning: (text) => append(otui.t`${otui.dim(`⋯ thinking\n${text}`)}`),
    onUsage: (usage) => {
      const parts: string[] = [];
      if (usage.inputTokens !== undefined) {
        parts.push(`↑${usage.inputTokens}`);
      }
      if (usage.outputTokens !== undefined) {
        parts.push(`↓${usage.outputTokens}`);
      }
      if (parts.length > 0) {
        append(otui.t`${otui.dim(`${parts.join(" ")} tokens`)}`);
      }
    },
    onToolCall: (name, input) => {
      const args = summarizeToolArgs(input);
      const call = args.length > 0 ? `${name}(${args})` : `${name}()`;
      append(otui.t`${otui.cyan(`⚙ ${call}`)}`);
    },
    onToolResult: (_name, result) => {
      const { summary, hidden } = collapseToolOutput(result.output);
      const more = hidden > 0 ? ` · +${hidden} more` : "";
      const line = `${result.isError ? "✗" : "↳"} ${summary}${more}`;
      append(result.isError ? otui.t`${otui.red(line)}` : otui.t`${otui.dim(line)}`);
    },
    onSystem: (text) => append(text.includes("[error]") ? otui.t`${otui.red(text)}` : otui.t`${otui.dim(text)}`),
  };
}

/** True only for an explicit `y`/`yes` (case-insensitive). Default-deny otherwise. */
export function isShellApproved(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/** Compact token count for the header counter: 1234 → "1.2K", else the number. */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * In-TUI provider → model picker (used when no `--provider`/`--model` flags were
 * given). Renders a provider SelectRenderable, then a model SelectRenderable, both
 * navigated with ↑/↓ + Enter (they own focus, so no readline/Input conflict).
 * Resolves the chosen selection, or `undefined` if it cannot resolve one.
 */
function selectProviderModelInTui(
  otui: OpenTui,
  r: Renderer,
  detected: DetectedProvider[],
): Promise<TuiSelection | undefined> {
  return new Promise((resolve) => {
    if (detected.length === 0) {
      resolve(undefined);
      return;
    }
    const box = new otui.BoxRenderable(r, { id: "picker", flexGrow: 1, flexDirection: "column", padding: 1 });
    r.root.add(box);
    const title = new otui.TextRenderable(r, {
      id: "picker-title",
      content: otui.t`${otui.bold("Select a provider")} ${otui.dim("(↑/↓, Enter)")}`,
    });
    box.add(title);
    const provSelect = new otui.SelectRenderable(r, {
      id: "picker-provider",
      width: 60,
      height: Math.min(8, Math.max(1, detected.length)),
      options: detected.map((d) => ({ name: d.name, description: `${d.models.length} model(s)` })),
    });
    box.add(provSelect);
    provSelect.focus();
    provSelect.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = provSelect.getSelectedOption();
      const prov = chosen === null ? undefined : detected.find((d) => d.name === chosen.name);
      if (prov === undefined) {
        r.root.remove(box);
        resolve(undefined);
        return;
      }
      title.content = otui.t`${otui.bold(`Select a model for ${prov.name}`)} ${otui.dim("(↑/↓, Enter)")}`;
      box.remove(provSelect);
      const models = prov.models.length > 0 ? prov.models : ["fake-echo"];
      const modelSelect = new otui.SelectRenderable(r, {
        id: "picker-model",
        width: 60,
        // showDescription defaults to TRUE, which reserved a 2nd (empty) line per
        // item and hid the model name — models have no description, so disable it.
        showDescription: false,
        height: Math.min(12, Math.max(3, models.length)),
        options: models.map((m) => ({ name: m, description: "" })),
      });
      box.add(modelSelect);
      modelSelect.focus();
      modelSelect.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
        const chosenModel = modelSelect.getSelectedOption();
        const model = chosenModel === null ? (models[0] ?? "fake-echo") : chosenModel.name;
        r.root.remove(box);
        resolve(prov.baseUrl === undefined ? { provider: prov.name, model } : { provider: prov.name, model, baseUrl: prov.baseUrl });
      });
    });
  });
}

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
  makeAgentDeps: (sel: TuiSelection) => Promise<AgentDeps>;
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
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  // Pending `shell_exec` approval resolver (default-deny on teardown).
  let uid = 0;
  let pendingApproval: ((ok: boolean) => void) | undefined;
  try {
    // Stable non-nullable handle for the closures below (the outer `renderer`
    // stays `Renderer | undefined` for the `finally` teardown).
    const r = (renderer = await otui.createCliRenderer({
      exitOnCtrlC: true,
      // Full-screen (grok/opencode style): own the alternate screen buffer so the
      // shell's prior scrollback is cleared on launch and restored on exit, and
      // the layout fills the terminal (composer anchored to the bottom). The
      // earlier `split-footer` left the launch output on screen and floated the
      // composer mid-screen.
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      onDestroy: () => {
        pendingApproval?.(false); // deny any in-flight approval on exit
        pendingApproval = undefined;
        resolveDone();
      },
    }));

    // Resolve the provider/model — from flags, or an in-TUI picker.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.destroy();
      return true; // could not select; treat as a clean exit (do not fall back)
    }
    const deps = await opts.makeAgentDeps(sel);

    // Header bar (grok-style): identity on the left, cumulative token counter on
    // the right (updated from usage).
    const header = new otui.BoxRenderable(r, {
      id: "header",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    header.add(
      new otui.TextRenderable(r, {
        id: "header-left",
        content: otui.t`${otui.dim(`keryx · agent · ${sel.provider}/${sel.model}`)}`,
      }),
    );
    const tokenText = new otui.TextRenderable(r, { id: "header-tokens", content: "" });
    header.add(tokenText);
    r.root.add(header);

    // A scrollable, sticky-to-bottom transcript so long conversations scroll and
    // auto-follow the newest output; the AgentIO renders into its `.content`.
    const scroll = new otui.ScrollBoxRenderable(r, {
      id: "transcript",
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
    });
    r.root.add(scroll);
    const transcript = scroll.content;

    const io = createTuiAgentIo(otui, r, transcript);
    // Cumulative token usage → the header counter (not per-turn transcript lines).
    let totalIn = 0;
    let totalOut = 0;
    io.onUsage = (u) => {
      totalIn += u.inputTokens ?? 0;
      totalOut += u.outputTokens ?? 0;
      tokenText.content = otui.t`${otui.dim(`↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`)}`;
    };
    // `shell_exec` approval: render a prompt; resolve from the NEXT composer
    // submit (handled in the ENTER listener). Keeps the default-deny gate.
    io.requestApproval = (_tool, inputJson) => {
      let cmd = inputJson;
      try {
        const parsed: unknown = JSON.parse(inputJson);
        if (parsed !== null && typeof parsed === "object" && typeof (parsed as { command?: unknown }).command === "string") {
          cmd = (parsed as { command: string }).command;
        }
      } catch {
        // show the raw input if it is not JSON
      }
      transcript.add(
        new otui.TextRenderable(r, {
          id: `ap${uid++}`,
          content: otui.t`${otui.yellow(`Run: ${cmd}`)} ${otui.dim("[y/N]")}`,
        }),
      );
      return new Promise<boolean>((resolve) => {
        pendingApproval = resolve;
      });
    };

    // The live `/` command dropdown (Pi/grok-style): a SelectRenderable filtered
    // as the composer changes; hidden when the value is not a slash query.
    const menu = new otui.SelectRenderable(r, {
      id: "menu",
      height: 6,
      visible: false,
      options: [...AGENT_SLASH_COMMANDS],
    });
    r.root.add(menu);

    // Bordered composer (grok-style rounded input box) — compact single line.
    const composer = new otui.BoxRenderable(r, {
      id: "composer",
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const input = new otui.InputRenderable(r, { id: "prompt", placeholder: "type a task or / for commands" });
    composer.add(input);
    r.root.add(composer);
    input.focus();

    // Footer hints.
    r.root.add(
      new otui.TextRenderable(r, {
        id: "footer",
        content: otui.t`${otui.dim("/ commands · Ctrl+C to exit")}`,
        paddingLeft: 1,
      }),
    );

    // `menuNav` = the `/` dropdown (not the Input) currently owns the keyboard.
    let menuNav = false;
    input.on(otui.InputRenderableEvents.INPUT, () => {
      const matches = filterCommands(input.value);
      if (matches.length > 0) {
        menu.options = matches;
        menu.visible = true;
      } else {
        menu.visible = false;
        menuNav = false;
      }
    });

    const helpText = (): string =>
      ["Commands:", ...AGENT_SLASH_COMMANDS.map((c) => `  ${c.name}  ${c.description}`)].join("\n") + "\n";

    const history: NormalizedMessage[] = [];
    let busy = false;
    // Run a submitted line: a slash command, an unknown-slash notice, or a turn.
    const runLine = (line: string): void => {
      if (busy || line.length === 0) {
        return;
      }
      // Echo a slash command so it is clear WHICH command ran (turns echo their
      // own `❯ …` user box below).
      if (line.startsWith("/")) {
        transcript.add(
          new otui.TextRenderable(r, { id: `c${uid++}`, content: otui.t`${otui.cyan(`❯ ${line}`)}`, marginTop: 1 }),
        );
      }
      const command = findAgentCommand(line);
      if (command !== undefined) {
        if (command.name === "/exit") {
          r.destroy();
          return;
        }
        if (command.name === "/clear") {
          history.length = 0;
          io.onSystem?.("Conversation cleared.\n");
          return;
        }
        io.onSystem?.(helpText()); // /help
        return;
      }
      if (line.startsWith("/")) {
        io.onSystem?.(`Unknown command: ${line}\n`);
        io.onSystem?.(helpText());
        return;
      }
      const userBox = new otui.BoxRenderable(r, {
        id: `ub${uid++}`,
        borderStyle: "rounded",
        border: true,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        alignSelf: "flex-start",
      });
      userBox.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: otui.t`${otui.cyan(`❯ ${line}`)}` }));
      transcript.add(userBox);
      transcript.add(
        new otui.TextRenderable(r, { id: `h${uid++}`, content: otui.t`${otui.cyan("●")} ${otui.bold("keryx")}`, marginTop: 1 }),
      );
      busy = true;
      void runAgentTurn(io, deps, history, line).finally(() => {
        busy = false;
      });
    };

    // Route ↑/↓/Enter/Esc to the `/` command dropdown when it is open — via the
    // GLOBAL internal key handler, which runs BEFORE the focused Input, so a
    // handled key does not also move the Input's cursor / submit a turn.
    // Selecting a command from the dropdown (Enter on the focused menu) runs it
    // and returns focus to the composer.
    menu.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const opt = menu.getSelectedOption();
      menuNav = false;
      menu.visible = false;
      input.value = "";
      input.focus();
      if (opt !== null) {
        runLine(opt.name);
      }
    });
    // The first ↑/↓ while the dropdown is open TRANSFERS focus to the menu; from
    // then on the native SelectRenderable handles ↑/↓/Enter (the case that worked
    // via mouse-focus). Esc closes and returns focus to the composer. Typing (no
    // arrow) keeps composer focus and filters. Runs before the Input via onInternal.
    r._internalKeyInput.onInternal("keypress", (key) => {
      if (!menu.visible) {
        menuNav = false;
        return;
      }
      if (key.name === "escape") {
        menu.visible = false;
        menuNav = false;
        input.focus();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (!menuNav && (key.name === "up" || key.name === "down")) {
        menuNav = true;
        menu.focus();
        if (key.name === "down") {
          menu.moveDown();
        } else {
          menu.moveUp();
        }
        key.preventDefault();
        key.stopPropagation();
      }
    });

    input.on(otui.InputRenderableEvents.ENTER, () => {
      // A pending shell_exec approval consumes this submit (y/N), never a turn.
      if (pendingApproval !== undefined) {
        const ok = isShellApproved(input.value);
        input.value = "";
        menu.visible = false;
        const resolve = pendingApproval;
        pendingApproval = undefined;
        transcript.add(
          new otui.TextRenderable(r, {
            id: `av${uid++}`,
            content: ok ? otui.t`${otui.green("approved")}` : otui.t`${otui.red("denied")}`,
          }),
        );
        resolve(ok);
        return;
      }
      const line = input.value.trim();
      input.value = "";
      menu.visible = false;
      runLine(line);
    });

    await done;
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
