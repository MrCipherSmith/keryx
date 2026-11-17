import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AcpClient, RpcError } from "../acp/client";
import { acpStart, acpTransport, acpStop, listenBridge, setWindowTitle, versionCheck } from "../platform/commands";
import {
  hasLiveSessions,
  SESSION_RELEASED,
  type AskUserRequest,
  type AskUserResult,
  type ConfigOption,
  type InitializeResult,
  type LoadSessionResult,
  type NewSessionResult,
  type PermissionOutcome,
  type PermissionRequest,
  type SessionInfo,
  type SessionUpdate,
} from "../acp/types";
import { initialState, reducer, sessionMarks, shownView, type Action, type RoutedUpdate } from "./reducer";
import { DialogQueue, type PendingAsk, type PendingPermission } from "./dialogQueue";
import { SessionRegistry } from "./sessionRegistry";
import { basename } from "../lib/format";

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

const CANCELLED: PermissionOutcome = { outcome: "cancelled" };

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
  const [dialogVersion, setDialogVersion] = useState(0);
  const dialogsRef = useRef<DialogQueue | null>(null);
  if (!dialogsRef.current) dialogsRef.current = new DialogQueue(() => setDialogVersion((v) => v + 1));
  const dialogs = dialogsRef.current;
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const live = useRef<Live>({ client: null, gen: 0, initialized: false, usable: false, unlisten: null, reg: new SessionRegistry<Turn>() });

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

  const refreshSessions = useCallback(async () => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.initialized) return;
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
    } catch {
      /* listing is optional; an agent without session/list just shows none */
    }
  }, [cwd, dispatch]);

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
        const r = await client.request<LoadSessionResult>("session/load", { sessionId, cwd, mcpServers: [] });
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
    async (client: AcpClient, gen: number): Promise<boolean> => {
      const l = live.current;
      const intent = l.reg.beginCreate();
      dispatch({ t: "creating", delta: 1 });
      try {
        const r = await client.request<NewSessionResult>("session/new", { cwd, mcpServers: [] });
        if (l.gen !== gen) return false;
        if (typeof r?.sessionId !== "string") throw new Error("keryx returned no session id");
        const show = l.reg.created(r.sessionId, intent);
        dispatch({ t: "created", sessionId: r.sessionId, modes: r.modes, configOptions: r.configOptions, show });
        // Updates keryx may have sent for it before the reply was read.
        for (const u of l.reg.takeOrphans(r.sessionId)) acceptUpdate(u);
        return true;
      } catch (e) {
        if (l.gen !== gen) return false;
        const why = isLeaseError(e) ? "The session is in use by another keryx" : "Could not start a session";
        dispatch({ t: "banner", level: "error", text: `${why}: ${errMessage(e)}` });
        return false;
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
    async (client: AcpClient, gen: number, loadId: string | null, fallbackToNew: boolean) => {
      const l = live.current;
      let ok = loadId ? await openLoad(client, gen, loadId) : false;
      if (l.gen !== gen) return;
      if (!ok && (!loadId || fallbackToNew)) {
        if (loadId) dispatch({ t: "clearBanners" });
        ok = await openNew(client, gen);
        // The reload's lease dialog is moot once the fresh session is up.
        if (ok && loadId && l.gen === gen) setFatal((f) => (f?.kind === "leased" ? null : f));
      }
      if (l.gen !== gen) return;
      dispatch({ t: "phase", phase: "ready" });
      void refreshSessions();
    },
    [openLoad, openNew, refreshSessions, dispatch],
  );

  const connect = useCallback(
    async (opts: { loadSessionId: string | null; fallbackToNew: boolean }) => {
      const l = live.current;
      const gen = ++l.gen;
      l.unlisten?.();
      l.client?.close("restarting keryx");
      dialogs.dropAll();
      l.initialized = false;
      l.usable = false;
      l.reg.reset();
      setFatal(null);
      dispatch({ t: "connectionReset" });
      dispatch({ t: "phase", phase: "starting" });
      dispatch({ t: "clearBanners" });

      const client = new AcpClient(acpTransport);
      l.client = client;
      client.onNotification = (method, params) => {
        if (method === "session/update") handleUpdate(params);
        else if (method === SESSION_RELEASED) handleReleased(params);
      };
      client.onRequest = async (method, params) => {
        if (method === "session/request_permission") {
          const sid = l.reg.admit(params);
          if (!sid) return { outcome: CANCELLED };
          return { outcome: await dialogs.permission(sid, params as PermissionRequest) };
        }
        if (method === "_keryx/ask_user") {
          const sid = l.reg.admit(params);
          if (!sid) return { outcome: "cancelled" } satisfies AskUserResult;
          return dialogs.ask(sid, params as AskUserRequest);
        }
        throw new RpcError(-32601, `Method not found: ${method}`);
      };
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
            if (!initialized && usageError) setFatal({ kind: "noShell", found: "unknown", reason: "no-profile" });
            dispatch({ t: "phase", phase: "exited", exit: info });
          },
        });
        const start = await acpStart(cwd, false);
        if (l.gen !== gen) return;
        if (start.note) dispatch({ t: "banner", level: "info", text: start.note });

        const init = await client.request<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            _meta: { keryx: { askUser: true } },
          },
          clientInfo: { name: "keryx-desktop", title: "Keryx", version: "0.1.0" },
        });
        if (l.gen !== gen) return;
        l.initialized = true;

        const found = init.agentInfo?.version ?? "unknown";
        const profile = init._meta?.keryx?.profile === "shell" ? "shell" : "editor";
        dispatch({ t: "agent", profile, version: init.agentInfo?.version ?? null });
        if (profile !== "shell" || !hasLiveSessions(init)) {
          setFatal({ kind: "noShell", found, reason: profile !== "shell" ? "no-profile" : "no-live-sessions" });
          dispatch({ t: "phase", phase: "ready" });
          return;
        }
        const check = await versionCheck(found);
        if (l.gen !== gen) return;
        if (!check.ok) {
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
    [cwd, dialogs, dispatch, handleUpdate, handleReleased, finishStart],
  );

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
    (text: string): boolean => {
      const l = live.current;
      const client = l.client;
      const sessionId = l.reg.shown;
      if (!client || !l.initialized || !sessionId || !l.reg.held.has(sessionId) || l.reg.turns.has(sessionId) || !text.trim()) return false;
      dispatch({ t: "userSent", sessionId, text });
      dispatch({ t: "busy", sessionId, busy: true });
      const turn = { client } as Turn;
      turn.done = (async () => {
        try {
          const r = await client.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
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
            void refreshSessions();
          }
        }
      })();
      l.reg.turns.set(sessionId, turn);
      return true;
    },
    [dialogs, dispatch, refreshSessions],
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
      if (l.reg.planSwitch(id) === "load") {
        setFatal((f) => (f?.kind === "leased" ? null : f));
        dispatch({ t: "clearBanners" });
      }
      await openLoad(client, l.gen, id);
    },
    [openLoad, dispatch],
  );

  const newSession = useCallback(async () => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.usable) return;
    setFatal((f) => (f?.kind === "leased" ? null : f));
    dispatch({ t: "clearBanners" });
    await openNew(client, l.gen);
    void refreshSessions();
  }, [openNew, refreshSessions, dispatch]);

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
    sendPrompt,
    cancel,
    newSession,
    loadSession,
    reopen,
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
