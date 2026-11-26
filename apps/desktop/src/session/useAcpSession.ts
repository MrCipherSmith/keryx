import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { PREPARE_REVIEW_METHOD, type ReviewDraftHints } from "../../../../src/acp/review-draft";
import { AcpClient, RpcError } from "../acp/client";
import { refusalReason, writeSessionFlags, type SessionFlagsChange } from "./sessionFlagsWrite";
import { hasCommandExtension } from "../acp/commands";
import {
  extensionsOf,
  PROVIDERS_LOGIN_CHALLENGE,
  SUBAGENT_NOTIFICATION,
  supportsTasks,
  TASKS_EVENT,
  TASKS_LIST,
  toTasks,
  type LoginChallenge,
} from "../acp/providers";
import { acpStart, acpTransport, acpStop, listenBridge, versionCheck } from "../platform/commands";
import { isTauri } from "../platform/backend";
import { buildUserPrompt, type UserPromptContext } from "./userPrompt";
import { onPtyExit, panelMcpServers, ptyOpenRun, ptyTail } from "../platform/panels";
import { closeTerminalTab, onTabClosed, setRunTracker, showTerminalTab } from "../panels/panelBus";
import { notifyDelegateChange, setDelegateApi } from "./delegateBus";
import { createDelegateTerminals, type DelegateLaunch } from "./delegateTerminals";
import { createTerminalRuns, newRunId, type DeliveryOutcome, type TerminalResultEntry } from "./terminalRuns";
import { setTerminalRunApi } from "./terminalRunBus";
import {
  canOrganizeSessions,
  hasLiveSessions,
  DELEGATE_EXITED,
  DELEGATE_RESULT,
  DELEGATE_TERMINAL,
  type DelegateResultParams,
  SESSION_FLAGS,
  SESSION_RELEASED,
  SESSION_SHOWN,
  SESSION_TRASH,
  type CommandEffect,
  type AskUserResult,
  type ConfigOption,
  type InitializeResult,
  type LoadSessionResult,
  type NewSessionResult,
  type PermissionOutcome,
  type SessionFlags,
  type SessionInfo,
  type SessionSubject,
  type SessionUpdate,
} from "../acp/types";
import { initialState, pendingQueueSend, reducer, sessionMarks, shownView, type Action, type RoutedUpdate, type WindowState } from "./reducer";
import { desktopReviewCommands, runCommandLine, type RunOptions, type UiActions } from "./commandRunner";
import { DialogQueue, type PendingAsk, type PendingPermission } from "./dialogQueue";
import { readSubagentHistory, subagentHistoryWriter } from "./subagentHistory";
import { SessionRegistry } from "./sessionRegistry";
import { answerAgentRequest } from "./agentRequests";
import { retentionDays } from "../lib/retention";
import { idleSessions, pickStartSession } from "./startup";
import { readTelegramAttachment, readTelegramTurn, TELEGRAM_SESSION, TELEGRAM_TURN } from "./telegramSession";
import { PendingSubjects } from "./subjectBinding";

export type { PendingAsk, PendingPermission } from "./dialogQueue";

export interface ReviewDraftRequest extends ReviewDraftHints {
  prompt?: string;
  sessionId: string;
  nonce: string;
}

export type Fatal =
  | { kind: "incompatible"; found: string; required: string }
  /** This keryx cannot serve the app at all: no shell profile, or one without live sessions. */
  | { kind: "noShell"; found: string; reason: "no-profile" | "no-live-sessions" }
  | { kind: "leased"; sessionId: string };

/** keryx answers a leased session with error.data.reason "session-leased"; the anchored text is only a fallback. */
function isLeaseError(e: unknown): boolean {
  if (refusalReason(e) === "session-leased") return true;
  return /(^|[^\w-])session-leased([^\w-]|$)/.test(errMessage(e));
}

export function modelOption(options: ConfigOption[]): ConfigOption | undefined {
  return options.find((o) => o.id === "model") ?? options.find((o) => o.category === "model");
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** keryx refused a prompt because the session already runs a turn. */
function isBusyRefusal(e: unknown): boolean {
  return e instanceof RpcError && (e.data as { condition?: unknown } | undefined)?.condition === "session-busy";
}

/**
 * JSON-RPC errors keryx answers a prompt with before it stores anything or starts a turn: invalid request
 * (busy, opening, stopping), method not found, invalid params, unknown session.
 */
const PRE_TURN_REFUSALS: ReadonlySet<number> = new Set([-32600, -32601, -32602, -32002]);
/** keryx's "unknown ACP session" (resourceNotFound). */
const UNKNOWN_SESSION = -32002;

/**
 * A results prompt failed for a reason that passes (flow 523, plan "State × event matrix": the results
 * are kept and sent again once the window holds the session again): the session was released (the window
 * saw `_keryx/session_released` before the "unknown session" answer), keryx is shutting down, or the
 * failure is not keryx's answer at all (the connection closed or broke under the prompt, which may never
 * have reached keryx; keryx skips a run id it already stored, so sending it again is safe).
 */
function waitsForHold(e: unknown, stillHeld: boolean): boolean {
  if (!(e instanceof RpcError)) return true;
  if (e.code === UNKNOWN_SESSION) return !stillHeld;
  return (e.data as { condition?: unknown } | undefined)?.condition === "shutting-down";
}

/** The prompt that resumes keryx's saved issue questions. */
const RESUME_ISSUE_QUESTIONS = "Resume the pending issue questions.";

/** The display line of a results prompt; keryx ignores it and stores its own continuation line. */
function terminalResultsLine(results: readonly TerminalResultEntry[]): string {
  return results.length === 1 ? "The result of a command run from the Run button." : `The results of ${results.length} commands run from the Run button.`;
}


interface Turn {
  client: AcpClient;
  done: Promise<void>;
}

interface Live {
  client: AcpClient | null;
  gen: number;
  initialized: boolean;
  /** This keryx passed the profile, live-sessions and version checks (or the user chose to continue anyway). */
  usable: boolean;
  /** keryx advertised `_keryx/command`; without it commands go as prompt text. */
  commandMethod: boolean;
  /** `initialize._meta.keryx.extensions`: the extension methods this keryx serves. */
  extensions: readonly string[];
  /** `initialize._meta.keryx.terminalResults`: this keryx takes Run results in `session/prompt` (flow 523). */
  terminalResults: boolean;
  unlisten: (() => void) | null;
  /** Which sessions keryx holds for this window, their turns, and which one is shown. */
  reg: SessionRegistry<Turn>;
}

/**
 * One window over one `keryx acp --profile shell` connection. Every session the window opens stays
 * alive in keryx: its turn, tasks and dialogs keep going while another one is on screen. Switching to
 * a held session is local; only a session the window does not hold (history, or released by keryx's
 * idle cap) is loaded.
 */
/** The permission modes a review session may be raised to. */
export type ReviewSessionMode = "trust" | "auto";
const MODE_RANK: Readonly<Record<string, number>> = { ask: 0, trust: 1, auto: 2 };
/** An unknown mode ranks lowest, so a review session is raised out of it. */
const modeRank = (modeId: string): number => MODE_RANK[modeId] ?? -1;

/** The session mode a Desktop review runs in: Auto review mode → `auto`, Manual → at least `trust`. */
export function reviewSessionMode(reviewMode: "auto" | "manual" | undefined): ReviewSessionMode {
  return reviewMode === "manual" ? "trust" : "auto";
}

export function useAcpSession(cwd: string) {
  const [win, rawDispatch] = useReducer(reducer, initialState);
  const archiveWriter = useMemo(() => subagentHistoryWriter(cwd), [cwd]);
  useEffect(() => {
    for (const [sid, conv] of Object.entries(win.convs)) archiveWriter.track(sid, conv.subagents);
  }, [archiveWriter, win.convs]);
  useEffect(() => {
    window.addEventListener("pagehide", archiveWriter.flush);
    return () => { window.removeEventListener("pagehide", archiveWriter.flush); archiveWriter.flush(); };
  }, [archiveWriter]);
  const winRef = useRef(win);
  winRef.current = win;
  const sendSequence = useRef(0);
  const [dialogVersion, setDialogVersion] = useState(0);
  const dialogsRef = useRef<DialogQueue | null>(null);
  if (!dialogsRef.current) dialogsRef.current = new DialogQueue(() => setDialogVersion((v) => v + 1));
  const dialogs = dialogsRef.current;
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraftRequest[]>([]);
  const prepareReview = useCallback((sessionId: string, hints: ReviewDraftHints, prompt?: string) => {
    const request = { ...hints, sessionId, nonce: crypto.randomUUID(), prompt };
    setReviewDrafts(previous => previous.some(draft =>
      draft.sessionId === sessionId && draft.target === hints.target && draft.flowId === hints.flowId)
      ? previous : [...previous, request]);
  }, []);
  const dismissReviewDraftRequest = useCallback((nonce: string) => {
    setReviewDrafts(previous => previous.filter(draft => draft.nonce !== nonce));
  }, []);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  /** The incompatible-keryx dialog was put away; `fatal` itself stays, so the window keeps saying so. */
  const [fatalHidden, setFatalHidden] = useState(false);
  const [canPrepareIssue, setCanPrepareIssue] = useState(false);
  const [extensions, setExtensions] = useState<readonly string[]>([]);
  /** The keryx this window runs (`acp_start`), for project commands run in a terminal tab. */
  const [keryxPath, setKeryxPath] = useState<string | null>(null);
  const challengeListeners = useRef(new Set<(c: LoginChallenge) => void>());
  const live = useRef<Live>({ client: null, gen: 0, initialized: false, usable: false, commandMethod: false, extensions: [], terminalResults: false, unlisten: null, reg: new SessionRegistry<Turn>() });

  // session/update notifications are queued and applied once per animation frame (a timer covers a
  // hidden window, where frames do not fire), so a long replay or a fast stream is not one render per update.
  const queue = useRef<RoutedUpdate[]>([]);
  const flushTimers = useRef({ raf: 0, timeout: 0 });
  const cancelFlush = useCallback(() => {
    const t = flushTimers.current;
    if (t.raf) cancelAnimationFrame(t.raf);
    if (t.timeout) window.clearTimeout(t.timeout);
    t.raf = 0;
    t.timeout = 0;
  }, []);
  const flushUpdates = useCallback(() => {
    cancelFlush();
    const batch = queue.current;
    if (batch.length === 0) return;
    queue.current = [];
    rawDispatch({ t: "updates", updates: batch });
  }, [cancelFlush]);
  const enqueueUpdate = useCallback(
    (u: RoutedUpdate) => {
      queue.current.push(u);
      const t = flushTimers.current;
      if (t.raf || t.timeout) return;
      t.raf = requestAnimationFrame(flushUpdates);
      t.timeout = window.setTimeout(flushUpdates, 250);
    },
    [flushUpdates],
  );
  /** Every other action applies the queued updates first, so ordering is the arrival order. */
  const dispatch = useCallback(
    (a: Action) => {
      flushUpdates();
      rawDispatch(a.t === "subagent" ? { ...a, at: Date.now() } : a);
    },
    [flushUpdates],
  );

  /** `/delegate` runs in the built-in terminal (D-14): tabs, and their subagent entries in the session's Activity list. */
  const delegates = useMemo(
    () =>
      createDelegateTerminals({
        openRun: (launch) => ptyOpenRun(launch.cwd, launch.argv, launch.title, 80, 24),
        showTab: showTerminalTab,
        closeTab: closeTerminalTab,
        onChange: notifyDelegateChange,
        dispatch,
        notifyExit: (sessionId, runId) => live.current.client?.notify(DELEGATE_EXITED, { sessionId, runId }),
      }),
    [dispatch],
  );
  useEffect(() => {
    setDelegateApi(delegates);
    return () => setDelegateApi(null);
  }, [delegates]);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void onPtyExit((e) => delegates.exited(e.id, e.code)).then((u) => (live ? (off = u) : u()));
    const offClosed = onTabClosed((id) => delegates.closed(id));
    return () => {
      live = false;
      off?.();
      offClosed();
    };
  }, [delegates]);
  const openTerminal = useCallback(
    (sessionId: string, launch: DelegateLaunch) => {
      delegates.start(sessionId, launch).catch((e: unknown) =>
        dispatch({ t: "notice", sessionId, level: "error", text: `Could not open the terminal: ${errMessage(e)}` }),
      );
    },
    [delegates, dispatch],
  );

  /** Flow links waiting for keryx to store a new session (it lists one only after its first save). */
  const pendingFlow = useRef(new Map<string, string>());

  /** Every `_keryx/session_flags` write except the subject binding: see writeSessionFlags. Throws on failure. */
  const writeFlags = useCallback(
    (sessionId: string, change: SessionFlagsChange) =>
      writeSessionFlags(live, cwd, sessionId, change, (id, flags) => dispatch({ t: "flags", sessionId: id, flags })),
    [cwd, dispatch],
  );

  /** Link `sessionId` to its pending flow; quiet, kept for the next try when keryx does not have the session yet. */
  const applyPendingFlow = useCallback(
    async (sessionId: string) => {
      const flow = pendingFlow.current.get(sessionId);
      if (!live.current.client || flow === undefined) return;
      try {
        await writeFlags(sessionId, { flow });
        pendingFlow.current.delete(sessionId);
      } catch {
        /* not stored yet: retried after its turn */
      }
    },
    [writeFlags],
  );

  /** The stored sessions of this project, newest first; null when the list could not be read. */
  const refreshSessions = useCallback(async (): Promise<SessionInfo[] | null> => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.initialized) return null;
    try {
      const all: SessionInfo[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 5; page++) {
        const r: { sessions?: SessionInfo[]; nextCursor?: string | null } = await client.request(
          "session/list",
          cursor ? { cwd, cursor } : { cwd },
        );
        all.push(...(r.sessions ?? []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      if (l.client === client) dispatch({ t: "sessions", sessions: all });
      return all;
    } catch {
      /* listing is optional; an agent without session/list just shows none */
      return null;
    }
  }, [cwd, dispatch]);

  /** PR and issue bindings waiting for keryx to store a new session, applied like the pending flow link. */
  const [pendingSubjects, setPendingSubjects] = useState<ReadonlyMap<string, SessionSubject>>(() => new Map());
  const subjects = useMemo(() => new PendingSubjects({
    write: (sessionId, subject) => {
      const client = live.current.client;
      return client ? client.request<SessionFlags>(SESSION_FLAGS, { sessionId, cwd, subject }) : Promise.reject(new Error("keryx is not running"));
    },
    onFlags: (sessionId, flags) => {
      dispatch({ t: "flags", sessionId, flags });
      // The pending binding is dropped only once the stored list (which then holds it) is read.
      return refreshSessions();
    },
    onNotice: (sessionId, text) => dispatch({ t: "notice", sessionId, level: "warn", text }),
    onChange: setPendingSubjects,
  }), [cwd, dispatch, refreshSessions]);

  /**
   * Archive the sessions nobody touched for the retention window (Settings → Sessions). The shown
   * session and any with a running turn are kept; pinned ones are never archived. Best effort.
   */
  const archiveIdle = useCallback(
    async (sessions: readonly SessionInfo[]) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable || !l.extensions.includes(SESSION_FLAGS)) return;
      const keep = new Set<string>([...(l.reg.shown ? [l.reg.shown] : []), ...l.reg.turns.keys(), ...l.reg.telegramTurns.keys()]);
      const ids = idleSessions(sessions, Date.now(), retentionDays(), keep);
      for (const sessionId of ids) {
        try {
          await writeFlags(sessionId, { archived: true });
        } catch {
          /* in use elsewhere or gone: tried again next time */
        }
        if (l.client !== client) return;
      }
    },
    [writeFlags],
  );

  /** Re-list a session's background tasks (keryx sends no output chunks, only start/phase/exit events). */
  const refreshTasks = useCallback(
    async (sessionId: string) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.initialized || !supportsTasks(l.extensions) || !l.reg.held.has(sessionId)) return;
      try {
        const r = await client.request<unknown>(TASKS_LIST, { sessionId });
        if (l.client === client) dispatch({ t: "tasks", sessionId, tasks: toTasks(r) });
      } catch {
        /* the list is best effort; the panel keeps what it had */
      }
    },
    [dispatch],
  );

  const acceptUpdate = useCallback(
    (u: RoutedUpdate) => {
      const reg = live.current.reg;
      if (u.update.sessionUpdate === TELEGRAM_TURN && reg.held.has(u.sessionId)) {
        const turn = readTelegramTurn(u.update);
        const current = reg.telegramTurns.get(u.sessionId);
        if (turn?.phase === "started" && !current) reg.telegramTurns.set(u.sessionId, turn);
        if (turn?.phase === "finished" && current?.generation === turn.generation && current.updateId === turn.updateId) {
          reg.telegramTurns.delete(u.sessionId);
          dialogs.dropSession(u.sessionId);
        }
      }
      if (u.update.sessionUpdate === "_keryx/telegram/decision" && u.update.phase === "closed" &&
        typeof u.update.requestId === "string") dialogs.dropRequest(u.sessionId, u.update.requestId);
      if (u.update.sessionUpdate === "_keryx/telegram/delivery" && u.update.status === "unconfirmed") {
        dispatch({ t: "notice", sessionId: u.sessionId, level: "warn", text: "Telegram reply delivery could not be confirmed. The reply is available in Desktop." });
      }
      enqueueUpdate(u);
      if (u.update.sessionUpdate === "session_info_update") void refreshSessions();
    },
    [dialogs, dispatch, enqueueUpdate, refreshSessions],
  );

  /** Every session/update goes to the session it names, shown or not. */
  const handleUpdate = useCallback(
    (params: unknown) => {
      const p = params as { sessionId?: unknown; update?: SessionUpdate } | null;
      if (!p?.update || typeof p.sessionId !== "string") return;
      const u: RoutedUpdate = { sessionId: p.sessionId, update: p.update, at: Date.now() };
      if (live.current.reg.route(u) === "apply") acceptUpdate(u);
    },
    [acceptUpdate],
  );

  /** keryx's idle cap released a session: it stays visible read-only; a return to it loads it. */
  const handleReleased = useCallback(
    (params: unknown) => {
      const sid = (params as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sid !== "string" || !live.current.reg.release(sid)) return;
      dialogs.dropSession(sid);
      setReviewDrafts(previous => previous.filter(draft => draft.sessionId !== sid));
      dispatch({ t: "released", sessionId: sid });
    },
    [dialogs, dispatch],
  );

  /**
   * One prompt turn of `sessionId`, whatever started it: the busy mark, the turn slot, keryx's stop-reason
   * notices and the end-of-turn bookkeeping. `onFailed` hears a failure on this connection (a busy refusal
   * included); `onLost`, a failure once the window has moved to another connection (a restart replaced the
   * client before the old one's rejection ran). Resolves when the turn is over; never rejects.
   */
  const runTurn = useCallback(
    (client: AcpClient, sessionId: string, params: Record<string, unknown>, onFailed: (e: unknown) => void, onLost?: (e: unknown) => void): Promise<void> => {
      const l = live.current;
      dispatch({ t: "busy", sessionId, busy: true });
      const turn = { client } as Turn;
      l.reg.turns.set(sessionId, turn);
      // The slot is taken: a hold a load's caller placed for its own turn ends here (that turn, or one that came
      // first, which the caller's send then meets as busy). What waited goes when this turn ends.
      l.reg.heldForCaller.delete(sessionId);
      turn.done = (async () => {
        let busyRefusal = false;
        try {
          const r = await client.request<{ stopReason?: string }>("session/prompt", { sessionId, ...params });
          if (l.client !== client) return;
          const notice = (level: "info" | "warn", t: string) => dispatch({ t: "notice", sessionId, level, text: t });
          if (r?.stopReason === "max_tokens") notice("warn", "Stopped: the model hit its token limit.");
          else if (r?.stopReason === "max_turn_requests") notice("warn", "Stopped: too many model requests in one turn.");
          else if (r?.stopReason === "refusal") notice("warn", "The model refused to continue.");
          else if (r?.stopReason === "cancelled") notice("info", "Stopped.");
        } catch (e) {
          if (l.client === client) {
            busyRefusal = isBusyRefusal(e);
            onFailed(e);
          } else onLost?.(e);
        } finally {
          if (l.reg.turns.get(sessionId) === turn) l.reg.turns.delete(sessionId);
          if (l.client === client) {
            // keryx sends no request for a turn after its prompt reply: anything still queued is stale.
            if (!busyRefusal) dialogs.dropSession(sessionId);
            dispatch({ t: "busy", sessionId, busy: false });
            // One flags write at a time: the flow link first, then the subject binding.
            void applyPendingFlow(sessionId).then(() => subjects.apply(sessionId)).finally(() => void refreshSessions());
          }
        }
      })();
      return turn.done;
    },
    [dialogs, dispatch, refreshSessions, applyPendingFlow, subjects],
  );

  /** Starts a turn in the shown session; returns true only when the prompt was accepted (the caller may then clear its draft). */
  const sendPrompt = useCallback(
    (text: string, target?: string, context?: UserPromptContext, literal = false, replaces?: number, issue?: { issueLaunchId: string } | { resumeIssueQuestions: true }): boolean => {
      const extra = context?.blocks ?? [];
      const l = live.current;
      const client = l.client;
      const sessionId = target ?? l.reg.shown;
      if (!client || !l.initialized || !sessionId || !l.reg.held.has(sessionId) || l.reg.turns.has(sessionId) ||
        l.reg.telegramTurns.has(sessionId) || (!text.trim() && extra.length === 0)) return false;
      const restoringQuestions = !!issue && "resumeIssueQuestions" in issue;
      const sendId = ++sendSequence.current;
      if (!restoringQuestions) dispatch({ t: "userSent", sessionId, sendId, text, context, ...(replaces !== undefined ? { replaces } : {}) });
      const prompt = buildUserPrompt(text, extra, literal);
      void runTurn(client, sessionId, { prompt, ...(issue ? { _meta: { keryx: issue } } : {}) }, (e) => {
        const busyRefusal = isBusyRefusal(e);
        if (!restoringQuestions) dispatch({ t: "userSendFailed", sessionId, sendId, busyRefusal });
        dispatch({ t: "notice", sessionId, level: busyRefusal ? "warn" : "error",
          text: busyRefusal ? "This session is already running a turn. Edit your message to retry once it finishes." : errMessage(e) });
      });
      return true;
    },
    [dispatch, runTurn],
  );

  /**
   * Run results (flow 523) to `sessionId` as one prompt, when it can take one now (null otherwise). No
   * user bubble: keryx stores its own continuation line for the turn and the run cards show what was sent.
   * A command in flight counts as busy: keryx holds the session's turn slot for /compact and /rewind, and
   * the command's end asks again (`trackCommand`). So does a session whose load's caller holds its slot for its
   * own turn (`holdForCaller`): the results go after that turn, or when the hold ends without one (`releaseHold`).
   * A prompt with no answer from keryx (its connection closed or was replaced) waits to be sent again; keryx
   * answers success for runs it already stored.
   */
  const sendTerminalResults = useCallback(
    (sessionId: string, results: readonly TerminalResultEntry[]): Promise<DeliveryOutcome> | null => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.initialized || !l.reg.held.has(sessionId) || l.reg.turns.has(sessionId) ||
        l.reg.telegramTurns.has(sessionId) || l.reg.commands.has(sessionId) || l.reg.heldForCaller.has(sessionId)) return null;
      let outcome: DeliveryOutcome = { kind: "done" };
      const params = { prompt: [{ type: "text", text: terminalResultsLine(results) }], _meta: { keryx: { terminalResults: results } } };
      return runTurn(client, sessionId, params, (e) => {
        if (isBusyRefusal(e)) outcome = { kind: "busy" };
        else if (waitsForHold(e, l.reg.held.has(sessionId))) outcome = { kind: "wait" };
        else if (e instanceof RpcError && PRE_TURN_REFUSALS.has(e.code)) outcome = { kind: "refused", error: errMessage(e) };
        // The results were stored and the follow-up turn failed: said like any failed turn.
        else dispatch({ t: "notice", sessionId, level: "error", text: errMessage(e) });
      }, () => {
        outcome = { kind: "wait" };
      }).then(() => outcome);
    },
    [dispatch, runTurn],
  );
  const sendResults = useRef(sendTerminalResults);
  sendResults.current = sendTerminalResults;

  /** Run clicks from this window's transcripts (flow 523): tracked runs whose results go back to their sessions. */
  const terminalRuns = useMemo(
    () =>
      createTerminalRuns({
        acceptsResults: () => (live.current.initialized ? live.current.terminalResults : null),
        send: (sessionId, results) => sendResults.current(sessionId, results),
        tail: (id, lines) => ptyTail(id, lines),
        showTab: showTerminalTab,
        dispatch,
        now: () => Date.now(),
        newRunId,
        later: (fn, ms) => void window.setTimeout(fn, ms),
      }),
    [dispatch],
  );
  useEffect(() => {
    setRunTracker(terminalRuns);
    setTerminalRunApi({ showTab: (runId) => terminalRuns.showTab(runId), sendNow: (runId) => void terminalRuns.sendNow(runId) });
    return () => {
      setRunTracker(null);
      setTerminalRunApi(null);
    };
  }, [terminalRuns]);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    void onPtyExit((e) => void terminalRuns.exited(e.id, e.code)).then((u) => (alive ? (off = u) : u()));
    const offClosed = onTabClosed((id) => terminalRuns.closed(id));
    return () => {
      alive = false;
      off?.();
      offClosed();
    };
  }, [terminalRuns]);

  /**
   * Resume keryx's saved issue questions in `sessionId` now, or queue the resume behind the turn that holds
   * its slot (the queue sends it when that turn ends). False when neither: the session cannot take it.
   */
  const resumeIssueQuestions = useCallback((sessionId: string): boolean => {
    if (sendPrompt(RESUME_ISSUE_QUESTIONS, sessionId, undefined, false, undefined, { resumeIssueQuestions: true })) return true;
    const reg = live.current.reg;
    if (!reg.held.has(sessionId) || (!reg.turns.has(sessionId) && !reg.telegramTurns.has(sessionId))) return false;
    dispatch({ t: "queueAdd", sessionId, text: RESUME_ISSUE_QUESTIONS, resumeIssueQuestions: true });
    return true;
  }, [dispatch, sendPrompt]);

  /**
   * One arbiter for every session's free turn slot (spec 3.9.5b), one prompt per session whose slot is free
   * (its turn ended, it is held again), in this order:
   * 1. the issue-question resume a load queued behind a running turn, when it is at the front of that
   *    session's queue (a load's resume takes the session first, as it does when it can send at once);
   * 2. the Run results waiting for the session (`terminalRuns.flush`);
   * 3. the next prompt the user queued, where neither of those took the slot.
   * Sending takes the slot at once (`runTurn` registers the turn), so a later step finds it taken. A session
   * whose load's caller holds its slot for its own turn (`holdForCaller`) is passed over: the results prompt
   * refuses it too (`sendTerminalResults`), and the hold's end runs this for it (`releaseHold`). `only` limits
   * the pass to one session.
   */
  const arbitrate = useCallback(
    (convs: WindowState["convs"], only?: string) => {
      const l = live.current;
      const turnRunning = (c: { sessionId: string }) => l.reg.turns.has(c.sessionId) || l.reg.telegramTurns.has(c.sessionId);
      const free = Object.values(convs).filter((c) => (only === undefined || c.sessionId === only) && !l.reg.heldForCaller.has(c.sessionId));
      for (const c of free) {
        const front = pendingQueueSend(c, turnRunning(c));
        if (front?.resumeIssueQuestions && sendPrompt(front.text, c.sessionId, undefined, false, undefined, { resumeIssueQuestions: true })) dispatch({ t: "queueShift", sessionId: c.sessionId });
      }
      const tookSlot = terminalRuns.flush(only);
      for (const c of free) {
        if (tookSlot.has(c.sessionId)) continue;
        const next = pendingQueueSend(c, turnRunning(c));
        // A resume at the front was step 1's: sent there, or refused on the same checks it would meet here.
        if (next && !next.resumeIssueQuestions && sendPrompt(next.text, c.sessionId, undefined, false, undefined, next.issueLaunchId ? { issueLaunchId: next.issueLaunchId } : undefined)) dispatch({ t: "queueShift", sessionId: c.sessionId });
      }
    },
    [sendPrompt, dispatch, terminalRuns],
  );

  /**
   * End the hold a load's caller placed on `sessionId` (`holdForCaller`) when it starts no turn after all (it
   * gave up, or its send was refused): what waited for the slot goes now, in the arbiter's order. Nothing
   * happens when there is no hold (its turn took the slot, which already ended it).
   */
  const releaseHold = useCallback(
    (sessionId: string) => {
      if (live.current.reg.heldForCaller.delete(sessionId)) arbitrate(winRef.current.convs, sessionId);
    },
    [arbitrate],
  );

  /**
   * session/load of a session the window does not hold. Its replay lands off screen; the session is
   * shown on success unless the user has switched elsewhere since. A failure changes nothing on screen.
   * When keryx answers that issue questions wait, they are resumed (or queued); `onIssueQuestions` hears
   * whether that happened. `holdForCaller`: the caller starts a turn in the session itself once this resolves
   * (a review, after an awaited mode switch), so the session's free slot is held for that turn: its Run
   * results and queued prompts wait until a turn takes the slot or the caller ends the hold (`releaseHold`).
   * Any other load of the session ends a hold an earlier load placed.
   */
  const openLoad = useCallback(
    async (client: AcpClient, gen: number, sessionId: string, opts: { issueScope?: AbortSignal; onIssueQuestions?: (resumed: boolean) => void; holdForCaller?: boolean } = {}): Promise<boolean> => {
      const l = live.current;
      const { issueScope, onIssueQuestions } = opts;
      if (issueScope?.aborted) return false;
      if (opts.holdForCaller === true) l.reg.heldForCaller.add(sessionId);
      else releaseHold(sessionId);
      const plan = l.reg.planSwitch(sessionId);
      if (plan === "show") {
        l.reg.showLocal(sessionId);
        dispatch({ t: "show", sessionId });
        return true;
      }
      if (plan === "pending") {
        l.reg.wantLoad(sessionId, issueScope);
        return true;
      }
      l.reg.beginLoad(sessionId, issueScope);
      dispatch({ t: "loadStart", sessionId });
      try {
        const [r, archive] = await Promise.all([
          client.request<LoadSessionResult>("session/load", { sessionId, cwd, mcpServers: await panelMcpServers(cwd) }),
          readSubagentHistory(cwd, sessionId),
        ]);
        if (l.gen !== gen) return false;
        const show = l.reg.loadDone(sessionId);
        dispatch({ t: "loadDone", sessionId, archive, modes: r?.modes, configOptions: r?.configOptions, show });
        // Held again: Run results that waited for it (released, keryx restarting, a lost connection) may go
        // again, from the window's arbiter. The issue questions resumed below are sent before this returns, so
        // they take the slot first. A caller that starts a turn itself (a review) holds the slot from the
        // load's start (`holdForCaller`): the results go after its turn, or once it gives up (`releaseHold`).
        terminalRuns.resume(sessionId);
        if (!issueScope?.aborted && r?._meta?.keryx?.pendingIssueQuestions) {
          const resumed = resumeIssueQuestions(sessionId);
          onIssueQuestions?.(resumed);
        }
        return true;
      } catch (e) {
        if (l.gen !== gen) return false;
        l.reg.loadFailed(sessionId);
        dispatch({ t: "loadFailed", sessionId });
        if (issueScope?.aborted) return false;
        if (isLeaseError(e)) setFatal({ kind: "leased", sessionId });
        else dispatch({ t: "banner", level: "error", text: `Could not load the session: ${errMessage(e)}` });
        return false;
      }
    },
    [cwd, dispatch, resumeIssueQuestions, terminalRuns, releaseHold],
  );

  /** session/new. The new session is added and shown unless the user switched elsewhere meanwhile; a failure changes nothing on screen. */
  const openNew = useCallback(
    async (client: AcpClient, gen: number): Promise<string | null> => {
      const l = live.current;
      const intent = l.reg.beginCreate();
      dispatch({ t: "creating", delta: 1 });
      try {
        const r = await client.request<NewSessionResult>("session/new", { cwd, mcpServers: await panelMcpServers(cwd) });
        if (l.gen !== gen) return null;
        if (typeof r?.sessionId !== "string") throw new Error("keryx returned no session id");
        const show = l.reg.created(r.sessionId, intent);
        dispatch({ t: "created", sessionId: r.sessionId, modes: r.modes, configOptions: r.configOptions, show });
        // Updates keryx may have sent for it before the reply was read.
        for (const u of l.reg.takeOrphans(r.sessionId)) acceptUpdate(u);
        return r.sessionId;
      } catch (e) {
        if (l.gen !== gen) return null;
        const why = isLeaseError(e) ? "The session is in use by another keryx" : "Could not start a session";
        dispatch({ t: "banner", level: "error", text: `${why}: ${errMessage(e)}` });
        return null;
      } finally {
        if (l.gen === gen) {
          l.reg.endCreate();
          dispatch({ t: "creating", delta: -1 });
        }
      }
    },
    [cwd, dispatch, acceptUpdate],
  );

  const finishStart = useCallback(
    async (client: AcpClient, gen: number, requested: string | null, fallbackToNew: boolean) => {
      const l = live.current;
      // Opening a project: the newest empty session, else the newest in use; a new one only when
      // there is none (or it fails to load).
      const listed = requested ? null : await refreshSessions();
      if (l.gen !== gen) return;
      const loadId = requested ?? (listed ? pickStartSession(listed) : null);
      fallbackToNew = fallbackToNew || requested === null;
      let ok = loadId ? await openLoad(client, gen, loadId) : false;
      if (l.gen !== gen) return;
      if (!ok && (!loadId || fallbackToNew)) {
        if (loadId) dispatch({ t: "clearBanners" });
        ok = (await openNew(client, gen)) !== null;
        // The reload's lease dialog is moot once the fresh session is up.
        if (ok && loadId && l.gen === gen) setFatal((f) => (f?.kind === "leased" ? null : f));
      }
      if (l.gen !== gen) return;
      dispatch({ t: "phase", phase: "ready" });
      void refreshSessions().then((all) => {
        if (all && l.gen === gen) void archiveIdle(all);
      });
    },
    [openLoad, openNew, refreshSessions, archiveIdle, dispatch],
  );

  type ConnectOptions = { loadSessionId: string | null; fallbackToNew: boolean; preferBundled?: boolean };
  /** `connect` itself, for the one restart on the bundled keryx it starts from inside. */
  const connectRef = useRef<((opts: ConnectOptions) => Promise<void>) | null>(null);
  const connect = useCallback(
    async (opts: ConnectOptions) => {
      const l = live.current;
      const gen = ++l.gen;
      l.unlisten?.();
      l.client?.close("restarting keryx");
      dialogs.dropAll();
      l.initialized = false;
      l.usable = false;
      l.commandMethod = false;
      l.extensions = [];
      l.terminalResults = false;
      setExtensions([]);
      setCanPrepareIssue(false);
      l.reg.reset();
      setReviewDrafts([]);
      setFatal(null);
      setFatalHidden(false);
      dispatch({ t: "connectionReset" });
      dispatch({ t: "phase", phase: "starting" });
      dispatch({ t: "clearBanners" });

      const client = new AcpClient(acpTransport);
      l.client = client;
      let canFallBack = false;
      /**
       * Automatic ran a keryx on PATH that cannot serve the app (too old, or no shell profile): start
       * once more on the bundled keryx instead of stopping on the incompatible-keryx dialog.
       */
      const fallBackToBundled = (found: string): boolean => {
        if (!canFallBack || opts.preferBundled === true) return false;
        void connectRef.current?.({ ...opts, preferBundled: true }).then(() => {
          dispatch({
            t: "banner",
            level: "info",
            text: `The keryx on your PATH (${found}) is too old for this app, so the keryx bundled with the app runs instead. \`npm i -g @mrciphersmith/keryx\` updates the PATH one once a newer release is out.`,
          });
        });
        return true;
      };
      client.onNotification = (method, params) => {
        if (method === "session/update") handleUpdate(params);
        else if (method === SESSION_RELEASED) handleReleased(params);
        else if (method === SUBAGENT_NOTIFICATION) {
          const p = params as { sessionId?: unknown; event?: unknown } | null;
          if (typeof p?.sessionId === "string" && p.event) dispatch({ t: "subagent", sessionId: p.sessionId, event: p.event });
        } else if (method === DELEGATE_TERMINAL) {
          // The model started an external run (trust/auto mode): the same terminal tab as `/delegate`, closed when it returns.
          const p = params as Partial<DelegateLaunch> & { sessionId?: unknown } | null;
          if (typeof p?.sessionId === "string" && typeof p.runId === "string" && Array.isArray(p.argv) && typeof p.cwd === "string") {
            openTerminal(p.sessionId, {
              runId: p.runId,
              agentId: typeof p.agentId === "string" ? p.agentId : "agent",
              title: typeof p.title === "string" ? p.title : p.runId,
              argv: p.argv.filter((a): a is string => typeof a === "string"),
              cwd: p.cwd,
              autoClose: true,
            });
          }
        } else if (method === DELEGATE_RESULT) {
          const p = params as Partial<DelegateResultParams> | null;
          if (typeof p?.sessionId === "string" && typeof p.runId === "string" && typeof p.text === "string") {
            dispatch({ t: "delegateResult", sessionId: p.sessionId, runId: p.runId, agentId: typeof p.agentId === "string" ? p.agentId : "agent", turn: typeof p.turn === "number" ? p.turn : 1, text: p.text });
            if (p.autoClose === true) delegates.finish(p.runId);
          }
        } else if (method === TASKS_EVENT) {
          const sid = (params as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sid === "string") void refreshTasks(sid);
        } else if (method === PROVIDERS_LOGIN_CHALLENGE) {
          const c = params as LoginChallenge | null;
          if (c && typeof c.userCode === "string") for (const f of challengeListeners.current) f(c);
        }
      };
      client.onRequest = (method, params, id) => answerAgentRequest(method, params, l.reg, dialogs,
        l.gen === gen && l.extensions.includes(PREPARE_REVIEW_METHOD) ? prepareReview : undefined, id);
      client.onReplyFailed = (method, error) => {
        if (l.gen === gen) dispatch({ t: "banner", level: "error", text: `Could not send keryx the answer to ${method}: ${error}` });
      };

      try {
        l.unlisten = await listenBridge({
          onMessage: (line) => {
            if (l.gen === gen) client.handleLine(line);
          },
          onError: (message) => {
            if (l.gen === gen) dispatch({ t: "banner", level: "warn", text: message });
          },
          onExit: (info) => {
            if (l.gen !== gen) return;
            client.close();
            dialogs.dropAll();
            const initialized = l.initialized;
            l.reg.reset();
            setReviewDrafts([]);
            dispatch({ t: "connectionReset" });
            const usageError =
              info.code === 2 || /usage|unknown (value|option|profile)|unrecognized|invalid (value|profile)|--profile/i.test(info.stderrTail);
            // A keryx that rejects --profile shell is too old for the app.
            if (!initialized && usageError && fallBackToBundled("unknown")) return;
            if (!initialized && usageError) setFatal({ kind: "noShell", found: "unknown", reason: "no-profile" });
            dispatch({ t: "phase", phase: "exited", exit: info });
          },
        });
        const start = await acpStart(cwd, false, opts.preferBundled === true);
        if (l.gen !== gen) return;
        canFallBack = start.canFallBack === true;
        setKeryxPath(start.keryxPath);
        if (start.note) dispatch({ t: "banner", level: "info", text: start.note });

        const init = await client.request<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            // `terminal`: /delegate runs the vendor CLI in the side panel's terminal (D-14); only the app has one.
            // `terminalResults`: a Run click is tracked and its result comes back as a `session/prompt`
            // (flow 523); keryx gives the Run guidance and takes results only from a client that says so.
            _meta: { keryx: { askUser: true, prepareReview: true, operatorCards: true, ...(isTauri() ? { terminal: true, terminalResults: true, telegramSession: true } : {}) } },
          },
          clientInfo: { name: "keryx-desktop", title: "Keryx", version: "0.2.5" },
        });
        if (l.gen !== gen) return;
        l.initialized = true;
        l.commandMethod = hasCommandExtension(init);
        l.extensions = extensionsOf(init);
        l.terminalResults = init._meta?.keryx?.terminalResults === true;
        setExtensions(l.extensions);
        setCanPrepareIssue(init._meta?.keryx?.issuePreparation === true);

        const found = init.agentInfo?.version ?? "unknown";
        const profile = init._meta?.keryx?.profile === "shell" ? "shell" : "editor";
        dispatch({ t: "agent", profile, version: init.agentInfo?.version ?? null, canOrganize: canOrganizeSessions(init) });
        if (profile !== "shell" || !hasLiveSessions(init)) {
          if (fallBackToBundled(found)) return;
          setFatal({ kind: "noShell", found, reason: profile !== "shell" ? "no-profile" : "no-live-sessions" });
          dispatch({ t: "phase", phase: "ready" });
          return;
        }
        const check = await versionCheck(found);
        if (l.gen !== gen) return;
        if (!check.ok) {
          if (fallBackToBundled(check.found)) return;
          setFatal({ kind: "incompatible", found: check.found, required: check.required });
          return;
        }
        l.usable = true;
        await finishStart(client, gen, opts.loadSessionId, opts.fallbackToNew);
      } catch (e) {
        if (l.gen !== gen) return;
        dispatch({ t: "banner", level: "error", text: errMessage(e) });
        dispatch({ t: "phase", phase: "exited", exit: { code: null, stderrTail: errMessage(e) } });
      }
    },
    [cwd, dialogs, dispatch, handleUpdate, handleReleased, finishStart, refreshTasks, prepareReview],
  );
  connectRef.current = connect;

  useEffect(() => {
    void connect({ loadSessionId: null, fallbackToNew: false });
    return () => {
      const l = live.current;
      l.gen++;
      cancelFlush();
      queue.current = [];
      l.unlisten?.();
      l.client?.close("window closed");
      dialogs.dropAll();
      void acpStop();
    };
    // connect once per window/cwd
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  /** A window left open keeps archiving sessions that go idle, once an hour. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (winRef.current.phase === "ready") void archiveIdle(winRef.current.sessions);
    }, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [archiveIdle]);

  const shown = useMemo(() => shownView(win), [win]);
  const commands = useMemo(() => desktopReviewCommands(shown.commands), [shown.commands]);
  const state = useMemo(() => ({ ...shown, commands }), [shown, commands]);
  const shownDialogs = useMemo(
    () => dialogs.forSession(win.shownId),
    // dialogVersion changes whenever the queue does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dialogs, dialogVersion, win.shownId],
  );
  const marks = useMemo(
    () => sessionMarks(win, dialogs.waiting()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [win, dialogs, dialogVersion],
  );

  // ---- user actions -------------------------------------------------------

  /** Stop the shown session's turn only; every other session keeps running. */
  const cancel = useCallback(() => {
    const l = live.current;
    const sessionId = l.reg.shown;
    const client = l.client;
    if (!client || !sessionId || !l.reg.held.has(sessionId)) return;
    client.notify("session/cancel", { sessionId });
    dialogs.dropSession(sessionId);
  }, [dialogs]);

  /**
   * Show a session: local when the window holds it, session/load otherwise. Nothing is cancelled or released.
   * `holdForCaller`: the caller sends a turn to the session itself once this resolves, and its Run results and
   * queued prompts wait for that turn; a caller that then sends none ends the hold with `releaseHold`.
   */
  const loadSession = useCallback(
    async (id: string, options?: { holdForCaller?: boolean }) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable) return false;
      const plan = l.reg.planSwitch(id);
      if (plan === "load") {
        setFatal((f) => (f?.kind === "leased" ? null : f));
        dispatch({ t: "clearBanners" });
      } else if (plan === "show" && l.reg.shown !== id) {
        // A local switch sends no request; tell keryx so its idle cap counts this session as in use.
        client.notify(SESSION_SHOWN, { sessionId: id });
      }
      return openLoad(client, l.gen, id, { holdForCaller: options?.holdForCaller === true });
    },
    [openLoad, dispatch],
  );

  /** A new session, shown when it opens; resolves its id, or null when it could not start. */
  const newSession = useCallback(async (): Promise<string | null> => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.usable) return null;
    setFatal((f) => (f?.kind === "leased" ? null : f));
    dispatch({ t: "clearBanners" });
    const id = await openNew(client, l.gen);
    void refreshSessions();
    return id;
  }, [openNew, refreshSessions, dispatch]);

  /**
   * Work on a flow: in a new session linked to the flow (`target` "new"), or in a session already
   * linked to it. Resolves the session that is now shown, or null when none could be opened.
   */
  const workOnFlow = useCallback(
    async (flowDir: string, target: "new" | string): Promise<string | null> => {
      if (target !== "new") {
        await loadSession(target);
        return target;
      }
      const id = await newSession();
      if (id) {
        pendingFlow.current.set(id, flowDir);
        await applyPendingFlow(id);
      }
      return id;
    },
    [loadSession, newSession, applyPendingFlow],
  );

  /**
   * Link a stored session to a flow package (the PR work row's Link). Rejects when keryx refuses or cannot be
   * reached, so the caller can keep its offer and say why; nothing is kept pending for a later retry.
   */
  const linkFlow = useCallback(async (sessionId: string, flowDir: string) => {
    await writeFlags(sessionId, { flow: flowDir });
  }, [writeFlags]);

  /** Bind a session to a GitHub PR or issue; a new session keeps the binding pending until keryx stores it. */
  const bindSubject = useCallback((sessionId: string, subject: SessionSubject) => subjects.bind(sessionId, subject), [subjects]);

  const setMode = useCallback(
    async (modeId: string) => {
      const l = live.current;
      const client = l.client;
      const sessionId = l.reg.shown;
      if (!client || !sessionId || !l.reg.held.has(sessionId)) return;
      try {
        await client.request("session/set_mode", { sessionId, modeId });
        if (l.client === client) {
          dispatch({ t: "updates", updates: [{ sessionId, at: Date.now(), update: { sessionUpdate: "current_mode_update", currentModeId: modeId } }] });
        }
      } catch (e) {
        if (l.client === client) dispatch({ t: "notice", sessionId, level: "error", text: `Could not change mode: ${errMessage(e)}` });
      }
    },
    [dispatch],
  );

  /**
   * Raise a held session's permission mode to at least `modeId` (ask < trust < auto). A session already in an equal or
   * more permissive mode keeps it. Used for the session Desktop opens for a review turn, before the turn is sent.
   * Resolves false when the mode could not be set; the session then keeps its mode and a notice says why.
   */
  const raiseMode = useCallback(
    async (sessionId: string, modeId: ReviewSessionMode): Promise<boolean> => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.reg.held.has(sessionId)) return false;
      // A session running a turn gets no review turn (the send is refused as busy), so its mode is left alone and the
      // caller is not held behind a mode change while that turn runs.
      if (l.reg.turns.has(sessionId) || l.reg.telegramTurns.has(sessionId)) return false;
      const current = winRef.current.convs[sessionId]?.modes?.currentModeId;
      if (current !== undefined && modeRank(current) >= modeRank(modeId)) return true;
      try {
        await client.request("session/set_mode", { sessionId, modeId });
        if (l.client === client) {
          dispatch({ t: "updates", updates: [{ sessionId, at: Date.now(), update: { sessionUpdate: "current_mode_update", currentModeId: modeId } }] });
        }
        return true;
      } catch (e) {
        if (l.client === client) dispatch({ t: "notice", sessionId, level: "error", text: `Could not change mode: ${errMessage(e)}` });
        return false;
      }
    },
    [dispatch],
  );

  const setModel = useCallback(
    async (configId: string, value: string) => {
      const l = live.current;
      const client = l.client;
      const sessionId = l.reg.shown;
      if (!client || !sessionId || !l.reg.held.has(sessionId)) return;
      try {
        const r = await client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId, configId, value });
        if (r?.configOptions && l.client === client) dispatch({ t: "config", sessionId, configOptions: r.configOptions });
      } catch (e) {
        if (l.client === client) dispatch({ t: "notice", sessionId, level: "error", text: `Could not change model: ${errMessage(e)}` });
      }
    },
    [dispatch],
  );

  /** The arbiter runs on every change of the window's sessions (`arbitrate`). */
  useEffect(() => arbitrate(win.convs), [win.convs, arbitrate]);

  /** Replay a held session from keryx (after /compact or /rewind changed its history). */
  const reloadSession = useCallback(
    async (sessionId: string) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable || !l.reg.held.has(sessionId)) return;
      l.reg.held.delete(sessionId); // so the switch plan is "load"
      const ok = await openLoad(client, l.gen, sessionId);
      if (!ok && l.client === client && !l.reg.loading.has(sessionId)) l.reg.held.add(sessionId);
    },
    [openLoad],
  );

  /**
   * What a command changed. mode, model, config and plan reach the window through keryx's own
   * session updates (already applied by the reducer); the session list is refreshed because a title may
   * have changed; a rewritten transcript is replayed. Unknown effects are ignored.
   */
  const applyEffects = useCallback(
    (sessionId: string, effects: readonly CommandEffect[]) => {
      if (effects.includes("transcript")) void reloadSession(sessionId);
      if (effects.includes("tasks")) void refreshTasks(sessionId);
      if (effects.some((e) => e === "model" || e === "config" || e === "transcript")) void refreshSessions();
    },
    [reloadSession, refreshSessions, refreshTasks],
  );

  /** The tasks of the session on screen are listed whenever it is shown (and once keryx is ready). */
  useEffect(() => {
    if (win.shownId && win.phase === "ready") void refreshTasks(win.shownId);
  }, [win.shownId, win.phase, extensions, refreshTasks]);

  /** One request to keryx for the Providers dialog and the Activity panel. */
  const rpc = useCallback(<T,>(method: string, params?: unknown): Promise<T> => {
    const client = live.current.client;
    return client ? client.request<T>(method, params) : Promise.reject(new Error("keryx is not running"));
  }, []);
  const telegramSession = useCallback(async (sessionId: string, operation: "status" | "attach" | "detach", topicName?: string) => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.reg.held.has(sessionId) || !l.extensions.includes(TELEGRAM_SESSION)) return false;
    const previous = winRef.current.convs[sessionId]?.telegram ?? null;
    const result = await client.request<unknown>(TELEGRAM_SESSION, { sessionId, operation, ...(topicName ? { topicName } : {}) });
    if (l.client !== client || !l.reg.held.has(sessionId)) return false;
    const value = readTelegramAttachment(result, sessionId);
    if (!value) throw new Error("Keryx returned an invalid Telegram session status.");
    dispatch({ t: "telegramStatus", sessionId, previous, value });
    return true;
  }, [dispatch]);
  useEffect(() => {
    if (shown.phase === "ready" && shown.held && shown.sessionId && extensions.includes(TELEGRAM_SESSION)) {
      const sessionId = shown.sessionId;
      const previous = winRef.current.convs[sessionId]?.telegram ?? null;
      void telegramSession(sessionId, "status").catch(() => {
        if (live.current.reg.held.has(sessionId)) dispatch({ t: "telegramStatus", sessionId, previous, value: { state: "unavailable", reason: "serve-unavailable" } });
      });
    }
  }, [dispatch, extensions, shown.phase, shown.held, shown.sessionId, telegramSession]);
  const onLoginChallenge = useCallback((f: (c: LoginChallenge) => void) => {
    challengeListeners.current.add(f);
    return () => void challengeListeners.current.delete(f);
  }, []);

  /** Run a composer line or a view's command line: a command, the queue, or plain text for the model. Resolves true when the draft may be cleared. */
  const runCommand = useCallback(
    (line: string, ui: UiActions, opts: RunOptions = {}): Promise<boolean> => {
      const l = live.current;
      const sid = l.reg.shown;
      const conv = sid ? winRef.current.convs[sid] : undefined;
      return runCommandLine(
        line,
        {
          client: l.client,
          sessionId: sid,
          busy: (conv?.busy ?? false) || !!conv?.telegramTurn,
          commands: conv?.commands ?? [],
          hasCommandMethod: l.commandMethod,
          queue: conv?.queue ?? [],
          dispatch,
          sendPrompt: (t) => sendPrompt(t),
          startTurn: (target, t) => sendPrompt(t, target),
          newSession: () => void newSession(),
          interrupt: cancel,
          applyEffects,
          openTerminal,
          prepareReview,
          ui,
          trackCommand: (target) => {
            const end = l.reg.beginCommand(target);
            return () => {
              end();
              // Run results that waited for the command go now (a command that ends with no card changes nothing else).
              terminalRuns.flush(target);
            };
          },
        },
        opts,
      );
    },
    [dispatch, sendPrompt, newSession, cancel, applyEffects, openTerminal, prepareReview, terminalRuns],
  );

  /** Archive/unarchive or pin/unpin a stored session. Errors show as a banner. */
  const setFlags = useCallback(
    async (sessionId: string, change: SessionFlagsChange) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable) return;
      try {
        await writeFlags(sessionId, change);
      } catch (e) {
        if (l.client === client) dispatch({ t: "banner", level: "error", text: `Could not update the session: ${errMessage(e)}` });
      }
    },
    [dispatch, writeFlags],
  );

  /**
   * Move a stored session to the system trash. keryx refuses one with a running turn or task, or one
   * open in another keryx. The shown one is replaced by another session the window holds, or a new one.
   */
  const trashSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable) return false;
      try {
        await client.request(SESSION_TRASH, { sessionId, cwd });
      } catch (e) {
        if (l.client === client) dispatch({ t: "banner", level: "error", text: `Could not move the session to the Trash: ${errMessage(e)}` });
        return false;
      }
      if (l.client !== client) return true;
      l.reg.release(sessionId);
      dialogs.dropSession(sessionId);
      setReviewDrafts(previous => previous.filter(draft => draft.sessionId !== sessionId));
      const wasShown = l.reg.shown === sessionId;
      if (wasShown) l.reg.shown = null;
      archiveWriter.remove(sessionId);
      dispatch({ t: "removed", sessionId });
      if (wasShown) {
        const next = [...l.reg.held].pop();
        if (next) await loadSession(next);
        else await newSession();
      }
      void refreshSessions();
      return true;
    },
    [archiveWriter, cwd, dialogs, dispatch, loadSession, newSession, refreshSessions],
  );

  /** A new keryx process; the shown session is reloaded (a new one when that fails). */
  const restart = useCallback(() => {
    void connect({ loadSessionId: live.current.reg.shown, fallbackToNew: true });
  }, [connect]);

  /** Reopen the shown session after keryx released it. */
  const reopen = useCallback(() => {
    const id = live.current.reg.shown;
    if (id) void loadSession(id);
  }, [loadSession]);

  const continueAnyway = useCallback(() => {
    const l = live.current;
    const client = l.client;
    if (!client) return;
    setFatal(null);
    l.usable = true;
    void finishStart(client, l.gen, null, false);
  }, [finishStart]);

  const answerPermission = useCallback((p: PendingPermission, outcome: PermissionOutcome) => dialogs.answerPermission(p, outcome), [dialogs]);
  const answerAsk = useCallback((a: PendingAsk, result: AskUserResult) => dialogs.answerAsk(a, result), [dialogs]);
  const projectTelegramQuestion = useCallback(async (ask: PendingAsk) => {
    if (typeof ask.requestId !== "string" || ask.req._meta?.keryx?.telegramProjectable !== true) return false;
    const l = live.current;
    const client = l.client;
    if (!client || !l.reg.held.has(ask.sessionId) || !l.extensions.includes(TELEGRAM_SESSION)) return false;
    const result = await client.request<{ projected?: boolean }>("_keryx/telegram/project-question",
      { sessionId: ask.sessionId, requestId: ask.requestId });
    return l.client === client && result?.projected === true;
  }, []);

  return {
    state,
    /** The shown session's dialogs; other sessions keep theirs queued. */
    reviewDraftRequest: reviewDrafts.find(request => request.sessionId === win.shownId) ?? null,
    dismissReviewDraftRequest,
    permissions: shownDialogs.permissions,
    asks: shownDialogs.asks,
    /** Busy / waiting / held marks for every session the window has. */
    marks,
    fatal,
    fatalHidden,
    hideFatal: () => setFatalHidden(true),
    sendPrompt,
    canPrepareIssue,
    openIssueSession: async (sessionId: string, initialTurn?: { launchId: string; text: string }, pendingQuestions = false, issueScope?: AbortSignal) => {
      const l = live.current;
      const alreadyHeld = l.reg.held.has(sessionId);
      /** The load's answer said issue questions wait: whether they were resumed (or queued). */
      let loadResumed = true;
      if (!l.client || !l.usable || !await openLoad(l.client, l.gen, sessionId, { issueScope, onIssueQuestions: (resumed) => { loadResumed = resumed; } })) throw new Error("Could not open the linked session.");
      if (issueScope?.aborted) return;
      // Nothing is sent beside a turn running in a held session: a reopen from the board while the resume
      // turn runs must not start a second one.
      const resumed = alreadyHeld && pendingQuestions && !l.reg.turns.has(sessionId) ? resumeIssueQuestions(sessionId) : loadResumed;
      if (!resumed) throw new Error("Reopen the linked session and resume Flow preparation.");
      if (initialTurn && !sendPrompt(initialTurn.text, sessionId, undefined, false, undefined, { issueLaunchId: initialTurn.launchId })) {
        if (!l.reg.turns.has(sessionId) && !l.reg.telegramTurns.has(sessionId)) throw new Error("Reopen the linked session and resume Flow preparation.");
        dispatch({ t: "queueAdd", sessionId, text: initialTurn.text, issueLaunchId: initialTurn.launchId });
      }
      void refreshSessions();
    },
    runCommand,
    /** Show a `/delegate` run's terminal tab; false when it is closed (or not a terminal run). */
    focusDelegateTerminal: (runId: string): boolean => delegates.focus(runId),
    rpc,
    telegramSession,
    extensions,
    keryxPath,
    onLoginChallenge,
    refreshTasks,
    /** A notice in the shown session's transcript. */
    notify: (level: "info" | "warn" | "error", text: string) => {
      const sessionId = live.current.reg.shown;
      if (sessionId) dispatch({ t: "notice", sessionId, level, text });
    },
    removeQueued: (index: number) => {
      const sessionId = live.current.reg.shown;
      if (sessionId) dispatch({ t: "queueRemove", sessionId, index });
    },
    cancel,
    newSession,
    loadSession,
    releaseHold,
    reopen,
    setFlags,
    trashSession,
    workOnFlow,
    linkFlow,
    bindSubject,
    /** Whether `sessionId` is the session shown now (read live, not from the last render). */
    isShown: (sessionId: string) => live.current.reg.shown === sessionId,
    /** Bindings keryx has not stored yet, by session id. */
    pendingSubjects,
    setMode,
    raiseMode,
    setModel,
    restart,
    continueAnyway,
    answerPermission,
    answerAsk,
    projectTelegramQuestion,
    dismissFatal: () => setFatal(null),
    dismissBanner: (id: number) => dispatch({ t: "dismissBanner", id }),
  };
}
