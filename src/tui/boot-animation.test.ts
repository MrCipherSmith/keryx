// Flow 266 P1 — headless coverage for the boot animation, against the real
// `@opentui/core` test renderer (mirrors `shell-chrome.test.ts`'s harness),
// not a replica of its layout math.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  centerWrappedLines,
  createSplashLifecycle,
  DEFAULT_BOOT_DURATION_MS,
  hardWrapLines,
  mountEmptyTranscriptSplash,
  mountStartupIndicator,
  playBootAnimation,
  SPLASH_HELP_HINT,
  SPLASH_HINT,
  type SplashHandle,
} from "./boot-animation";
import { onKeypress } from "./tui-shell";

async function loadOpenTui(): Promise<
  | {
      core: typeof import("@opentui/core");
      testing: typeof import("@opentui/core/testing");
    }
  | undefined
> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

otuiTest("renders the wordmark, then auto-unmounts once durationMs elapses", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 40, height: 12 });

  const done = playBootAnimation(otui.core, setup.renderer, {
    onKeypress: (handler) => onKeypress(setup.renderer, handler),
    durationMs: 200,
  });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("K E R Y X");

  await done;
  await setup.flush();
  expect(setup.captureCharFrame()).not.toContain("K E R Y X");

  setup.renderer.destroy();
});

otuiTest("any keypress skips the animation immediately, before durationMs elapses", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 40, height: 12 });

  const done = playBootAnimation(otui.core, setup.renderer, {
    onKeypress: (handler) => onKeypress(setup.renderer, handler),
    durationMs: 5_000, // long enough that only the skip can resolve this in a test
  });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("K E R Y X");

  await setup.mockInput.pressKeys(["x"]);
  await done; // would hang the test (and fail its timeout) if the skip path were broken

  setup.renderer.destroy();
});

otuiTest("KERYX_SKIP_BOOT=1 resolves without mounting anything, for the pty smoke test", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 40, height: 12 });
  const previous = process.env.KERYX_SKIP_BOOT;
  process.env.KERYX_SKIP_BOOT = "1";
  try {
    await playBootAnimation(otui.core, setup.renderer, {
      onKeypress: (handler) => onKeypress(setup.renderer, handler),
      durationMs: DEFAULT_BOOT_DURATION_MS,
    });
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("K E R Y X");
  } finally {
    if (previous === undefined) {
      delete process.env.KERYX_SKIP_BOOT;
    } else {
      process.env.KERYX_SKIP_BOOT = previous;
    }
  }
  setup.renderer.destroy();
});

otuiTest("opts.skip=true resolves without mounting anything, independent of the env var", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 40, height: 12 });

  await playBootAnimation(otui.core, setup.renderer, {
    onKeypress: (handler) => onKeypress(setup.renderer, handler),
    durationMs: DEFAULT_BOOT_DURATION_MS,
    skip: true,
  });
  await setup.flush();
  expect(setup.captureCharFrame()).not.toContain("K E R Y X");

  setup.renderer.destroy();
});

// --- flow 270 AC10 -----------------------------------------------------------

otuiTest("the boot animation shows no loading steps: it did no work behind them", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 60, height: 12 });

  const done = playBootAnimation(otui.core, setup.renderer, {
    onKeypress: (handler) => onKeypress(setup.renderer, handler),
    durationMs: 200,
  });
  await setup.flush();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("K E R Y X");
  for (const fake of ["Reading .metaproject index", "Connecting provider", "Warming graph"]) {
    expect(frame).not.toContain(fake);
  }
  await done;
  setup.renderer.destroy();
});

otuiTest("the empty-transcript wordmark stays until removed, centred, and removing twice is safe", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 80, height: 30 });
  const transcript = new otui.core.BoxRenderable(setup.renderer, { id: "transcript-fixture", width: "100%", flexDirection: "column" });
  setup.renderer.root.add(transcript);

  const splash = mountEmptyTranscriptSplash(otui.core, setup.renderer, transcript);
  await setup.flush();
  const lines = setup.captureCharFrame().split("\n");
  const wordmarkRow = lines.findIndex((line) => line.includes("K E R Y X"));
  expect(wordmarkRow).toBeGreaterThan(3); // pushed down from the top of the pane
  const left = (lines[wordmarkRow] ?? "").indexOf("K E R Y X");
  const right = 80 - (left + "K E R Y X".length);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(4); // horizontally centred in the 80-column pane
  expect(setup.captureCharFrame()).toContain(SPLASH_HINT);

  splash.remove();
  splash.remove();
  await setup.flush();
  expect(setup.captureCharFrame()).not.toContain("K E R Y X");
  setup.renderer.destroy();
});

// Flow 277 (shell god-file split, P2): `tui-shell.ts` used to hold a bare
// `let removeSplash` toggled at three call sites, pinned only by the
// source-text audit this replaces (see the git history of this file for the
// old version) — a 1400-char magic window anchored on `runLine`'s
// declaration, fragile to any code inserted between the anchor and the
// `removeSplash?.()` call it was hunting for. The mount decision and the
// "removed at most once" contract are now `createSplashLifecycle`, proven
// directly below with a fake `mount` — no renderer, no source text.
describe("createSplashLifecycle (flow 270 AC10; flow 277 P2)", () => {
  function fakeMount(log: string[]): () => SplashHandle {
    return () => {
      log.push("mount");
      let removed = false;
      return {
        remove(): void {
          if (removed) return;
          removed = true;
          log.push("remove");
        },
        addStatus(text: string): void {
          log.push("status:" + text);
        },
      };
    };
  }

  test("a genuinely empty session (history.length === 0) mounts immediately", () => {
    const log: string[] = [];
    createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 0 });
    expect(log).toEqual(["mount"]);
  });

  test("BOUNDARY — a session with existing history never mounts at all", () => {
    // Distinguishes a real length check from a stub that always mounts.
    const log: string[] = [];
    const lifecycle = createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 5 });
    expect(log).toEqual([]);
    lifecycle.removeIfShown(); // still a safe no-op — nothing was ever mounted
    expect(log).toEqual([]);
  });

  test("removeIfShown tears down a mounted splash exactly once, even called twice", () => {
    const log: string[] = [];
    const lifecycle = createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 0 });
    lifecycle.removeIfShown();
    lifecycle.removeIfShown();
    expect(log).toEqual(["mount", "remove"]);
  });

  test("addStatusIfShown paints into the splash and reports that it did", () => {
    const log: string[] = [];
    const lifecycle = createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 0 });
    expect(lifecycle.addStatusIfShown("bus: joined as @agent-1 · 0 peers")).toBe(true);
    expect(log).toEqual(["mount", "status:bus: joined as @agent-1 · 0 peers"]);
  });

  test("BOUNDARY — after teardown it reports false, so the caller keeps its own line", () => {
    const log: string[] = [];
    const lifecycle = createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 0 });
    lifecycle.removeIfShown();
    expect(lifecycle.addStatusIfShown("bus: joined as @agent-1 · 0 peers")).toBe(false);
    expect(log).toEqual(["mount", "remove"]);
  });

  test("BOUNDARY — a session with history has no splash to paint a status into", () => {
    const log: string[] = [];
    const lifecycle = createSplashLifecycle({ mount: fakeMount(log), initialHistoryLength: 3 });
    expect(lifecycle.addStatusIfShown("bus: joined as @agent-1 · 0 peers")).toBe(false);
    expect(log).toEqual([]);
  });
});

test("the shell wires createSplashLifecycle at startup, opened-with-history, and the first operator line", () => {
  // Flow 277 (P2): anchored on the extracted symbol's name rather than the
  // three call sites' surrounding statements, so reformatting any of them no
  // longer breaks this — the mount/remove CONTRACT itself is proven above,
  // against the real function, not by reading tui-shell.ts.
  const source = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  expect(source).toContain("splash = createSplashLifecycle({");
  expect((source.match(/splash\??\.removeIfShown\(\);/g) ?? []).length).toBeGreaterThanOrEqual(3);
  // The bus-joined notice is painted into the splash while it is up, and only
  // falls back to a transcript line once it is gone (`addStatusIfShown`).
  expect(source).toContain("splash?.addStatusIfShown(");
});

// The narrow-pane bug: at a realistic terminal width the hint and the
// bus-joined line are WIDER than the transcript pane, so the renderer wrapped
// them itself and every row after the first landed flush left.
describe("splash wrapping (narrow-pane centring)", () => {
  test("a line that fits comes back as exactly one row", () => {
    expect(centerWrappedLines("hello world", 40)).toEqual(["hello world"]);
  });

  test("BOUNDARY — a line exactly as wide as the pane stays ONE row", () => {
    const exact = "x".repeat(20);
    expect(centerWrappedLines(exact, 20)).toEqual([exact]);
  });

  test("no produced row is ever wider than the pane — the invariant centring needs", () => {
    for (const width of [8, 12, 19, 24, 40]) {
      for (const row of centerWrappedLines(SPLASH_HINT, width)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a word longer than the pane is hard-split instead of overflowing", () => {
    expect(centerWrappedLines("aaaaaa bb", 4)).toEqual(["aaaa", "aa", "bb"]);
  });

  test("hardWrapLines preserves blank rows and wraps without re-flowing", () => {
    expect(hardWrapLines("ab\n\ncd", 10)).toEqual(["ab", "", "cd"]);
    expect(hardWrapLines("x".repeat(9), 4)).toEqual(["xxxx", "xxxx", "x"]);
  });
});

// Flow 303 (AC13): a new user's start screen names `/help`.
otuiTest("the start screen shows the /help hint, in the same theme colour as the existing hint, within the pane width", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 80, height: 30 });
  const transcript = new otui.core.BoxRenderable(setup.renderer, { id: "transcript-fixture", width: "100%", flexDirection: "column" });
  setup.renderer.root.add(transcript);

  const splash = mountEmptyTranscriptSplash(otui.core, setup.renderer, transcript);
  await setup.flush();

  const frame = setup.captureCharFrame();
  expect(frame).toContain(SPLASH_HELP_HINT);
  expect(frame).toContain("/help");
  for (const line of frame.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(80);
  }

  // Same styling as the existing hint (both `dimChunk`) — a real theme colour,
  // not a hardcoded one, and consistent with the rest of the start screen.
  type Node = { getChildren(): Node[]; content?: { chunks?: Array<{ text?: string; fg?: unknown }> } };
  const findByText = (root: Node, needle: string): unknown => {
    for (const chunk of root.content?.chunks ?? []) {
      if (chunk.text?.includes(needle) === true) {
        return chunk.fg;
      }
    }
    for (const child of root.getChildren()) {
      const found = findByText(child, needle);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const root = setup.renderer.root as unknown as Node;
  const hintColor = findByText(root, "type a message to start");
  const helpHintColor = findByText(root, "/help");
  expect(hintColor).toBeDefined();
  expect(helpHintColor).toBeDefined();
  expect(helpHintColor).toEqual(hintColor);

  splash.remove();
  setup.renderer.destroy();
});

// Flow 303 (AC14): the gap between the boot animation closing and the chrome
// being ready never shows a blank screen — a loading indicator with a short
// step label stays up instead, and a slow injected startup step proves it.
describe("mountStartupIndicator (AC14)", () => {
  otuiTest("shows the initial label immediately, in theme colours", async () => {
    const otui = requireOtui();
    const setup = await otui.testing.createTestRenderer({ width: 60, height: 20 });
    const ticks: Array<() => void> = [];
    const handle = mountStartupIndicator(otui.core, setup.renderer, "Preparing your session…", {
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: () => {},
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Preparing your session…");
    handle.remove();
    setup.renderer.destroy();
  });

  otuiTest("setStep replaces the label", async () => {
    const otui = requireOtui();
    const setup = await otui.testing.createTestRenderer({ width: 60, height: 20 });
    const handle = mountStartupIndicator(otui.core, setup.renderer, "Preparing your session…", {
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Preparing your session…");

    handle.setStep("Loading agent tools and MCP servers…");
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Loading agent tools and MCP servers…");
    expect(frame).not.toContain("Preparing your session…");

    handle.remove();
    setup.renderer.destroy();
  });

  otuiTest("remove tears it down, and a second remove is a safe no-op", async () => {
    const otui = requireOtui();
    const setup = await otui.testing.createTestRenderer({ width: 60, height: 20 });
    const cleared: unknown[] = [];
    const handle = mountStartupIndicator(otui.core, setup.renderer, "Starting…", {
      setInterval: () => "timer-handle",
      clearInterval: (h) => cleared.push(h),
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Starting…");

    handle.remove();
    handle.remove();
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("Starting…");
    expect(cleared).toEqual(["timer-handle"]);
    setup.renderer.destroy();
  });

  otuiTest("the spinner glyph advances on each injected tick, without waiting on real time", async () => {
    const otui = requireOtui();
    const setup = await otui.testing.createTestRenderer({ width: 60, height: 20 });
    let tick: (() => void) | undefined;
    const handle = mountStartupIndicator(otui.core, setup.renderer, "Loading…", {
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    await setup.flush();
    const first = setup.captureCharFrame();
    expect(first).toContain("Loading…");

    tick?.();
    await setup.flush();
    const second = setup.captureCharFrame();
    expect(second).toContain("Loading…");
    // The spinner glyph itself changed, even though the label did not.
    expect(second).not.toBe(first);

    handle.remove();
    setup.renderer.destroy();
  });

  // The literal AC14 test: "an injected slow startup step" proves the
  // indicator is on screen while startup is pending and gone once it
  // completes — the same mount/remove sequence `launchTuiAgentShell` wires
  // around its own slow step (`opts.makeAgentDeps`).
  otuiTest("is on screen while an injected slow startup step is pending, and gone once it resolves", async () => {
    const otui = requireOtui();
    const setup = await otui.testing.createTestRenderer({ width: 60, height: 20 });

    let resolveSlowStep: (() => void) | undefined;
    const slowStartupStep = new Promise<void>((resolve) => {
      resolveSlowStep = resolve;
    });

    const handle = mountStartupIndicator(otui.core, setup.renderer, "Loading agent tools and MCP servers…", {
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Loading agent tools and MCP servers…");

    const startupDone = slowStartupStep.then(() => {
      handle.remove();
    });

    // Still pending: the indicator is still on screen — this is the exact
    // regression the operator reported (a blank screen while this runs).
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Loading agent tools and MCP servers…");

    resolveSlowStep?.();
    await startupDone;
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("Loading agent tools and MCP servers…");

    setup.renderer.destroy();
  });
});

otuiTest("a resize re-wraps the splash at the NEW width instead of leaving it clipped", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 20 });
  const transcript = new otui.core.BoxRenderable(setup.renderer, {
    id: "transcript-fixture",
    width: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  setup.renderer.root.add(transcript);
  const splash = mountEmptyTranscriptSplash(otui.core, setup.renderer, transcript);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain(SPLASH_HINT); // fits on one row at 88 columns

  setup.renderer.resize(34, 20);
  await setup.flush();
  // The pane is now 32 columns, so the hint MUST have been re-broken over
  // several rows. Losing its tail means the rows are still wrapped for the old,
  // wider pane and merely clipped at the new edge — the defect the renderer RESIZE
  // event cannot fix on its own, because it fires BEFORE the layout is recomputed.
  const frame = setup.captureCharFrame();
  expect(frame).toContain("commands");
  for (const line of frame.split("\n")) {
    if (line.trim().length === 0) continue;
    const left = line.length - line.trimStart().length;
    expect(Math.abs(left - (34 - line.trimEnd().length))).toBeLessThanOrEqual(3);
  }

  splash.remove();
  setup.renderer.destroy();
});

otuiTest("at a narrow width the hint and a status line are centred, not flush-left", async () => {
  const otui = requireOtui();
  const setup = await otui.testing.createTestRenderer({ width: 40, height: 20 });
  const transcript = new otui.core.BoxRenderable(setup.renderer, {
    id: "transcript-fixture",
    width: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  setup.renderer.root.add(transcript);

  const splash = mountEmptyTranscriptSplash(otui.core, setup.renderer, transcript);
  splash.addStatus("bus: joined as @agent-1 · 0 peers (requested name was taken; renamed)");
  await setup.flush();

  const lines = setup.captureCharFrame().split("\n");
  // The status line really did wrap — otherwise this proves nothing.
  expect(lines.filter((l) => l.includes("bus: joined") || l.includes("requested name")).length).toBeGreaterThan(1);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const left = line.length - line.trimStart().length;
    const rightGap = 40 - line.trimEnd().length;
    expect(Math.abs(left - rightGap)).toBeLessThanOrEqual(3); // centred to within a column
  }

  splash.remove();
  splash.remove();
  await setup.flush();
  expect(setup.captureCharFrame()).not.toContain("K E R Y X");
  setup.renderer.destroy();
});
