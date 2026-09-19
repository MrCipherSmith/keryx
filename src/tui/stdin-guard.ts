// Terminal-input health for the OpenTUI shells.
//
// Observed failure (session 603f3171, keryx 0.2.121 under herdr): the shell kept
// rendering — spinner and elapsed timer live — while the terminal's input queue
// sat full at 4095 unread bytes. The tty reader fd had been dropped from the
// process's epoll set, so no key, Esc or Ctrl+C ever reached OpenTUI; raw mode
// was still on and the process still owned the foreground. An approval picker
// was on screen, which made it look like the picker had hung. It had not: input
// as a whole had stopped. What detached the reader is not yet known, which is
// why this module does two things:
//
//   - `instrumentStdin` (only under `keryx shell --debug`) records every call
//     that can stop the stream — pause, setRawMode, listener removal, destroy —
//     with the calling stack, plus the stream's own lifecycle events;
//   - `recoverStdin` re-arms input: raw mode back on, the renderer's data
//     listener re-attached if it went missing, and a pause/resume cycle so the
//     runtime re-registers the tty reader. It runs on SIGUSR2 in every session
//     (`kill -USR2 <pid>` from another terminal un-sticks a dead shell) and from
//     the `--debug` watcher when it sees the stall.

import { callerStack, debugEvent, isDebugEnabled, summarizeInputChunk } from "./debug-log";

/** The subset of `process.stdin` this module touches. */
export interface StdinLike {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  readableEnded?: boolean;
  readableLength?: number;
  destroyed?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  isPaused(): boolean;
  pause(): unknown;
  resume(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  listeners(event: string): unknown[];
  listenerCount(event: string): number;
}

let rendererListener: ((chunk: Buffer) => void) | undefined;

/** A point-in-time description of the input stream. */
export function stdinSnapshot(stdin: StdinLike): Record<string, unknown> {
  const safe = <T>(read: () => T): T | string => {
    try {
      return read();
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    isTTY: safe(() => stdin.isTTY === true),
    isRaw: safe(() => stdin.isRaw),
    paused: safe(() => stdin.isPaused()),
    flowing: safe(() => stdin.readableFlowing),
    ended: safe(() => stdin.readableEnded),
    destroyed: safe(() => stdin.destroyed),
    buffered: safe(() => stdin.readableLength),
    dataListeners: safe(() => stdin.listenerCount("data")),
    readableListeners: safe(() => stdin.listenerCount("readable")),
    rendererAttached: safe(() =>
      rendererListener === undefined ? undefined : stdin.listeners("data").includes(rendererListener),
    ),
  };
}

/** True when the stream is in a state that cannot deliver keystrokes. */
export function stdinLooksStalled(snapshot: Record<string, unknown>): boolean {
  return (
    snapshot.paused === true ||
    snapshot.flowing === false ||
    snapshot.ended === true ||
    snapshot.destroyed === true ||
    snapshot.dataListeners === 0 ||
    snapshot.rendererAttached === false ||
    (snapshot.isTTY === true && snapshot.isRaw === false)
  );
}

/**
 * Remember the renderer's own stdin `data` listener so recovery can re-attach it
 * if something removed it. Called by `createShellRenderer`.
 */
export function registerRendererInputListener(listener: ((chunk: Buffer) => void) | undefined): void {
  rendererListener = listener;
}

/**
 * Re-arm terminal input. Returns what it did, for the log. Every step is
 * individually guarded: a half-successful recovery is still better than none.
 */
export function recoverStdin(
  stdin: StdinLike,
  opts: { listener?: ((chunk: Buffer) => void) | undefined; cycle?: boolean } = {},
): string[] {
  const actions: string[] = [];
  const listener = opts.listener ?? rendererListener;
  const step = (name: string, run: () => unknown): void => {
    try {
      run();
      actions.push(name);
    } catch (error) {
      actions.push(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (stdin.isTTY === true && typeof stdin.setRawMode === "function" && stdin.isRaw !== true) {
    step("setRawMode(true)", () => stdin.setRawMode?.(true));
  }
  if (listener !== undefined && !stdin.listeners("data").includes(listener)) {
    step("re-attach renderer data listener", () => stdin.on("data", listener as (...args: unknown[]) => void));
  }
  if (opts.cycle === true) {
    // A pause/resume cycle makes the runtime drop and re-register its reader,
    // which a plain resume() on an already-flowing stream does not do.
    step("pause()", () => stdin.pause());
  }
  step("resume()", () => stdin.resume());
  return actions;
}

/**
 * Wrap the stream's stopping methods and subscribe to its lifecycle so a debug
 * log shows who stopped input and when. Returns an undo function.
 */
export function instrumentStdin(stdin: StdinLike): () => void {
  const target = stdin as unknown as Record<string, unknown>;
  const restores: (() => void)[] = [];
  const wrap = (method: string, describe: (args: unknown[]) => Record<string, unknown> = () => ({})): void => {
    const original = target[method];
    if (typeof original !== "function") {
      return;
    }
    const fn = original as (...args: unknown[]) => unknown;
    target[method] = function (this: unknown, ...args: unknown[]): unknown {
      debugEvent(`stdin.${method}`, { ...describe(args), before: stdinSnapshot(stdin), stack: callerStack() });
      return fn.apply(this, args);
    };
    restores.push(() => {
      target[method] = original;
    });
  };
  const eventName = (args: unknown[]): Record<string, unknown> => ({ event: String(args[0]) });
  wrap("pause");
  wrap("resume");
  wrap("setRawMode", (args) => ({ mode: args[0] }));
  wrap("removeListener", eventName);
  wrap("off", eventName);
  wrap("removeAllListeners", eventName);
  wrap("destroy");
  wrap("unref");
  wrap("unpipe");
  wrap("setEncoding", (args) => ({ encoding: args[0] }));

  const lifecycle: [string, (...args: unknown[]) => void][] = [];
  for (const event of ["end", "close", "error", "pause", "resume"]) {
    const handler = (...args: unknown[]): void => {
      debugEvent(`stdin.event.${event}`, { args: args.map((a) => (a instanceof Error ? a : String(a))), state: stdinSnapshot(stdin) });
    };
    lifecycle.push([event, handler as (...args: unknown[]) => void]);
  }
  // Observe data without consuming it: `data` listeners do not change flow mode
  // once the renderer's own listener has put the stream in flowing mode.
  const onData = (chunk: Buffer | string): void => {
    debugEvent("stdin.data", summarizeInputChunk(chunk));
  };
  lifecycle.push(["data", onData as (...args: unknown[]) => void]);
  for (const [event, handler] of lifecycle) {
    // `error` is the one event whose listener changes behaviour (an unhandled
    // stream error crashes the process). Recording it must not swallow it, so
    // it is only observed when something else already handles it.
    if (event === "error" && stdin.listenerCount("error") === 0) {
      continue;
    }
    stdin.on(event, handler);
  }
  debugEvent("stdin.instrumented", { state: stdinSnapshot(stdin) });
  return () => {
    for (const restore of restores) restore();
    for (const [event, handler] of lifecycle) stdin.off?.(event, handler);
  };
}

/**
 * Debug heartbeat: log the stream state every `intervalMs`, and when it looks
 * stalled, log that loudly and try to recover once per `cooldownMs`.
 */
export function startStdinHeartbeat(
  stdin: StdinLike,
  opts: {
    intervalMs?: number;
    cooldownMs?: number;
    extra?: () => Record<string, unknown>;
    /** False while input is stopped on purpose (renderer suspended/destroyed). */
    shouldRecover?: () => boolean;
  } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 1000;
  const cooldownMs = opts.cooldownMs ?? 10_000;
  let lastRecovery = 0;
  const timer = setInterval(() => {
    const state = stdinSnapshot(stdin);
    const stalled = stdinLooksStalled(state);
    debugEvent("heartbeat", { stdin: state, stalled, ...(opts.extra?.() ?? {}) });
    if (stalled && (opts.shouldRecover?.() ?? true) && Date.now() - lastRecovery > cooldownMs) {
      lastRecovery = Date.now();
      const actions = recoverStdin(stdin, { cycle: true });
      debugEvent("stdin.stall.recovered-in-process", { before: state, actions, after: stdinSnapshot(stdin) });
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/**
 * SIGUSR2 → recover terminal input. Installed in every TUI session (not only
 * `--debug`), because a shell whose input is dead cannot be reached any other
 * way short of killing it. `onRecovered` lets the caller repaint/refocus.
 */
export function installInputRecoverySignal(
  stdin: StdinLike,
  onRecovered?: (actions: string[]) => void,
  shouldRecover: () => boolean = () => true,
): () => void {
  if (process.platform === "win32") {
    return () => {};
  }
  const handler = (): void => {
    if (!shouldRecover()) {
      debugEvent("signal.SIGUSR2.skipped", { reason: "renderer suspended or destroyed", stdin: stdinSnapshot(stdin) });
      return;
    }
    const before = stdinSnapshot(stdin);
    const actions = recoverStdin(stdin, { cycle: true });
    const after = stdinSnapshot(stdin);
    debugEvent("signal.SIGUSR2.recover", { before, actions, after, debug: isDebugEnabled() });
    try {
      onRecovered?.(actions);
    } catch {
      // repaint is best-effort
    }
  };
  process.on("SIGUSR2", handler);
  return () => {
    process.off("SIGUSR2", handler);
  };
}
