// Run buttons (flow 523, plan "State × event matrix"): a Run click in a session's transcript is a tracked
// run. The terminal panel opens a tab whose process is the user's shell running exactly the command; when
// that process ends, or on "Send output now", the run's result goes to the session that showed the button
// as one `session/prompt` carrying `_meta.keryx.terminalResults`, once that session has no turn running,
// and keryx starts the agent's follow-up turn on its own. Runs are the window's and are not kept across a
// reload. No React; the hook supplies the platform.

import type { PtyTab } from "../platform/panels";
import type { RunOrigin } from "../panels/panelBus";
import type { Action, TerminalRunState, TerminalRunView } from "./reducer";

/** The most results one prompt carries (keryx refuses more); the rest go after that turn ends. */
export const RESULTS_PER_PROMPT = 8;
/** The output tail a result carries: at most this many lines… */
export const RUN_OUTPUT_LINES = 200;
/** …and at most this many bytes of UTF-8, the last ones. */
export const RUN_OUTPUT_MAX_BYTES = 16 * 1024;
/** The longest command keryx takes in a result, in characters. */
export const RUN_COMMAND_MAX_CHARS = 4096;
/** After a busy refusal the session is asked again no sooner than this. */
export const BUSY_RETRY_MS = 1000;

/** What the card says when keryx's `initialize` did not offer `_meta.keryx.terminalResults`. */
export const RESULTS_UNSUPPORTED = "this keryx does not take run results";

/** One entry of `_meta.keryx.terminalResults`: exactly these fields, which keryx validates strictly. */
export type TerminalResultEntry =
  | { runId: string; command: string; state: "exited"; exitCode: number | null; durationMs: number; output: string }
  | { runId: string; command: string; state: "running"; durationMs: number; output: string };

/** How keryx answered a results prompt. */
export type DeliveryOutcome =
  /** It took the results (the follow-up turn ran, or failed after they were stored). */
  | { kind: "done" }
  /** A turn was already running: nothing was stored. */
  | { kind: "busy" }
  /** It refused the prompt before storing anything (invalid params, unknown session). */
  | { kind: "refused"; error: string };

export interface TerminalRunDeps {
  /** keryx's `initialize._meta.keryx.terminalResults`; null while no `initialize` was answered on this connection. */
  acceptsResults(): boolean | null;
  /**
   * Send one `session/prompt` carrying `results` to `sessionId`, or null when that session cannot take a
   * prompt now (not held, not initialized, a turn running). The promise settles when keryx answers.
   */
  send(sessionId: string, results: readonly TerminalResultEntry[]): Promise<DeliveryOutcome> | null;
  /** The last `lines` lines of a tab's output as plain text. */
  tail(tabId: number, lines: number): Promise<string>;
  /** Open the side panel on Terminal and show `tab`. */
  showTab(tab: PtyTab): void;
  dispatch(a: Action): void;
  now(): number;
  /** A fresh id matching keryx's `^[A-Za-z0-9_-]{1,64}$`. */
  newRunId(): string;
  /** Run `fn` once, `ms` from now. */
  later(fn: () => void, ms: number): void;
}

export interface TerminalRuns {
  /** A Run click with an origin: its card is added; returns the run's id. */
  requested(command: string, origin: RunOrigin): string;
  /** The panel opened the run's tab. */
  opened(runId: string, tab: PtyTab): void;
  /** The panel could not open the run's tab. */
  failed(runId: string, error: string): void;
  /** A tab's process ended (`panel://pty-exit`). Ignored for tabs that are not runs. */
  exited(tabId: number, code: number | null): Promise<void>;
  /** The user closed a tab. A run still running is "closed": nothing is sent. */
  closed(tabId: number): void;
  /** "Send output now": a snapshot of a running run's output goes to its session. */
  sendNow(runId: string): Promise<void>;
  /** "Show tab"; false when the run is unknown or its tab is closed. */
  showTab(runId: string): boolean;
  /** Deliver what waits for `sessionId` (every session when omitted) if it can take a prompt now. */
  flush(sessionId?: string): void;
}

interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly command: string;
  state: TerminalRunState;
  tab: PtyTab | null;
  tabOpen: boolean;
  startedAt: number;
  exit: { code: number | null; durationMs: number } | null;
  result: TerminalResultEntry | null;
  /** Its place in the delivery order, from the first time its result was ready. */
  seq: number;
  error?: string;
  /** A "Send output now" read of the tail is in flight. */
  reading: boolean;
}

/** The last `RUN_OUTPUT_LINES` lines of `text`, then its last `RUN_OUTPUT_MAX_BYTES` bytes, cut at a character. */
export function capRunOutput(text: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const kept = lines.length > RUN_OUTPUT_LINES ? lines.slice(-RUN_OUTPUT_LINES).join("\n") : body;
  const bytes = new TextEncoder().encode(kept);
  if (bytes.length <= RUN_OUTPUT_MAX_BYTES) return kept;
  let start = bytes.length - RUN_OUTPUT_MAX_BYTES;
  // UTF-8 continuation bytes are 10xxxxxx: start at the next character's first byte.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Exits of tabs not (yet) known as runs, kept for a run whose tab id arrives after its exit. */
const EARLY_EXITS_KEPT = 32;

/** A result waits for delivery only in this state; a waiting snapshot is replaced by the exit's result. */
const deliverable = (run: Run): run is Run & { result: TerminalResultEntry } => run.state === "waiting" && run.result !== null;

export function createTerminalRuns(deps: TerminalRunDeps): TerminalRuns {
  const runs = new Map<string, Run>();
  const byTab = new Map<number, string>();
  const early = new Map<number, number | null>();
  /** Sessions that refused as busy: not asked again before this time. */
  const pausedUntil = new Map<string, number>();
  let seq = 0;

  const view = (run: Run): TerminalRunView => ({
    runId: run.runId,
    command: run.command,
    state: run.state,
    tabOpen: run.tabOpen,
    ...(run.exit ? { exitCode: run.exit.code, durationMs: run.exit.durationMs } : {}),
    ...(run.result ? { output: run.result.output } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  });
  const show = (run: Run): void => deps.dispatch({ t: "terminalRun", sessionId: run.sessionId, run: view(run) });
  const runOfTab = (tabId: number): Run | undefined => {
    const id = byTab.get(tabId);
    return id === undefined ? undefined : runs.get(id);
  };
  const elapsed = (run: Run): number => Math.max(0, Math.round(deps.now() - run.startedAt));

  /** The tail as a result carries it; a tail that cannot be read says so instead of passing for empty output. */
  const readOutput = async (tab: PtyTab): Promise<string> => {
    try {
      return capRunOutput(await deps.tail(tab.id, RUN_OUTPUT_LINES));
    } catch (e) {
      return `[the output could not be read: ${errText(e)}]`;
    }
  };

  const notSent = (run: Run, why: string): void => {
    run.state = "not-sent";
    run.error = why;
    show(run);
  };

  /** The run's result is built: it waits for its session, or cannot be sent at all. */
  const ready = (run: Run): void => {
    if (run.command.length > RUN_COMMAND_MAX_CHARS) return notSent(run, `the command is longer than the ${RUN_COMMAND_MAX_CHARS} characters keryx takes`);
    if (deps.acceptsResults() === false) return notSent(run, RESULTS_UNSUPPORTED);
    run.state = "waiting";
    if (run.seq === 0) run.seq = ++seq;
    show(run);
    flush(run.sessionId);
  };

  const settle = (sessionId: string, batch: readonly Run[], outcome: DeliveryOutcome): void => {
    if (outcome.kind === "done") return;
    for (const run of batch) {
      if (run.state !== "sent" && run.state !== "sent-while-running") continue;
      if (outcome.kind === "refused") notSent(run, outcome.error);
      else {
        run.state = "waiting";
        show(run);
      }
    }
    if (outcome.kind === "busy") {
      // Asked again after a pause and at the next turn end, not on the refused send's own end.
      pausedUntil.set(sessionId, deps.now() + BUSY_RETRY_MS);
      deps.later(() => flush(sessionId), BUSY_RETRY_MS);
    }
  };

  const deliver = (sessionId: string, accepts: boolean): void => {
    const waiting = [...runs.values()].filter((r) => r.sessionId === sessionId).filter(deliverable).sort((a, b) => a.seq - b.seq);
    if (waiting.length === 0) return;
    if (!accepts) {
      for (const run of waiting) notSent(run, RESULTS_UNSUPPORTED);
      return;
    }
    if ((pausedUntil.get(sessionId) ?? 0) > deps.now()) return;
    const batch = waiting.slice(0, RESULTS_PER_PROMPT);
    const reply = deps.send(sessionId, batch.map((r) => r.result));
    if (reply === null) return;
    pausedUntil.delete(sessionId);
    for (const run of batch) {
      run.state = run.result.state === "running" ? "sent-while-running" : "sent";
      show(run);
    }
    deps.dispatch({ t: "terminalSent", sessionId, runIds: batch.map((r) => r.runId) });
    void reply.then(
      (outcome) => settle(sessionId, batch, outcome),
      (e: unknown) => settle(sessionId, batch, { kind: "refused", error: errText(e) }),
    );
  };

  function flush(sessionId?: string): void {
    const accepts = deps.acceptsResults();
    if (accepts === null) return; // reconnecting: decided once keryx answers initialize
    const sessions = sessionId !== undefined ? [sessionId] : [...new Set([...runs.values()].filter(deliverable).map((r) => r.sessionId))];
    for (const s of sessions) deliver(s, accepts);
  }

  /** The process ended: the exit's result replaces whatever was not sent yet; otherwise the card only shows the exit. */
  const finish = async (run: Run): Promise<void> => {
    const tab = run.tab;
    const replaces = (): boolean => run.state === "running" || (run.state === "waiting" && run.result?.state === "running" && run.tabOpen);
    if (tab === null || !run.exit || !replaces()) return show(run);
    const output = await readOutput(tab);
    // A waiting snapshot may have been sent while the tail was read: then the exit only updates the card.
    if (!replaces()) return show(run);
    run.result = { runId: run.runId, command: run.command, state: "exited", exitCode: run.exit.code, durationMs: run.exit.durationMs, output };
    ready(run);
  };

  const api: TerminalRuns = {
    requested(command, origin) {
      const runId = deps.newRunId();
      const run: Run = {
        runId, sessionId: origin.sessionId, command, state: "starting", tab: null, tabOpen: false,
        startedAt: deps.now(), exit: null, result: null, seq: 0, reading: false,
      };
      runs.set(runId, run);
      show(run);
      return runId;
    },
    opened(runId, tab) {
      const run = runs.get(runId);
      if (!run || run.state !== "starting") return;
      run.tab = tab;
      run.tabOpen = true;
      run.state = "running";
      run.startedAt = deps.now();
      byTab.set(tab.id, runId);
      show(run);
      if (early.has(tab.id)) {
        const code = early.get(tab.id) ?? null;
        early.delete(tab.id);
        void api.exited(tab.id, code);
      }
    },
    failed(runId, error) {
      const run = runs.get(runId);
      if (!run || run.state !== "starting") return;
      run.state = "start-failed";
      run.error = error;
      show(run);
    },
    async exited(tabId, code) {
      const run = runOfTab(tabId);
      if (!run) {
        early.set(tabId, code);
        if (early.size > EARLY_EXITS_KEPT) early.delete(early.keys().next().value ?? tabId);
        return;
      }
      // The hang-up after a close, or a second report: the run already ended.
      if (run.exit || run.state === "closed") return;
      run.exit = { code, durationMs: elapsed(run) };
      await finish(run);
    },
    closed(tabId) {
      const run = runOfTab(tabId);
      if (!run || !run.tabOpen) return;
      run.tabOpen = false;
      if (run.state === "running" && !run.exit) run.state = "closed";
      show(run);
    },
    async sendNow(runId) {
      const run = runs.get(runId);
      if (!run || run.state !== "running" || run.exit || !run.tab || run.reading) return;
      run.reading = true;
      const output = await readOutput(run.tab);
      run.reading = false;
      // It ended (or was closed) meanwhile: the exit's own result goes instead.
      if (run.state !== "running" || run.exit) return;
      run.result = { runId: run.runId, command: run.command, state: "running", durationMs: elapsed(run), output };
      ready(run);
    },
    showTab(runId) {
      const run = runs.get(runId);
      if (!run || !run.tabOpen || !run.tab) return false;
      deps.showTab(run.tab);
      return true;
    },
    flush,
  };
  return api;
}
