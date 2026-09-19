// What an interactive surface offers when the session it was asked to open is
// held by another instance (agent bus P0, specification §6.1, AC3). One list,
// shared by the readline prompt (`commands/shell.ts`) and the TUI composer
// choice (`tui/tui-session-lease.ts`), so the two surfaces cannot drift.

import { describeLeaseHolder, type SessionLeasedError, type SkippedSession } from "./lease";
import { shortSessionId } from "./store";

/** What the operator chose for a session another shell holds (§6.1). */
export type LeasedChoice = "fork" | "view" | "cancel" | "take-over";

export interface LeasedChoiceRow {
  choice: LeasedChoice;
  label: string;
}

/**
 * The choices, in order: fork (the default), view read-only, cancel, and take
 * over only when the holder is stale. A live holder is never offered take-over.
 */
export function leasedChoiceRows(error: Pick<SessionLeasedError, "state">): LeasedChoiceRow[] {
  return [
    { choice: "fork", label: "fork (default): continue in a copy of the session" },
    { choice: "view", label: "view (read-only), then start a new session" },
    { choice: "cancel", label: "cancel" },
    ...(error.state === "stale" ? [{ choice: "take-over" as const, label: "take over (the holder is stale)" }] : []),
  ];
}

/** `Session <id> · <title> is open in <holder>[ (stale)].` */
export function describeLeasedSession(error: Pick<SessionLeasedError, "summary" | "holder" | "state">): string {
  const stale = error.state === "stale" ? " (stale)" : "";
  return `Session ${shortSessionId(error.summary.id)} · ${error.summary.title} is open in ${describeLeaseHolder(error.holder)}${stale}.`;
}

/**
 * The one line `-c` prints when it passed over a session another shell holds
 * (specification §6.1, AC1): the session, and its holder with the pid.
 */
export function describeSkippedSession(skipped: SkippedSession): string {
  const stale = skipped.state === "stale" ? " (stale)" : "";
  return `Skipped session ${shortSessionId(skipped.summary.id)} · ${skipped.summary.title}: open in ${describeLeaseHolder(skipped.holder)}${stale}\n`;
}
