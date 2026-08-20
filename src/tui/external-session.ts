// Live store for external child runs backing the operator surface (flow 176, T16).
// Package: docs/requirements/keryx-external-agent-runtime §7.5, §8.2; D-10.
//
// D-10 splits the two audiences: the PARENT agent gets trigger-driven updates
// from the fold, because reading a verbose vendor transcript spends the
// operator's own model budget in proportion to another vendor's verbosity; the
// OPERATOR gets everything, because rendering costs nothing. This store is the
// operator's half. It holds what the modal renders and nothing else — no
// context, no tokens, no parent state.
//
// It is deliberately not `SubagentSessionStore`: that store models a native
// child (fleet phase, work-kind log lines) while this one models a vendor
// process (argv, session handle, sandbox, parse skips, reported cost). Merging
// them would force one of the two to carry fields that are meaningless for it,
// and the sidebar only needs the small overlap.
//
// Impure only in its clock, which is injected. Everything the modal displays is
// computed by the pure formatters in `./external-transcript`.
import type { ExternalEvent, ExternalSandbox } from "../harness/external/types";
import type { ExternalRunView } from "./external-transcript";

/**
 * Events retained per run.
 *
 * A cap exists because an external child's transcript is unbounded and this
 * store lives for the whole shell process. Oldest-first trimming keeps the tail
 * the operator is actually watching; the facts that only appear at the START of
 * a run (the session handle) are lifted onto the record before any trimming, so
 * dropping the first events can never lose the resume route.
 */
export const MAX_EXTERNAL_EVENTS = 500;

/** How a run was launched — the fact `planExternalDelivery` needs and the registry cannot supply. */
export interface ExternalRunLaunch {
  readonly agentId: string;
  /** Registry label (`Codex`, `Claude`). */
  readonly agentLabel?: string;
  readonly model?: string;
  readonly sandbox?: ExternalSandbox;
  /** Absolute path of the disposable worktree (§7.2). */
  readonly worktreePath?: string;
  /** The exact launch argv, available before the run ends so Command works live. */
  readonly argv?: readonly string[];
  /** Assigned session handle (claude). codex announces its own on `thread.started`. */
  readonly sessionRef?: string;
  /** Registry `reportsCost`: turns a bare MISSING into an explained one. */
  readonly reportsCost?: boolean;
}

/** What a finished run contributes. Structurally the fields of `ExternalChildOutcome`. */
export interface ExternalRunCompletion {
  readonly status: string;
  readonly argv?: readonly string[];
  readonly sessionRef?: string;
  readonly costUnits?: number;
  readonly skippedLines?: number;
}

/** Which run changed, so an open inspector can ignore updates for other children. */
export type ExternalStoreHint = { readonly id: string; readonly kind: "start" | "event" | "warning" | "end" };

/** Internal mutable record. `ExternalRunView` is its readonly public face. */
interface MutableRun {
  id: string;
  agentId: string;
  agentLabel?: string;
  model?: string;
  sandbox?: ExternalSandbox;
  worktreePath?: string;
  argv?: readonly string[];
  resumeArgv?: readonly string[];
  sessionRef?: string;
  reportsCost?: boolean;
  costUnits?: number;
  skippedLines?: number;
  warnings: string[];
  status?: string;
  startedAt: number;
  endedAt?: number;
  events: ExternalEvent[];
}

/**
 * Session-scoped log of external child runs.
 *
 * Entries are never dropped one at a time, for the same reason
 * `SubagentSessionStore` keeps its own: a child that finished mid-turn must stay
 * clickable, or the operator loses the transcript at the exact moment they want
 * to read why it ended. `clear()` resets the whole store on `/clear` or a new
 * turn.
 */
export class ExternalRunStore {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<(hint: ExternalStoreHint) => void>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Register a run at spawn time. Re-registering an id refreshes its launch facts. */
  start(id: string, launch: ExternalRunLaunch): void {
    const existing = this.runs.get(id);
    const run: MutableRun = existing ?? {
      id,
      agentId: launch.agentId,
      warnings: [],
      startedAt: this.now(),
      events: [],
      status: "running",
    };
    run.agentId = launch.agentId;
    if (launch.agentLabel !== undefined) run.agentLabel = launch.agentLabel;
    if (launch.model !== undefined) run.model = launch.model;
    if (launch.sandbox !== undefined) run.sandbox = launch.sandbox;
    if (launch.worktreePath !== undefined) run.worktreePath = launch.worktreePath;
    if (launch.argv !== undefined) run.argv = launch.argv;
    if (launch.sessionRef !== undefined) run.sessionRef = launch.sessionRef;
    if (launch.reportsCost !== undefined) run.reportsCost = launch.reportsCost;
    this.runs.set(id, run);
    this.emit({ id, kind: "start" });
  }

  /**
   * Append one canonical event. Unknown ids are ignored rather than
   * auto-created: an event for a run nobody registered means the caller lost
   * track of it, and inventing a nameless entry hides that.
   */
  event(id: string, event: ExternalEvent): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    // Lifted BEFORE trimming: the handle arrives on the very first event of a
    // codex run, and losing it would silently remove the resume route.
    if (event.kind === "child_started" && event.sessionRef !== undefined) run.sessionRef = event.sessionRef;
    run.events.push(event);
    if (run.events.length > MAX_EXTERNAL_EVENTS) {
      run.events.splice(0, run.events.length - MAX_EXTERNAL_EVENTS);
    }
    this.emit({ id, kind: "event" });
  }

  /** Record a warning (out-of-range CLI version, truncated diff). Never a failure. */
  warn(id: string, warning: string): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    run.warnings.push(warning);
    this.emit({ id, kind: "warning" });
  }

  /** Attach the argv that continues this session by hand (Command tab, D-11). */
  setResumeArgv(id: string, argv: readonly string[]): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    run.resumeArgv = argv;
    this.emit({ id, kind: "event" });
  }

  /** Fold a finished run's outcome onto the record. */
  finish(id: string, completion: ExternalRunCompletion): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    run.status = completion.status;
    run.endedAt = this.now();
    if (completion.argv !== undefined) run.argv = completion.argv;
    if (completion.sessionRef !== undefined) run.sessionRef = completion.sessionRef;
    // An absent cost never overwrites a reported one, and never becomes zero.
    if (completion.costUnits !== undefined) run.costUnits = completion.costUnits;
    if (completion.skippedLines !== undefined) run.skippedLines = completion.skippedLines;
    this.emit({ id, kind: "end" });
  }

  /** One run's view, or undefined when the id is unknown. */
  get(id: string): ExternalRunView | undefined {
    return this.runs.get(id);
  }

  /** Every tracked run, in registration order. */
  list(): ExternalRunView[] {
    return [...this.runs.values()];
  }

  /** Whether this run is still live — what `planExternalDelivery` reads. */
  isRunning(id: string): boolean {
    const run = this.runs.get(id);
    return run !== undefined && run.endedAt === undefined;
  }

  /** Drop every tracked run (`/clear`, `/new`, or a fresh parent turn). */
  clear(): void {
    if (this.runs.size === 0) return;
    this.runs.clear();
    this.emit({ id: "*", kind: "end" });
  }

  /** Subscribe to change hints. Returns the unsubscribe. */
  subscribe(listener: (hint: ExternalStoreHint) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(hint: ExternalStoreHint): void {
    for (const listener of this.listeners) {
      try {
        listener(hint);
      } catch {
        // A broken subscriber must never break the run it is watching.
      }
    }
  }
}
