import type { BusClient } from "../bus/client";
import type { PresenceSurface } from "../bus/schema";
import type { ProviderPort } from "../harness/provider/types";
import type { OpenLeasedSessionOptions, OpenLeasedSessionResult, SessionLeaseHandle } from "../session/lease";

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
  /** With `resumeId`: fork the session and lease the fork (`--fork`). */
  fork?: boolean;
  /** With `resumeId`: reclaim a STALE holder's lease (`--take-over`). */
  takeOver?: boolean;
  /**
   * Written by the REPL with the session lease it currently holds, so a caller
   * outside the loop (the readline SIGINT/SIGTERM handler) can release it.
   */
  leaseBox?: { current: SessionLeaseHandle | undefined };
  /**
   * Test seam: the leased open used for the start-up open and for `/new`.
   * Production leaves it unset and gets `openLeasedSession`.
   */
  openLeased?: (opts: OpenLeasedSessionOptions) => OpenLeasedSessionResult;
  /**
   * `--name` (flow 273 T6), or the shell config's `bus.name`: the requested
   * bus instance name (decision D-06), threaded to `joinBus`'s
   * `requestedName`. Also the field the TUI launch options carry the same
   * value under (`session.busName` in `src/tui/tui-shell.ts`'s own opts), so
   * `keryx shell --name` reaches that surface's `joinBus` call too even
   * though that surface never reads THIS interface.
   */
  busName?: string;
  /**
   * Which bus `surface` this shell reports as (specification §4.1). The
   * readline chat and agent REPLs default to `"readline"`; the chat TUI —
   * driven through this same `runShell` — sets `"tui"`.
   */
  busSurface?: PresenceSurface;
  /**
   * Written by the REPL with the bus client it joined (mirrors `leaseBox`),
   * so a caller outside the loop (the readline SIGINT/SIGTERM handler) can
   * call `leave()` synchronously before `process.exit` (specification §5.4).
   */
  busBox?: { current: BusClient | undefined };
}

/** Resolved per-provider sampling/budget/timeout overrides (flow 268). */
export interface ShellModelParams {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** Injected dependencies keeping `runShell` deterministic + offline. */
export interface ShellDeps {
  makeProvider: (name: string, model: string, baseUrl?: string) => ProviderPort;
  clock: () => string;
  idSeq: () => string;
  initial: { provider: string; model: string; baseUrl?: string; modelParams?: ShellModelParams };
  /**
   * Bundled detect+pick selector for `/models`, `/provider`, and `/connect`.
   * `/models` passes `{ onlyProvider }`; `/provider` passes no opts (configure);
   * `/connect` passes `{ onlyConnected: true }` (switch among live providers).
   * When omitted, `/models`/`/provider` write "not available"; `/connect` falls
   * back to static env guidance. They NEVER crash the loop.
   */
  selectProviderModel?: (
    io: ShellIO,
    opts?: { onlyProvider?: string; onlyConnected?: boolean },
  ) => Promise<{ provider: string; model: string; baseUrl?: string; modelParams?: ShellModelParams }>;
  /** When set, persist chat turns to a per-project session. */
  session?: ShellSessionOpts;
}
