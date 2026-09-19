// Flow 266 P1 — headless coverage for the boot animation, against the real
// `@opentui/core` test renderer (mirrors `shell-chrome.test.ts`'s harness),
// not a replica of its layout math.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BOOT_DURATION_MS, mountEmptyTranscriptSplash, playBootAnimation, SPLASH_HINT } from "./boot-animation";
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

  const remove = mountEmptyTranscriptSplash(otui.core, setup.renderer, transcript);
  await setup.flush();
  const lines = setup.captureCharFrame().split("\n");
  const wordmarkRow = lines.findIndex((line) => line.includes("K E R Y X"));
  expect(wordmarkRow).toBeGreaterThan(3); // pushed down from the top of the pane
  const left = (lines[wordmarkRow] ?? "").indexOf("K E R Y X");
  const right = 80 - (left + "K E R Y X".length);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(4); // horizontally centred in the 80-column pane
  expect(setup.captureCharFrame()).toContain(SPLASH_HINT);

  remove();
  remove();
  await setup.flush();
  expect(setup.captureCharFrame()).not.toContain("K E R Y X");
  setup.renderer.destroy();
});

test("the shell mounts the wordmark only for an empty session and removes it on the first operator line or a session with history", () => {
  const source = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  expect(source).toContain("if (history.length === 0) {\n      removeSplash = mountEmptyTranscriptSplash(otui, r, transcript);");
  expect(source).toMatch(/if \(opened\.history\.length > 0\) \{\n\s+removeSplash\?\.\(\);/);
  // Flow 274 reformatted `runLine`'s signature onto several lines (adding the
  // "bus-message" origin), so a plain indexOf on the single-line signature
  // no longer matches — anchor on just the declaration instead.
  const runLineMatch = source.match(/const runLine = \(/);
  const runLineStart = runLineMatch ? runLineMatch.index! : -1;
  const operatorBlock = source.slice(runLineStart, runLineStart + 1400);
  expect(operatorBlock).toContain("consecutiveAutoWakes = 0;");
  expect(operatorBlock).toContain("removeSplash?.();");
});
