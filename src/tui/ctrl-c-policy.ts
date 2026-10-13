// Ctrl+C in the TUI shell: cancel a running turn, and quit only on a deliberate second press at an idle
// prompt. Closing the shell tears down the session (and the remote-control topic), so one stray press
// must not do it. Pure: the clock is injected, no renderer dependency.

export const CTRL_C_EXIT_WINDOW_MS = 2000;

export const CTRL_C_EXIT_HINT = "Press Ctrl+C again to exit";

export type CtrlCAction = "cancel-turn" | "arm-exit" | "exit";

export interface CtrlCPolicy {
  /** One Ctrl+C press; `turnActive` is whether a foreground turn is running right now. */
  press(turnActive: boolean): CtrlCAction;
}

export function createCtrlCPolicy(opts: { now: () => number; windowMs?: number }): CtrlCPolicy {
  const windowMs = opts.windowMs ?? CTRL_C_EXIT_WINDOW_MS;
  let armedAt: number | undefined;
  return {
    press(turnActive) {
      if (turnActive) {
        armedAt = undefined;
        return "cancel-turn";
      }
      const now = opts.now();
      if (armedAt !== undefined && now - armedAt <= windowMs) {
        armedAt = undefined;
        return "exit";
      }
      armedAt = now;
      return "arm-exit";
    },
  };
}

export function isCtrlC(key: { name: string; ctrl: boolean }): boolean {
  return key.ctrl && key.name === "c";
}
