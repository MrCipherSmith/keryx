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

/** Under the wordmark in an empty transcript: what to do next. */
export const SPLASH_HINT = "type a message to start · / for commands";

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

  // No loading steps: the ones this used to cycle through ("Reading
  // .metaproject index", "Connecting provider", "Warming graph") were labels
  // on a timer, not work being done (flow 270 AC10).
  box.add(new otui.TextRenderable(r, { id: "boot-hint", content: otui.t`${otui.dim("any key to skip")}`, marginTop: 1 }));

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(doneTimer);
      unsubscribe();
      r.root.remove(box);
      resolve();
    };

    const doneTimer = setTimeout(finish, durationMs);
    const unsubscribe = opts.onKeypress(() => finish());
  });
}

/** Rows the shell spends outside the transcript (header, composer, footer). */
const SHELL_CHROME_ROWS = 8;

/**
 * The wordmark in an empty transcript (flow 270 AC10): a new session opens on
 * it instead of a blank pane, and it stays until the operator sends the first
 * message. The boot animation above is a 350 ms flash before the picker; this
 * is what remains on screen afterwards.
 *
 * Added as the transcript's first child, horizontally centred, pushed down to
 * roughly the middle of the pane. Returns `remove`, safe to call twice.
 */
export function mountEmptyTranscriptSplash(otui: OpenTui, r: Renderer, transcript: Box): () => void {
  const rows = WORDMARK.length + 2;
  const paneRows = Math.max(0, r.height - SHELL_CHROME_ROWS);
  const box: Box = new otui.BoxRenderable(r, {
    id: "transcript-splash",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    flexShrink: 0,
    marginTop: Math.max(1, Math.floor((paneRows - rows) / 2)),
  });
  for (const [index, line] of WORDMARK.entries()) {
    box.add(new otui.TextRenderable(r, { id: `splash-logo-${index}`, content: otui.t`${otui.bold(line)}` }));
  }
  box.add(new otui.TextRenderable(r, { id: "splash-hint", content: otui.t`${otui.dim(SPLASH_HINT)}`, marginTop: 1 }));
  transcript.add(box);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    transcript.remove(box);
  };
}

/**
 * Flow 277 (shell god-file split, P2): `tui-shell.ts` used to hold a bare
 * `let removeSplash: (() => void) | undefined` and toggle it at three call
 * sites (the initial mount decision, `applyOpened`'s history-length teardown,
 * and `runLine`'s first-operator-line teardown) — each pinned only by a
 * source-text audit (`boot-animation.test.ts`) slicing `tui-shell.ts`'s text
 * into windows, because none of those three call sites were reachable from a
 * test without a renderer. This is that state, extracted so the mount
 * decision and the "removed at most once" contract are unit-testable with a
 * fake `mount`.
 */
export interface SplashLifecycleOptions {
  /** `() => mountEmptyTranscriptSplash(otui, r, transcript)` — called at most once, only when the session opens empty. */
  mount: () => () => void;
  /** `history.length` at startup (flow 270 AC10): the splash only ever mounts for a genuinely empty session. */
  initialHistoryLength: number;
}

export interface SplashLifecycle {
  /** Remove the splash if it is currently shown. A safe no-op when it was never mounted (history.length > 0) or already removed. */
  removeIfShown(): void;
}

/** Build a {@link SplashLifecycle} — see its own and {@link SplashLifecycleOptions}'s doc comments. */
export function createSplashLifecycle(opts: SplashLifecycleOptions): SplashLifecycle {
  let remove: (() => void) | undefined = opts.initialHistoryLength === 0 ? opts.mount() : undefined;
  return {
    removeIfShown() {
      remove?.();
      remove = undefined;
    },
  };
}
