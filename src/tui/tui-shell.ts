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
import { type DetectedProvider, fetchOpenRouterModels } from "../commands/select";
import { collapseToolOutput, summarizeToolArgs } from "../lib/ui";
import { saveShellConfig } from "../lib/shell-config";

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
    // Reasoning is COLLAPSED to a one-line marker (grok/opencode style) instead of
    // dumping the whole chain-of-thought; `line count` hints at its length.
    onReasoning: (text) => {
      const lines = text.trim().split("\n").filter((l) => l.trim().length > 0).length;
      append(otui.t`${otui.dim(`◆ thought (${lines} line${lines === 1 ? "" : "s"})`)}`);
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
 * Rough token estimate of the conversation (≈ 4 chars/token) — a fallback for the
 * context counter when the provider does not report exact `usage` (e.g. local
 * Ollama models). Pure.
 */
export function estimateContextTokens(history: readonly { content: string }[]): number {
  const chars = history.reduce((n, m) => n + m.content.length, 0);
  return Math.round(chars / 4);
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
    backgroundColor: "#0a1414",
    flexDirection: "column",
    padding: 1,
  });
}

/** Prompt for the OpenRouter API key in an overlay; resolve the key or `undefined`. */
function promptOpenRouterKey(otui: OpenTui, r: Renderer): Promise<string | undefined> {
  return new Promise((resolve) => {
    const box = overlayBox(otui, r, "key-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "kp-title", content: otui.t`${otui.bold("Paste your OpenRouter API key")} ${otui.dim("(Enter)")}` }));
    box.add(
      new otui.TextRenderable(r, {
        id: "kp-note",
        content: otui.t`${otui.dim("Get one at openrouter.ai/keys · saved to your keryx config dir (owner-only, 0600)")}`,
        marginTop: 1,
      }),
    );
    const keyInput = new otui.InputRenderable(r, { id: "kp-input", placeholder: "sk-or-...", marginTop: 1 });
    box.add(keyInput);
    keyInput.focus();
    keyInput.on(otui.InputRenderableEvents.ENTER, () => {
      const key = keyInput.value.trim();
      r.root.remove(box);
      resolve(key.length > 0 ? key : undefined);
    });
  });
}

/**
 * In-TUI provider → model picker. A provider SelectRenderable, then the filterable
 * {@link pickModelInTui}. For OpenRouter the LIVE model list is fetched (all models,
 * searchable — e.g. `free`); without a key it then prompts + persists one. Absolute
 * overlay (works at startup AND for `/connect`). Resolves the selection or `undefined`.
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
    const box = overlayBox(otui, r, "picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "picker-title", content: otui.t`${otui.bold("Select a provider")} ${otui.dim("(↑/↓, Enter)")}` }));
    const provSelect = new otui.SelectRenderable(r, {
      id: "picker-provider",
      width: 60,
      height: Math.min(8, Math.max(1, detected.length)),
      options: detected.map((d) => ({ name: d.name, description: d.name === "openrouter" ? "hosted · many models" : `${d.models.length} model(s)` })),
      selectedTextColor: "#ffd166",
    });
    box.add(provSelect);
    provSelect.focus();
    provSelect.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = provSelect.getSelectedOption();
      const prov = chosen === null ? undefined : detected.find((d) => d.name === chosen.name);
      r.root.remove(box);
      if (prov === undefined) {
        resolve(undefined);
        return;
      }
      void (async () => {
        // OpenRouter: fetch the live, filterable model list; others use detected.
        const models = prov.name === "openrouter" ? await fetchOpenRouterModels(globalThis.fetch) : prov.models;
        const model = await pickModelInTui(otui, r, models);
        if (model === undefined) {
          resolve(undefined);
          return;
        }
        const hasKey = typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.length > 0;
        if (prov.name === "openrouter" && !hasKey) {
          const key = await promptOpenRouterKey(otui, r);
          if (key !== undefined) {
            process.env.OPENROUTER_API_KEY = key;
            saveShellConfig({ openrouterKey: key }); // persist (0600), opencode-style
          }
        }
        resolve(prov.baseUrl === undefined ? { provider: prov.name, model } : { provider: prov.name, model, baseUrl: prov.baseUrl });
      })();
    });
  });
}

/**
 * In-TUI model picker with TYPE-TO-FILTER (search by name, e.g. `free`). Absolute
 * overlay; the SelectRenderable is focused (↑/↓/Enter native) while printable keys
 * and Backspace edit a live filter over the (potentially large) model list. Resolves
 * the chosen model, or `undefined` on Esc / no match. Removes its key handler on close.
 */
function pickModelInTui(otui: OpenTui, r: Renderer, models: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const all = models.length > 0 ? models : ["fake-echo"];
    const box = overlayBox(otui, r, "model-picker");
    r.root.add(box);
    box.add(new otui.TextRenderable(r, { id: "mp-title", content: otui.t`${otui.bold("Select a model")}` }));
    const filterLine = new otui.TextRenderable(r, { id: "mp-filter", content: otui.t`${otui.dim("type to filter · ↑/↓ Enter · Esc to cancel")}` });
    box.add(filterLine);
    const NO_MATCH = "(no match)";
    const sel = new otui.SelectRenderable(r, {
      id: "mp-sel",
      width: 72,
      showDescription: false,
      height: 14,
      showScrollIndicator: true,
      wrapSelection: true,
      options: all.map((m) => ({ name: m, description: "" })),
      selectedTextColor: "#ffd166",
    });
    box.add(sel);
    sel.focus();

    let filter = "";
    const apply = (): void => {
      const q = filter.trim().toLowerCase();
      const matches = q.length > 0 ? all.filter((m) => m.toLowerCase().includes(q)) : all;
      sel.options = matches.length > 0 ? matches.map((m) => ({ name: m, description: "" })) : [{ name: NO_MATCH, description: "" }];
      filterLine.content = otui.t`${otui.dim(q.length > 0 ? `filter: ${filter}  (${matches.length})` : "type to filter · ↑/↓ Enter · Esc to cancel")}`;
    };

    const onKey = (key: { name: string; ctrl: boolean; meta: boolean; sequence: string; preventDefault: () => void; stopPropagation: () => void }): void => {
      if (key.name === "escape") {
        cleanup();
        resolve(undefined);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
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
      // ↑/↓/Enter fall through to the focused SelectRenderable.
    };
    const cleanup = (): void => {
      r._internalKeyInput.offInternal("keypress", onKey);
      r.root.remove(box);
    };
    r._internalKeyInput.onInternal("keypress", onKey);

    sel.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
      const chosen = sel.getSelectedOption();
      cleanup();
      resolve(chosen === null || chosen.name === NO_MATCH ? undefined : chosen.name);
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
  /** Re-probe providers for `/connect` and `/model` (fresh detection). */
  redetect?: () => Promise<DetectedProvider[]>;
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
      // Enable mouse so OpenTUI tracks drag-selection (the alternate screen would
      // otherwise disable the terminal's native selection). Copy-on-select is
      // wired below (OSC52), matching grok/opencode.
      useMouse: true,
      onDestroy: () => {
        pendingApproval?.(false); // deny any in-flight approval on exit
        pendingApproval = undefined;
        resolveDone();
      },
    }));
    // Assigned once the sidebar toast is built (below); the copy handler may fire
    // before then, so start with a safe no-op.
    let showToast: (msg: string) => void = () => {};
    // Copy-on-select (grok/opencode): when a mouse selection changes, copy the
    // selected text to the SYSTEM clipboard via OSC52 (works locally and over SSH;
    // the terminal must permit clipboard access — e.g. iTerm2's "Applications may
    // access the clipboard"). Best-effort: any failure is ignored.
    r.on(otui.CliRenderEvents.SELECTION, () => {
      try {
        const text = r.getSelection()?.getSelectedText() ?? "";
        if (text.length > 0) {
          r.copyToClipboardOSC52(text);
          showToast("Copied to clipboard");
        }
      } catch {
        // clipboard access not permitted — ignore
      }
    });

    // Resolve the provider/model — from flags, or an in-TUI picker.
    const sel = opts.initial ?? (await selectProviderModelInTui(otui, r, opts.detected));
    if (sel === undefined) {
      r.destroy();
      return true; // could not select; treat as a clean exit (do not fall back)
    }
    // Persist the chosen provider/model (opencode-style) so the next launch reuses it.
    saveShellConfig(sel.baseUrl === undefined ? { provider: sel.provider, model: sel.model } : { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    // Mutable: `/connect` and `/model` rebuild these mid-session.
    let currentSel: TuiSelection = sel;
    let deps = await opts.makeAgentDeps(sel);

    // opencode-style layout: a main chat column on the left + a right status
    // sidebar (model, context, tools).
    const rootRow = new otui.BoxRenderable(r, { id: "root-row", flexGrow: 1, flexDirection: "row" });
    r.root.add(rootRow);
    const main = new otui.BoxRenderable(r, { id: "main", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    rootRow.add(main);
    const sidebar = new otui.BoxRenderable(r, {
      id: "sidebar",
      width: 30,
      flexShrink: 0,
      flexDirection: "column",
      border: ["left"],
      borderColor: "#22333b",
      paddingLeft: 2,
      paddingRight: 1,
      paddingTop: 1,
    });
    rootRow.add(sidebar);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t`${otui.bold("keryx")}` }));
    sidebar.add(new otui.TextRenderable(r, { id: "sb-model-k", content: otui.t`${otui.dim("Model")}`, marginTop: 1 }));
    const sbModelV = new otui.TextRenderable(r, { id: "sb-model-v", content: otui.t`${otui.dim(`${sel.provider}/${sel.model}`)}` });
    sidebar.add(sbModelV);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-ctx-k", content: otui.t`${otui.dim("Context")}`, marginTop: 1 }));
    const sbContext = new otui.TextRenderable(r, { id: "sb-ctx-v", content: otui.t`${otui.dim("0 tokens")}` });
    sidebar.add(sbContext);
    sidebar.add(new otui.TextRenderable(r, { id: "sb-tools-k", content: otui.t`${otui.dim("Tools")}`, marginTop: 1 }));
    sidebar.add(
      new otui.TextRenderable(r, { id: "sb-tools-v", content: otui.t`${otui.dim(`${deps.tools.length} available`)}` }),
    );
    // Toast area pinned to the bottom of the sidebar (spacer pushes it down).
    sidebar.add(new otui.BoxRenderable(r, { id: "sb-spacer", flexGrow: 1 }));
    const toastText = new otui.TextRenderable(r, { id: "sb-toast", content: "" });
    sidebar.add(toastText);
    // A transient toast: `✓ <msg>`, cleared after 5s or replaced by the next toast.
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    showToast = (msg: string): void => {
      toastText.content = otui.t`${otui.green(`✓ ${msg}`)}`;
      if (toastTimer !== undefined) {
        clearTimeout(toastTimer);
      }
      toastTimer = setTimeout(() => {
        toastText.content = "";
        toastTimer = undefined;
      }, 5000);
    };

    // Header bar (grok-style): identity on the left, cumulative token counter on
    // the right (updated from usage).
    const header = new otui.BoxRenderable(r, {
      id: "header",
      flexShrink: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    const headerLeft = new otui.TextRenderable(r, {
      id: "header-left",
      content: otui.t`${otui.dim(`keryx · agent · ${sel.provider}/${sel.model}`)}`,
    });
    header.add(headerLeft);
    const tokenText = new otui.TextRenderable(r, { id: "header-tokens", content: otui.t`${otui.dim("↑0 ↓0")}` });
    header.add(tokenText);
    main.add(header);

    // A scrollable, sticky-to-bottom transcript so long conversations scroll and
    // auto-follow the newest output; the AgentIO renders into its `.content`.
    const scroll = new otui.ScrollBoxRenderable(r, {
      id: "transcript",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
    });
    main.add(scroll);
    const transcript = scroll.content;

    const io = createTuiAgentIo(otui, r, transcript);
    // Cumulative token usage → the header counter + sidebar. Prefer the provider's
    // EXACT `usage`; fall back to an estimate (see the turn `finally` below) for
    // providers that report nothing (e.g. local Ollama models).
    let totalIn = 0;
    let totalOut = 0;
    let hasExactUsage = false;
    io.onUsage = (u) => {
      if ((u.inputTokens ?? 0) === 0 && (u.outputTokens ?? 0) === 0) {
        return; // a 0/0 report is not usable — keep the estimate
      }
      hasExactUsage = true;
      totalIn += u.inputTokens ?? 0;
      totalOut += u.outputTokens ?? 0;
      tokenText.content = otui.t`${otui.dim(`↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`)}`;
      sbContext.content = otui.t`${otui.dim(`${(totalIn + totalOut).toLocaleString()} tokens`)}`;
    };
    // Reasoning: store the full text (for `/think`) and render a collapsed marker.
    let lastReasoning = "";
    io.onReasoning = (text) => {
      lastReasoning = text;
      const n = text.trim().split("\n").filter((l) => l.trim().length > 0).length;
      transcript.add(
        new otui.TextRenderable(r, {
          id: `th${uid++}`,
          content: otui.t`${otui.dim(`◆ thought (${n} line${n === 1 ? "" : "s"}) · /think to expand`)}`,
        }),
      );
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
      flexShrink: 0,
      height: 10,
      visible: false,
      options: [...AGENT_SLASH_COMMANDS],
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: "#0f1b1b",
      focusedBackgroundColor: "#0f1b1b",
      selectedBackgroundColor: "#22333b",
      textColor: "#c8d0d0",
      focusedTextColor: "#c8d0d0",
      selectedTextColor: "#ffd166",
      descriptionColor: "#6b7a7a",
      selectedDescriptionColor: "#8b9a9a",
    });
    main.add(menu);

    // Bordered composer (grok-style rounded input box) — compact single line.
    const composer = new otui.BoxRenderable(r, {
      id: "composer",
      flexShrink: 0,
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const input = new otui.InputRenderable(r, { id: "prompt", placeholder: "type a task or / for commands" });
    composer.add(input);
    main.add(composer);
    input.focus();

    // Footer: hints on the left, model on the right (grok/opencode style).
    const footer = new otui.BoxRenderable(r, {
      id: "footer",
      flexShrink: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    footer.add(new otui.TextRenderable(r, { id: "footer-left", content: otui.t`${otui.dim("/ commands · Ctrl+C to exit")}` }));
    const footerRight = new otui.TextRenderable(r, { id: "footer-right", content: otui.t`${otui.dim(`${sel.provider}/${sel.model}`)}` });
    footer.add(footerRight);
    main.add(footer);

    // `menuNav` = the `/` dropdown (not the Input) currently owns the keyboard.
    // The dropdown is FOCUSED as soon as it opens, so ↑/↓/Enter work immediately;
    // printable keys / Backspace are re-routed to the composer value (below) so
    // typing still filters live.
    let menuNav = false;
    const refilter = (): void => {
      const matches = filterCommands(input.value);
      if (matches.length > 0 && input.value.startsWith("/")) {
        menu.options = matches;
        menu.visible = true;
        if (!menuNav) {
          menu.focus();
          menuNav = true;
        }
      } else {
        menu.visible = false;
        if (menuNav) {
          menuNav = false;
          input.focus();
        }
      }
    };
    input.on(otui.InputRenderableEvents.INPUT, refilter);

    const helpText = (): string =>
      ["Commands:", ...AGENT_SLASH_COMMANDS.map((c) => `  ${c.name}  ${c.description}`)].join("\n") + "\n";

    const history: NormalizedMessage[] = [];
    let busy = false;

    // `/model` and `/connect` rebuild `deps` mid-session and refresh the labels.
    const updateModelLabels = (): void => {
      const label = `${currentSel.provider}/${currentSel.model}`;
      headerLeft.content = otui.t`${otui.dim(`keryx · agent · ${label}`)}`;
      sbModelV.content = otui.t`${otui.dim(label)}`;
      footerRight.content = otui.t`${otui.dim(label)}`;
    };
    const switchTo = async (ns: TuiSelection): Promise<void> => {
      currentSel = ns;
      deps = await opts.makeAgentDeps(ns);
      saveShellConfig(
        ns.baseUrl === undefined ? { provider: ns.provider, model: ns.model } : { provider: ns.provider, model: ns.model, baseUrl: ns.baseUrl },
      );
      updateModelLabels();
      input.focus();
      showToast(`Switched to ${ns.provider}/${ns.model}`);
    };

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
        if (command.name === "/think") {
          io.onSystem?.(lastReasoning.trim().length > 0 ? `${lastReasoning.trim()}\n` : "No reasoning yet.\n");
          return;
        }
        if (command.name === "/model") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const prov = detected.find((d) => d.name === currentSel.provider);
            // OpenRouter: fetch the live, filterable model list; others use detected.
            const models = currentSel.provider === "openrouter" ? await fetchOpenRouterModels(globalThis.fetch) : (prov?.models ?? []);
            const chosen = await pickModelInTui(otui, r, models);
            if (chosen !== undefined) {
              await switchTo(
                currentSel.baseUrl === undefined
                  ? { provider: currentSel.provider, model: chosen }
                  : { provider: currentSel.provider, model: chosen, baseUrl: currentSel.baseUrl },
              );
            } else {
              input.focus();
            }
          })();
          return;
        }
        if (command.name === "/connect") {
          void (async () => {
            const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;
            const ns = await selectProviderModelInTui(otui, r, detected);
            if (ns !== undefined) {
              await switchTo(ns);
            } else {
              input.focus();
            }
          })();
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
        borderColor: "#3a4a4a", // muted (was bright cyan)
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        alignSelf: "flex-start",
      });
      userBox.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: otui.t`${otui.dim(`❯ ${line}`)}` }));
      transcript.add(userBox);
      transcript.add(
        new otui.TextRenderable(r, {
          id: `h${uid++}`,
          content: otui.t`${otui.cyan("●")} ${otui.bold("keryx")}  ${otui.dim(hhmm())}`,
          marginTop: 1,
        }),
      );
      busy = true;
      const startedAt = Date.now();
      void runAgentTurn(io, deps, history, line).finally(() => {
        busy = false;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        transcript.add(
          new otui.TextRenderable(r, { id: `w${uid++}`, content: otui.t`${otui.dim(`worked for ${secs}s`)}`, marginTop: 1 }),
        );
        // No exact provider usage → show an estimated context size (never stuck at 0).
        if (!hasExactUsage) {
          const est = estimateContextTokens(history);
          tokenText.content = otui.t`${otui.dim(`~${fmtTokens(est)}`)}`;
          sbContext.content = otui.t`${otui.dim(`~${est.toLocaleString()} tokens (est)`)}`;
        }
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
    // The dropdown is FOCUSED from the moment it opens (`refilter`), so the native
    // SelectRenderable handles ↑/↓/Enter immediately. Here we only re-route
    // printable keys / Backspace back into the composer value so typing still
    // filters live, and Esc to close. Runs before the focused menu via onInternal.
    r._internalKeyInput.onInternal("keypress", (key) => {
      if (!menu.visible || !menuNav) {
        return;
      }
      if (key.name === "escape") {
        menu.visible = false;
        menuNav = false;
        input.value = "";
        input.focus();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "backspace") {
        input.value = input.value.slice(0, -1);
        refilter();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      // A printable single character (no modifiers) → append to the filter query.
      const ch = key.sequence;
      if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
        input.value += ch;
        refilter();
        key.preventDefault();
        key.stopPropagation();
      }
      // ↑/↓/Enter fall through → the focused SelectRenderable handles them.
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
