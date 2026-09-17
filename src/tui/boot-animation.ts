// One-time branded intro shown on `keryx shell --tui` launch, before the
// provider/model picker (flow 266 P1). Built on plain `@opentui/core`
// primitives, injected as a parameter like every other file here (ADR-0005:
// `@opentui/core` is loaded only via dynamic `import()`, never a top-level
// one) — deliberately NOT `@opentui/react`, which would pull React itself in
// as a runtime dependency and break keryx's zero-`dependencies` floor. See
// docs/requirements/keryx-boot-animation/README.md for the full reasoning.
//
// `KERYX_SKIP_BOOT=1` bypasses the animation entirely — the escape hatch for
// `shell-pty-launch.smoke.test.ts`, which spawns the real launch path and
// would otherwise wait out the animation on every run.

import { getTheme } from "./theme";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;

/** OpenTUI keypress event fields this module reads — a narrowed mirror of `tui-shell.ts`'s `KeypressEvent`. */
export type BootKeypressEvent = { name: string; sequence: string };

export type BootAnimationOptions = {
  /**
   * Subscribe to raw keypresses; any key ends the animation immediately.
   * Injected rather than read from `r` directly, mirroring `theme-picker.ts`'s
   * `PresentThemePickerOptions.onKeypress` — keeps this module decoupled from
   * `tui-shell.ts`'s own keypress wiring (`onKeypress`/`_internalKeyInput`)
   * instead of importing back into the file that will call this one.
   */
  onKeypress: (handler: (key: BootKeypressEvent) => void) => () => void;
  /** Total duration before auto-completing, absent a skip. Default: {@link DEFAULT_BOOT_DURATION_MS}. */
  durationMs?: number;
  /**
   * Programmatic skip, same effect as `KERYX_SKIP_BOOT=1` — for a caller that
   * already knows (a test, a future `--no-boot` flag) rather than relying on
   * the environment. Checked in addition to, not instead of, the env var.
   */
  skip?: boolean;
};

/** Exported so a caller (or a future settings surface) can reason about the default without re-reading this file. */
export const DEFAULT_BOOT_DURATION_MS = 350;

const WORDMARK = ["========================", "       K E R Y X        ", "========================"];

const STEPS = ["Reading .metaproject index", "Connecting provider", "Warming graph"];

/**
 * Mount the animation on `r.root`, run it to completion (or until skipped),
 * then unmount. Resolves once the box is gone — the caller's next mount
 * (the provider/model picker, or the chrome) is safe to proceed immediately.
 */
export async function playBootAnimation(otui: OpenTui, r: Renderer, opts: BootAnimationOptions): Promise<void> {
  if (process.env.KERYX_SKIP_BOOT === "1" || opts.skip === true) {
    return;
  }

  const durationMs = opts.durationMs ?? DEFAULT_BOOT_DURATION_MS;
  const theme = getTheme();

  const box: Box = new otui.BoxRenderable(r, {
    id: "boot-animation",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: theme.bg,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  });
  r.root.add(box);

  const logoBox = new otui.BoxRenderable(r, { id: "boot-logo-box", flexDirection: "column", alignItems: "center" });
  box.add(logoBox);
  for (const [index, line] of WORDMARK.entries()) {
    logoBox.add(new otui.TextRenderable(r, { id: `boot-logo-${index}`, content: otui.t`${otui.bold(line)}` }));
  }

  const statusText = new otui.TextRenderable(r, {
    id: "boot-status",
    content: otui.t`${otui.dim(STEPS[0] ?? "")}`,
    marginTop: 1,
  });
  box.add(statusText);
  box.add(new otui.TextRenderable(r, { id: "boot-hint", content: otui.t`${otui.dim("any key to skip")}`, marginTop: 1 }));

  await new Promise<void>((resolve) => {
    let settled = false;
    let stepIndex = 0;

    const stepTimer = setInterval(
      () => {
        stepIndex = Math.min(stepIndex + 1, STEPS.length - 1);
        const step = STEPS[stepIndex];
        if (step !== undefined) {
          statusText.content = otui.t`${otui.dim(step)}`;
        }
      },
      Math.max(1, Math.floor(durationMs / STEPS.length)),
    );

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(stepTimer);
      clearTimeout(doneTimer);
      unsubscribe();
      r.root.remove(box);
      resolve();
    };

    const doneTimer = setTimeout(finish, durationMs);
    const unsubscribe = opts.onKeypress(() => finish());
  });
}
