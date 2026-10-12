// The two pure decisions the full-screen shell makes around `/history` and the topic's restore
// (flow 399). They used to be inline in `tui-shell.ts`, where no test could reach them: a flipped
// mapping would have posted a resumed session's restore as a new session's welcome (or the
// reverse) with every other test still green.

/** What the topic is told about the session the shell just entered. */
export type SessionEntryKind = "new" | "resumed";

export interface SessionEntry {
  /** What the history restore reads: true only for a session that already had a past. */
  readonly resumed: boolean;
  /** What the bridge's `sessionEntered` is called with. */
  readonly kind: SessionEntryKind;
}

/**
 * The entry a shell makes into a session it has just opened. `resumed` is `openSession`'s own
 * answer: true for `-r <id>`, `/resume <id>` and `-c` when a session existed to continue, false
 * for a session that was just created (the plain start, `-c` with nothing to continue, `/new`).
 */
export function sessionEntryOf(resumed: boolean): SessionEntry {
  return { resumed, kind: resumed ? "resumed" : "new" };
}

/** `/new` and `/clear` never resume: they always create a session. */
export const NEW_SESSION_ENTRY: SessionEntry = sessionEntryOf(false);

/** The text after the command word of a `/history [N]` line, as `parseHistoryArgs` reads it. */
export function historyArgsOf(line: string): string {
  return line.trim().split(/\s+/).slice(1).join(" ");
}
