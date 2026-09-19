// The agent TUI's side of the session lease (agent bus P0, flow 271;
// specification §6.1, §6.2; AC3, AC4, AC6, AC7).
//
// Pure helpers and small seams, kept out of `tui-shell.ts` so they can be
// tested without a renderer:
//
// - the `● live` / `◌ stale` row markers for the startup picker and the
//   Session Switcher;
// - the fork / view / cancel (/ take over) choice, as composer-choice options
//   built from the list the readline prompt uses, and the handling of each;
// - the lease holder the shell's switches and exit paths go through.

import {
  releaseSessionLease,
  type SessionLeaseHandle,
  SessionLeasedError,
  type SessionLeaseState,
  sessionLeaseState,
  switchLeasedSession,
} from "../session/lease";
import { describeLeasedSession, type LeasedChoice, leasedChoiceRows } from "../session/lease-choice";
import type { ChoiceOption } from "./composer-choice";

/** The row marker for a session's lease state: held rows only; `mine` and `free` are unmarked. */
export function leaseMarker(state: SessionLeaseState): string {
  if (state === "live") return "● live";
  if (state === "stale") return "◌ stale";
  return "";
}

/** Looks a session's lease state up; the default reads the lease on disk. */
export type LeaseStateLookup = (sessionId: string) => SessionLeaseState;

/** The production lookup for `cwd` (and a test data dir). */
export function leaseStateLookup(cwd: string, dataDir?: string): LeaseStateLookup {
  return (sessionId) => {
    try {
      return sessionLeaseState(cwd, sessionId, dataDir).state;
    } catch {
      // A lease that cannot be read marks nothing; opening it will say why.
      return "free";
    }
  };
}

/** `label` with the marker appended, e.g. `abc123 · title  ● live`. */
export function withLeaseMarker(label: string, state: SessionLeaseState): string {
  const marker = leaseMarker(state);
  return marker.length > 0 ? `${label}  ${marker}` : label;
}

/** The composer-choice title and options for a held session (fork is recommended). */
export function leasedChoiceRequest(error: SessionLeasedError): {
  title: string;
  subtitle: string;
  options: ChoiceOption[];
  cancelId: LeasedChoice;
} {
  const descriptions: Record<LeasedChoice, string> = {
    fork: "Continue in a copy of the session; the other shell keeps the original",
    view: "Show the session read-only, then start a new session",
    cancel: "Exit without opening a session",
    "take-over": "Reclaim the lease: the holder has stopped refreshing it",
  };
  return {
    title: describeLeasedSession(error),
    subtitle: "Esc = cancel",
    cancelId: "cancel",
    options: leasedChoiceRows(error).map((row) => ({
      id: row.choice,
      label: row.label,
      description: descriptions[row.choice],
      ...(row.choice === "fork" ? { recommended: true } : {}),
    })),
  };
}

/** Narrow a composer-choice answer to a `LeasedChoice` offered for `error`; anything else cancels. */
export function toLeasedChoice(error: SessionLeasedError, id: string | undefined): LeasedChoice {
  const offered = leasedChoiceRows(error).find((row) => row.choice === id);
  return offered?.choice ?? "cancel";
}

/** Seams for {@link resolveLeasedStartup}; `tui-shell.ts` passes the real ones. */
export interface LeasedStartupDeps<R> {
  /** Show the choice (the composer dock) and resolve the answer. */
  choose: (error: SessionLeasedError) => Promise<LeasedChoice>;
  /**
   * The leased open: `{}` is a new session, `{ resumeId, fork }` a fork,
   * `{ resumeId, takeOver }` a take-over.
   */
  open: (target: { resumeId?: string; fork?: boolean; takeOver?: boolean }) => R;
  /** Renders the held session read-only (`exportSessionMarkdown`); may throw. */
  exportSession: (sessionId: string) => string;
  /** Put the rendered session in the transcript, read-only. */
  showReadOnly: (markdown: string) => void;
  /** A one-line notice in the transcript. */
  notice: (text: string) => void;
}

export type LeasedStartupOutcome<R> = { kind: "opened"; opened: R } | { kind: "cancelled" };

/**
 * The TUI's handling of a `SessionLeasedError` at startup (specification §6.1,
 * AC3), the same semantics as the readline `runWithLeaseChoice`:
 *
 * - fork: re-open the id with `fork`;
 * - take over (offered only when stale): re-open with `takeOver`;
 * - view: render the held session read-only, then open a NEW session;
 * - cancel: open nothing.
 *
 * A fork or take-over that is refused again (the holder became live, say)
 * asks again with the new refusal. Any other error propagates, so the caller
 * keeps its "new session" fallback.
 */
export async function resolveLeasedStartup<R>(
  first: SessionLeasedError,
  deps: LeasedStartupDeps<R>,
): Promise<LeasedStartupOutcome<R>> {
  let error = first;
  for (;;) {
    const choice = await deps.choose(error);
    if (choice === "cancel") {
      return { kind: "cancelled" };
    }
    if (choice === "view") {
      try {
        deps.showReadOnly(deps.exportSession(error.summary.id));
      } catch (cause) {
        deps.notice(`Could not render the session: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return { kind: "opened", opened: deps.open({}) };
    }
    try {
      const target =
        choice === "fork"
          ? { resumeId: error.summary.id, fork: true }
          : { resumeId: error.summary.id, takeOver: true };
      return { kind: "opened", opened: deps.open(target) };
    } catch (cause) {
      if (!(cause instanceof SessionLeasedError)) {
        throw cause;
      }
      deps.notice(cause.message);
      error = cause;
    }
  }
}

/**
 * The one lease the TUI shell holds. Every open hands its lease to `hold`,
 * every in-process switch goes through `switchTo` (target first, then the old
 * one is released; a refusal leaves the current lease held), and every exit
 * path calls `release`, which is idempotent.
 */
export interface TuiLeaseHolder {
  readonly current: SessionLeaseHandle | undefined;
  hold(next: SessionLeaseHandle | undefined): void;
  switchTo<R extends { lease: SessionLeaseHandle }>(openTarget: () => R): R;
  release(): void;
}

export function createTuiLeaseHolder(): TuiLeaseHolder {
  let current: SessionLeaseHandle | undefined;
  return {
    get current() {
      return current;
    },
    hold(next) {
      if (current !== undefined && current !== next) {
        releaseSessionLease(current);
      }
      current = next;
    },
    switchTo(openTarget) {
      // Throws, with `current` untouched, when the target is refused.
      const next = switchLeasedSession(current, openTarget);
      current = next.lease;
      return next;
    },
    release() {
      const held = current;
      current = undefined;
      releaseSessionLease(held);
    },
  };
}
