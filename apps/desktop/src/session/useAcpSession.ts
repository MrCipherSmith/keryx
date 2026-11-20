import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AcpClient, RpcError } from "../acp/client";
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
import { acpStart, acpTransport, acpStop, listenBridge, setWindowTitle, versionCheck } from "../platform/commands";
import { isTauri } from "../platform/backend";
import { buildUserPrompt, type UserPromptContext } from "./userPrompt";
import { onPtyExit, panelMcpServers, ptyOpenRun } from "../platform/panels";
import { closeTerminalTab, onTabClosed, showTerminalTab } from "../panels/panelBus";
import { notifyDelegateChange, setDelegateApi } from "./delegateBus";
import { createDelegateTerminals, type DelegateLaunch } from "./delegateTerminals";
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
  type SessionUpdate,
} from "../acp/types";
import { initialState, pendingQueueSend, reducer, sessionMarks, shownView, type Action, type RoutedUpdate } from "./reducer";
import { runCommandLine, type RunOptions, type UiActions } from "./commandRunner";
import { DialogQueue, type PendingAsk, type PendingPermission } from "./dialogQueue";
import { SessionRegistry } from "./sessionRegistry";
import { answerAgentRequest } from "./agentRequests";
import { basename } from "../lib/format";
import { retentionDays } from "../lib/retention";
import { idleSessions, pickStartSession } from "./startup";

export type { PendingAsk, PendingPermission } from "./dialogQueue";

export type Fatal =
  | { kind: "incompatible"; found: string; required: string }
  /** This keryx cannot serve the app at all: no shell profile, or one without live sessions. */
  | { kind: "noShell"; found: string; reason: "no-profile" | "no-live-sessions" }
  | { kind: "leased"; sessionId: string };

/** keryx answers a leased session with error.data.reason "session-leased"; the anchored text is only a fallback. */
function isLeaseError(e: unknown): boolean {
  if (e instanceof RpcError) {
    const reason = (e.data as { reason?: unknown } | undefined)?.reason;
    if (reason === "session-leased") return true;
  }
  return /(^|[^\w-])session-leased([^\w-]|$)/.test(errMessage(e));
}

export function modelOption(options: ConfigOption[]): ConfigOption | undefined {
  return options.find((o) => o.id === "model") ?? options.find((o) => o.category === "model");
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
export function useAcpSession(cwd: string) {
  const [win, rawDispatch] = useReducer(reducer, initialState);
  const winRef = useRef(win);
  winRef.current = win;
  const [dialogVersion, setDialogVersion] = useState(0);
  const dialogsRef = useRef<DialogQueue | null>(null);
  if (!dialogsRef.current) dialogsRef.current = new DialogQueue(() => setDialogVersion((v) => v + 1));
  const dialogs = dialogsRef.current;
  const [fatal, setFatal] = useState<Fatal | null>(null);
  /** The incompatible-keryx dialog was put away; `fatal` itself stays, so the window keeps saying so. */
  const [fatalHidden, setFatalHidden] = useState(false);
  const [extensions, setExtensions] = useState<readonly string[]>([]);
  /** The keryx this window runs (`acp_start`), for project commands run in a terminal tab. */
  const [keryxPath, setKeryxPath] = useState<string | null>(null);
  const challengeListeners = useRef(new Set<(c: LoginChallenge) => void>());
  const live = useRef<Live>({ client: null, gen: 0, initialized: false, usable: false, commandMethod: false, extensions: [], unlisten: null, reg: new SessionRegistry<Turn>() });

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
      rawDispatch(a);
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

  /** Link `sessionId` to its pending flow; quiet, kept for the next try when keryx does not have the session yet. */
  const applyPendingFlow = useCallback(
    async (sessionId: string) => {
      const l = live.current;
      const client = l.client;
      const flow = pendingFlow.current.get(sessionId);
      if (!client || flow === undefined) return;
      try {
        const flags = await client.request<SessionFlags>(SESSION_FLAGS, { sessionId, cwd, flow });
        pendingFlow.current.delete(sessionId);
        if (l.client === client) dispatch({ t: "flags", sessionId, flags: flags ?? {} });
      } catch {
        /* not stored yet: retried after its turn */
      }
    },
    [cwd, dispatch],
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

  /**
   * Archive the sessions nobody touched for the retention window (Settings → Sessions). The shown
   * session and any with a running turn are kept; pinned ones are never archived. Best effort.
   */
  const archiveIdle = useCallback(
    async (sessions: readonly SessionInfo[]) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable || !l.extensions.includes(SESSION_FLAGS)) return;
      const keep = new Set<string>([...(l.reg.shown ? [l.reg.shown] : []), ...l.reg.turns.keys()]);
      const ids = idleSessions(sessions, Date.now(), retentionDays(), keep);
      for (const sessionId of ids) {
        try {
          const flags = await client.request<SessionFlags>(SESSION_FLAGS, { sessionId, cwd, archived: true });
          if (l.client !== client) return;
          dispatch({ t: "flags", sessionId, flags: flags ?? {} });
        } catch {
          /* in use elsewhere or gone: tried again next time */
        }
      }
    },
    [cwd, dispatch],
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
      enqueueUpdate(u);
      if (u.update.sessionUpdate === "session_info_update") void refreshSessions();
    },
    [enqueueUpdate, refreshSessions],
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
      dispatch({ t: "released", sessionId: sid });
    },
    [dialogs, dispatch],
  );

  /**
   * session/load of a session the window does not hold. Its replay lands off screen; the session is
   * shown on success unless the user has switched elsewhere since. A failure changes nothing on screen.
   */
  const openLoad = useCallback(
    async (client: AcpClient, gen: number, sessionId: string): Promise<boolean> => {
      const l = live.current;
      const plan = l.reg.planSwitch(sessionId);
      if (plan === "show") {
        l.reg.showLocal(sessionId);
        dispatch({ t: "show", sessionId });
        return true;
      }
      if (plan === "pending") {
        l.reg.wantLoad(sessionId);
        return true;
      }
      l.reg.beginLoad(sessionId);
      dispatch({ t: "loadStart", sessionId });
      try {
        const r = await client.request<LoadSessionResult>("session/load", { sessionId, cwd, mcpServers: await panelMcpServers(cwd) });
        if (l.gen !== gen) return false;
        const show = l.reg.loadDone(sessionId);
        dispatch({ t: "loadDone", sessionId, modes: r?.modes, configOptions: r?.configOptions, show });
        return true;
      } catch (e) {
        if (l.gen !== gen) return false;
        l.reg.loadFailed(sessionId);
        dispatch({ t: "loadFailed", sessionId });
        if (isLeaseError(e)) setFatal({ kind: "leased", sessionId });
        else dispatch({ t: "banner", level: "error", text: `Could not load the session: ${errMessage(e)}` });
        return false;
      }
    },
    [cwd, dispatch],
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
      setExtensions([]);
      l.reg.reset();
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
      client.onRequest = (method, params) => answerAgentRequest(method, params, l.reg, dialogs);
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
            _meta: { keryx: { askUser: true, ...(isTauri() ? { terminal: true } : {}) } },
          },
          clientInfo: { name: "keryx-desktop", title: "Keryx", version: "0.2.4" },
        });
        if (l.gen !== gen) return;
        l.initialized = true;
        l.commandMethod = hasCommandExtension(init);
        l.extensions = extensionsOf(init);
        setExtensions(l.extensions);

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
    [cwd, dialogs, dispatch, handleUpdate, handleReleased, finishStart, refreshTasks],
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

  const state = useMemo(() => shownView(win), [win]);
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

  useEffect(() => {
    const title = state.title && state.title.trim() ? state.title : "New session";
    void setWindowTitle(`${title} — ${basename(cwd)}`);
  }, [state.title, cwd]);

  // ---- user actions -------------------------------------------------------

  /** Starts a turn in the shown session; returns true only when the prompt was accepted (the caller may then clear its draft). */
  const sendPrompt = useCallback(
    (text: string, target?: string, context?: UserPromptContext, literal = false): boolean => {
      const extra = context?.blocks ?? [];
      const l = live.current;
      const client = l.client;
      const sessionId = target ?? l.reg.shown;
      if (!client || !l.initialized || !sessionId || !l.reg.held.has(sessionId) || l.reg.turns.has(sessionId) || (!text.trim() && extra.length === 0)) return false;
      dispatch({ t: "userSent", sessionId, text, context });
      dispatch({ t: "busy", sessionId, busy: true });
      const turn = { client } as Turn;
      turn.done = (async () => {
        try {
          const prompt = buildUserPrompt(text, extra, literal);
          const r = await client.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt });
          if (l.client !== client) return;
          const notice = (level: "info" | "warn", t: string) => dispatch({ t: "notice", sessionId, level, text: t });
          if (r?.stopReason === "max_tokens") notice("warn", "Stopped: the model hit its token limit.");
          else if (r?.stopReason === "max_turn_requests") notice("warn", "Stopped: too many model requests in one turn.");
          else if (r?.stopReason === "refusal") notice("warn", "The model refused to continue.");
          else if (r?.stopReason === "cancelled") notice("info", "Stopped.");
        } catch (e) {
          if (l.client === client) dispatch({ t: "notice", sessionId, level: "error", text: errMessage(e) });
        } finally {
          if (l.reg.turns.get(sessionId) === turn) l.reg.turns.delete(sessionId);
          if (l.client === client) {
            // keryx sends no request for a turn after its prompt reply: anything still queued is stale.
            dialogs.dropSession(sessionId);
            dispatch({ t: "busy", sessionId, busy: false });
            void applyPendingFlow(sessionId).finally(() => void refreshSessions());
          }
        }
      })();
      l.reg.turns.set(sessionId, turn);
      return true;
    },
    [dialogs, dispatch, refreshSessions, applyPendingFlow],
  );

  /** Stop the shown session's turn only; every other session keeps running. */
  const cancel = useCallback(() => {
    const l = live.current;
    const sessionId = l.reg.shown;
    const client = l.client;
    if (!client || !sessionId || !l.reg.held.has(sessionId)) return;
    client.notify("session/cancel", { sessionId });
    dialogs.dropSession(sessionId);
  }, [dialogs]);

  /** Show a session: local when the window holds it, session/load otherwise. Nothing is cancelled or released. */
  const loadSession = useCallback(
    async (id: string) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable) return;
      const plan = l.reg.planSwitch(id);
      if (plan === "load") {
        setFatal((f) => (f?.kind === "leased" ? null : f));
        dispatch({ t: "clearBanners" });
      } else if (plan === "show" && l.reg.shown !== id) {
        // A local switch sends no request; tell keryx so its idle cap counts this session as in use.
        client.notify(SESSION_SHOWN, { sessionId: id });
      }
      await openLoad(client, l.gen, id);
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

  /** Prompts queued while a turn ran go out in order, one per ended turn. */
  useEffect(() => {
    const l = live.current;
    for (const c of Object.values(win.convs)) {
      const next = pendingQueueSend(c, l.reg.turns.has(c.sessionId));
      if (next && sendPrompt(next.text, c.sessionId)) dispatch({ t: "queueShift", sessionId: c.sessionId });
    }
  }, [win.convs, sendPrompt, dispatch]);

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
          busy: conv?.busy ?? false,
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
          ui,
          trackCommand: (target) => l.reg.beginCommand(target),
        },
        opts,
      );
    },
    [dispatch, sendPrompt, newSession, cancel, applyEffects, openTerminal],
  );

  /** Archive/unarchive or pin/unpin a stored session. Errors show as a banner. */
  const setFlags = useCallback(
    async (sessionId: string, change: { archived?: boolean; pinned?: boolean; flow?: string | null }) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.usable) return;
      try {
        const flags = await client.request<SessionFlags>(SESSION_FLAGS, { sessionId, cwd, ...change });
        if (l.client === client) dispatch({ t: "flags", sessionId, flags: flags ?? {} });
      } catch (e) {
        if (l.client === client) dispatch({ t: "banner", level: "error", text: `Could not update the session: ${errMessage(e)}` });
      }
    },
    [cwd, dispatch],
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
      const wasShown = l.reg.shown === sessionId;
      if (wasShown) l.reg.shown = null;
      dispatch({ t: "removed", sessionId });
      if (wasShown) {
        const next = [...l.reg.held].pop();
        if (next) await loadSession(next);
        else await newSession();
      }
      void refreshSessions();
      return true;
    },
    [cwd, dialogs, dispatch, loadSession, newSession, refreshSessions],
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

  return {
    state,
    /** The shown session's dialogs; other sessions keep theirs queued. */
    permissions: shownDialogs.permissions,
    asks: shownDialogs.asks,
    /** Busy / waiting / held marks for every session the window has. */
    marks,
    fatal,
    fatalHidden,
    hideFatal: () => setFatalHidden(true),
    sendPrompt,
    runCommand,
    /** Show a `/delegate` run's terminal tab; false when it is closed (or not a terminal run). */
    focusDelegateTerminal: (runId: string): boolean => delegates.focus(runId),
    rpc,
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
    reopen,
    setFlags,
    trashSession,
    workOnFlow,
    setMode,
    setModel,
    restart,
    continueAnyway,
    answerPermission,
    answerAsk,
    dismissFatal: () => setFatal(null),
    dismissBanner: (id: number) => dispatch({ t: "dismissBanner", id }),
  };
}
