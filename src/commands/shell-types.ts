import type { ProviderPort } from "../harness/provider/types";

/** Async line source + write sink; no real stdio is reached by `runShell`. */
export interface ShellIO {
  lines: AsyncIterable<string>;
  write: (s: string) => void;
  /**
   * OPTIONAL rich-rendering hooks (flow 031). They let a TTY wrapper tell
   * assistant token deltas (still `write`) apart from system text and see turn
   * boundaries, so it can render a spinner + markdown.
   */
  onTurnStart?: () => void;
  onTurnEnd?: (full: string) => void;
  onSystem?: (text: string) => void;
  /** Flush queued asynchronous notices only while terminal output is safe. */
  onSafeBoundary?: () => void;
}

/** Optional per-project session wiring for chat/agent REPLs. */
export interface ShellSessionOpts {
  cwd: string;
  continueLast?: boolean;
  resumeId?: string;
  /** When false, skip persistence (tests default). Default true when object set. */
  enabled?: boolean;
}

/** Injected dependencies keeping `runShell` deterministic + offline. */
export interface ShellDeps {
  makeProvider: (name: string, model: string, baseUrl?: string) => ProviderPort;
  clock: () => string;
  idSeq: () => string;
  initial: { provider: string; model: string; baseUrl?: string };
  /**
   * Bundled detect+pick selector for the `/models` and `/provider` (no-arg)
   * slash commands. `/models` passes `{ onlyProvider: <current provider> }` to
   * offer only the current provider's models; `/provider` passes no opts (a
   * full re-selection across all providers). When omitted, both commands
   * write a "not available" message and no-op (they NEVER crash the loop).
   */
  selectProviderModel?: (
    io: ShellIO,
    opts?: { onlyProvider?: string },
  ) => Promise<{ provider: string; model: string; baseUrl?: string }>;
  /** When set, persist chat turns to a per-project session. */
  session?: ShellSessionOpts;
}
