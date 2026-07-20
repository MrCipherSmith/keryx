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
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";

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

/**
 * Attempt the OpenTUI agent shell. Returns `true` if it ran to completion (user
 * exited), `false` if it declined/failed and the caller should fall back to the
 * readline shell. Never throws.
 */
export async function launchTuiAgentShell(
  deps: AgentDeps,
  opts?: { onStart?: () => void },
): Promise<boolean> {
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
      screenMode: "split-footer",
      onDestroy: () => {
        pendingApproval?.(false); // deny any in-flight approval on exit
        pendingApproval = undefined;
        resolveDone();
      },
    }));
    // The renderer initialised — hand off stdin (the caller closes readline) so
    // OpenTUI is the sole stdin consumer. Called ONLY past this point, so the
    // pre-init fallback paths above keep the readline shell usable.
    opts?.onStart?.();
    // A scrollable, sticky-to-bottom transcript so long conversations scroll and
    // auto-follow the newest output; the AgentIO renders into its `.content`.
    const scroll = new otui.ScrollBoxRenderable(r, {
      id: "transcript",
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column", padding: 1 },
    });
    r.root.add(scroll);
    const transcript = scroll.content;
    transcript.add(
      new otui.TextRenderable(r, {
        id: "header",
        content: "keryx — agent (OpenTUI) · type a task · Ctrl+C to exit",
      }),
    );

    const io = createTuiAgentIo(otui, r, transcript);
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

    const input = new otui.InputRenderable(r, { id: "prompt", placeholder: "type a task or / for commands" });
    r.root.add(input);
    input.focus();

    input.on(otui.InputRenderableEvents.INPUT, () => {
      const matches = filterCommands(input.value);
      if (matches.length > 0) {
        menu.options = matches;
        menu.visible = true;
      } else {
        menu.visible = false;
      }
    });

    const helpText = (): string =>
      ["Commands:", ...AGENT_SLASH_COMMANDS.map((c) => `  ${c.name}  ${c.description}`)].join("\n") + "\n";

    const history: NormalizedMessage[] = [];
    let busy = false;
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
      if (busy) {
        return; // one turn at a time
      }
      const line = input.value.trim();
      input.value = "";
      menu.visible = false;
      if (line.length === 0) {
        return;
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
      transcript.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: otui.t`${otui.cyan(`❯ ${line}`)}` }));
      transcript.add(new otui.TextRenderable(r, { id: `h${uid++}`, content: otui.t`${otui.cyan("●")} ${otui.bold("keryx")}` }));
      busy = true;
      void runAgentTurn(io, deps, history, line).finally(() => {
        busy = false;
      });
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
