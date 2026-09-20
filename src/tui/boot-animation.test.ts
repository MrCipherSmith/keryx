// Flow 266 P1 — headless coverage for the boot animation, against the real
// `@opentui/core` test renderer (mirrors `shell-chrome.test.ts`'s harness),
// not a replica of its layout math.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSplashLifecycle,
  DEFAULT_BOOT_DURATION_MS,
  mountEmptyTranscriptSplash,
  playBootAnimation,
  SPLASH_HINT,
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

// Flow 277 (shell god-file split, P2): `tui-shell.ts` used to hold a bare
// `let removeSplash` toggled at three call sites, pinned only by the
// source-text audit this replaces (see the git history of this file for the
// old version) — a 1400-char magic window anchored on `runLine`'s
// declaration, fragile to any code inserted between the anchor and the
// `removeSplash?.()` call it was hunting for. The mount decision and the
// "removed at most once" contract are now `createSplashLifecycle`, proven
// directly below with a fake `mount` — no renderer, no source text.
describe("createSplashLifecycle (flow 270 AC10; flow 277 P2)", () => {
  function fakeMount(log: string[]): () => () => void {
    return () => {
      log.push("mount");
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        log.push("remove");
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
});

test("the shell wires createSplashLifecycle at startup, opened-with-history, and the first operator line", () => {
  // Flow 277 (P2): anchored on the extracted symbol's name rather than the
  // three call sites' surrounding statements, so reformatting any of them no
  // longer breaks this — the mount/remove CONTRACT itself is proven above,
  // against the real function, not by reading tui-shell.ts.
  const source = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  expect(source).toContain("splash = createSplashLifecycle({");
  expect((source.match(/splash\??\.removeIfShown\(\);/g) ?? []).length).toBeGreaterThanOrEqual(3);
});
