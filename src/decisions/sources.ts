// Flow 400: where a journaled decision came from. Every question a human answers about the work goes through
// the journal and carries one of these as `source`: the model's own ask_user, the round-limit picker, and the
// TUI pickers that choose how work proceeds.
//
// Pure permissions (allow/deny of a command, a patch, a subagent, a mode) are NOT journaled: they have no
// recommendation to follow or ignore, so an arm and a deviation would measure nothing.

export const DECISION_SOURCES = {
  /** The model asked through the `ask_user` tool. */
  askUser: "ask_user",
  /** "Tool-loop round limit reached: increase the limit or cancel". */
  roundLimit: "round-limit",
  /** The TUI picker for how a wiki enrich run proceeds (drafts only or force all). */
  wikiEnrich: "tui-wiki-enrich",
  /** The TUI picker that routes a message sent while the main agent is busy (main queue or side worker). */
  queueRoute: "tui-queue-route",
  /** The TUI picker for a session that another shell already holds (fork, view, cancel). */
  sessionLease: "tui-session-lease",
} as const;

export type DecisionSource = (typeof DECISION_SOURCES)[keyof typeof DECISION_SOURCES];

/** The sources a work decision may carry, for tests and for a report that groups by source. */
export const WORK_DECISION_SOURCES: readonly string[] = Object.values(DECISION_SOURCES);
