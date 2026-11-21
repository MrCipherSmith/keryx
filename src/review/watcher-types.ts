// Serialized by the CLI and read by both Desktop hosts.
export interface WatcherKey {
  repo: string;
  repositoryId: string;
  viewer: string;
}

export interface WatcherEvent {
  kind:
    | "opened"
    | "left_open"
    | "push"
    | "review_requested"
    | "review_request_removed"
    | "review_submitted"
    | "draft_changed"
    | "rebase"
    | "decision"
    | "ci"
    | "updated";
  number: number;
  at: string;
  headSha: string;
  description: string;
  reviewer?: string;
}

export const PR_WATCH_TOPICS = ["reviews", "requests", "status", "checks"] as const;
export type PrWatchTopic = typeof PR_WATCH_TOPICS[number];

export interface PrSubscription {
  number: number;
  topics: PrWatchTopic[];
  rebase?: true;
  activity?: WatcherEvent[];
}

export interface WatcherSnapshot {
  version: 1;
  state: "disabled" | "enabled" | "paused";
  intervalMinutes: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** A poll succeeded, but an earlier attempt could not be recovered. */
  recoveryWarning?: string;
  /** False when the local schedule can be shown but access to repository activity has not been verified. */
  historyAvailable?: boolean;
  events: WatcherEvent[];
  /** Filled from the operating system by the control command. */
  installed: boolean;
}

export const DEFAULT_WATCHER_MINUTES = 5;
