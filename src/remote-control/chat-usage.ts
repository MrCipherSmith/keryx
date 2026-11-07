import type { LiveShellUsage } from "./live-shell";

export type SessionChatUsage = {
  turn: LiveShellUsage | null;
  session: LiveShellUsage | null;
  /** Some runs predate usage reporting, or the machine discarded part of a run's log. */
  incomplete: boolean;
};
