// Flow 060 — OpenTUI shell Phase 1 headless tests.
//
// Proves the driver → TuiShell → OpenTUI-buffer render path WITHOUT a real TTY:
// a scripted provider is driven through `runAgentTurn` with the `TuiShell`
// `AgentIO` (createTuiAgentIo), then the captured frame is asserted to contain the
// streamed assistant text and a tool line. `@opentui/core` is optional + loaded
// via dynamic import; the tests skip when it is absent.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composerHeightForLines,
  createShellChrome,
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_ROWS,
  SIDEBAR_TEXT_WIDTH,
} from "./shell-chrome";
import {
  applyRuntimeSwitchToSlate,
  attachBlockIo,
  attachUsageIo,
  createTuiAgentIo,
  estimateContextTokens,
  fmtTokens,
  isShellApproved,
  mountCwdPanel,
  resolveSidebarMetadata,
  onKeypress,
  pickShellApproval,
  pickSearchProviderStep,
  adaptiveSelectHeight,
  selectBoxHeight,
  filterConnectedDetectedProviders,
  searchProviderWizardInTui,
  selectSearchProviderAndReport,
  shortenCwd,
  type BlockSink,
} from "./tui-shell";
import {
  appendUserEcho,
  createBlockMount,
  createBlockNavController,
  createBlockRegistry,
  createBlockView,
  createSegmentView,
  EVICTED_BLOCK_TEXT,
  MAX_THOUGHT_LINES,
  type BlockState,
} from "./transcript-blocks";
import { hugWidth } from "../lib/md-blocks";
import { commandsForMode, filterCommands } from "../commands/agent-commands";
import { runAgentTurn } from "../commands/agent";
import type { AgentDeps } from "../commands/agent";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription } from "../harness/provider/types";
import type { DetectedProvider } from "../commands/select";
import { readSlate, writeSlate } from "../session/slate";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import type {
  SearchConnectionResult,
  SearchProviderController,
  SearchProviderDescriptor,
  SearchProviderId,
  SearchSelectionResult,
} from "../harness/search";
import type { SearchFieldDescriptor } from "../harness/search/types";

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

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 400): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createMockFetch(
  impl: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  const mocked: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => impl(input, init),
    {
      preconnect: async () => {},
    },
  );
  return mocked;
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
test("composerHeightForLines: grow then clamp (vertical scroll above max)", () => {
  expect(composerHeightForLines(0)).toBe(COMPOSER_MIN_ROWS);
  expect(composerHeightForLines(1)).toBe(1);
  expect(composerHeightForLines(3)).toBe(3);
  expect(composerHeightForLines(6)).toBe(COMPOSER_MAX_ROWS);
  expect(composerHeightForLines(20)).toBe(COMPOSER_MAX_ROWS);
  expect(composerHeightForLines(20, 8)).toBe(8);
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

test("adaptiveSelectHeight: grows to available for a big list, min 1/4 of parent, never overflows", () => {
  // Small list: fills to its content size, but at least 1/4 of the available height.
  expect(adaptiveSelectHeight(1, 24)).toBe(Math.floor(24 / 4)); // min = 6
  expect(adaptiveSelectHeight(3, 24, 1)).toBe(6); // min dominates (3 < 6)
  // List taller than 1/4: grows with content.
  expect(adaptiveSelectHeight(10, 24)).toBe(10);
  // Huge list: capped at the full available height (scrolls within it).
  expect(adaptiveSelectHeight(500, 24)).toBe(24);
  // per=2 (described items) doubles content rows, still capped at available.
  expect(adaptiveSelectHeight(100, 40, 2)).toBe(40);
  expect(adaptiveSelectHeight(6, 40, 2)).toBe(12);
  // Never overflows available even with degenerate inputs.
  expect(adaptiveSelectHeight(1000, 10)).toBe(10);
  expect(adaptiveSelectHeight(0, 10)).toBe(2); // min 1/4 of 10 = 2, never 0
});

test("filterConnectedDetectedProviders: keeps only providers with valid, successful credentials", async () => {
  const detected: DetectedProvider[] = [
    { name: "deepseek", models: ["deepseek-chat"], envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
    { name: "rapid-mlx", models: ["qwen3.5-9b-4bit"], baseUrl: "http://127.0.0.1:8010" },
    { name: "openrouter", models: ["openai/gpt-4o-mini"], envKey: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api" },
  ];

  const connected = await filterConnectedDetectedProviders(detected, {
    env: { DEEPSEEK_API_KEY: "good", OPENROUTER_API_KEY: "also-good" },
    fetch: createMockFetch((input) => {
      const hasDeepseek = `${input}`.includes("deepseek");
      const liveModels = hasDeepseek ? ["deepseek-reasoner"] : ["openrouter/gpt-4o"];
      return Promise.resolve(jsonResponse({ data: liveModels.map((id) => ({ id })) }));
    }),
  });

  expect(connected.map((provider) => provider.name).sort()).toEqual(["deepseek", "openrouter", "rapid-mlx"]);
});

test("filterConnectedDetectedProviders: excludes key-required providers when key is missing", async () => {
  const detected: DetectedProvider[] = [
    { name: "deepseek", models: ["deepseek-chat"], envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
  ];

  const connected = await filterConnectedDetectedProviders(detected, {
    env: {},
    fetch: createMockFetch(() => {
      return Promise.resolve(jsonResponse({ data: [{ id: "deepseek-chat" }] }));
    }),
  });

  expect(connected).toEqual([]);
});

test("filterConnectedDetectedProviders: excludes local providers when the live probe fails", async () => {
  const detected: DetectedProvider[] = [
    { name: "rapid-mlx", models: ["qwen3.5-9b-4bit"], baseUrl: "http://127.0.0.1:8010" },
  ];

  const connected = await filterConnectedDetectedProviders(detected, {
    env: {},
    fetch: createMockFetch(() => Promise.resolve(jsonResponse({ error: "down" }, false, 503))),
  });

  expect(connected).toEqual([]);
});

test("filterConnectedDetectedProviders: excludes key-required providers when live models fail", async () => {
  const detected: DetectedProvider[] = [
    { name: "deepseek", models: ["deepseek-chat"], envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
  ];

  const connected = await filterConnectedDetectedProviders(detected, {
    env: { DEEPSEEK_API_KEY: "bad" },
    fetch: createMockFetch(() => {
      return Promise.resolve(jsonResponse({ error: "invalid key" }, false, 401));
    }),
  });

  expect(connected).toEqual([]);
});

// --- gap G-2: the working directory is visible on the default surface --------

test("shortenCwd: $HOME collapses, a path that fits is untouched", () => {
  // $HOME → `~`, the same spelling the readline header uses (shared collapseHome).
  expect(shortenCwd(`${homedir()}/goodea/keryx`, 26)).toBe("~/goodea/keryx");
  // Outside $HOME and inside the budget: returned verbatim, no marker added.
  expect(shortenCwd("/etc/hosts", 26)).toBe("/etc/hosts");
  // Exactly at the budget is still a fit — 26 chars, no truncation.
  expect(shortenCwd("/aaaaaaaa/bbbbbbbb/cccccccc", 27)).toBe("/aaaaaaaa/bbbbbbbb/cccccccc");
});

test("shortenCwd: an overlong path drops LEADING segments and keeps the tail", () => {
  const long = "/Users/someone/work/clients/acme/services/api/src";
  const short = shortenCwd(long, 26);
  expect(short.length).toBeLessThanOrEqual(26);
  // The tail identifies the directory, so it must survive intact…
  expect(short.endsWith("/api/src")).toBe(true);
  // …and the head, which does not, is what gets spent.
  expect(short.startsWith("…/")).toBe(true);
  expect(short).not.toContain("Users");
  // Whole segments are dropped, never cut mid-name: every retained segment is a
  // real segment of the input.
  for (const seg of short.split("/").slice(1)) {
    expect(long.split("/")).toContain(seg);
  }
  // The budget is spent greedily — one more segment would not have fit.
  expect(`…/clients/${short.slice(2)}`.length).toBeGreaterThan(26);
});

test("shortenCwd: a pathological single long segment keeps its own tail", () => {
  // No separator to cut at, so the segment itself is truncated from the left.
  const single = `/${"z".repeat(80)}tail`;
  const short = shortenCwd(single, 26);
  expect(short.length).toBe(26);
  expect(short.startsWith("…")).toBe(true);
  expect(short.endsWith("tail")).toBe(true);
  // Degenerate budgets never overflow and never throw.
  expect(shortenCwd("/some/where", 1)).toBe("…");
  expect(shortenCwd("/some/where", 0)).toBe("");
  expect(shortenCwd("/some/where", -5)).toBe("");
});

otuiTest("G-2: the shipped sidebar shows the working directory, tail-first and unclipped", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · agent",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  // The SHIPPED panel and the SHIPPED budget — not a replica.
  //
  // This cwd sits ON the boundary deliberately: at the correct budget the
  // greediest fit is exactly 26 chars, and at the next segment out it is 29 — so
  // a budget that forgot the sidebar's border and padding (30) would pick the
  // 29-char form, which the 26-column column cannot render. A path whose
  // shortening happens to be identical at 26 and 30 would let a wrong budget
  // through, which is precisely what an earlier draft of this test did.
  const cwd = "/Users/someone/cc/aaaaaaaaaa/bbbbbbbbb/src";
  mountCwdPanel(otui.core, setup.renderer, chrome.sidebarTop, cwd);
  await setup.flush();
  const frame = setup.captureCharFrame();

  expect(frame).toContain("Directory"); // the panel label
  const expected = shortenCwd(cwd, SIDEBAR_TEXT_WIDTH);
  expect(expected).toBe("…/aaaaaaaaaa/bbbbbbbbb/src");
  expect(expected.length).toBe(SIDEBAR_TEXT_WIDTH); // exactly fills the column
  // Present in full: a value shortened to a wrong budget is cut off by the
  // layout, and this fails.
  expect(frame).toContain(expected);
  expect(expected.endsWith("/src")).toBe(true);
  // …and on ONE row: a value over budget wraps into a second sidebar line
  // (measured: `…/cc/aaaaaaaaaa/bbbbbbbbb/` + `src`), which is the visible
  // symptom `toContain` above rejects.
  const rows = frame.split("\n").filter((line) => line.includes("…/") || line.includes("/src"));
  expect(rows.length).toBe(1);
  // The sidebar CELL — everything right of the column's border rule — stays
  // inside the text budget.
  const cell = rows[0]?.slice((rows[0]?.lastIndexOf("│") ?? -1) + 1) ?? "";
  expect(cell.trim().length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);

  chrome.destroy();
  setup.renderer.destroy();
});

test("resolveSidebarMetadata reads branch via the injected git runner", () => {
  const git = (args: string[], _cwd: string): string | undefined => {
    if (args[0] === "rev-parse") {
      return "feature/sidebar-ui";
    }
    return undefined;
  };
  expect(resolveSidebarMetadata("/tmp/unused", git).branch).toBe("feature/sidebar-ui");
  expect(resolveSidebarMetadata("/tmp/unused", () => undefined).branch).toBeUndefined();
  expect(resolveSidebarMetadata("/tmp/unused", () => "HEAD").branch).toBeUndefined();
});

otuiTest("G-2: the shipped sidebar shows the current git branch", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · agent",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  try {
    mountCwdPanel(otui.core, setup.renderer, chrome.sidebarTop, "/tmp/keryx-unused", {
      branch: "feature/sidebar-ui",
    });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Directory");
    expect(frame).toContain("Branch");
    expect(frame).toContain("feature/sidebar-ui");
    expect(frame).not.toContain("https://github.com/");
  } finally {
    chrome.destroy();
    setup.renderer.destroy();
  }
});

// --- gap G-1: per-turn AND cumulative usage, not one instead of the other ----

otuiTest("G-1: attachUsageIo keeps the per-turn line AND adds the cumulative counter", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · agent",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
    headerMeta: "↑0 ↓0",
  });
  // The real composition the shell installs: the base IO, then the wrapper, with
  // both sinks pointed at real renderables so ONE frame shows both readings.
  const io = createTuiAgentIo(otui.core, setup.renderer, chrome.transcript);
  const sbContext = new otui.core.TextRenderable(setup.renderer, { id: "sb-ctx-v", content: "0 tokens" });
  chrome.sidebarTop.add(sbContext);
  let exactSeen = 0;
  attachUsageIo(io, {
    setHeaderMeta: (text) => chrome.setHeaderMeta(text),
    setContextTotal: (total) => {
      sbContext.content = `${total.toLocaleString()} tokens`;
    },
    onExactUsage: () => {
      exactSeen += 1;
    },
  });

  const provider = scriptedProvider([
    [
      { kind: "usage_update", usage: { inputTokens: 1200, outputTokens: 34 } },
      { kind: "text_delta", text: "done" },
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
  await runAgentTurn(io, deps, [], "cost?");
  await setup.flush();
  const frame = setup.captureCharFrame();

  // Per-turn: what THIS turn cost, exact numbers, in the transcript (flow 050).
  expect(frame).toContain("↑1200 ↓34 tokens");
  // Cumulative: the session's context budget, compacted, in the header + sidebar.
  expect(frame).toContain("↑1.2K ↓34");
  expect(frame).toContain("1,234 tokens");
  expect(exactSeen).toBe(1);

  chrome.destroy();
  setup.renderer.destroy();
});

otuiTest("G-1: a 0/0 usage report prints no per-turn line and does not retire the estimate", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · agent",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  const io = createTuiAgentIo(otui.core, setup.renderer, chrome.transcript);
  const metas: string[] = [];
  let exactSeen = 0;
  attachUsageIo(io, {
    setHeaderMeta: (text) => metas.push(text),
    setContextTotal: () => {},
    onExactUsage: () => {
      exactSeen += 1;
    },
  });

  const provider = scriptedProvider([
    [
      { kind: "usage_update", usage: { inputTokens: 0, outputTokens: 0 } },
      { kind: "text_delta", text: "done" },
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
  await runAgentTurn(io, deps, [], "cost?");
  await setup.flush();

  // The guard runs AHEAD of the call-through, so a useless `↑0 ↓0 tokens` line
  // is never appended and the shell's estimate fallback still applies.
  expect(setup.captureCharFrame()).not.toContain("tokens");
  expect(metas).toEqual([]);
  expect(exactSeen).toBe(0);

  chrome.destroy();
  setup.renderer.destroy();
});

// A provider that reports only one side must not print `↓undefined`: that guard
// lives in the BASE hook, and wrapping has to leave it intact.
otuiTest("G-1: wrapping preserves the base hook's report-only-what-you-got guard", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const transcript = new otui.core.BoxRenderable(setup.renderer, {
    id: "transcript",
    flexGrow: 1,
    flexDirection: "column",
  });
  setup.renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, setup.renderer, transcript);
  attachUsageIo(io, { setHeaderMeta: () => {}, setContextTotal: () => {} });

  io.onUsage?.({ inputTokens: 5 });
  await setup.flush();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("↑5 tokens");
  expect(frame).not.toContain("↓");
  setup.renderer.destroy();
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

otuiTest("block-nav ↑ scrolls an off-screen focused block into view", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 10 });
  const first = h.add({ kind: "output", summary: "FIRST-BLOCK", fullText: "one" });
  for (let i = 0; i < 12; i++) {
    h.add({ kind: "output", summary: `later-${i}`, fullText: "x" });
  }
  await h.flush();
  h.scroll.stickyScroll = false;
  h.scroll.scrollTop = h.scroll.scrollHeight;
  await h.flush();
  expect(h.captureCharFrame()).not.toContain("FIRST-BLOCK");

  h.nav.enter();
  await h.flush();
  for (let i = 0; i < 12; i++) {
    h.mockInput.pressArrow("up");
    await h.flush();
  }
  expect(h.registry.focused()?.id).toBe(first);
  expect(lineWith(h.captureCharFrame(), "FIRST-BLOCK")).toContain("❯");
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
  // The block really expanded. Sticky-bottom shows its TAIL: before flow 115 the
  // frame was squeezed to the viewport height and stuck on `payload line 0`,
  // which is exactly the mis-measurement this suite now forbids.
  expect(h.captureCharFrame()).toContain("payload line 119");

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

    // The draft renders at EVERY offset. Flow 109 had to carve out
    // `scrollTop === 2`, where a bordered child bled its bottom border over the
    // composer's interior row and swallowed the draft. Flow 115 found the cause:
    // the block frames carried `alignSelf: "flex-start"`, which stops a box
    // measuring its intrinsic height — the bleed was OUR layout, not an upstream
    // defect. The carve-out is gone; the ban is enforced by
    // `src/capability/tui-layout.test.ts`.
    expect(`${at}: ${frame.includes("draft prompt")}`).toBe(`${at}: true`);
  }
  h.destroy();
});

otuiTest("alignSelf — not @opentui/core — is what overdraws the composer at scrollTop===2 (flow 115 root cause)", async () => {
  const otui = requireOtui();
  // Flow 109 recorded this as an UPSTREAM defect ("a bordered child in a
  // ScrollBox bleeds its bottom border over the composer at exactly scrollTop
  // 2") and carved it out of the AC11 assertion above. Flow 115 re-ran the same
  // pure-primitive repro with one option changed and found the real cause: the
  // frames carried `alignSelf: "flex-start"`, which makes a node stop measuring
  // its intrinsic height, collapse to the viewport and paint outside its own
  // box. Swap the hug for `maxWidth` and the bleed disappears at every offset.
  //
  // The test now pins BOTH arms, so neither the diagnosis nor the fix can be
  // quietly lost: `alignSelf` still reproduces the bleed, `maxWidth` never does.
  const observed: Record<number, boolean> = {};
  const withMaxWidth: Record<number, boolean> = {};
  for (const [headerLines, hug] of [0, 1, 2, 3].flatMap((n) =>
    (["alignSelf", "maxWidth"] as const).map((h) => [n, h] as const),
  )) {
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

    // THE variable under test: the same two boxes hug their content either the
    // flow-109 way (`alignSelf`) or the flow-115 way (`maxWidth`).
    const payload = Array.from({ length: 120 }, (_, i) => `payload line ${i}`).join("\n");
    const hugOpts = (text: string, chrome: number): Record<string, unknown> =>
      hug === "alignSelf" ? { alignSelf: "flex-start" } : { maxWidth: hugWidth(text, chrome) };
    const outer = new otui.core.BoxRenderable(renderer, {
      id: "outer",
      flexDirection: "column",
      flexShrink: 0,
      ...hugOpts(payload, 4),
    });
    for (let i = 0; i < headerLines; i++) {
      outer.add(new otui.core.TextRenderable(renderer, { id: `hdr${i}`, content: `header ${i}` }));
    }
    scroll.content.add(outer);
    const frameBox = new otui.core.BoxRenderable(renderer, {
      id: "frame",
      flexDirection: "column",
      flexShrink: 0,
      ...hugOpts(payload, 4),
      borderStyle: "rounded",
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
    });
    frameBox.add(new otui.core.TextRenderable(renderer, { id: "ft", content: payload }));
    outer.add(frameBox);

    await flush();
    resize(40, 8);
    await flush();
    const visible = captureCharFrame().includes("draft prompt");
    if (hug === "alignSelf") {
      observed[scroll.scrollTop] = visible;
    } else {
      withMaxWidth[scroll.scrollTop] = visible;
    }
    renderer.destroy();
  }

  // One header line per offset, so each sweep lands on 0..3.
  expect(Object.keys(observed).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  expect(observed[0]).toBe(true);
  expect(observed[1]).toBe(true);
  expect(observed[2]).toBe(false); // ← the bleed, caused by `alignSelf`
  expect(observed[3]).toBe(true);

  // The shipped hug never bleeds — at any offset the sweep reaches.
  expect(Object.values(withMaxWidth).every((v) => v)).toBe(true);
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

// --- flow 115: transcript measurement, secondary reasoning, /think toggle ---
//
// RED before T2/T5. The defect these pin: a transcript box carrying
// `alignSelf: "flex-start"` stops measuring its intrinsic height, collapses to
// the viewport, squeezes bordered children so their border rows paint over the
// content row, and makes the ScrollBox under-report `scrollHeight` — which puts
// every row below a large expanded block permanently out of reach.

/** Every descendant of `node`, itself excluded. */
function descendants(node: { getChildren?: () => unknown[] }): { id: string; height: number }[] {
  const out: { id: string; height: number }[] = [];
  for (const child of (node.getChildren?.() ?? []) as { id: string; height: number }[]) {
    out.push(child);
    out.push(...descendants(child as unknown as { getChildren?: () => unknown[] }));
  }
  return out;
}

/** The captured span carrying `needle`, searched across every line. */
function spanWith(frame: SpanFrame, needle: string): { attributes: number } | undefined {
  for (const line of frame.lines) {
    const span = line.spans.find((s) => s.text.includes(needle));
    if (span !== undefined) {
      return span;
    }
  }
  return undefined;
}

otuiTest("AC2: a bordered transcript box keeps its natural height even when the transcript overflows", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 16 });
  // The shipped user-echo box, shared by the agent and chat shells.
  appendUserEcho(otui.core, h.renderer, h.scroll.content, { id: "ub-1", line: "первый вопрос" });
  const big = h.add({
    kind: "thought",
    summary: "",
    fullText: Array.from({ length: 30 }, (_, i) => `reasoning line ${i + 1}`).join("\n"),
  });
  appendUserEcho(otui.core, h.renderer, h.scroll.content, { id: "ub-2", line: "добавляй" });
  h.nav.setCollapsed(big, false);
  await h.flush();
  await h.flush();

  // A rounded box with one content row is 3 rows tall. Squeezed to 2, OpenTUI
  // paints its borders over the text — the corruption users reported.
  const boxes = descendants(h.scroll.content);
  for (const id of ["ub-1", "ub-2"]) {
    const box = boxes.find((b) => b.id === id);
    expect(`${id}: ${box?.height}`).toBe(`${id}: 3`);
  }
  h.destroy();
});

otuiTest("AC3: an expanded block reports its real height, so rows below it stay reachable", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 16 });
  const big = h.add({
    kind: "output",
    summary: "big-summary",
    fullText: Array.from({ length: 30 }, (_, i) => `payload line ${i + 1}`).join("\n"),
  });
  h.scroll.content.add(
    new otui.core.TextRenderable(h.renderer, { id: "after", content: "MARKER-AFTER-BLOCK" }),
  );
  h.nav.setCollapsed(big, false);
  await h.flush();
  await h.flush();

  // 30 payload lines + the frame's two border rows must all be measured.
  const children = h.scroll.content.getChildren() as unknown as { height: number }[];
  const summed = children.reduce((n, c) => n + c.height, 0);
  expect(summed).toBeGreaterThanOrEqual(32);
  expect(h.scroll.scrollHeight).toBeGreaterThanOrEqual(summed);

  // …and the row registered AFTER the block can actually be scrolled to.
  h.scroll.stickyScroll = false;
  h.scroll.scrollTop = h.scroll.scrollHeight;
  await h.flush();
  expect(h.captureCharFrame()).toContain("MARKER-AFTER-BLOCK");
  h.destroy();
});

otuiTest("AC4: an expanded reasoning body is dim; tool output on the same frame is not", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 24 });
  const io = createTuiAgentIo(otui.core, h.renderer, h.scroll.content);
  attachBlockIo(io, h.addBlock);
  io.onReasoning?.("REASONING-BODY-LINE");
  // Two lines: the first becomes the collapsed SUMMARY in the (always dim)
  // header, so the body assertion below must target a line the header never
  // shows.
  io.onToolResult?.("read_file", { output: "tool summary\nTOOL-OUTPUT-LINE", isError: false });
  for (const state of h.registry.list()) {
    h.nav.setCollapsed(state.id, false);
  }
  await h.flush();
  await h.flush();

  const spans = h.captureSpans();
  const dim = otui.core.TextAttributes.DIM;
  const reasoning = spanWith(spans, "REASONING-BODY-LINE");
  const output = spanWith(spans, "TOOL-OUTPUT-LINE");
  expect(reasoning).toBeDefined();
  expect(output).toBeDefined();
  expect((reasoning?.attributes ?? 0) & dim).toBe(dim); // secondary
  expect((output?.attributes ?? 0) & dim).toBe(0); // unchanged
  h.destroy();
});

otuiTest("AC5: an expanded reasoning body is bounded, while the retained payload stays whole", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 40 });
  const io = createTuiAgentIo(otui.core, h.renderer, h.scroll.content);
  attachBlockIo(io, h.addBlock);
  const lines = Array.from({ length: 60 }, (_, i) => `thought line ${i + 1}`);
  io.onReasoning?.(lines.join("\n"));
  const id = h.registry.list().at(-1)?.id ?? "";
  h.nav.setCollapsed(id, false);
  await h.flush();
  await h.flush();

  const frame = h.captureCharFrame();
  expect(frame).toContain("thought line 1");
  expect(frame).not.toContain(`thought line ${MAX_THOUGHT_LINES + 1}`);
  expect(frame).toContain("more lines not shown");
  // Retention is untouched: copy still gets everything (flow 109 D-4).
  expect(h.registry.bodyText(id)).toContain("thought line 60");
  expect(h.nav.copy(id)).toBe(true);
  expect(h.copied.at(-1)).toContain("thought line 60");
  h.destroy();
});

otuiTest("AC6: toggleNewest expands then collapses the newest reasoning block, and the header says how", async () => {
  const otui = requireOtui();
  const h = await mountBlockHarness(otui, { width: 70, height: 24 });
  const io = createTuiAgentIo(otui.core, h.renderer, h.scroll.content);
  attachBlockIo(io, h.addBlock);
  io.onToolResult?.("read_file", { output: "unrelated output", isError: false });
  io.onReasoning?.("REASONING-BODY-LINE\nsecond line");

  // What `/think` calls (the shell closure keeps only the command dispatch).
  const expanded = h.nav.toggleNewest("thought");
  await h.flush();
  expect(expanded?.kind).toBe("thought");
  expect(expanded?.collapsed).toBe(false);
  expect(h.captureCharFrame()).toContain("REASONING-BODY-LINE");
  // While expanded the header advertises the way back.
  expect(h.captureCharFrame()).toContain("collapse");

  const collapsed = h.nav.toggleNewest("thought");
  await h.flush();
  expect(collapsed?.collapsed).toBe(true);
  expect(h.captureCharFrame()).not.toContain("REASONING-BODY-LINE");

  // An unrelated tool block is never the target of `/think`.
  expect(h.registry.list().find((b) => b.kind === "output")?.collapsed).toBe(true);
  expect(h.nav.toggleNewest("no-such-kind")).toBeUndefined();
  h.destroy();
});

// ===========================================================================
// The flow-041 advisory approval context on the TUI approval surface
// ===========================================================================
//
// The readline shell prints `buildApprovalContext` (graph blast radius + top
// memory note) above its `Run …? [y/N]` prompt. The TUI is the DEFAULT surface,
// so it must not be less informative — and must not be slower or less safe:
// the menu is interactive from the first frame and the context lands later, if
// at all. These drive the shell's own `pickShellApproval` (the very function
// `io.requestApproval` calls) against the real `showComposerChoice`.

/** A choice dock mirroring the shell's `choice-dock` (shell-chrome), headless. */
async function mountApprovalDock(
  otui: OtuiBundle,
  opts: { width?: number; height?: number } = {},
): Promise<TestSetup & { dock: InstanceType<OtuiBundle["core"]["BoxRenderable"]> }> {
  const setup = await otui.testing.createTestRenderer({
    width: opts.width ?? 80,
    height: opts.height ?? 20,
  });
  const dock = new otui.core.BoxRenderable(setup.renderer, {
    id: "choice-dock",
    flexShrink: 0,
    flexDirection: "column",
    visible: false,
  });
  setup.renderer.root.add(dock);
  return { ...setup, dock };
}

/** Drain the microtask queue so a resolved loader promise has reached the dock. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

otuiTest("the flow-041 approval context reaches the TUI approval dock (headless)", async () => {
  const otui = requireOtui();
  const h = await mountApprovalDock(otui);
  const command = "bun test src/tui/tui-shell.ts";
  let release: (text: string) => void = () => {};
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];

  const choice = pickShellApproval(otui.core, h.renderer, h.dock, command, async (cmd) => {
    asked.push(cmd);
    return pending;
  });

  // First frame: the question and the command are already up, WITHOUT the
  // context — the menu never waits on a metaproject lookup.
  await h.flush();
  const first = h.captureCharFrame();
  expect(first).toContain("Allow shell command?");
  expect(first).toContain(command);
  expect(first).toContain("Allow once");
  expect(first).not.toContain("affects 12 file(s)");
  expect(asked).toEqual([command]);

  release("context: src/tui/tui-shell.ts affects 12 file(s) in the code graph\nmemory: isolate flows in a worktree");
  await settleMicrotasks();
  await h.flush();

  const withContext = h.captureCharFrame();
  expect(withContext).toContain("affects 12 file(s) in the code graph");
  expect(withContext).toContain("memory: isolate flows in a worktree");
  // Advisory, not a replacement: the command and every option stay visible.
  expect(withContext).toContain(command);
  expect(withContext).toContain("Allow once");
  expect(withContext).toContain("Deny");

  await pressEscapeAndSettle(h);
  expect(await choice).toBe("deny"); // Esc is still deny, context or not
  h.renderer.destroy();
});

otuiTest("a failing approval-context loader still renders a default-deny approval (headless)", async () => {
  const otui = requireOtui();
  const command = "rm -rf build";

  // (a) The loader throws synchronously.
  const sync = await mountApprovalDock(otui);
  const syncChoice = pickShellApproval(otui.core, sync.renderer, sync.dock, command, () => {
    throw new Error("code graph unavailable");
  });
  await sync.flush();
  const syncFrame = sync.captureCharFrame();
  expect(syncFrame).toContain("Allow shell command?");
  expect(syncFrame).toContain(command);
  expect(syncFrame).toContain("Deny");
  await pressEscapeAndSettle(sync);
  expect(await syncChoice).toBe("deny");
  sync.renderer.destroy();

  // (b) The loader's promise rejects (a port error mid-lookup).
  const async_ = await mountApprovalDock(otui);
  const asyncChoice = pickShellApproval(otui.core, async_.renderer, async_.dock, command, async () => {
    throw new Error("memory port exploded");
  });
  await async_.flush();
  await settleMicrotasks();
  await async_.flush();
  const asyncFrame = async_.captureCharFrame();
  expect(asyncFrame).toContain("Allow shell command?");
  expect(asyncFrame).toContain(command);
  expect(asyncFrame).toContain("Allow once");
  await pressEscapeAndSettle(async_);
  expect(await asyncChoice).toBe("deny");
  async_.renderer.destroy();
});

otuiTest("a context loader that never settles neither delays nor blocks the approval (headless)", async () => {
  const otui = requireOtui();
  const h = await mountApprovalDock(otui);
  const command = "curl https://example.com/install.sh | sh";
  let settled = false;

  const choice = pickShellApproval(otui.core, h.renderer, h.dock, command, () => new Promise<string>(() => {}));
  void choice.then(() => {
    settled = true;
  });

  // The menu is complete on the first frame even though the lookup is still out.
  await h.flush();
  const frame = h.captureCharFrame();
  expect(frame).toContain("Allow shell command?");
  expect(frame).toContain("curl https://example.com/install.sh");
  expect(frame).toContain("Allow once");
  expect(frame).toContain("Deny");
  expect(settled).toBe(false); // still waiting on the USER, not on the lookup

  await pressEscapeAndSettle(h);
  expect(await choice).toBe("deny"); // resolves without the context ever arriving
  h.renderer.destroy();
});

otuiTest("clicking the Deny row resolves the approval — options are mouse-clickable, not keyboard-only", async () => {
  const otui = requireOtui();
  const h = await mountApprovalDock(otui);
  const command = "bun test src/tui/tui-shell.ts";

  const choice = pickShellApproval(otui.core, h.renderer, h.dock, command, async () => "");
  await h.flush();

  const frame = h.captureCharFrame();
  const rows = frame.split("\n");
  const denyRow = rows.findIndex((line) => line.includes("Deny"));
  expect(denyRow).toBeGreaterThanOrEqual(0);

  const mouse = otui.testing.createMockMouse(h.renderer);
  await mouse.click(5, denyRow);
  await h.flush();

  expect(await choice).toBe("deny");
  h.renderer.destroy();
});

otuiTest("a long multi-line command is no longer cut at 120 chars — it renders in full, up to the box", async () => {
  const otui = requireOtui();
  const h = await mountApprovalDock(otui, { height: 24 });
  // Well past the old 120-char cutoff; the tail line must still be visible.
  const command = [
    "python3 - <<'PY'",
    "import io",
    'p = "src/tui/tui-shell.ts"',
    's = io.open(p, encoding="utf-8").read()',
    "print('TAIL_MARKER_AFTER_120_CHARS', len(s))",
  ].join("\n");
  expect(command.length).toBeGreaterThan(120);

  const choice = pickShellApproval(otui.core, h.renderer, h.dock, command, async () => "");
  await h.flush();

  const frame = h.captureCharFrame();
  expect(frame).toContain("TAIL_MARKER_AFTER_120_CHARS");

  await pressEscapeAndSettle(h);
  expect(await choice).toBe("deny");
  h.renderer.destroy();
});

otuiTest("a streamed fence widens its frame as the payload grows (maxWidth is recomputed, flow 115)", async () => {
  const otui = requireOtui();
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 60, height: 12 });
  const parent = new otui.core.BoxRenderable(renderer, { id: "p", flexDirection: "column" });
  renderer.root.add(parent);

  const view = createSegmentView(otui.core, renderer, parent, { kind: "code", lang: "ts", body: "const a = 1" });
  await flush();
  const frame = parent.getChildren()[0] as unknown as { width: number; height: number };
  const narrow = frame.width;

  view.update({
    kind: "code",
    lang: "ts",
    body: "const a = 1\nconst bbbbbbbbbbbbbbbbbbbbbbbbbb = 2\nconst c = 3",
  });
  await flush();
  await flush();

  // A frame frozen at its first hug width would wrap the longer line instead of
  // growing — the whole point of recomputing `maxWidth` on repaint.
  expect(frame.width).toBeGreaterThan(narrow);
  expect(captureCharFrame()).toContain("const bbbbbbbbbbbbbbbbbbbbbbbbbb = 2");
  renderer.destroy();
});

// --- SLATE-2a: /model-switch Anchors auto-inject (AC4) ---
//
// `launchTuiAgentShell`'s `/model` handler (`command.name === "/model"`,
// ~tui-shell.ts:2549) is a giant closure with no headless test harness in
// this file — every existing test here either drives an exported PURE
// helper (isShellApproved, filterConnectedDetectedProviders, selectBoxHeight,
// mountCwdPanel, …) or renders `runAgentTurn` output through
// `createTuiAgentIo` inside a scripted-renderer harness; nothing drives the
// full REPL's slash-command dispatch (`launchTuiAgentShell` itself is never
// imported/invoked here). Per the dispatch brief, since the `/model` wiring
// is not cleanly testable at that layer without the implementation already
// existing, this pins down a NEW exported pure contract for T7 to build and
// wire the `/model` handler through — matching this file's existing
// extracted-pure-helper pattern:
//
//   applyRuntimeSwitchToSlate(params: {
//     slateSession: SlateSessionRef | undefined;
//     runtime: { provider: string; model: string };
//     history: NormalizedMessage[];
//   }): Promise<boolean>
//
// Reuses the SAME `recordSlateTouch` touched-tracking helper from
// `src/session/slate-lifecycle.ts` (called with the NEW provider/model as
// `runtime`) and, on a real change, pushes ONE `{role:"user",
// provenance:"project", content: renderAnchorsBlock(...)}` message into the
// TUI's `history` reflecting the new runtime — returns whether it injected.
// A `/model` handler that calls this after `switchTo(...)` succeeds
// satisfies AC4's "/model switch" trigger without this file needing to
// drive the real OpenTUI dropdown/picker at all.

async function tempSlateDirForTui(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keryx-tui-slate-"));
}

async function tempCwdForTui(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keryx-tui-slate-cwd-"));
}

test("SLATE-2a: applyRuntimeSwitchToSlate pushes an Anchors-block message into history reflecting the NEW provider/model after a /model switch", async () => {
  const dir = await tempSlateDirForTui();
  const cwd = await tempCwdForTui();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));
  const slateSession: SlateSessionRef = { dir, cwd, opened: true };
  const history: NormalizedMessage[] = [];

  const changed = await applyRuntimeSwitchToSlate({
    slateSession,
    runtime: { provider: "openai", model: "gpt-5" },
    history,
  });

  expect(changed).toBe(true);
  const anchorsMsg = history.find((m) => m.role === "user" && m.content.includes("gpt-5"));
  expect(anchorsMsg).toBeDefined();
  expect(anchorsMsg?.provenance).toBe("project");
  const slate = await readSlate(dir);
  expect(slate?.anchors.runtime).toEqual({ provider: "openai", model: "gpt-5" });
});

test("review finding 6: applyRuntimeSwitchToSlate calls onHistoryChange(\"tool\") immediately after pushing an Anchors-block message", async () => {
  const dir = await tempSlateDirForTui();
  const cwd = await tempCwdForTui();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));
  const slateSession: SlateSessionRef = { dir, cwd, opened: true };
  const history: NormalizedMessage[] = [];
  const changes: string[] = [];

  const changed = await applyRuntimeSwitchToSlate({
    slateSession,
    runtime: { provider: "openai", model: "gpt-5" },
    history,
    onHistoryChange: (kind) => changes.push(kind),
  });

  expect(changed).toBe(true);
  expect(changes).toEqual(["tool"]);
});

test("review finding 6: applyRuntimeSwitchToSlate does NOT call onHistoryChange when nothing changed (no-op switch, e.g. no slateSession or a same provider/model switch)", async () => {
  const history: NormalizedMessage[] = [];
  const changes: string[] = [];

  const changedUndefined = await applyRuntimeSwitchToSlate({
    slateSession: undefined,
    runtime: { provider: "openai", model: "gpt-5" },
    history,
    onHistoryChange: (kind) => changes.push(kind),
  });
  expect(changedUndefined).toBe(false);
  expect(changes).toEqual([]);

  const dir = await tempSlateDirForTui();
  const cwd = await tempCwdForTui();
  await writeSlate(dir, () => ({
    anchors: { root: cwd, touched: [], runtime: { provider: "anthropic", model: "claude" } },
    course: {},
    seeds: [],
  }));
  const slateSession: SlateSessionRef = { dir, cwd, opened: true };
  const changedSame = await applyRuntimeSwitchToSlate({
    slateSession,
    runtime: { provider: "anthropic", model: "claude" },
    history,
    onHistoryChange: (kind) => changes.push(kind),
  });
  expect(changedSame).toBe(false);
  expect(changes).toEqual([]);
});

test("SLATE-2a: applyRuntimeSwitchToSlate is a no-op (no history mutation) when slateSession is absent or not yet opened", async () => {
  const history: NormalizedMessage[] = [];

  const changedUndefined = await applyRuntimeSwitchToSlate({
    slateSession: undefined,
    runtime: { provider: "openai", model: "gpt-5" },
    history,
  });
  expect(changedUndefined).toBe(false);
  expect(history.length).toBe(0);

  const dir = await tempSlateDirForTui();
  const cwd = await tempCwdForTui();
  const notOpened: SlateSessionRef = { dir, cwd, opened: false };
  const changedNotOpened = await applyRuntimeSwitchToSlate({
    slateSession: notOpened,
    runtime: { provider: "openai", model: "gpt-5" },
    history,
  });
  expect(changedNotOpened).toBe(false);
  expect(history.length).toBe(0);
});

test("SLATE-2a: applyRuntimeSwitchToSlate is idempotent — switching to the SAME provider/model twice injects only once", async () => {
  const dir = await tempSlateDirForTui();
  const cwd = await tempCwdForTui();
  await writeSlate(dir, () => ({
    anchors: { root: cwd, touched: [], runtime: { provider: "anthropic", model: "claude" } },
    course: {},
    seeds: [],
  }));
  const slateSession: SlateSessionRef = { dir, cwd, opened: true };
  const history: NormalizedMessage[] = [];

  const first = await applyRuntimeSwitchToSlate({
    slateSession,
    runtime: { provider: "anthropic", model: "claude" },
    history,
  });

  expect(first).toBe(false);
  expect(history.length).toBe(0);
});

// --- SLATE-3a: tui-shell.ts getSessionDir threading (flow 161, AC5) ------
//
// `launchTuiAgentShell` builds `deps = await opts.makeAgentDeps(sel)` at its
// FIRST call site (before session/`slateSession` setup runs later in the
// same function — see the `slateSession` declaration further down) and
// rebuilds `deps` at two more call sites (`/model`/`/connect` switch, and a
// read-only side-worker deps rebuild). `slate_read`/`slate_write_seed` need
// the CURRENT session dir at TOOL-INVOKE time, not whatever was true when
// `deps.tools` was last built — a plain static dir threaded once cannot
// track a session opened/reassigned later.
//
// Chosen shape (T8, for T9 to build exactly this): `opts.makeAgentDeps`'s
// type gains a second parameter, `getSessionDir: () => string | undefined`,
// and EVERY real call site passes `() => slateSession?.dir` — a closure
// reading `launchTuiAgentShell`'s own `let slateSession` variable BY
// REFERENCE. This is safe even at the FIRST call site (textually before
// `let slateSession` is declared): the closure is only CREATED there, never
// INVOKED until a turn actually runs a tool call, by which point
// `slateSession`'s `let` has long since executed further down in the same
// linear async function body — TDZ is a call-time concern, not a
// closure-creation-time one.
//
// Like the SLATE-2a `/model` audit above, `launchTuiAgentShell` itself is
// never imported/invoked in this file (no headless harness for the full
// OpenTUI REPL) — this is a source-text audit, following the exact
// precedent `shell.test.ts`'s SLATE-5 / SLATE-3a describe blocks set for
// `runAgentRepl` (also never driven end-to-end here).
describe("SLATE-3a — tui-shell.ts getSessionDir threading (source-text audit)", () => {
  const tuiSource = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const fnStart = tuiSource.indexOf("export async function launchTuiAgentShell(opts: {");
  const fnBody = tuiSource.slice(fnStart); // last top-level function in the file

  // Fix round (Finding 1, code review of PR #306): `opts.makeAgentDeps`'s
  // second parameter widened from `getSessionDir: () => string | undefined`
  // to `getSlateSession: () => SlateSessionRef | undefined` — a `.dir`-only
  // getter meant `commands/shell.ts`'s `makeAgentDeps` closure had no way to
  // hand `createSpawnSubagentTool` a real `SlateSessionRef` at all, so
  // SLATE-6's child-slate fold silently never fired in a real TUI session.
  // Every call site below now passes the live ref itself (`() =>
  // slateSession`), not a pre-narrowed `.dir` string; `shell.ts`'s own
  // `makeAgentDeps` derives `.dir` locally where `buildInteractiveAgentTools`
  // still needs just the string (see that file).
  test("opts.makeAgentDeps's type accepts a getSlateSession second parameter", () => {
    const optsTypeBlock = fnBody.slice(0, fnBody.indexOf("}): Promise<boolean> {"));
    expect(optsTypeBlock).toContain(
      "makeAgentDeps: (sel: TuiSelection, getSlateSession: () => SlateSessionRef | undefined) => Promise<AgentDeps>;",
    );
  });

  test("the FIRST opts.makeAgentDeps call site (before slateSession is declared) passes a live getter, not a snapshot", () => {
    const callIndex = fnBody.indexOf("let deps = await opts.makeAgentDeps(");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const declIndex = fnBody.indexOf("let slateSession: SlateSessionRef | undefined;");
    expect(declIndex).toBeGreaterThan(callIndex); // confirms the TDZ-shaped ordering this audit is about
    const call = fnBody.slice(callIndex, callIndex + 200);
    expect(call).toContain("opts.makeAgentDeps(sel, () => slateSession)");
  });

  test("the /model|/connect switchTo(...) rebuild passes the same live getter", () => {
    const switchToIndex = fnBody.indexOf("const switchTo = async (ns: TuiSelection)");
    expect(switchToIndex).toBeGreaterThanOrEqual(0);
    const switchToBlock = fnBody.slice(switchToIndex, switchToIndex + 300);
    expect(switchToBlock).toContain("opts.makeAgentDeps(ns, () => slateSession)");
  });

  test("the read-only side-worker deps rebuild passes the same live getter", () => {
    const baseIndex = fnBody.indexOf("const base = await opts.makeAgentDeps(");
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    const baseBlock = fnBody.slice(baseIndex, baseIndex + 200);
    expect(baseBlock).toContain("opts.makeAgentDeps(currentSel, () => slateSession)");
  });

  test("all three real call sites are updated — not fewer, not more", () => {
    const occurrences = fnBody.split("() => slateSession)").length - 1;
    expect(occurrences).toBe(3);
  });
});

// --- SLATE-15: /goal wiring in tui-shell.ts's command switch (flow 161, T10
// — AC1/AC2) ------------------------------------------------------------
//
// RED until T11 lands the wiring. `launchTuiAgentShell` itself is never
// imported/invoked in this file (no headless harness for the full OpenTUI
// REPL — see the SLATE-2a/SLATE-3a source-text audits above), so this is a
// source-text audit, following the same precedent. The ACTUAL /goal
// behavior (fail-closed `--workspace` validation, no-workspace-created
// guarantee, ensureSlateOpened + runAgentTurn sequencing) is proven directly
// against the shared `runGoalCommand` core in `../commands/goal-command.test.ts`;
// this block only proves the TUI surface actually WIRES that core in — the
// Phase-2 cross-surface-gap lesson this flow's dispatch briefs call out
// explicitly ("verify both surfaces by grep, do not assume symmetry").
//
// PINNED SHAPE (T11 implements exactly this — see subagent-result): a new
// `if (command.name === "/goal") { ... return; }` branch inside the command
// switch (alongside `/model`, `/copy`, `/interrupt`, etc.), calling:
//   void (async () => {
//     await runGoalCommand({
//       raw: line.slice(command.name.length).trim(),
//       cwd: sessionCwd,
//       io,
//       deps,
//       history,
//       slateSession,
//       mintAttemptId: mintTimestampAttemptId,
//     });
//   })();
// `runGoalCommand` mutates `slateSession.opened`/`.dir` targets IN PLACE (the
// same object `opts.makeAgentDeps`'s `getSessionDir` closure already reads BY
// REFERENCE per the SLATE-3a audit above) — no additional getSessionDir
// re-wiring is needed for this branch.
//
// `/goal` must ALSO be registered in `agent-commands.ts`'s
// `AGENT_SLASH_COMMANDS` (AGENT_ONLY mode) for `findAgentCommand`/the `/`
// composer dropdown to recognize it here at all — see
// `agent-commands.test.ts`'s own SLATE-15 additions for that half.
describe("SLATE-15 — tui-shell.ts /goal wiring (source-text audit)", () => {
  const tuiSource2 = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const fnStart2 = tuiSource2.indexOf("export async function launchTuiAgentShell(opts: {");
  const fnBody2 = tuiSource2.slice(fnStart2);

  test("runGoalCommand is imported from ../commands/goal-command", () => {
    expect(tuiSource2).toMatch(/from ["'](\.\.\/commands\/)?goal-command["']/);
    expect(tuiSource2).toContain("runGoalCommand");
  });

  test("the command switch has a /goal branch calling runGoalCommand", () => {
    const branchIndex = fnBody2.indexOf('command.name === "/goal"');
    expect(branchIndex).toBeGreaterThanOrEqual(0);
    const branchBlock = fnBody2.slice(branchIndex, branchIndex + 400);
    expect(branchBlock).toContain("runGoalCommand(");
  });

  test("the /goal branch passes cwd, io, deps, history, slateSession, and mintAttemptId", () => {
    const branchIndex = fnBody2.indexOf('command.name === "/goal"');
    const branchBlock = fnBody2.slice(branchIndex, branchIndex + 500);
    expect(branchBlock).toContain("sessionCwd");
    expect(branchBlock).toContain("slateSession");
    expect(branchBlock).toContain("mintTimestampAttemptId");
  });
});

// --- flow 163 AC8: the TUI's OpenTUI REPL never triggers the Track B
// wrap-up composer this way either — the same invariant shell.test.ts's own
// "flow 163 AC8" source-text audit proves for the readline REPL, mirrored
// here for `launchTuiAgentShell` (the OpenTUI equivalent). The trigger call
// site exists ONLY in the one-shot `keryx harness run` path (harness.test.ts's
// own positive-half audit). Source-text audit, following the exact
// precedent this file already sets above (SLATE-2a/SLATE-3a audits):
// `launchTuiAgentShell` has no headless injection seam, so this is proven by
// reading the real source rather than driving the OpenTUI REPL end-to-end.
describe("flow 163 AC8 — tui-shell.ts's OpenTUI REPL never triggers the wrap-up composer (source-text audit)", () => {
  const tuiSourceAc8 = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("tui-shell.ts never imports or calls the Track B wrap-up composer", () => {
    expect(tuiSourceAc8).not.toContain("runWrapUp");
    expect(tuiSourceAc8).not.toMatch(/machine-wrap-up/);
  });
});

// --- flow 173 AC7/AC9: tui-shell.ts real exit-sweep wiring, and the
// deliberate AC9 divergence — a background job must NOT be swept on
// /clear|/new (source-text audit) ----------------------------------------
//
// `launchTuiAgentShell` calls `opts.makeAgentDeps(...)` three times per
// session (confirmed above, SLATE-3a audit: the initial call, the
// `/model`/`/connect` `switchTo(...)` rebuild, and the read-only
// side-worker deps rebuild) — `shell.ts`'s own `makeAgentDeps` closure is
// audited separately (`shell.test.ts`, "flow 173 AC7 — shell.ts TUI
// makeAgentDeps jobRegistry session-scope") to thread ONE session-scoped
// `jobRegistry` across all three. This file's job is the OTHER half: the
// real session-exit trigger this file owns (`/exit`, `r.destroy()` — there
// is no `process.on(SIGINT/SIGTERM)` handler in this codebase, confirmed by
// grep, so `/exit` IS the graceful-exit path for AC7) must call the
// `sweepBackgroundJobs` hook `makeAgentDeps` now returns on `AgentDeps`
// (mirrors the already-existing `deps.resetSubagentBudget?.()` optional-hook
// call-site precedent, used elsewhere in this same file).
//
// `/clear`/`/new` (the OTHER close-trigger in this file, which also calls
// `closeSlateSession` + `sessions.clear()` + `deps.resetSubagentBudget?.()`)
// must NOT gain this call — AC9 requires a running background job to
// survive `/clear`/`/new`; only real session exit (`/exit`) sweeps it. This
// is the direct TUI-surface analog of the readline-side negative assertion
// in `shell.test.ts`'s AC7 audit above.
//
// `launchTuiAgentShell` has no headless injection seam (same precedent as
// every other audit in this file/`shell.test.ts`) — source-text audit.
//
// PINNED SHAPE (task-implementer builds exactly this): inside the
// `if (command.name === "/exit") {` branch's `void (async () => { ... })();`
// IIFE, immediately after `await closeSlateSession(slateSession,
// mintTimestampAttemptId);` and before `r.off("theme_mode", onThemeMode);`:
//   await deps.sweepBackgroundJobs?.();
// F-002 (review fix-round): the ORIGINAL version of this describe block
// asserted `sweepBackgroundJobs` occurs EXACTLY ONCE in the file — true only
// because, at the time, the busy-dispatch `/exit` branch and `onDestroy`
// (Ctrl+C — `exitOnCtrlC: true` in `createShellRenderer`) neither swept nor
// purged background jobs at all: a real gap (an orphaned, unsandboxed
// process surviving Ctrl+C indefinitely), not a property worth locking in.
// This block now asserts the CORRECT invariant instead: sweep (OS-level,
// `deps.sweepBackgroundJobs?.()`/`liveDeps?.sweepBackgroundJobs?.()`) AND
// purge (store-level, `jobs.removeAll()`/`liveJobs?.removeAll()`) both fire
// at every REAL exit path — non-busy `/exit`, busy-dispatch `/exit`, and
// `onDestroy` — and neither fires on `/clear`/`/new` (AC9: a running job
// must survive those).
describe("flow 173 F-002/AC7/AC9 — background-job sweep fires at every real exit path, never on /clear|/new (source-text audit)", () => {
  const tuiSourceAc7 = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const sweepCall = "await deps.sweepBackgroundJobs?.();";
  const removeAllCall = "jobs.removeAll();";
  const onDestroySweepCall = "await liveDeps?.sweepBackgroundJobs?.();";
  const onDestroyRemoveAllCall = "liveJobs?.removeAll();";

  test("no process-level SIGINT/SIGTERM handler exists — /exit and onDestroy (Ctrl+C) are the real graceful-exit triggers this audit targets", () => {
    expect(tuiSourceAc7).not.toMatch(/process\.on\(\s*["'](SIGINT|SIGTERM)["']/);
  });

  test("the non-busy /exit branch sweeps AND purges background jobs, right after closing the slate session", () => {
    const exitIdx = tuiSourceAc7.indexOf('if (command.name === "/exit") {');
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    const exitBlock = tuiSourceAc7.slice(exitIdx, exitIdx + 500);
    const closeIdx = exitBlock.indexOf("await closeSlateSession(slateSession, mintTimestampAttemptId);");
    const sweepIdx = exitBlock.indexOf(sweepCall);
    const removeIdx = exitBlock.indexOf(removeAllCall);
    const destroyIdx = exitBlock.indexOf("r.destroy();");
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(sweepIdx).toBeGreaterThan(closeIdx);
    expect(removeIdx).toBeGreaterThan(sweepIdx);
    expect(destroyIdx).toBeGreaterThan(removeIdx);
  });

  test("F-002: the busy-dispatch /exit branch (classifyBusyDispatch === 'exit') ALSO sweeps AND purges background jobs — this is the SECOND real exit path that was previously missing it entirely", () => {
    const exitIdx = tuiSourceAc7.indexOf('case "exit": {');
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    const exitBlock = tuiSourceAc7.slice(exitIdx, exitIdx + 500);
    const closeIdx = exitBlock.indexOf("await closeSlateSession(slateSession, mintTimestampAttemptId);");
    const sweepIdx = exitBlock.indexOf(sweepCall);
    const removeIdx = exitBlock.indexOf(removeAllCall);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(sweepIdx).toBeGreaterThan(closeIdx);
    expect(removeIdx).toBeGreaterThan(sweepIdx);
  });

  test("F-002: onDestroy (Ctrl+C) ALSO sweeps AND purges background jobs, and defers resolveDone() until the sweep settles — the THIRD real exit path that was previously missing it entirely", () => {
    const onDestroyIdx = tuiSourceAc7.indexOf("onDestroy: () => {");
    expect(onDestroyIdx).toBeGreaterThanOrEqual(0);
    const nextTopLevelMarker = tuiSourceAc7.indexOf("applyThemeId(getThemeId(), r.themeMode);", onDestroyIdx);
    expect(nextTopLevelMarker).toBeGreaterThan(onDestroyIdx);
    const onDestroyBlock = tuiSourceAc7.slice(onDestroyIdx, nextTopLevelMarker);
    const removeIdx = onDestroyBlock.indexOf(onDestroyRemoveAllCall);
    const sweepIdx = onDestroyBlock.indexOf(onDestroySweepCall);
    const resolveIdx = onDestroyBlock.indexOf("resolveDone();");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(sweepIdx).toBeGreaterThan(removeIdx);
    // resolveDone() is called from INSIDE the deferred async IIFE (a
    // `finally`), after the sweep — never synchronously alongside it — so
    // nothing downstream of `launchTuiAgentShell()` can observe `done`
    // resolving before the sweep has actually run.
    expect(resolveIdx).toBeGreaterThan(sweepIdx);
  });

  test("AC9: /clear|/new does NOT sweep or purge background jobs — a running job must survive it", () => {
    const newBlockStart = tuiSourceAc7.indexOf('if (command.name === "/clear" || command.name === "/new") {');
    expect(newBlockStart).toBeGreaterThanOrEqual(0);
    const newBlockEnd = tuiSourceAc7.indexOf('if (command.name === "/goal") {', newBlockStart);
    expect(newBlockEnd).toBeGreaterThan(newBlockStart);
    const newBlock = tuiSourceAc7.slice(newBlockStart, newBlockEnd);
    expect(newBlock).not.toContain(sweepCall);
    expect(newBlock).not.toContain(removeAllCall);
    expect(newBlock).not.toContain("removeAll");
  });

  test("sweepBackgroundJobs (OS-level) is called at exactly the three real exit paths: non-busy /exit, busy /exit, onDestroy", () => {
    const plainOccurrences = tuiSourceAc7.split(sweepCall).length - 1;
    expect(plainOccurrences).toBe(2); // non-busy /exit + busy /exit
    const onDestroyOccurrences = tuiSourceAc7.split(onDestroySweepCall).length - 1;
    expect(onDestroyOccurrences).toBe(1); // onDestroy (reads the TDZ-safe `liveDeps` ref, not `deps` directly)
  });

  test("jobs.removeAll() (store-level purge) is called at exactly the three real exit paths: non-busy /exit, busy /exit, onDestroy", () => {
    const plainOccurrences = tuiSourceAc7.split(removeAllCall).length - 1;
    expect(plainOccurrences).toBe(2); // non-busy /exit + busy /exit
    const onDestroyOccurrences = tuiSourceAc7.split(onDestroyRemoveAllCall).length - 1;
    expect(onDestroyOccurrences).toBe(1); // onDestroy (reads the TDZ-safe `liveJobs` ref, not `jobs` directly)
  });
});

// --- F-008: paintJobs must not repaint the whole sidebar on every output
// chunk (source-text audit — `paintJobs` is a closure with no injection seam,
// same precedent as every other audit in this file) ------------------------
describe("flow 173 F-008 — paintJobs skips repaint on 'output' hints, mirroring paintSubagents' 'log' guard", () => {
  const tuiSourceF008 = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("paintJobs takes an optional hint and returns early on hint.kind === 'output'", () => {
    const paintJobsIdx = tuiSourceF008.indexOf("const paintJobs = (hint?: BackgroundJobStoreHint): void => {");
    expect(paintJobsIdx).toBeGreaterThanOrEqual(0);
    const paintBackgroundJobSidebarIdx = tuiSourceF008.indexOf("paintBackgroundJobSidebar(otui, r, sbJobs, jobs.list(), {", paintJobsIdx);
    expect(paintBackgroundJobSidebarIdx).toBeGreaterThan(paintJobsIdx);
    const guardBlock = tuiSourceF008.slice(paintJobsIdx, paintBackgroundJobSidebarIdx);
    expect(guardBlock).toContain('hint?.kind === "output"');
    expect(guardBlock).toContain("return;");
  });

  test("jobs.subscribe(paintJobs) passes the BackgroundJobStore's hint through (subscribe/emit both carry it)", () => {
    expect(tuiSourceF008).toContain("jobs.subscribe(paintJobs);");
  });

  test("BackgroundJobStoreHint is imported from background-job-session", () => {
    expect(tuiSourceF008).toMatch(/import\s*\{\s*BackgroundJobStore,\s*type BackgroundJobStoreHint\s*\}\s*from\s*"\.\/background-job-session";/);
  });
});

// --- F-003: the side-worker deps builder filters tools by risk==="read" AND
// excludes shell_job_kill by name (source-text audit — `spawnSideWorker` is a
// closure with no injection seam, same precedent as above) -----------------
describe("flow 173 F-003 — side-worker tool filter excludes shell_job_kill by name, keeps shell_job_output", () => {
  const tuiSourceF003 = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("a module-level deny-list constant names shell_job_kill (not a risk-level change — AC6 is frozen)", () => {
    expect(tuiSourceF003).toContain('const SIDE_WORKER_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set(["shell_job_kill"]);');
  });

  test("the side-worker tools filter checks BOTH risk==='read' and the deny-list, not risk alone", () => {
    const filterIdx = tuiSourceF003.indexOf("const tools = base.tools.filter(");
    expect(filterIdx).toBeGreaterThanOrEqual(0);
    const filterBlock = tuiSourceF003.slice(filterIdx, filterIdx + 300);
    expect(filterBlock).toContain('t.definition.risk === "read"');
    expect(filterBlock).toContain("SIDE_WORKER_DENIED_TOOL_NAMES.has(t.definition.name)");
  });
});

// ===========================================================================
// Flow 179 — /search-provider bare-arg wizard (searchProviderWizardInTui)
// ===========================================================================
//
// Drives the REAL `searchProviderWizardInTui` (exported from tui-shell.ts)
// against a minimal fake `SearchProviderController` — configure/test/select
// spies plus a scripted `configurable()` list — so every case controls its
// outcome deterministically without touching the real search-config file the
// concrete class reads/writes. Navigation goes through the shell's own
// `onKeypress`-driven renderables, the same seam flow 109 established above:
// `SelectRenderable` via arrow keys + Enter, `InputRenderable` via typed text
// + Enter, Esc via the same `pressEscapeAndSettle` helper (the lone-ESC
// parser-timeout accommodation applies here too, since the wizard's own Esc
// handling goes through the identical `onKeypress` wrapper).
// Shared search-provider test fixtures (flow 179 T3 dispatch note): reused by
// both the flow 179 wizard describe block below and flow 180's
// `pickSearchProviderStep`/`selectSearchProviderAndReport` describe block
// further down (flow 180 T5) — hoisted to file scope, rather than duplicated
// per-block, once a second describe block needed the same fakes.
const SEARXNG_FIELDS: SearchFieldDescriptor[] = [
  { id: "baseUrl", label: "Base URL", required: true, defaultValue: "http://localhost" },
  { id: "port", label: "Port", required: true, defaultValue: "8080" },
];

const SEARXNG_DESCRIPTOR: SearchProviderDescriptor = {
  id: "searxng",
  displayName: "SearXNG",
  kind: "local",
  fields: SEARXNG_FIELDS,
  defaults: { baseUrl: "http://localhost", port: "8080" },
  credentialSchema: { required: false, secret: true },
  documentationUrl: "https://docs.searxng.org/admin/installation.html",
  capabilities: { localLoopback: true, supportsPublicationDate: true },
  testConnection: async () => ({ ok: true }),
  search: async () => ({ query: "", results: [] }),
};

// Stands in for any of the 3 zero-field remote providers (brave/tavily/exa
// in the real registry): 0 fields, a required credential.
const BRAVE_DESCRIPTOR: SearchProviderDescriptor = {
  id: "brave",
  displayName: "Brave Search API",
  kind: "remote",
  fields: [],
  defaults: {},
  credentialSchema: { required: true, label: "Brave Search API key", secret: true },
  documentationUrl: "https://api.search.brave.com/app/documentation",
  capabilities: { localLoopback: false, supportsPublicationDate: false },
  testConnection: async () => ({ ok: true }),
  search: async () => ({ query: "", results: [] }),
};

type SearchControllerCall =
  | { kind: "configure"; providerId: SearchProviderId; fields: Record<string, string>; credential: string | undefined }
  | { kind: "test"; providerId: SearchProviderId }
  | { kind: "select"; providerId: SearchProviderId };

/**
 * Minimal fake `SearchProviderController` (flow 179 T3 dispatch note):
 * records every configure/test/select call and lets each test script
 * `test()`'s result deterministically, rather than driving the real class
 * (which reads/writes the on-disk search-config file).
 */
function fakeSearchProviderController(opts: {
  providers: readonly SearchProviderDescriptor[];
  testResult?: () => SearchConnectionResult;
  selectResult?: SearchSelectionResult;
}): { controller: SearchProviderController; calls: SearchControllerCall[] } {
  const calls: SearchControllerCall[] = [];
  const fake = {
    configurable: (): readonly SearchProviderDescriptor[] => opts.providers,
    configure: (providerId: SearchProviderId, fields: Record<string, string>, credential?: string): void => {
      calls.push({ kind: "configure", providerId, fields, credential });
    },
    test: async (providerId: SearchProviderId): Promise<SearchConnectionResult> => {
      calls.push({ kind: "test", providerId });
      return (opts.testResult ?? (() => ({ ok: true })))();
    },
    select: async (providerId: SearchProviderId): Promise<SearchSelectionResult> => {
      calls.push({ kind: "select", providerId });
      return opts.selectResult ?? { ok: true };
    },
  };
  // `SearchProviderController` is a concrete class with private fields, so
  // TS only structurally accepts a real instance — the fake above has every
  // PUBLIC member the wizard actually calls (configurable/configure/test/
  // select), so the cast is the standard escape for a class-typed fake.
  return { controller: fake as unknown as SearchProviderController, calls };
}

describe("flow 179 — /search-provider bare-arg wizard", () => {
  otuiTest("AC1/AC4: step 1 lists exactly configurable() providers; Esc at step 1 cancels with no controller calls", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const { controller, calls } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR, BRAVE_DESCRIPTOR] });

    const done = searchProviderWizardInTui(otui.core, renderer, controller);
    const step1Frame = await waitForFrame(
      (frame) => frame.includes("searxng (SearXNG)") && frame.includes("brave (Brave Search API)"),
    );
    expect(step1Frame).toContain("Select a search provider");

    await pressEscapeAndSettle({ mockInput, flush });
    await done; // cancels: the wizard's promise resolves without mutating any state

    expect(calls).toEqual([]);
    renderer.destroy();
  });

  otuiTest("AC5: a 0-field provider (brave) skips the fields sub-step straight to the credential prompt", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const { controller, calls } = fakeSearchProviderController({ providers: [BRAVE_DESCRIPTOR] });

    const done = searchProviderWizardInTui(otui.core, renderer, controller);
    await waitForFrame((frame) => frame.includes("brave (Brave Search API)"));
    mockInput.pressEnter(); // brave is the only option
    await flush();

    const credentialFrame = await waitForFrame((frame) => frame.includes("Paste your"));
    expect(credentialFrame).toContain("Brave Search API key"); // credentialSchema.label, not a field prompt

    // Esc at step 2's FIRST sub-step (there are no fields, so credential is
    // first) returns to step 1 (AC5), rather than closing the modal.
    await pressEscapeAndSettle({ mockInput, flush });
    const step1Frame = await waitForFrame((frame) => frame.includes("brave (Brave Search API)"));
    expect(step1Frame).toContain("Select a search provider");

    // Esc at step 1 cancels the whole wizard (AC4).
    await pressEscapeAndSettle({ mockInput, flush });
    await done;

    expect(calls).toEqual([]);
    renderer.destroy();
  });

  otuiTest(
    "AC5: multi-field provider (searxng) walks both fields in order seeded with defaultValue; Esc steps back one sub-step at a time, then to step 1",
    async () => {
      const otui = requireOtui();
      const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
      const { controller, calls } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR] });

      const done = searchProviderWizardInTui(otui.core, renderer, controller);
      await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
      mockInput.pressEnter(); // searxng is the only option
      await flush();

      const baseUrlFrame = await waitForFrame((frame) => frame.includes("Base URL"));
      expect(baseUrlFrame).toContain("http://localhost"); // seeded with defaultValue
      mockInput.pressEnter(); // accept the default baseUrl
      await flush();

      const portFrame = await waitForFrame((frame) => frame.includes("Port"));
      expect(portFrame).toContain("8080"); // seeded with defaultValue
      mockInput.pressEnter(); // accept the default port
      await flush();

      await waitForFrame((frame) => frame.includes("Set as active provider"));

      // Esc at the toggle goes back one sub-step: the port field (not closing the modal).
      await pressEscapeAndSettle({ mockInput, flush });
      const portAgain = await waitForFrame((frame) => frame.includes("Port"));
      expect(portAgain).toContain("8080");

      // Esc at the port field goes back one sub-step: the base URL field.
      await pressEscapeAndSettle({ mockInput, flush });
      const baseUrlAgain = await waitForFrame((frame) => frame.includes("Base URL"));
      expect(baseUrlAgain).toContain("http://localhost");

      // Esc at step 2's FIRST sub-step returns to step 1 (AC5).
      await pressEscapeAndSettle({ mockInput, flush });
      const step1Frame = await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
      expect(step1Frame).toContain("Select a search provider");

      // Esc at step 1 cancels the whole wizard (AC4).
      await pressEscapeAndSettle({ mockInput, flush });
      await done;

      expect(calls).toEqual([]);
      renderer.destroy();
    },
  );

  otuiTest("AC6: success path with the active toggle set to Yes calls configure() -> test() -> select() with the provider id", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const { controller, calls } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR] });

    const done = searchProviderWizardInTui(otui.core, renderer, controller);
    await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
    mockInput.pressEnter(); // searxng
    await flush();
    await waitForFrame((frame) => frame.includes("Base URL"));
    mockInput.pressEnter(); // accept default baseUrl
    await flush();
    await waitForFrame((frame) => frame.includes("Port"));
    mockInput.pressEnter(); // accept default port
    await flush();
    await waitForFrame((frame) => frame.includes("Set as active provider"));
    mockInput.pressEnter(); // "Yes" is the default-selected first option
    await flush();

    const successFrame = await waitForFrame((frame) => frame.includes("configured, tested, and set as active"));
    expect(successFrame).toContain("'searxng'");
    mockInput.pressEnter(); // close on success
    await flush();
    await done;

    // The exact call `/search-connect` already makes: `select(providerId)`.
    expect(calls).toEqual([
      { kind: "configure", providerId: "searxng", fields: { baseUrl: "http://localhost", port: "8080" }, credential: undefined },
      { kind: "test", providerId: "searxng" },
      { kind: "select", providerId: "searxng" },
    ]);
    renderer.destroy();
  });

  otuiTest("AC6: success path with the active toggle set to No calls configure() -> test(), never calls select()", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const { controller, calls } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR] });

    const done = searchProviderWizardInTui(otui.core, renderer, controller);
    await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
    mockInput.pressEnter(); // searxng
    await flush();
    await waitForFrame((frame) => frame.includes("Base URL"));
    mockInput.pressEnter(); // accept default baseUrl
    await flush();
    await waitForFrame((frame) => frame.includes("Port"));
    mockInput.pressEnter(); // accept default port
    await flush();
    await waitForFrame((frame) => frame.includes("Set as active provider"));
    mockInput.pressArrow("down"); // move off "Yes" onto "No"
    mockInput.pressEnter();
    await flush();

    const successFrame = await waitForFrame((frame) => frame.includes("configured and tested successfully"));
    expect(successFrame).toContain("'searxng'");
    mockInput.pressEnter(); // close on success
    await flush();
    await done;

    expect(calls.map((call) => call.kind)).toEqual(["configure", "test"]);
    renderer.destroy();
  });

  otuiTest(
    "AC6/AC7: failure path shows the failure reason; Esc -> retry re-enters step 2 at the FIRST sub-step with previously entered values preserved as seeds",
    async () => {
      const otui = requireOtui();
      const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
      const { controller, calls } = fakeSearchProviderController({
        providers: [SEARXNG_DESCRIPTOR],
        testResult: () => ({ ok: false, reason: "transport-failed" }),
      });

      const done = searchProviderWizardInTui(otui.core, renderer, controller);
      await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
      mockInput.pressEnter(); // searxng
      await flush();
      await waitForFrame((frame) => frame.includes("Base URL"));
      mockInput.pressEnter(); // accept default baseUrl
      await flush();
      await waitForFrame((frame) => frame.includes("Port"));
      await mockInput.typeText("9"); // cursor sits after the seeded "8080" -> "80809"
      mockInput.pressEnter();
      await flush();
      await waitForFrame((frame) => frame.includes("Set as active provider"));
      mockInput.pressArrow("down"); // "No" — keep this test focused on the failure/retry path
      mockInput.pressEnter();
      await flush();

      const failureFrame = await waitForFrame((frame) => frame.includes("test failed"));
      expect(failureFrame).toContain("connection validation failed");
      expect(failureFrame).toContain("Esc to go back and retry");

      await pressEscapeAndSettle({ mockInput, flush }); // "retry": re-enters step 2

      // Retry lands on the FIRST sub-step (base URL) — NOT the port field or
      // the toggle the user was last on.
      const retryFrame = await waitForFrame((frame) => frame.includes("Base URL"));
      expect(retryFrame).toContain("http://localhost");
      mockInput.pressEnter(); // accept baseUrl again
      await flush();

      const portRetryFrame = await waitForFrame((frame) => frame.includes("Port"));
      expect(portRetryFrame).toContain("80809"); // the previously entered value, preserved as the seed

      // Cleanly end the wizard: back out to step 1, then cancel.
      await pressEscapeAndSettle({ mockInput, flush }); // port -> base URL
      await pressEscapeAndSettle({ mockInput, flush }); // base URL -> step 1
      const step1Frame = await waitForFrame((frame) => frame.includes("searxng (SearXNG)"));
      expect(step1Frame).toContain("Select a search provider");
      await pressEscapeAndSettle({ mockInput, flush }); // cancel
      await done;

      expect(calls.filter((call) => call.kind === "test")).toHaveLength(1);
      expect(calls.filter((call) => call.kind === "configure")).toHaveLength(1);
      renderer.destroy();
    },
  );
});

// --- flow 180 — tui-shell.ts bare `/search-connect` interactive picker
// (source-text audit) ----------------------------------------------------
//
// `launchTuiAgentShell` has no headless injection seam (same file-wide
// constraint the SLATE-2a/SLATE-3a/SLATE-15/flow 163 AC8/flow 173
// describe blocks above document and rely on) — its `/search-connect`
// branch (tui-shell.ts, inside the giant command-dispatch closure) cannot
// be driven through a real `otuiTest`/`mockInput`/`waitForFrame` pipeline
// from this file, so this is a source-text audit, following the exact
// precedent those blocks set.
//
// This does NOT mean the picker's interactive behavior (renders exactly
// the given provider list, Esc resolves `undefined`, selecting resolves
// the chosen descriptor) goes unproven: flow 180 T2 (commit 55a9997)
// reused `pickSearchProviderStep` UNCHANGED from flow 179 — the exact same
// function, only ever called here with a different `providers` argument
// (`selectable()` instead of `configurable()`) — and flow 179's own
// "AC1/AC4: step 1 lists exactly configurable() providers; Esc at step 1
// cancels with no controller calls" test (above) already drives that
// generic list/Esc/select behavior through the real SelectRenderable/
// onKeypress pipeline. Re-driving the same generic behavior here would
// duplicate that coverage without touching flow 179's own tests/code
// (out of scope per this flow's dispatch). What this audit proves instead
// is flow 180's actual NEW surface: the bare-arg WIRING around that
// reused function (which list it is called with, what happens with the
// Esc/selected result, the empty-list guard, and the args-given path
// staying byte-identical).
//
// Historical note: at T3 time (commit 71c28de), `pickSearchProviderStep`
// and `selectSearchProviderAndReport` were unexported, which forced this
// block to fall back to a source-text audit for their generic list/Esc/
// select behavior too. Flow 180 T5 (commit 2cba647) exported both — purely
// additive, the same pattern already used for `searchProviderWizardInTui`,
// `pickShellApproval`, `adaptiveSelectHeight`, `selectBoxHeight`, and
// `filterConnectedDetectedProviders` — and added the "flow 180 T5 —
// pickSearchProviderStep (real key-driven interaction)" and "flow 180 T5 —
// selectSearchProviderAndReport (real function invocation)" describe
// blocks below, which drive both functions through the real interactive
// pipeline instead of an audit. This block itself is intentionally left
// in place: it still proves flow 180's actual NEW surface — the bare-arg
// WIRING around the reused function — which this file still has no
// headless seam to drive interactively (same SLATE-2a/SLATE-3a/SLATE-15/
// flow 163 AC8/flow 173 constraint).
describe("flow 180 — tui-shell.ts /search-connect bare-arg picker wiring (source-text audit)", () => {
  const tuiSource = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const branchIdx = tuiSource.indexOf('if (command.name === "/search-connect") {');
  const nextBranchIdx = tuiSource.indexOf('if (command.name === "/think")');
  const branchBlock = tuiSource.slice(branchIdx, nextBranchIdx);

  test("the /search-connect branch exists exactly once", () => {
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(tuiSource.indexOf('if (command.name === "/search-connect") {', branchIdx + 1)).toBe(-1);
  });

  test("AC1: bare-arg branch reads searchProviderController.selectable() (not configurable()) as the picker's candidate list", () => {
    expect(branchBlock).toContain("const selectable = searchProviderController.selectable();");
  });

  test("AC1: 1+ connected providers opens the picker via chrome.withOverlay(() => pickSearchProviderStep(otui, r, selectable))", () => {
    expect(branchBlock).toContain("chrome.withOverlay(() => pickSearchProviderStep(otui, r, selectable))");
  });

  test("AC3: an empty selectable() list shows the existing 'no connected providers' message and returns before the picker call", () => {
    const emptyGuardIdx = branchBlock.indexOf("if (selectable.length === 0) {");
    expect(emptyGuardIdx).toBeGreaterThanOrEqual(0);
    const pickerCallIdx = branchBlock.indexOf("pickSearchProviderStep(otui, r, selectable)");
    expect(pickerCallIdx).toBeGreaterThan(emptyGuardIdx); // the picker call textually follows the empty-guard block

    const emptyGuardBlock = branchBlock.slice(emptyGuardIdx, pickerCallIdx);
    expect(emptyGuardBlock).toContain("No connected search providers found. Run /search-provider first.");
    expect(emptyGuardBlock).toContain("return;");
    // Confirms the empty-guard's own body never reaches the picker call —
    // the only occurrence inside this slice would be a genuine wiring bug.
    expect(emptyGuardBlock).not.toContain("pickSearchProviderStep(otui, r, selectable)");
  });

  test("AC2: Esc (picked === undefined) returns before selectSearchProviderAndReport/select is ever called", () => {
    const pickedIdx = branchBlock.indexOf("const picked = await chrome.withOverlay");
    expect(pickedIdx).toBeGreaterThanOrEqual(0);
    const escGuardIdx = branchBlock.indexOf("if (picked === undefined) {", pickedIdx);
    expect(escGuardIdx).toBeGreaterThanOrEqual(0);
    const reportCallIdx = branchBlock.indexOf("selectSearchProviderAndReport(searchProviderController, io.onSystem, picked.id)");
    expect(reportCallIdx).toBeGreaterThan(escGuardIdx); // the report/select call textually follows the Esc guard

    const escGuardBlock = branchBlock.slice(escGuardIdx, reportCallIdx);
    expect(escGuardBlock).toContain("return;"); // Esc branch returns, skipping the call below entirely
  });

  test("AC2: selecting a provider in the picker routes through the shared selectSearchProviderAndReport(controller, onSystem, id) helper", () => {
    expect(branchBlock).toContain("await selectSearchProviderAndReport(searchProviderController, io.onSystem, picked.id);");
  });

  test("AC4: /search-connect <id> (args given) still resolves the id via configurable() and routes through the SAME shared helper", () => {
    const argsGivenIdx = branchBlock.indexOf("const normalizedProviderId = searchProviderController.configurable()");
    expect(argsGivenIdx).toBeGreaterThanOrEqual(0);
    const argsGivenBlock = branchBlock.slice(argsGivenIdx);
    expect(argsGivenBlock).toContain("Unknown provider '${providerId}'.");
    expect(argsGivenBlock).toContain("await selectSearchProviderAndReport(searchProviderController, io.onSystem, normalizedProviderId);");
  });

  test("AC5: /search-provider's own bare/args-given branches are untouched — this flow only wires /search-connect", () => {
    const searchProviderBranchIdx = tuiSource.indexOf('if (command.name === "/search-provider") {');
    expect(searchProviderBranchIdx).toBeGreaterThanOrEqual(0);
    expect(searchProviderBranchIdx).toBeLessThan(branchIdx); // /search-provider's branch precedes /search-connect's, unmoved
    const searchProviderBlock = tuiSource.slice(searchProviderBranchIdx, branchIdx);
    expect(searchProviderBlock).toContain("searchProviderWizardInTui(otui, r, searchProviderController)");
    // The wizard's own entry point is untouched by flow 180 — no picker/select wiring added here.
    expect(searchProviderBlock).not.toContain("selectSearchProviderAndReport");
  });
});

// --- flow 180 T5 — pickSearchProviderStep / selectSearchProviderAndReport,
// driven for real ------------------------------------------------------
//
// T3 (commit 71c28de) left these as source-text audits because neither
// function was exported. Flow 180 T5 exported both (purely additive — the
// same precedent as `searchProviderWizardInTui`, `pickShellApproval`,
// `adaptiveSelectHeight`, `selectBoxHeight`, and
// `filterConnectedDetectedProviders`, all exported in this file only for
// test access) so this block can drive them directly instead: the picker
// through the real `SelectRenderable`/`onKeypress` pipeline (same seam as
// flow 179's own describe block above, reusing its `fakeSearchProviderController`
// fixture), and the helper by calling the real exported function and
// inspecting the `onSystem` messages it actually emits.
//
// This does NOT touch the separate "flow 180 — tui-shell.ts /search-connect
// bare-arg picker wiring (source-text audit)" describe block above: that one
// covers the OUTER command-string dispatch inside `launchTuiAgentShell`'s
// closure, which still has no test seam in this file (unchanged precedent).
describe("flow 180 T5 — pickSearchProviderStep (real key-driven interaction)", () => {
  otuiTest("renders exactly the given providers; Enter resolves the picked descriptor", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const providers = [SEARXNG_DESCRIPTOR, BRAVE_DESCRIPTOR];

    const resultPromise = pickSearchProviderStep(otui.core, renderer, providers);
    const frame = await waitForFrame(
      (f) => f.includes("searxng (SearXNG)") && f.includes("brave (Brave Search API)"),
    );
    expect(frame).toContain("Select a search provider");

    mockInput.pressEnter(); // "searxng (SearXNG)" is the first/default-selected option
    await flush();
    const picked = await resultPromise;

    expect(picked).toEqual(SEARXNG_DESCRIPTOR);
    renderer.destroy();
  });

  otuiTest("Enter after moving down the list resolves the descriptor actually highlighted, not just the first one", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const providers = [SEARXNG_DESCRIPTOR, BRAVE_DESCRIPTOR];

    const resultPromise = pickSearchProviderStep(otui.core, renderer, providers);
    await waitForFrame((f) => f.includes("brave (Brave Search API)"));
    mockInput.pressArrow("down"); // move off searxng onto brave
    mockInput.pressEnter();
    await flush();
    const picked = await resultPromise;

    expect(picked).toEqual(BRAVE_DESCRIPTOR);
    renderer.destroy();
  });

  otuiTest("Esc resolves undefined (AC2 cancel path) with no descriptor picked", async () => {
    const otui = requireOtui();
    const { renderer, mockInput, flush, waitForFrame } = await otui.testing.createTestRenderer({ width: 100, height: 30 });
    const providers = [SEARXNG_DESCRIPTOR];

    const resultPromise = pickSearchProviderStep(otui.core, renderer, providers);
    await waitForFrame((f) => f.includes("searxng (SearXNG)"));
    await pressEscapeAndSettle({ mockInput, flush });
    const picked = await resultPromise;

    expect(picked).toBeUndefined();
    renderer.destroy();
  });
});

describe("flow 180 T5 — selectSearchProviderAndReport (real function invocation)", () => {
  test("calls controller.select(providerId) and emits the exact success message /search-connect <id> already used", async () => {
    const { controller, calls } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR] });
    const messages: string[] = [];

    await selectSearchProviderAndReport(controller, (text) => messages.push(text), "searxng");

    expect(calls).toEqual([{ kind: "select", providerId: "searxng" }]);
    expect(messages).toEqual(["Search provider 'searxng' selected.\n"]);
  });

  test("failure/not-configured: emits the not-configured message and resolves without throwing", async () => {
    const { controller } = fakeSearchProviderController({
      providers: [SEARXNG_DESCRIPTOR],
      selectResult: { ok: false, reason: "not-configured" },
    });
    const messages: string[] = [];

    await expect(
      selectSearchProviderAndReport(controller, (text) => messages.push(text), "searxng"),
    ).resolves.toBeUndefined();

    expect(messages).toEqual(["Cannot select 'searxng': provider is not configured.\n"]);
  });

  test("failure/not-connected: emits the not-connected message with the retry hint and resolves without throwing", async () => {
    const { controller } = fakeSearchProviderController({
      providers: [SEARXNG_DESCRIPTOR],
      selectResult: { ok: false, reason: "not-connected" },
    });
    const messages: string[] = [];

    await expect(
      selectSearchProviderAndReport(controller, (text) => messages.push(text), "searxng"),
    ).resolves.toBeUndefined();

    expect(messages).toEqual([
      "Cannot select 'searxng': provider is not connected (run /search-provider searxng <params> to test).\n",
    ]);
  });

  test("failure/other reason: falls back to the generic reason message and resolves without throwing", async () => {
    // `SearchSelectionResult`'s public type only allows "not-configured" |
    // "not-connected", so the generic fallback branch is exercised the same
    // way the fake controller itself is faked: cast past the narrow type to
    // reach the defensive `else` branch in `selectSearchProviderAndReport`.
    const { controller } = fakeSearchProviderController({
      providers: [SEARXNG_DESCRIPTOR],
      selectResult: { ok: false, reason: "quota-exceeded" } as unknown as SearchSelectionResult,
    });
    const messages: string[] = [];

    await expect(
      selectSearchProviderAndReport(controller, (text) => messages.push(text), "searxng"),
    ).resolves.toBeUndefined();

    expect(messages).toEqual(["Cannot select 'searxng': quota-exceeded.\n"]);
  });

  test("no onSystem callback provided: still resolves without throwing", async () => {
    const { controller } = fakeSearchProviderController({ providers: [SEARXNG_DESCRIPTOR] });

    await expect(selectSearchProviderAndReport(controller, undefined, "searxng")).resolves.toBeUndefined();
  });
});

// The complete OpenTUI REPL is not mountable under the unit harness. As with
// the nearby /goal and exit coverage, this pins the lifecycle wiring here while
// the provider/wiki suites exercise the cancellable work itself.
describe("flow 219 — foreground operation lifecycle wiring (source-text audit)", () => {
  const source = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("normal turns and in-process wiki work use one identity-safe foreground owner", () => {
    expect(source.includes("foregroundOperation")).toBe(true);
    expect(source.includes("mainTurnAbortController")).toBe(false);
    expect(source).toMatch(/runAgentTurn\([\s\S]{0,250}signal:\s*foregroundOperation\.signal/);
    expect(source).toMatch(/wikiEnrich\([\s\S]{0,500}signal:\s*foregroundOperation\.signal/);
  });

  test("Force removes its selected item, cancels the active operation, and waits for settlement before priority dispatch", () => {
    const start = source.indexOf("const forceMainQueue =");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 1_400);
    expect(block).toContain("mainQueue = removeMainQueueItem(mainQueue, index)");
    expect(block).toMatch(/foregroundOperation\.cancel\(/);
    expect(block).toMatch(/await\s+foregroundOperation\.(settled|whenSettled)\(/);
    expect(block).toMatch(/priorityMainQuestion[\s\S]{0,250}runLine\(/);
  });

  test("busy exit and renderer destruction cancel before disposal and cannot drain queued work afterwards", () => {
    const busyExit = source.slice(source.indexOf('case "exit": {'), source.indexOf('case "exit": {') + 1_200);
    const onDestroy = source.slice(source.indexOf("onDestroy: () => {"), source.indexOf("onDestroy: () => {") + 1_200);
    expect(busyExit).toMatch(/foregroundOperation\.cancel\(/);
    expect(onDestroy).toMatch(/foregroundOperation\.cancel\(/);
    expect(onDestroy).toMatch(/foregroundOperation\.dispose\(\)|foregroundOperation\.destroy\(\)/);
  });
});
