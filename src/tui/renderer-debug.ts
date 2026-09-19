// Wires the terminal-input guard (`stdin-guard.ts`) and, under `--debug`, the
// event log (`debug-log.ts`) onto a freshly created shell renderer. Kept out of
// `shell-chrome.ts` so the chrome stays about layout.

import { callerStack, debugEvent, isDebugEnabled } from "./debug-log";
import {
  installInputRecoverySignal,
  instrumentStdin,
  registerRendererInputListener,
  startStdinHeartbeat,
  type StdinLike,
} from "./stdin-guard";

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
export function attachRendererGuards(r: Renderer, stdin: StdinLike = process.stdin as unknown as StdinLike): () => void {
  const internals = r as unknown as {
    stdinListener?: (chunk: Buffer) => void;
    controlState?: string;
    currentFocusedRenderable?: { id?: string } | null;
    _internalKeyInput?: {
      onInternal: (event: string, handler: (key: DebugKey) => void) => void;
      offInternal: (event: string, handler: (key: DebugKey) => void) => void;
    };
  };
  registerRendererInputListener(internals.stdinListener);
  const shouldRecover = (): boolean => !r.isDestroyed && internals.controlState !== "explicit_suspended";
  const teardown: (() => void)[] = [];
  teardown.push(
    installInputRecoverySignal(
      stdin,
      () => {
        r.requestRender();
      },
      shouldRecover,
    ),
  );
  teardown.push(() => registerRendererInputListener(undefined));

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
  teardown.push(instrumentStdin(stdin));
  teardown.push(
    startStdinHeartbeat(stdin, {
      shouldRecover,
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
