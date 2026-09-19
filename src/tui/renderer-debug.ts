// Wires the terminal-input guard (`stdin-guard.ts`) and, under `--debug`, the
// event log (`debug-log.ts`) onto a freshly created shell renderer. Kept out of
// `shell-chrome.ts` so the chrome stays about layout.

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { callerStack, debugEvent, isDebugEnabled } from "./debug-log";
import {
  installInputRecoverySignal,
  instrumentStdin,
  openTerminalInput,
  recoverStdin,
  registerRendererInputListener,
  startStdinHeartbeat,
  stdinIsDead,
  stdinSnapshot,
  type StdinLike,
} from "./stdin-guard";

/**
 * Keep `process.emitWarning` output off the full-screen UI while it is up.
 *
 * The runtime prints warnings straight to stderr, which under the alternate
 * screen lands on top of the rendered frame: a MaxListenersExceededWarning once
 * garbled the sidebar and footer of a live session. While the renderer owns the
 * terminal, warnings go to the `--debug` log instead; on teardown (terminal
 * restored) a one-line summary of each is printed so none is lost, and the
 * runtime's own listeners are put back.
 */
export function routeProcessWarnings(
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): () => void {
  const previous = process.listeners("warning");
  const seen: string[] = [];
  const onWarning = (warning: Error): void => {
    debugEvent("process.warning", { name: warning.name, message: warning.message, stack: warning.stack });
    if (seen.length < 20) {
      seen.push(`${warning.name}: ${warning.message}`);
    }
  };
  process.removeAllListeners("warning");
  process.on("warning", onWarning);
  return () => {
    process.off("warning", onWarning);
    for (const listener of previous) {
      process.on("warning", listener as (warning: Error) => void);
    }
    for (const line of seen) {
      write(`keryx: runtime warning during the session — ${line}\n`);
    }
  };
}

/** At most this many reopens per minute — a tty that EOFs on every open is not recoverable. */
const MAX_REOPENS_PER_MINUTE = 5;

/** Kernel-side facts at the moment input ended (debug only): foreground group, termios. */
function eofDiagnostics(): Record<string, unknown> {
  if (process.platform !== "linux") {
    return {};
  }
  let tty: string | undefined;
  try {
    tty = readlinkSync("/proc/self/fd/0");
  } catch {
    tty = undefined;
  }
  let stat: string;
  try {
    stat = readFileSync("/proc/self/stat", "utf8").trim();
  } catch {
    stat = "";
  }
  // Fields after "(comm)": state ppid pgrp session tty_nr tpgid …
  const fields = stat.replace(/^.*\)\s+/, "").split(" ");
  const stty =
    tty !== undefined ? spawnSync("stty", ["-a", "-F", tty], { encoding: "utf8", timeout: 1500 }).stdout?.trim() : undefined;
  return { tty, pgrp: fields[2], session: fields[3], tpgid: fields[5], stty };
}

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;

type DebugKey = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift?: boolean;
  sequence: string;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
};

/**
 * Attach input recovery (always) and debug instrumentation (only while a
 * `--debug` run is active). Returns the teardown to run from `onDestroy`.
 */
export function attachRendererGuards(
  r: Renderer,
  initial: StdinLike = process.stdin as unknown as StdinLike,
  deps: { openInput?: () => StdinLike | undefined } = {},
): () => void {
  const internals = r as unknown as {
    stdin?: unknown;
    stdinListener?: (chunk: Buffer) => void;
    controlState?: string;
    currentFocusedRenderable?: { id?: string } | null;
    _internalKeyInput?: {
      onInternal: (event: string, handler: (key: DebugKey) => void) => void;
      offInternal: (event: string, handler: (key: DebugKey) => void) => void;
    };
  };
  const listener = internals.stdinListener;
  registerRendererInputListener(listener);
  const shouldRecover = (): boolean => !r.isDestroyed && internals.controlState !== "explicit_suspended";
  const teardown: (() => void)[] = [];

  // --- terminal input that survives an EOF -------------------------------
  // `current` is whichever stream the renderer reads now: `process.stdin` at
  // first, a reopened tty stream after an EOF (see `openTerminalInput`).
  let current: StdinLike = initial;
  let unwatch: () => void = () => {};
  let undoInstrument: () => void = () => {};
  const reopenTimes: number[] = [];

  const reopen = (reason: string): string[] => {
    const now = Date.now();
    while (reopenTimes.length > 0 && now - (reopenTimes[0] ?? 0) > 60_000) reopenTimes.shift();
    if (reopenTimes.length >= MAX_REOPENS_PER_MINUTE) {
      debugEvent("stdin.reopen-gave-up", { reason, reopensLastMinute: reopenTimes.length });
      return ["reopen skipped: rate limit"];
    }
    reopenTimes.push(now);
    const next = (deps.openInput ?? openTerminalInput)();
    if (next === undefined) {
      return ["reopen failed"];
    }
    const previous = current;
    unwatch();
    undoInstrument();
    undoInstrument = () => {};
    if (listener !== undefined) {
      try {
        previous.off?.("data", listener as (...args: unknown[]) => void);
      } catch {
        // the old stream is dead anyway
      }
      next.on("data", listener as (...args: unknown[]) => void);
    }
    current = next;
    // OpenTUI reads `renderer.stdin` for raw mode and teardown; point it at the
    // live stream so exit restores the terminal through the right descriptor.
    internals.stdin = next;
    watch(next);
    if (isDebugEnabled()) {
      undoInstrument = instrumentStdin(next);
    }
    next.resume();
    debugEvent("stdin.replaced", { reason, state: stdinSnapshot(next) });
    r.requestRender();
    return [`reopened terminal input (${reason})`];
  };

  function watch(stream: StdinLike): void {
    const onDead = (event: string) => (): void => {
      if (current !== stream) {
        return;
      }
      if (isDebugEnabled()) {
        debugEvent(`stdin.dead.${event}`, { state: stdinSnapshot(stream), ...eofDiagnostics() });
      }
      if (!shouldRecover()) {
        return;
      }
      // After the stream's own end/close handling has run.
      setTimeout(() => {
        if (current === stream && shouldRecover()) {
          reopen(event);
        }
      }, 0);
    };
    const onEnd = onDead("end");
    const onClose = onDead("close");
    stream.on("end", onEnd);
    stream.on("close", onClose);
    unwatch = () => {
      stream.off?.("end", onEnd);
      stream.off?.("close", onClose);
    };
  }
  watch(current);

  const recover = (): string[] =>
    stdinIsDead(current) ? reopen("recover") : recoverStdin(current, { cycle: true });

  teardown.push(
    installInputRecoverySignal(
      () => current,
      () => {
        r.requestRender();
      },
      shouldRecover,
      recover,
    ),
  );
  teardown.push(() => {
    unwatch();
    undoInstrument();
    registerRendererInputListener(undefined);
    if (current !== initial) {
      // A reopened descriptor would otherwise keep the process alive after exit.
      (current as { destroy?: () => void }).destroy?.();
    }
  });
  teardown.push(routeProcessWarnings());

  if (!isDebugEnabled()) {
    return () => {
      for (const fn of teardown.splice(0)) fn();
    };
  }

  debugEvent("renderer.created", {
    controlState: internals.controlState,
    width: r.width,
    height: r.height,
    hasStdinListener: internals.stdinListener !== undefined,
  });
  undoInstrument = instrumentStdin(current);
  teardown.push(
    startStdinHeartbeat(() => current, {
      shouldRecover,
      recover,
      extra: () => ({
        controlState: internals.controlState,
        focused: internals.currentFocusedRenderable?.id,
      }),
    }),
  );

  // Registered before the chrome's own handlers, so it sees every key first;
  // the outcome (prevented/stopped) is read after the synchronous dispatch.
  const onKey = (key: DebugKey): void => {
    const printable = key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta;
    queueMicrotask(() => {
      debugEvent("key", {
        name: printable ? "<printable>" : key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        prevented: key.defaultPrevented,
        stopped: key.propagationStopped,
        focused: internals.currentFocusedRenderable?.id,
      });
    });
  };
  internals._internalKeyInput?.onInternal("keypress", onKey);
  teardown.push(() => internals._internalKeyInput?.offInternal("keypress", onKey));

  const emitter = r as unknown as {
    on?: (event: string, fn: (...args: unknown[]) => void) => void;
    off?: (event: string, fn: (...args: unknown[]) => void) => void;
  };
  for (const event of ["resize", "focus", "blur", "capabilities"]) {
    const fn = (...args: unknown[]): void => {
      debugEvent(`renderer.${event}`, event === "capabilities" ? {} : { args: args.map(String) });
    };
    emitter.on?.(event, fn);
    teardown.push(() => emitter.off?.(event, fn));
  }

  // Who stops the renderer (and with it stdin) — with the calling stack.
  const target = r as unknown as Record<string, unknown>;
  for (const method of ["suspend", "resume", "pause", "stop", "destroy"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    const fn = original as (...args: unknown[]) => unknown;
    target[method] = function (this: unknown, ...args: unknown[]): unknown {
      debugEvent(`renderer.${method}`, { controlState: internals.controlState, stack: callerStack() });
      return fn.apply(this, args);
    };
    teardown.push(() => {
      target[method] = original;
    });
  }

  return () => {
    debugEvent("renderer.teardown");
    for (const fn of teardown.splice(0)) {
      try {
        fn();
      } catch {
        // teardown is best-effort
      }
    }
  };
}
