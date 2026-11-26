// Run buttons (flow 523, plan "State × event matrix"): a Run click in a session's transcript is a tracked
// run. The terminal panel opens a tab whose process is the user's shell running exactly the command; when
// that process ends, or on "Send output now", the run's result goes to the session that showed the button
// as one `session/prompt` carrying `_meta.keryx.terminalResults`, once that session has no turn running,
// and keryx starts the agent's follow-up turn on its own. Runs are the window's and are not kept across a
// reload. No React; the hook supplies the platform.

import type { PtyTab, PtyTail } from "../platform/panels";
import type { RunOrigin } from "../panels/panelBus";
import { runCanChange, type Action, type TerminalRunState, type TerminalRunView } from "./reducer";

// The wire limits below are copies of keryx's own (`src/acp/terminal-result.ts`: TERMINAL_RESULTS_MAX,
// TERMINAL_COMMAND_MAX_CHARS, TERMINAL_RESULT_MAX_BYTES, TERMINAL_OUTPUT_CUT_LINE, its runId pattern and
// TerminalResult). The web view cannot import that module, which reads node:fs through its redaction.
// terminalRuns.test.ts loads it and fails when one of the three limits or the cut line differs, or when a
// batch built here does not pass keryx's validator. That test is in the desktop suite, which CI runs
// (desktop-check.yml) for a change under apps/desktop/** or to src/acp/terminal-result.ts or
// src/session/terminal-note.ts. The copies it does not compare: the runId pattern (newRunId; a batch it
// builds passes the validator, which covers a mismatch only through the ids the test makes), the replayed
// note's shape (reducer.ts terminalNoteOf) and keryx's refusal conditions (useAcpSession.ts).

/** The most results one prompt carries (keryx refuses more); the rest go after that turn ends. */
export const RESULTS_PER_PROMPT = 8;
/** The output tail a result carries: at most this many lines… */
export const RUN_OUTPUT_LINES = 200;
/** …and at most this many bytes of UTF-8, the last ones. */
export const RUN_OUTPUT_MAX_BYTES = 16 * 1024;
/** The longest command keryx takes in a result, in characters. */
export const RUN_COMMAND_MAX_CHARS = 4096;
/** After a busy refusal the session is asked again no sooner than this; each refusal in a row doubles it… */
export const BUSY_RETRY_MS = 1000;
/** …up to this. */
export const BUSY_RETRY_MAX_MS = 30_000;

/** The first line of an output that lost its beginning to the line or byte cap: the agent is told it is a tail. */
export const RUN_OUTPUT_CUT = "[… earlier output was cut; the end of the output follows]";

/**
 * The line after the cut line when no whole line fits (the last line alone is over the cap, or the host kept
 * only part of one line): the end the cut line promises is not there, and the output is not empty.
 */
export const RUN_OUTPUT_NOTHING_WHOLE = "[the last line is longer than 16 KiB and was not sent]";

/** What the card says when keryx's `initialize` did not offer `_meta.keryx.terminalResults`. */
export const RESULTS_UNSUPPORTED = "this keryx does not take run results";

/** A fresh run id, matching keryx's `^[A-Za-z0-9_-]{1,64}$`. */
export const newRunId = (): string => `run-${crypto.randomUUID()}`;

/** One entry of `_meta.keryx.terminalResults`: exactly these fields, which keryx validates strictly. */
export type TerminalResultEntry =
  | { runId: string; command: string; state: "exited"; exitCode: number | null; durationMs: number; output: string }
  | { runId: string; command: string; state: "running"; durationMs: number; output: string };

/** How keryx answered a results prompt. */
export type DeliveryOutcome =
  /**
   * It took the results: the follow-up turn ran, or failed after they were stored, or keryx had stored every
   * one of them already (a resend after a lost connection: it skips a run id it holds and answers success).
   */
  | { kind: "done" }
  /** A turn was already running: nothing was stored. Asked again after a pause. */
  | { kind: "busy" }
  /** It refused the prompt before storing anything (invalid params, unknown session): final. */
  | { kind: "refused"; error: string }
  /**
   * Not taken now, and sent again once the window holds the session again (`resume`): keryx released it or
   * is shutting down (nothing was stored), or the connection was lost with no answer (the prompt may never
   * have reached keryx; one that did is skipped as a duplicate).
   */
  | { kind: "wait" };

export interface TerminalRunDeps {
  /** keryx's `initialize._meta.keryx.terminalResults`; null while no `initialize` was answered on this connection. */
  acceptsResults(): boolean | null;
  /**
   * Send one `session/prompt` carrying `results` to `sessionId`, or null when that session cannot take a
   * prompt now (not held, not initialized, a turn or a command running, or a load's caller holding its slot
   * for a turn of its own). The promise settles when keryx answers.
   */
  send(sessionId: string, results: readonly TerminalResultEntry[]): Promise<DeliveryOutcome> | null;
  /** The last `lines` lines of a tab's output as plain text, and whether the host dropped earlier output. */
  tail(tabId: number, lines: number): Promise<PtyTail>;
  /** Open the side panel on Terminal and show `tab`. */
  showTab(tab: PtyTab): void;
  dispatch(a: Action): void;
  now(): number;
  /** A fresh id matching keryx's `^[A-Za-z0-9_-]{1,64}$` (`newRunId`). */
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
  /**
   * Deliver what waits for `sessionId` (every session when omitted) if it can take a prompt now. Returns
   * the sessions a results prompt went to: their turn slot is taken.
   */
  flush(sessionId?: string): ReadonlySet<string>;
  /**
   * The window holds `sessionId` again (its load finished): results that answered "wait" may go again.
   * Nothing is sent here: the next `flush` sends them. Issue questions the load resumes are sent before that
   * flush, and a load whose caller starts a turn itself (a review) holds the session's slot for that turn
   * (useAcpSession `holdForCaller`: `send` answers null until the hold ends), so either goes first.
   */
  resume(sessionId: string): void;
  /** How many runs the store still holds; one that can no longer change is dropped (its card stays). */
  tracked(): number;
}

interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly command: string;
  state: TerminalRunState;
  tab: PtyTab | null;
  tabOpen: boolean;
  startedAt: number;
  /** The process's end; `tabOpen` says whether its tab was still open then (a real end, not the hang-up of a close). */
  exit: { code: number | null; durationMs: number; tabOpen: boolean } | null;
  result: TerminalResultEntry | null;
  /** Its place in the delivery order, from the first time its result was ready. */
  seq: number;
  error?: string;
  /** Reads of the tab's tail in flight ("Send output now", the exit's result). */
  reads: number;
  /** A results prompt carrying this run is on its way and keryx has not answered. */
  sending: boolean;
}

const NEWLINE = 0x0a;

/**
 * The output a result carries: whole lines only, at most `RUN_OUTPUT_LINES` of them and
 * `RUN_OUTPUT_MAX_BYTES` bytes of UTF-8, the last ones. A text that lost its beginning (more lines or
 * bytes than that, or `truncated`: the host already dropped earlier output) starts with the
 * `RUN_OUTPUT_CUT` line, counted within both caps. keryx redacts what it is sent, so a byte cut never
 * starts inside a line: the partial line is left out, and no fragment of a secret's line (a token whose
 * prefix was cut off, a value without its `NAME=`) reaches it. A last line longer than the caps leaves
 * only the cut line and the `RUN_OUTPUT_NOTHING_WHOLE` line.
 */
export function capRunOutput(text: string, truncated = false): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const encoder = new TextEncoder();
  if (!truncated && lines.length <= RUN_OUTPUT_LINES && encoder.encode(body).length <= RUN_OUTPUT_MAX_BYTES) return body;
  // Cut: the RUN_OUTPUT_CUT line takes one of the lines and its bytes.
  const bytes = encoder.encode(lines.slice(-(RUN_OUTPUT_LINES - 1)).join("\n"));
  const room = RUN_OUTPUT_MAX_BYTES - encoder.encode(`${RUN_OUTPUT_CUT}\n`).length;
  let start = 0;
  if (bytes.length > room) {
    start = bytes.length - room;
    // Not at a line's start: from the next line (a newline byte is never inside a UTF-8 character).
    if (bytes[start - 1] !== NEWLINE) {
      const next = bytes.indexOf(NEWLINE, start);
      start = next < 0 ? bytes.length : next + 1;
    }
  }
  const kept = new TextDecoder().decode(bytes.subarray(start));
  return kept === "" ? `${RUN_OUTPUT_CUT}\n${RUN_OUTPUT_NOTHING_WHOLE}` : `${RUN_OUTPUT_CUT}\n${kept}`;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Exits of tabs not (yet) known as runs, kept for a run whose tab id arrives after its exit. */
const EARLY_EXITS_KEPT = 32;

/** Its process ended while its tab was open: a real end, not the hang-up of a close. */
const endedWithTabOpen = (run: Run): boolean => run.exit?.tabOpen === true;

/**
 * A waiting "Send output now" snapshot of a run whose process has ended with its tab open: the exit's
 * result replaces it (a snapshot whose tab was closed first goes as it is).
 */
const superseded = (run: Run): boolean => endedWithTabOpen(run) && run.result?.state === "running";

/** A result waits for delivery only in this state, and never as a snapshot its exit replaces. */
const deliverable = (run: Run): run is Run & { result: TerminalResultEntry } =>
  run.state === "waiting" && run.result !== null && !superseded(run);

export function createTerminalRuns(deps: TerminalRunDeps): TerminalRuns {
  const runs = new Map<string, Run>();
  const byTab = new Map<number, string>();
  const early = new Map<number, number | null>();
  /** Sessions that refused as busy: not asked again before this time. */
  const pausedUntil = new Map<string, number>();
  /** Busy refusals in a row per session, for the next pause. */
  const busyStreak = new Map<string, number>();
  /** Sessions that answered "wait": asked again only on `resume`. */
  const parked = new Set<string>();
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
  /** Nothing can change the run any more: it leaves the store, its card keeps what it shows. */
  const forget = (run: Run): void => {
    runs.delete(run.runId);
    if (run.tab) byTab.delete(run.tab.id);
  };
  /**
   * It cannot change (a final state, "not sent" included, and its tab closed: `runCanChange`), its process's
   * end (if it had a tab) was seen, and nothing is read or sent for it in flight. A reload keeps cards by a
   * stricter rule (reducer.ts `keptOnReload`: a "not sent" card goes whatever its tab does); the store keeps
   * such a run while its tab is open all the same, so its Show tab works and the tab's close reaches its card.
   */
  const forgetIfDone = (run: Run): void => {
    const done = !runCanChange(run) && (run.tab === null || run.exit !== null) && run.reads === 0 && !run.sending;
    if (done) forget(run);
  };
  const show = (run: Run): void => {
    deps.dispatch({ t: "terminalRun", sessionId: run.sessionId, run: view(run) });
    forgetIfDone(run);
  };
  const runOfTab = (tabId: number): Run | undefined => {
    const id = byTab.get(tabId);
    return id === undefined ? undefined : runs.get(id);
  };
  const elapsed = (run: Run): number => Math.max(0, Math.round(deps.now() - run.startedAt));

  /** The tail as a result carries it; a tail that cannot be read says so instead of passing for empty output. */
  const readOutput = async (run: Run, tab: PtyTab): Promise<string> => {
    run.reads += 1;
    try {
      const tail = await deps.tail(tab.id, RUN_OUTPUT_LINES + 1);
      return capRunOutput(tail.text, tail.truncated);
    } catch (e) {
      return `[the output could not be read: ${errText(e)}]`;
    } finally {
      run.reads -= 1;
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
    for (const run of batch) run.sending = false;
    if (outcome.kind !== "busy") busyStreak.delete(sessionId);
    if (outcome.kind === "done") {
      for (const run of batch) forgetIfDone(run);
      return;
    }
    // keryx stored nothing: the follow-up turn `terminalSent` counted did not start.
    deps.dispatch({ t: "terminalUnsent", sessionId });
    for (const run of batch) {
      if (run.state !== "sent" && run.state !== "sent-while-running") continue;
      if (outcome.kind === "refused") {
        notSent(run, outcome.error);
        continue;
      }
      run.state = "waiting";
      show(run);
      // A snapshot whose process ended while it was on its way: the exit's result goes instead.
      if (superseded(run) && run.reads === 0) void finish(run);
    }
    if (outcome.kind === "wait") parked.add(sessionId);
    if (outcome.kind === "busy") {
      // Asked again after a pause that doubles with each refusal in a row, and at a turn end after it.
      const streak = busyStreak.get(sessionId) ?? 0;
      busyStreak.set(sessionId, streak + 1);
      const pause = Math.min(BUSY_RETRY_MS * 2 ** streak, BUSY_RETRY_MAX_MS);
      pausedUntil.set(sessionId, deps.now() + pause);
      deps.later(() => flush(sessionId), pause);
    }
  };

  /** True when a results prompt went to `sessionId`. */
  const deliver = (sessionId: string, accepts: boolean): boolean => {
    const waiting = [...runs.values()].filter((r) => r.sessionId === sessionId).filter(deliverable).sort((a, b) => a.seq - b.seq);
    if (waiting.length === 0) return false;
    if (!accepts) {
      for (const run of waiting) notSent(run, RESULTS_UNSUPPORTED);
      return false;
    }
    if (parked.has(sessionId) || (pausedUntil.get(sessionId) ?? 0) > deps.now()) return false;
    const batch = waiting.slice(0, RESULTS_PER_PROMPT);
    const reply = deps.send(sessionId, batch.map((r) => r.result));
    if (reply === null) return false;
    pausedUntil.delete(sessionId);
    for (const run of batch) {
      run.state = run.result.state === "running" ? "sent-while-running" : "sent";
      run.sending = true;
      show(run);
    }
    deps.dispatch({ t: "terminalSent", sessionId, runIds: batch.map((r) => r.runId) });
    void reply.then(
      (outcome) => settle(sessionId, batch, outcome),
      (e: unknown) => settle(sessionId, batch, { kind: "refused", error: errText(e) }),
    );
    return true;
  };

  function flush(sessionId?: string): ReadonlySet<string> {
    const took = new Set<string>();
    const accepts = deps.acceptsResults();
    if (accepts === null) return took; // reconnecting: decided once keryx answers initialize
    const sessions = sessionId !== undefined ? [sessionId] : [...new Set([...runs.values()].filter(deliverable).map((r) => r.sessionId))];
    for (const s of sessions) if (deliver(s, accepts)) took.add(s);
    return took;
  }

  /**
   * The process ended: the exit's result replaces whatever was not sent yet; otherwise the card only shows
   * the exit. An end after the tab closed (the hang-up while "Send output now" read the tail) is no result.
   */
  const finish = async (run: Run): Promise<void> => {
    const tab = run.tab;
    const replaces = (): boolean => endedWithTabOpen(run) && (run.state === "running" || (run.state === "waiting" && superseded(run)));
    if (tab === null || !run.exit || !replaces()) return show(run);
    const output = await readOutput(run, tab);
    // Sent, closed or refused while the tail was read: then the exit only updates the card.
    if (!replaces()) return show(run);
    run.result = { runId: run.runId, command: run.command, state: "exited", exitCode: run.exit.code, durationMs: run.exit.durationMs, output };
    ready(run);
  };

  const api: TerminalRuns = {
    requested(command, origin) {
      const runId = deps.newRunId();
      const run: Run = {
        runId, sessionId: origin.sessionId, command, state: "starting", tab: null, tabOpen: false,
        startedAt: deps.now(), exit: null, result: null, seq: 0, reads: 0, sending: false,
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
      // The hang-up after a close: the run already ended, and now nothing can change it.
      if (run.state === "closed") return forget(run);
      // A second report.
      if (run.exit) return;
      run.exit = { code, durationMs: elapsed(run), tabOpen: run.tabOpen };
      await finish(run);
    },
    closed(tabId) {
      const run = runOfTab(tabId);
      if (!run || !run.tabOpen) return;
      run.tabOpen = false;
      // Still running: closed, and nothing is sent. A "Send output now" whose tail is being read (the only
      // read before an end) was asked for first: its snapshot still goes once (AC8's exception).
      if (run.state === "running" && !run.exit && run.reads === 0) run.state = "closed";
      show(run);
    },
    async sendNow(runId) {
      const run = runs.get(runId);
      if (!run || run.state !== "running" || run.exit || !run.tab || run.reads > 0) return;
      const output = await readOutput(run, run.tab);
      // It ended with its tab open meanwhile: the exit's own result goes instead. A close meanwhile, and the
      // hang-up after it, leave the snapshot to go as read (or saying the tail could not be read).
      if (run.state !== "running" || endedWithTabOpen(run)) return;
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
    resume(sessionId) {
      parked.delete(sessionId);
    },
    tracked: () => runs.size,
  };
  return api;
}
