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
import { boldChunk, dimChunk } from "./theme-text";
import { SIDEBAR_WIDTH } from "./shell-chrome";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
/** One already-broken splash row; see `mountEmptyTranscriptSplash`. */
type TextNode = InstanceType<OpenTui["TextRenderable"]>;

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
    logoBox.add(new otui.TextRenderable(r, { id: `boot-logo-${index}`, content: otui.t`${boldChunk(otui, line)}` }));
  }

  // No loading steps: the ones this used to cycle through ("Reading
  // .metaproject index", "Connecting provider", "Warming graph") were labels
  // on a timer, not work being done (flow 270 AC10).
  box.add(new otui.TextRenderable(r, { id: "boot-hint", content: otui.t`${dimChunk(otui, "any key to skip")}`, marginTop: 1 }));

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
 * Narrowest inner width the splash lays text out into — the floor below which
 * wrapping stops being meaningful, so a degenerate width (0 before the first
 * layout pass, or a resize into nothing) still produces rows.
 */
export const SPLASH_MIN_COLS = 12;

/** One mounted splash: teardown, plus adding centred lines to it while it is up. */
export interface SplashHandle {
  /** Tear the splash down. Safe to call twice, and after any number of addStatus calls. */
  remove(): void;
  /** Add a line INSIDE the splash, centred with the wordmark (the bus-joined notice does this). No-op once removed. */
  addStatus(text: string): void;
}

/**
 * Break `text` into rows of at most `width` characters.
 *
 * `@opentui/core` has NO text alignment: `TextBufferOptions` offers only
 * `wrapMode`/`truncate`, there is no `textAlign`, and `Box`'s `titleAlignment`
 * styles a border TITLE rather than its contents. Centring therefore cannot be
 * requested, only arranged — a parent's `alignItems: "center"` centres a CHILD,
 * so a child as wide as the pane cannot be centred and the renderer-wrapped
 * remainder of a longer one lands flush left (the reported bug). The fix is to
 * never hand the parent a line wider than it: break the text here and mount one
 * child per row.
 *
 * `byWord` is for PROSE (a word that does not fit still gets hard-split, since
 * there is no space to break on); `false` is for ART, where the spaces are part
 * of the glyph and re-flowing them at word boundaries would redraw a different
 * picture.
 */
function breakLines(text: string, width: number, byWord: boolean): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const parts = byWord ? para.split(/\s+/).filter((w) => w.length > 0) : [para];
    if (parts.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const part of parts) {
      if (part.length > limit) {
        if (line.length > 0) {
          out.push(line);
        }
        let at = 0;
        while (at + limit < part.length) {
          out.push(part.slice(at, at + limit));
          at += limit;
        }
        line = part.slice(at); // the tail stays open, so the next word can join it
        continue;
      }
      const next = line.length === 0 ? part : line + " " + part;
      if (next.length > limit) {
        out.push(line);
        line = part;
        continue;
      }
      line = next;
    }
    out.push(line);
  }
  return out;
}

/** Art-preserving wrap (single space-free chunks); see {@link breakLines}. */
export function hardWrapLines(text: string, width: number): string[] {
  return breakLines(text, width, false);
}

/** Word wrap for the hint/status prose; see {@link breakLines}. */
export function centerWrappedLines(text: string, width: number): string[] {
  return breakLines(text, width, true);
}

/**
 * The wordmark in an empty transcript (flow 270 AC10): a new session opens on
 * it instead of a blank pane, and it stays until the operator sends the first
 * message. The boot animation above is a 350 ms flash before the picker; this
 * is what remains on screen afterwards.
 *
 * Added as the transcript's first child, horizontally centred, pushed down to
 * roughly the middle of the pane. Returns a {@link SplashHandle} whose `remove`
 * is safe to call twice.
 *
 * Every line is pre-broken to the pane width and mounted as its OWN
 * `TextRenderable` with `wrapMode: "none"`, and the whole thing is repainted
 * once the first frame gives the box its real width and on every resize — a
 * wrap done once at mount would otherwise stay broken for the old width.
 */
export function mountEmptyTranscriptSplash(otui: OpenTui, r: Renderer, transcript: Box): SplashHandle {
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
  transcript.add(box);

  let removed = false;
  const statusTexts: string[] = [];
  let painted: TextNode[] = [];

  /** (Re)build the splash's children at the current pane width. */
  const paint = (): void => {
    if (removed) {
      return;
    }
    // `box.width` is the truth after layout, but it is 0 until the first layout
    // pass — so the opening frame falls back to the same arithmetic `helpText()`
    // uses: the terminal, less the sidebar, less the transcript's 1-column
    // padding on each side.
    const width =
      box.width > 0
        ? box.width
        : Math.max(SPLASH_MIN_COLS, (r.width > 0 ? r.width : 80) - SIDEBAR_WIDTH - 2);
    for (const child of painted) {
      box.remove(child);
    }
    painted = [];
    const emit = (text: string, kind: "logo" | "hint" | "status"): void => {
      const lines = kind === "logo" ? hardWrapLines(text, width) : centerWrappedLines(text, width);
      for (const [index, line] of lines.entries()) {
        const node = new otui.TextRenderable(r, {
          id: `splash-${kind}-${index}`,
          // Load-bearing: a row of exactly `width` columns can still be
          // re-wrapped by the renderer, putting half of it back at the left edge.
          wrapMode: "none",
          content: otui.t`${kind === "logo" ? boldChunk(otui, line) : dimChunk(otui, line)}`,
          ...(index === 0 && kind !== "logo" ? { marginTop: 1 } : {}),
        });
        box.add(node);
        painted.push(node);
      }
    };
    for (const line of WORDMARK) {
      emit(line, "logo");
    }
    emit(SPLASH_HINT, "hint");
    for (const status of statusTexts) {
      emit(status, "status");
    }
  };

  paint();

  // Repainting on the NEXT FRAME, never inline in the resize handler: the
  // renderer's RESIZE fires BEFORE Yoga has recomputed the layout, so a paint()
  // run straight from that handler would read the pane's OLD width and re-wrap
  // to it — leaving the text clipped at the new, narrower edge. The same
  // deferral covers the first frame, where `box.width` is still 0.
  let repaintQueued = false;
  const onFrame = (): void => {
    r.off(otui.CliRenderEvents.FRAME, onFrame);
    repaintQueued = false;
    paint();
  };
  const repaintAfterLayout = (): void => {
    if (removed || repaintQueued) {
      return;
    }
    repaintQueued = true;
    r.on(otui.CliRenderEvents.FRAME, onFrame);
  };
  repaintAfterLayout(); // once with the real width, after the opening layout
  r.on(otui.CliRenderEvents.RESIZE, repaintAfterLayout);

  return {
    remove(): void {
      if (removed) {
        return;
      }
      removed = true;
      r.off(otui.CliRenderEvents.FRAME, onFrame);
      r.off(otui.CliRenderEvents.RESIZE, repaintAfterLayout);
      transcript.remove(box);
    },
    addStatus(text: string): void {
      const cleaned = text.replace(/\s+$/, "");
      if (removed || cleaned.length === 0) {
        return;
      }
      statusTexts.push(cleaned);
      paint();
    },
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
  mount: () => SplashHandle;
  /** `history.length` at startup (flow 270 AC10): the splash only ever mounts for a genuinely empty session. */
  initialHistoryLength: number;
}

export interface SplashLifecycle {
  /** Remove the splash if it is currently shown. A safe no-op when it was never mounted (history.length > 0) or already removed. */
  removeIfShown(): void;
  /**
   * Paint `text` as a centred line inside the splash while it is on screen.
   * `false` means there is no splash to paint into — the session opened with
   * history, or the first operator line already tore it down — so the caller
   * keeps its ordinary transcript line instead.
   */
  addStatusIfShown(text: string): boolean;
}

/** Build a {@link SplashLifecycle} — see its own and {@link SplashLifecycleOptions}'s doc comments. */
export function createSplashLifecycle(opts: SplashLifecycleOptions): SplashLifecycle {
  let handle: SplashHandle | undefined = opts.initialHistoryLength === 0 ? opts.mount() : undefined;
  return {
    removeIfShown() {
      handle?.remove();
      handle = undefined;
    },
    addStatusIfShown(text: string): boolean {
      if (handle === undefined) {
        return false;
      }
      handle.addStatus(text);
      return true;
    },
  };
}
