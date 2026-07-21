// Flow 060 — OpenTUI shell Phase 1 headless tests.
//
// Proves the driver → TuiShell → OpenTUI-buffer render path WITHOUT a real TTY:
// a scripted provider is driven through `runAgentTurn` with the `TuiShell`
// `AgentIO` (createTuiAgentIo), then the captured frame is asserted to contain the
// streamed assistant text and a tool line. `@opentui/core` is optional + loaded
// via dynamic import; the tests skip when it is absent.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composerHeightForLines,
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_ROWS,
} from "./shell-chrome";
import {
  attachBlockIo,
  createTuiAgentIo,
  estimateContextTokens,
  fmtTokens,
  isShellApproved,
  onKeypress,
  selectBoxHeight,
  type BlockSink,
} from "./tui-shell";
import {
  createBlockMount,
  createBlockNavController,
  createBlockRegistry,
  createBlockView,
  EVICTED_BLOCK_TEXT,
  type BlockState,
} from "./transcript-blocks";
import { commandsForMode, filterCommands } from "../commands/agent-commands";
import { runAgentTurn } from "../commands/agent";
import type { AgentDeps } from "../commands/agent";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, ProviderDescription } from "../harness/provider/types";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    // SEQUENTIAL, never `Promise.all`: the two entrypoints share a module cycle
    // (`core-slot.ts` extends `Renderable`), and evaluating them concurrently
    // hits the cycle mid-initialization — `Cannot access 'Renderable' before
    // initialization` / `… 'TestWriteStream' …`. Awaiting core first settles it.
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

/**
 * Loaded ONCE, at module scope, so an absent optional dependency SKIPS the
 * renderer tests instead of passing them — the same shape `chat-shell.test.ts`
 * and `shell-chrome.test.ts` already use.
 *
 * Every renderer test below used to `return` early when the dependency was
 * missing, which bun reports as a PASS: on a platform whose prebuilt native
 * binary does not resolve they became silent no-ops and the run still went
 * green. That is fine for a developer, and useless as the per-platform evidence
 * O-3 needs — so the absence is now visible as a skip, which
 * `scripts/opentui-tests-no-skips.ts` turns into a hard CI failure. Flow 114
 * converted the first three; the remaining 13 followed, so `otuiTest` is now
 * the ONLY way a test in this file reaches a renderer.
 */
const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

/** The bundle, inside a body that only runs when it is present. */
function requireOtui(): NonNullable<Awaited<ReturnType<typeof loadOpenTui>>> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without the optional TUI dependency");
  }
  return OTUI;
}

/** Minimal scripted ProviderPort: replays a fixed event list per stream() call. */
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): AgentDeps["provider"] {
  let call = 0;
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
  return {
    describe: () => description,
    stream: (_request, opts) => {
      const events = scripts[call] ?? [];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

let idCounter = 0;
const fixedIdSeq = (): (() => string) => {
  idCounter = 0;
  return () => `id-${idCounter++}`;
};

otuiTest("driver → TuiShell renders streamed assistant text + a tool line (headless)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 20 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, renderer, transcript);

  const provider = scriptedProvider([
    // Round 1: a get_cwd tool call.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    // Round 2: the final answer text.
    [{ kind: "text_delta", text: "Your directory is set." }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };

  await runAgentTurn(io, deps, [], "where am I?");
  await flush();
  const frame = captureCharFrame();
  expect(frame).toContain("Your directory is set."); // streamed assistant text rendered
  expect(frame).toContain("get_cwd"); // tool call line rendered
  renderer.destroy();
});

otuiTest("assistant markdown renders bold/bullets without raw markers (headless, chrome parity)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 12 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, renderer, transcript);
  const provider = scriptedProvider([
    [{ kind: "text_delta", text: "**Bold** text\n- item one" }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "md");
  await flush();
  const frame = captureCharFrame();
  expect(frame).toContain("Bold"); // bold word rendered
  expect(frame).not.toContain("**"); // raw bold markers stripped
  expect(frame).toContain("•"); // bullet glyph rendered
  renderer.destroy();
});

otuiTest("live /-dropdown filters commands as you type (headless reactivity)", async () => {
  const otui = requireOtui();
  const { renderer, mockInput, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 12 });
  const menu = new otui.core.SelectRenderable(renderer, {
    id: "menu",
    width: 80,
    height: 6,
    visible: false,
    options: commandsForMode("agent"),
  });
  renderer.root.add(menu);
  const input = new otui.core.InputRenderable(renderer, { id: "prompt" });
  renderer.root.add(input);
  input.focus();
  input.on(otui.core.InputRenderableEvents.INPUT, () => {
    const matches = filterCommands(input.value, "agent");
    if (matches.length > 0) {
      menu.options = matches;
      menu.visible = true;
    } else {
      menu.visible = false;
    }
  });

  await mockInput.pressKeys(["/", "h"]);
  await flush();
  expect(input.value).toBe("/h");
  expect(menu.visible).toBe(true);
  const frame = captureCharFrame();
  expect(frame).toContain("/help");
  expect(frame).not.toContain("/clear"); // filtered out by the `h` prefix
  renderer.destroy();
});

test("isShellApproved: only explicit y/yes approves (default-deny)", () => {
  expect(isShellApproved("y")).toBe(true);
  expect(isShellApproved("Y")).toBe(true);
  expect(isShellApproved("yes")).toBe(true);
  expect(isShellApproved(" yes ")).toBe(true);
  expect(isShellApproved("n")).toBe(false);
  expect(isShellApproved("no")).toBe(false);
  expect(isShellApproved("")).toBe(false);
  expect(isShellApproved("yep")).toBe(false);
});

test("estimateContextTokens: ~4 chars/token over the history", () => {
  expect(estimateContextTokens([])).toBe(0);
  expect(estimateContextTokens([{ content: "abcd" }])).toBe(1);
  expect(estimateContextTokens([{ content: "a".repeat(400) }, { content: "b".repeat(400) }])).toBe(200);
});

test("fmtTokens: compact K formatting", () => {
  expect(fmtTokens(0)).toBe("0");
  expect(fmtTokens(999)).toBe("999");
  expect(fmtTokens(1000)).toBe("1.0K");
  expect(fmtTokens(1234)).toBe("1.2K");
  expect(fmtTokens(22000)).toBe("22.0K");
});

// The clamp under test is `shell-chrome.ts`'s — the one the shipped chrome's
// `syncComposerHeight` calls. A duplicate used to live in `tui-shell.ts` with no
// production caller left, so this test guarded an orphan.
test("composerHeightForLines: grow 1..6 then clamp (vertical scroll above max)", () => {
  expect(composerHeightForLines(0)).toBe(COMPOSER_MIN_ROWS);
  expect(composerHeightForLines(1)).toBe(1);
  expect(composerHeightForLines(3)).toBe(3);
  expect(composerHeightForLines(6)).toBe(COMPOSER_MAX_ROWS);
  expect(composerHeightForLines(20)).toBe(COMPOSER_MAX_ROWS);
  expect(composerHeightForLines(NaN)).toBe(COMPOSER_MIN_ROWS);
});

test("selectBoxHeight: described items need 2 rows each so all stay visible (flow 084)", () => {
  // Regression: the provider picker showed descriptions (2 rows/item) but was
  // sized `= count`, so `maxVisibleItems = floor(height/2)` hid all but the first.
  // With descriptions, every item must survive floor(height / 2).
  for (const count of [1, 2, 3, 4]) {
    const h = selectBoxHeight(count, true);
    expect(Math.floor(h / 2)).toBeGreaterThanOrEqual(count);
  }
  expect(selectBoxHeight(3, true)).toBe(6); // 3 providers → 6 rows
  // Without descriptions, 1 row per item.
  expect(selectBoxHeight(3, false)).toBe(3);
  expect(Math.floor(selectBoxHeight(4, false) / 1)).toBeGreaterThanOrEqual(4);
  // Capped so a huge list scrolls instead of overflowing the screen.
  expect(selectBoxHeight(100, true)).toBe(16);
  expect(selectBoxHeight(100, true, 8)).toBe(8);
  // Never returns 0 rows for an empty list.
  expect(selectBoxHeight(0, true)).toBe(2);
  expect(selectBoxHeight(0, false)).toBe(1);
});

otuiTest("ScrollBox transcript renders appended content (headless)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 60, height: 10 });
  const scroll = new otui.core.ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column" },
  });
  renderer.root.add(scroll);
  scroll.content.add(new otui.core.TextRenderable(renderer, { id: "line", content: "hello scrollbox" }));
  await flush();
  expect(captureCharFrame()).toContain("hello scrollbox");
  renderer.destroy();
});

otuiTest("content survives a terminal resize (headless)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame, resize } = await otui.testing.createTestRenderer({ width: 60, height: 10 });
  const box = new otui.core.BoxRenderable(renderer, { id: "b", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(box);
  box.add(new otui.core.TextRenderable(renderer, { id: "t", content: "resize me" }));
  await flush();
  expect(captureCharFrame()).toContain("resize me");
  resize(40, 8);
  await flush();
  expect(captureCharFrame()).toContain("resize me"); // survives the resize
  renderer.destroy();
});

otuiTest("OpenTUI Input accepts typed keys (composer primitive)", async () => {
  const otui = requireOtui();
  const { renderer, mockInput } = await otui.testing.createTestRenderer({ width: 70, height: 4 });
  const input = new otui.core.InputRenderable(renderer, { id: "prompt" });
  renderer.root.add(input);
  input.focus();
  await mockInput.pressKeys(["h", "i"]);
  expect(input.value).toBe("hi");
  renderer.destroy();
});

// ===========================================================================
// Flow 109 — collapsible transcript blocks: nav mode, code/diff frames, layout
// ===========================================================================
//
// These drive the SHELL'S OWN objects, not replicas: the real
// `createBlockRegistry` + `createBlockView` + `createBlockNavController`,
// subscribed through the real `onKeypress` wrapper (the same private-keypress
// path `launchTuiAgentShell` uses), inside a layout that mirrors the shell's
// (scrollbox transcript → `/`-menu → composer → footer). `launchTuiAgentShell`
// itself needs a TTY and a provider, so it can never be entered headlessly; the
// nav controller was extracted in T5 precisely so everything below its wiring
// line is reachable here.
//
// `@opentui/core` types are only ever reached STRUCTURALLY, via `loadOpenTui`'s
// inferred return type. A top-level type-only import of the package would trip
// the optional-dependency guard in `src/capability/no-optional-imports`.
// That guard is a regex over file TEXT, so it cannot tell code from prose: do
// not spell the forbidden `import … from "<the package>"` form out in a comment
// here either, or this file fails the guard while containing no such import.

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;
type SpanFrame = ReturnType<TestSetup["captureSpans"]>;

/** The rendered line containing `needle`, or "" — used to pin per-line markers. */
function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

/**
 * OpenTUI's stdin parser holds a lone `\x1b` in its pending buffer for
 * `DEFAULT_TIMEOUT_MS` (20ms on the real clock, `chunk-*.js` → `reconcileTimeoutState`)
 * to tell a bare Esc apart from the START of an escape sequence. `flush()` only
 * awaits a render frame, not wall time, so a `pressEscape()` + `flush()` pair sees
 * nothing at all. Real terminals pay exactly the same 20ms, so waiting it out is a
 * harness timing accommodation — NOT a product workaround.
 */
const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: {
  mockInput: TestSetup["mockInput"];
  flush: TestSetup["flush"];
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/** The rendered lines, trailing blank rows dropped. */
function nonEmptyLines(frame: string): string[] {
  const lines = frame.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The foreground color (as `[r,g,b,a]`) of the span carrying `needle`. */
function fgOf(frame: SpanFrame, needle: string): [number, number, number, number] | undefined {
  for (const line of frame.lines) {
    const span = line.spans.find((s) => s.text.includes(needle));
    if (span !== undefined) {
      return span.fg.toInts();
    }
  }
  return undefined;
}

/**
 * Mount the shell's block wiring headlessly. `schedule` runs inline so the
 * controller's post-layout scroll re-assert is deterministic instead of racing a
 * `setTimeout`; every other port is the real renderable the shell passes.
 *
 * `add` is NOT a replica any more (T6/F3): it is the shell's own `addBlock`
 * composition — the real `createBlockMount` plus `nav.paint` — so a regression
 * in register → mount → paint fails here.
 */
async function mountBlockHarness(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; filler?: number; core?: OtuiBundle["core"] } = {},
): Promise<
  TestSetup & {
    scroll: InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
    textarea: InstanceType<OtuiBundle["core"]["TextareaRenderable"]>;
    menu: InstanceType<OtuiBundle["core"]["SelectRenderable"]>;
    registry: ReturnType<typeof createBlockRegistry>;
    nav: ReturnType<typeof createBlockNavController>;
    add: (input: { kind: string; summary: string; fullText: string }) => string;
    addBlock: BlockSink;
    copied: string[];
    toasts: string[];
    state: { menuNav: boolean; overlay: boolean; composerFocusCalls: number };
    destroy: () => void;
  }
> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 80, height: opts.height ?? 24 });
  const { renderer } = setup;
  const main = new otui.core.BoxRenderable(renderer, { id: "main", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(main);
  const scroll = new otui.core.ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column" },
  });
  main.add(scroll);
  for (let i = 0; i < (opts.filler ?? 0); i++) {
    scroll.content.add(new otui.core.TextRenderable(renderer, { id: `filler${i}`, content: `filler line ${i}` }));
  }
  const menu = new otui.core.SelectRenderable(renderer, {
    id: "menu",
    width: 40,
    height: 4,
    visible: false,
    options: commandsForMode("agent"),
  });
  main.add(menu);
  const composer = new otui.core.BoxRenderable(renderer, {
    id: "composer",
    flexShrink: 0,
    borderStyle: "rounded",
    border: true,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const textarea = new otui.core.TextareaRenderable(renderer, {
    id: "prompt",
    placeholder: "ask keryx",
    wrapMode: "word",
    minHeight: COMPOSER_MIN_ROWS,
    maxHeight: COMPOSER_MAX_ROWS,
    height: COMPOSER_MIN_ROWS,
    width: "100%",
  });
  composer.add(textarea);
  main.add(composer);
  const footer = new otui.core.BoxRenderable(renderer, { id: "footer", flexShrink: 0, flexDirection: "row" });
  footer.add(new otui.core.TextRenderable(renderer, { id: "footer-left", content: "ctrl+o blocks" }));
  main.add(footer);
  textarea.focus();

  const registry = createBlockRegistry();
  // `opts.core` lets a test hand the block views an INSTRUMENTED core (counting
  // wrappers around the real classes) while the surrounding chrome above still
  // uses the genuine one.
  const mount = createBlockMount(opts.core ?? otui.core, renderer, scroll.content, registry);
  const copied: string[] = [];
  const toasts: string[] = [];
  const state = { menuNav: false, overlay: false, composerFocusCalls: 0 };
  const nav = createBlockNavController({
    registry,
    view: (id) => mount.view(id),
    scroll,
    // The shell's own guard expression: `(menu.visible && menuNav) || overlayActive()`.
    isBlocked: () => (menu.visible && state.menuNav) || state.overlay,
    focusComposer: () => {
      state.composerFocusCalls += 1;
      textarea.focus();
    },
    blurComposer: () => textarea.blur(),
    copyText: (text) => {
      copied.push(text);
    },
    toast: (message) => {
      toasts.push(message);
    },
    schedule: (run) => run(),
  });
  const unsubscribe = onKeypress(renderer, nav.handleKey);
  // The shell's own `addBlock` (tui-shell.ts): mount, then paint through nav.
  const addBlock: BlockSink = (input, options = {}) => {
    const id = mount.add(input, options);
    nav.paint(id);
    return id;
  };
  const add = (input: { kind: string; summary: string; fullText: string }): string =>
    addBlock({ ...input, lineCount: input.fullText.split("\n").length }, { hint: "ctrl+o" });

  return {
    ...setup,
    scroll,
    textarea,
    menu,
    registry,
    nav,
    add,
    addBlock,
    copied,
    toasts,
    state,
    destroy: () => {
      unsubscribe();
      renderer.destroy();
    },
  };
}

otuiTest("AC1: the REAL io wiring retains a tool result's full output (headless, through runAgentTurn)", async () => {
  const otui = requireOtui();
  // The shipped path end to end: `createTuiAgentIo` + `attachBlockIo` + the real
  // `createBlockMount`, driven by `runAgentTurn`. No hand-written IO handlers —
  // a wrong field / wrong lineCount / missing fullText in `attachBlockIo` fails
  // here (T6/F3: the previous proof went through a harness replica).
  const root = await mkdtemp(join(tmpdir(), "keryx-tui-blocks-"));
  const body = ["line one", "line two", "line three", "line four"].join("\n");
  await writeFile(join(root, "notes.txt"), body, "utf8");

  const h = await mountBlockHarness(otui, { width: 80, height: 24 });
  const io = createTuiAgentIo(otui.core, h.renderer, h.scroll.content);
  const chrome = { reasoning: 0, calls: 0, results: 0 };
  attachBlockIo(io, h.addBlock, {
    onReasoning: () => {
      chrome.reasoning += 1;
    },
    onToolCall: () => {
      chrome.calls += 1;
    },
    onToolResult: () => {
      chrome.results += 1;
    },
  });

  const provider = scriptedProvider([
    [
      { kind: "reasoning_delta", text: "step one\nstep two" },
      { kind: "tool_call_start", toolCallId: "c1", toolName: "read_file" },
      { kind: "tool_call_end", toolCallId: "c1", input: '{"path":"notes.txt"}' },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(root),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };

  await runAgentTurn(io, deps, [], "read the notes");
  await h.flush();

  const blocks = h.registry.list();
  const output = blocks.find((b) => b.kind === "output");
  const call = blocks.find((b) => b.kind === "tool");
  expect(output).toBeDefined();
  expect(call).toBeDefined();
  if (output === undefined || call === undefined) {
    throw new Error(`no tool blocks registered: ${blocks.map((b) => b.kind).join(",")}`);
  }

  // AC1: the payload the shell used to DISCARD is recoverable after render.
  expect(h.registry.bodyText(output.id)).toBe(body);
  expect(output.lineCount).toBe(4);
  expect(output.summary).toContain("line one"); // collapsed header keeps the preview
  expect(output.collapsed).toBe(true);
  expect(h.registry.bodyText(call.id)).toBe('{"path":"notes.txt"}'); // raw input json
  expect(chrome).toEqual({ reasoning: 1, calls: 1, results: 1 }); // shell chrome still ran

  // …and expanding it through the real nav path paints the retained text.
  h.nav.setCollapsed(output.id, false);
  await h.flush();
  expect(h.captureCharFrame()).toContain("line four");
  h.destroy();
  await rm(root, { recursive: true, force: true });
});

otuiTest("AC3: Ctrl+O enters block-nav, ↑/↓ move focus, Enter expands, y copies, Esc restores the composer", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 80, height: 24 });
  h.add({ kind: "thought", summary: "alpha-summary", fullText: "ALPHA-BODY" });
  const beta = h.add({ kind: "tool", summary: "beta-summary", fullText: "BETA-BODY" });
  h.add({ kind: "output", summary: "gamma-summary", fullText: "GAMMA-BODY" });
  await h.flush();

  const idle = h.captureCharFrame();
  expect(idle).toContain("▸ tool"); // every block starts collapsed
  expect(idle).toContain("beta-summary");
  expect(idle).not.toContain("❯"); // no focus marker outside nav mode
  expect(h.nav.active()).toBe(false);
  expect(h.textarea.focused).toBe(true);

  // Ctrl+O — enter nav mode.
  h.mockInput.pressKey("o", { ctrl: true });
  await h.flush();
  const navFrame = h.captureCharFrame();
  expect(h.nav.active()).toBe(true);
  expect(navFrame).not.toBe(idle); // the rendered frame changed
  expect(h.registry.focused()?.summary).toBe("gamma-summary"); // newest block focused
  expect(lineWith(navFrame, "gamma-summary")).toContain("❯");
  expect(h.textarea.focused).toBe(false); // composer lost focus

  // ↑ moves focus to the previous block, ↓ back to the newest.
  h.mockInput.pressArrow("up");
  await h.flush();
  expect(h.registry.focused()?.id).toBe(beta);
  expect(lineWith(h.captureCharFrame(), "beta-summary")).toContain("❯");
  expect(lineWith(h.captureCharFrame(), "gamma-summary")).not.toContain("❯");

  h.mockInput.pressArrow("down");
  await h.flush();
  expect(h.registry.focused()?.summary).toBe("gamma-summary");
  h.mockInput.pressArrow("up");
  await h.flush();
  expect(h.registry.focused()?.id).toBe(beta);

  // Enter toggles the FOCUSED block only.
  h.mockInput.pressEnter();
  await h.flush();
  const expanded = h.captureCharFrame();
  expect(h.registry.get(beta)?.collapsed).toBe(false);
  expect(expanded).toContain("BETA-BODY"); // body rendered
  expect(expanded).toContain("▾ tool"); // expanded marker
  expect(expanded).toContain("▸ thought"); // AC2: the others stayed collapsed
  expect(expanded).not.toContain("ALPHA-BODY");

  // Space toggles it back (the second binding).
  h.mockInput.pressKey(" ");
  await h.flush();
  expect(h.registry.get(beta)?.collapsed).toBe(true);
  expect(h.captureCharFrame()).not.toContain("BETA-BODY");

  // `y` copies the focused block's retained text (AC6).
  h.mockInput.pressKey("y");
  await h.flush();
  expect(h.copied).toEqual(["BETA-BODY"]);
  expect(h.toasts).toContain("Copied to clipboard");

  // Esc exits and hands the keyboard back to the composer.
  await pressEscapeAndSettle(h);
  expect(h.nav.active()).toBe(false);
  expect(h.textarea.focused).toBe(true);
  expect(h.captureCharFrame()).not.toContain("❯");
  h.destroy();
});

// --- repaint cost (the flow-109 review finding deferred out of its fix pass) --
//
// The finding: `render()` rebuilt the body on EVERY paint and `moveFocus` painted
// every block, so one `↑`/`↓` destroyed and rebuilt the renderables of — and
// re-parsed up to `MAX_BODY_LINES` of markdown for — every expanded block.
// Counting renderable construction and diff colouring measures exactly that: the
// blocks are given a DIFF payload, and `green` is only ever reached from
// `diffChunks`, never from the header, so a re-parse cannot hide.

/** The real core with renderable construction + diff colouring counted. */
function countingCore(otui: OtuiBundle): {
  core: OtuiBundle["core"];
  counts: { boxes: number; texts: number; greens: number };
} {
  const counts = { boxes: 0, texts: 0, greens: 0 };
  class CountingBox extends otui.core.BoxRenderable {
    constructor(...args: ConstructorParameters<OtuiBundle["core"]["BoxRenderable"]>) {
      super(...args);
      counts.boxes += 1;
    }
  }
  class CountingText extends otui.core.TextRenderable {
    constructor(...args: ConstructorParameters<OtuiBundle["core"]["TextRenderable"]>) {
      super(...args);
      counts.texts += 1;
    }
  }
  const core = {
    ...otui.core,
    BoxRenderable: CountingBox,
    TextRenderable: CountingText,
    green: (text: Parameters<OtuiBundle["core"]["green"]>[0]) => {
      counts.greens += 1;
      return otui.core.green(text);
    },
  } as unknown as OtuiBundle["core"];
  return { core, counts };
}

const DIFF_BODY = ["@@ -1,2 +1,2 @@", "-old line", "+new line one", "+new line two"].join("\n");

otuiTest("entering nav mode and moving focus repaint the highlight WITHOUT rebuilding any expanded body", async () => {
  const otui = requireOtui();
  const { core, counts } = countingCore(otui);
  const h = await mountBlockHarness(otui, { width: 80, height: 24, core });
  const first = h.add({ kind: "output", summary: "first-summary", fullText: DIFF_BODY });
  const second = h.add({ kind: "output", summary: "second-summary", fullText: DIFF_BODY });
  h.nav.setCollapsed(first, false);
  h.nav.setCollapsed(second, false);
  await h.flush();
  expect(h.captureCharFrame()).toContain("+new line one"); // both bodies really are expanded
  const mounted = { ...counts };
  expect(mounted.greens).toBeGreaterThan(0); // the diff payload was colourised once

  // Ctrl+O paints every block (the focus highlight has to appear somewhere) —
  // headers only: no renderable is built and no body is re-parsed.
  h.mockInput.pressKey("o", { ctrl: true });
  await h.flush();
  expect(counts).toEqual(mounted);
  expect(lineWith(h.captureCharFrame(), "second-summary")).toContain("❯");

  // …and neither does a run of focus moves over two expanded blocks.
  for (const direction of ["up", "down", "up", "down"] as const) {
    h.mockInput.pressArrow(direction);
    await h.flush();
  }
  expect(counts).toEqual(mounted);

  // The highlight still moved for real, and both bodies are still on screen —
  // so the counters above are not just measuring a repaint that never happened.
  expect(h.registry.focused()?.id).toBe(second);
  expect(lineWith(h.captureCharFrame(), "second-summary")).toContain("❯");
  expect(lineWith(h.captureCharFrame(), "first-summary")).not.toContain("❯");
  expect(h.captureCharFrame()).toContain("+new line one");

  // A collapse → expand cycle DOES rebuild — exactly one frame and one text child
  // for the one block that changed, not for both.
  h.mockInput.pressEnter();
  await h.flush();
  expect(h.registry.get(second)?.collapsed).toBe(true);
  expect(counts.boxes).toBe(mounted.boxes);
  h.mockInput.pressEnter();
  await h.flush();
  expect(h.registry.get(second)?.collapsed).toBe(false);
  expect(counts.boxes).toBe(mounted.boxes + 1);
  expect(counts.texts).toBe(mounted.texts + 1);
  h.destroy();
});

otuiTest("a repaint whose body text CHANGED (an eviction) repaints in place, keeping the mounted renderables", async () => {
  const otui = requireOtui();
  const { core, counts } = countingCore(otui);
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 12 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const state: BlockState = {
    id: "blk1",
    kind: "output",
    summary: "s",
    fullText: DIFF_BODY,
    lineCount: 4,
    collapsed: false,
    retained: true,
    truncated: false,
  };
  const view = createBlockView(core, renderer, transcript, state, { hint: "ctrl+o" });

  view.render(state, { body: DIFF_BODY });
  await flush();
  expect(captureCharFrame()).toContain("+new line one");
  const built = { ...counts };

  // Same text again — the cheap path: nothing built, nothing re-coloured.
  view.render(state, { body: DIFF_BODY });
  await flush();
  expect(counts).toEqual(built);

  // Retention drops the payload: the marker must replace it, and the SAME frame
  // and text renderable carry it (a content swap, not a rebuild).
  view.render({ ...state, retained: false, fullText: undefined }, { body: EVICTED_BLOCK_TEXT });
  await flush();
  expect(counts.boxes).toBe(built.boxes);
  expect(counts.texts).toBe(built.texts);
  expect(captureCharFrame()).toContain(EVICTED_BLOCK_TEXT);
  expect(captureCharFrame()).not.toContain("+new line one");
  view.destroy();
  renderer.destroy();
});

otuiTest("AC4: nav keys stay inert while the /-menu or an overlay owns the keyboard, and a turn ending mid-nav keeps focus", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 80, height: 24 });
  h.add({ kind: "tool", summary: "first-summary", fullText: "FIRST-BODY" });
  h.add({ kind: "output", summary: "second-summary", fullText: "SECOND-BODY" });
  await h.flush();

  // (a) the `/` dropdown is open in nav state — Ctrl+O must not fire.
  h.menu.visible = true;
  h.state.menuNav = true;
  await h.flush();
  const blockedFrame = h.captureCharFrame();
  h.mockInput.pressKey("o", { ctrl: true });
  await h.flush();
  expect(h.nav.active()).toBe(false);
  expect(h.captureCharFrame()).toBe(blockedFrame);
  h.menu.visible = false;
  h.state.menuNav = false;

  // (b) a picker/approval overlay is up — same.
  h.state.overlay = true;
  h.mockInput.pressKey("o", { ctrl: true });
  await h.flush();
  expect(h.nav.active()).toBe(false);
  h.state.overlay = false;

  // (c) nav mode is entered, then a turn completes underneath it.
  h.mockInput.pressKey("o", { ctrl: true });
  await h.flush();
  expect(h.nav.active()).toBe(true);
  const focusedId = h.registry.focused()?.id ?? "";
  const focusCalls = h.state.composerFocusCalls;

  // The shell's turn-end refocus + a late tool-result block arriving.
  h.nav.restoreComposerFocus();
  h.add({ kind: "output", summary: "late-summary", fullText: "LATE-BODY" });
  await h.flush();
  expect(h.state.composerFocusCalls).toBe(focusCalls); // focus NOT yanked back
  expect(h.textarea.focused).toBe(false);
  expect(h.nav.active()).toBe(true);
  expect(h.registry.focused()?.id).toBe(focusedId); // and focus did not move

  // Keys still reach nav mode after the turn ended.
  h.mockInput.pressEnter();
  await h.flush();
  expect(h.registry.get(focusedId)?.collapsed).toBe(false);

  // Once nav mode exits, the same turn-end path DOES refocus the composer.
  await pressEscapeAndSettle(h);
  h.nav.restoreComposerFocus();
  expect(h.state.composerFocusCalls).toBeGreaterThan(focusCalls);
  expect(h.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("AC5: a ```ts fence renders as a framed block whose header carries the language tag (headless)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 20 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, renderer, transcript);
  const provider = scriptedProvider([
    [
      { kind: "text_delta", text: "Try this:\n```ts\nconst a = 1;\nexport default a;\n```\ndone" },
      { kind: "model_end" },
    ],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };

  await runAgentTurn(io, deps, [], "code please");
  await flush();
  const frame = captureCharFrame();
  expect(frame).toContain("ts · 2 lines"); // language tag + line count in the frame header
  expect(frame).toContain("const a = 1;"); // fenced body rendered
  expect(frame).toContain("Try this:"); // surrounding prose still rendered
  expect(frame).not.toContain("```"); // fence lines consumed, never printed
  renderer.destroy();
});

otuiTest("AC7: diff add/del/hunk lines get distinct span colors and a bullet list is not misread as a diff", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 80, height: 24 });
  const diff = h.add({
    kind: "output",
    summary: "diff-summary",
    fullText: "@@ -1,3 +1,3 @@\n-removed line\n+added line\n kept line",
  });
  const bullets = h.add({ kind: "output", summary: "list-summary", fullText: "- first bullet\n- second bullet" });
  h.nav.setCollapsed(diff, false);
  h.nav.setCollapsed(bullets, false);
  await h.flush();

  const spans = h.captureSpans();
  const add = fgOf(spans, "+added line");
  const del = fgOf(spans, "-removed line");
  const hunk = fgOf(spans, "@@ -1,3 +1,3 @@");
  const bullet = fgOf(spans, "first bullet");
  expect(add).toBeDefined();
  expect(del).toBeDefined();
  expect(hunk).toBeDefined();
  expect(bullet).toBeDefined();
  if (add === undefined || del === undefined || hunk === undefined || bullet === undefined) {
    throw new Error("diff lines were not rendered");
  }

  // Green dominates an addition, red a deletion, and the hunk header is cyan
  // (low red, high green+blue). Asserted on the actual foreground color, not on
  // a substring: a plain-text check would pass even with no styling at all.
  expect(add[1]).toBeGreaterThan(add[0]);
  expect(add[1]).toBeGreaterThan(add[2]);
  expect(del[0]).toBeGreaterThan(del[1]);
  expect(del[0]).toBeGreaterThan(del[2]);
  expect(hunk[0]).toBeLessThan(hunk[1]);
  expect(hunk[0]).toBeLessThan(hunk[2]);
  expect(add).not.toEqual(del);
  expect(add).not.toEqual(hunk);
  expect(del).not.toEqual(hunk);

  // AC7 negative: `- ` bullets render as markdown bullets, never as deletions.
  expect(h.captureCharFrame()).toContain("• first bullet");
  expect(h.captureCharFrame()).not.toContain("- first bullet");
  expect(bullet).not.toEqual(del);
  h.destroy();
});

otuiTest("AC11: expanding a large block then resizing never pushes the composer or footer off-screen (flow-075 regression)", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 80, height: 20 });
  const big = h.add({
    kind: "output",
    summary: "big-summary",
    fullText: Array.from({ length: 120 }, (_, i) => `payload line ${i}`).join("\n"),
  });
  h.textarea.setText("draft prompt");
  h.nav.setCollapsed(big, false);
  await h.flush();
  expect(h.captureCharFrame()).toContain("payload line 0"); // the block really expanded

  for (const [width, height] of [
    [80, 20],
    [50, 12],
    [120, 30],
    [40, 8],
  ] as const) {
    h.resize(width, height);
    await h.flush();
    const at = `${width}x${height}`;
    const frame = h.captureCharFrame();
    const lines = nonEmptyLines(frame);

    // THE flow-075 guarantee: a 120-line expanded block does not shove the chrome
    // out of the viewport. The footer is the last row, and the composer's rounded
    // box occupies exactly the three rows directly above it.
    expect(`${at}: ${lines[lines.length - 1]?.includes("ctrl+o blocks")}`).toBe(`${at}: true`);
    expect(`${at}: ${lines[lines.length - 2]?.startsWith("╰")}`).toBe(`${at}: true`);
    expect(`${at}: ${lines[lines.length - 4]?.startsWith("╭")}`).toBe(`${at}: true`);
    // The composer keeps its draft across every resize.
    expect(`${at}: ${h.textarea.plainText}`).toBe(`${at}: draft prompt`);

    // The draft also renders — except at the one scroll offset where @opentui/core
    // bleeds a bordered child's bottom border over the composer's interior row.
    // That defect is upstream and reproduces with zero flow-109 code; it is pinned
    // by "known @opentui/core defect …" below, which will fail loudly once fixed.
    if (h.scroll.scrollTop !== 2) {
      expect(`${at}: ${frame.includes("draft prompt")}`).toBe(`${at}: true`);
    }
  }
  h.destroy();
});

otuiTest("known @opentui/core defect: a bordered child in a ScrollBox at scrollTop===2 overdraws the row below the viewport", async () => {
  const otui = requireOtui();
  // Built from PURE OpenTUI primitives — no flow-109 code — so this pins the
  // upstream bug rather than our layout. `createBlockView` renders an expanded
  // body as a bordered box inside the transcript ScrollBox, so it inherits the
  // defect: at exactly scrollTop 2 the frame's bottom border is painted one row
  // past the clip, over the composer's interior row ("│─draft─prompt─────╯").
  // Neither `overflow:"hidden"` (on the scrollbox, its content, the child, or the
  // column parent) nor a forced repaint suppresses it, and it is a pure function
  // of the offset: 0/1/3 are clean, 2 is not.
  // WHEN THIS TEST FAILS, the upstream fix has landed — delete it and drop the
  // `scrollTop !== 2` carve-out in the AC11 test above.
  const observed: Record<number, boolean> = {};
  for (const headerLines of [0, 1, 2, 3]) {
    const { renderer, flush, captureCharFrame, resize } = await otui.testing.createTestRenderer({
      width: 80,
      height: 20,
    });
    const main = new otui.core.BoxRenderable(renderer, { id: "main", flexGrow: 1, flexDirection: "column" });
    renderer.root.add(main);
    const scroll = new otui.core.ScrollBoxRenderable(renderer, {
      id: "transcript",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" },
    });
    main.add(scroll);
    const composer = new otui.core.BoxRenderable(renderer, {
      id: "composer",
      flexShrink: 0,
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const textarea = new otui.core.TextareaRenderable(renderer, {
      id: "prompt",
      wrapMode: "word",
      minHeight: COMPOSER_MIN_ROWS,
      maxHeight: COMPOSER_MAX_ROWS,
      height: COMPOSER_MIN_ROWS,
      width: "100%",
    });
    composer.add(textarea);
    main.add(composer);
    main.add(new otui.core.TextRenderable(renderer, { id: "footer", content: "ctrl+o blocks" }));
    textarea.setText("draft prompt");

    const outer = new otui.core.BoxRenderable(renderer, {
      id: "outer",
      flexDirection: "column",
      flexShrink: 0,
      alignSelf: "flex-start",
    });
    for (let i = 0; i < headerLines; i++) {
      outer.add(new otui.core.TextRenderable(renderer, { id: `hdr${i}`, content: `header ${i}` }));
    }
    scroll.content.add(outer);
    const frameBox = new otui.core.BoxRenderable(renderer, {
      id: "frame",
      flexDirection: "column",
      flexShrink: 0,
      alignSelf: "flex-start",
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    frameBox.add(
      new otui.core.TextRenderable(renderer, {
        id: "ft",
        content: Array.from({ length: 120 }, (_, i) => `payload line ${i}`).join("\n"),
      }),
    );
    outer.add(frameBox);

    await flush();
    resize(40, 8);
    await flush();
    observed[scroll.scrollTop] = captureCharFrame().includes("draft prompt");
    renderer.destroy();
  }

  // One header line per offset, so the sweep lands on 0..3.
  expect(Object.keys(observed).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  expect(observed[0]).toBe(true);
  expect(observed[1]).toBe(true);
  expect(observed[2]).toBe(false); // ← the defect
  expect(observed[3]).toBe(true);
});

otuiTest("AC12: expanding a non-newest block preserves the scroll offset instead of jumping to the bottom", async () => {
  const otui = requireOtui();
  // 40 filler lines in a 14-row viewport, so the transcript is genuinely scrolled.
  const h = await mountBlockHarness(otui, { width: 60, height: 14, filler: 40 });
  const older = h.add({
    kind: "output",
    summary: "older-summary",
    fullText: Array.from({ length: 30 }, (_, i) => `older body ${i}`).join("\n"),
  });
  const newest = h.add({ kind: "output", summary: "newest-summary", fullText: "NEWEST-BODY" });
  await h.flush();

  const before = h.scroll.scrollTop;
  const heightBefore = h.scroll.scrollHeight;
  expect(before).toBeGreaterThan(0); // sticky-bottom really did scroll

  h.nav.setCollapsed(older, false);
  await h.flush();

  // The content grew (so a bottom-follow WOULD have moved the viewport) …
  expect(h.scroll.scrollHeight).toBeGreaterThan(heightBefore);
  // … and the offset is exactly where it was, with sticky scroll suspended (D-5).
  expect(h.scroll.scrollTop).toBe(before);
  expect(h.scroll.stickyScroll).toBe(false);

  // Control: expanding the NEWEST block keeps sticky-follow, so new output
  // still scrolls into view.
  h.scroll.stickyScroll = true;
  await h.flush();
  const bottom = h.scroll.scrollTop;
  h.nav.setCollapsed(newest, false);
  await h.flush();
  expect(h.scroll.stickyScroll).toBe(true);
  expect(h.scroll.scrollTop).toBeGreaterThanOrEqual(bottom);
  h.destroy();
});

