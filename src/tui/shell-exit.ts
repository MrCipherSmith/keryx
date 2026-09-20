// Flow 277 (shell god-file split, P2): the TUI's exit sequence, lifted out of
// `tui-shell.ts` so it can be tested without a renderer.
//
// `launchTuiAgentShell` leaves the bus, releases the session lease and sweeps
// background jobs at FOUR places: the renderer's `onDestroy` (Ctrl+C), the
// busy-menu `case "exit"`, the `/exit` command, and the outer `finally`. Six
// tests across `tui-shell.test.ts` and `tui-session-lease.test.ts` each pinned
// their own copy by searching the file's text for the calls in the right
// order, because none of it was reachable from a test.
//
// Two of the four are the same sequence character for character. The other two
// are deliberately not, and that is the interesting part: `onDestroy` cannot
// `await` (`@opentui/core` calls it synchronously), so it releases the lease
// BEFORE the sweep and defers the sweep instead. A substring audit cannot tell
// a justified difference from a regression, which is why this module exports
// the invariant separately from the sequence.

/** The one ordering rule all four exit paths share (specification §5.4). */
export interface BusAndLeaseHolder {
  /** `liveBus?.leave()` — idempotent and safe to call synchronously. */
  leaveBus: () => void;
  /** `sessionLease.release()`. */
  releaseLease: () => void;
}

/**
 * Leave the bus, THEN release the session lease — never the other way round.
 *
 * Order is the property. The lease is what stops a second shell adopting this
 * session; the bus presence record says this instance is live. Releasing the
 * lease first opens a window where another shell can take the session over
 * while this one is still advertised on the bus as its holder.
 *
 * Called from all four exit paths, including the two that otherwise differ.
 */
export function leaveBusThenRelease(holder: BusAndLeaseHolder): void {
  holder.leaveBus();
  holder.releaseLease();
}

/** The steps the two command-driven exit paths run, in order. */
export interface SlateExitSteps extends BusAndLeaseHolder {
  /** `closeSlateSession(slateSession, mintTimestampAttemptId)`. */
  closeSlate: () => Promise<void>;
  /** `deps.sweepBackgroundJobs?.()` — the OS-level sweep of tracked job process groups. */
  sweepJobs: () => Promise<void>;
  /** `jobs.removeAll()` — the in-memory store purge, so the sidebar list goes too (flow 173 F-002). */
  purgeJobList: () => void;
  /** `r.off("theme_mode", onThemeMode)`. */
  detachRenderer: () => void;
  /** `r.destroy()`. */
  destroyRenderer: () => void;
}

/**
 * The exit sequence shared by the busy-menu `case "exit"` and the `/exit`
 * command. Both awaited the same five things in the same order and then tore
 * the renderer down; this is that, once.
 *
 * The order is not arbitrary:
 *
 * 1. `closeSlate` first, so the slate's last file is written while the session
 *    is still ours to write (flow 271 AC7).
 * 2. `sweepJobs` before `purgeJobList` — the sweep needs the registry the
 *    purge empties. Reversed, every tracked process group survives the
 *    session as an unsandboxed orphan (flow 173 F-002).
 * 3. `leaveBusThenRelease` after both, and in that order (specification §5.4).
 * 4. The renderer last, because everything above may still want to paint.
 */
export async function performSlateExit(steps: SlateExitSteps): Promise<void> {
  await steps.closeSlate();
  await steps.sweepJobs();
  steps.purgeJobList();
  leaveBusThenRelease(steps);
  steps.detachRenderer();
  steps.destroyRenderer();
}
