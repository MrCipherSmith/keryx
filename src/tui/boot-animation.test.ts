// Flow 266 P1 — headless coverage for the boot animation, against the real
// `@opentui/core` test renderer (mirrors `shell-chrome.test.ts`'s harness),
// not a replica of its layout math.
import { expect, test } from "bun:test";
import { DEFAULT_BOOT_DURATION_MS, playBootAnimation } from "./boot-animation";
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
