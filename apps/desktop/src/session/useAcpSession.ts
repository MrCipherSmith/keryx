import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AcpClient, RpcError } from "../acp/client";
import {
  acpStart,
  acpTransport,
  acpStop,
  listenBridge,
  setWindowTitle,
  versionCheck,
} from "../platform/commands";
import type {
  AskUserRequest,
  AskUserResult,
  ConfigOption,
  InitializeResult,
  LoadSessionResult,
  NewSessionResult,
  PermissionOutcome,
  PermissionRequest,
  SessionInfo,
  SessionUpdate,
} from "../acp/types";
import { initialState, reducer, type Action, type QueuedUpdate } from "./reducer";
import { basename } from "../lib/format";

export interface PendingPermission {
  id: number;
  req: PermissionRequest;
  resolve: (o: PermissionOutcome) => void;
}
export interface PendingAsk {
  id: number;
  req: AskUserRequest;
  resolve: (r: AskUserResult) => void;
}
export type Fatal =
  | { kind: "incompatible"; found: string; required: string }
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

interface Live {
  client: AcpClient | null;
  sessionId: string | null;
  gen: number;
  initialized: boolean;
  noProfile: boolean;
  unlisten: (() => void) | null;
  /** The replay of a session/load is running; owned by the switch token that set it. */
  replaying: boolean;
  /**
   * Session-switch token. Every switch (load, new, start-up) takes a fresh value synchronously,
   * before its first await; a continuation whose token is no longer current drops its result.
   */
  switchSeq: number;
  /** A switch is in flight: the composer must not send. */
  switching: boolean;
  /** The last session that finished loading or starting: the one to restore when a switch fails. */
  settled: string | null;
  /** The running prompt turn, tagged with its session; null when idle. */
  turn: { sessionId: string; client: AcpClient; done: Promise<void> } | null;
  initResult: InitializeResult | null;
}

export function useAcpSession(cwd: string) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [asks, setAsks] = useState<PendingAsk[]>([]);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const live = useRef<Live>({
    client: null,
    sessionId: null,
    gen: 0,
    initialized: false,
    noProfile: false,
    unlisten: null,
    replaying: false,
    switchSeq: 0,
    switching: false,
    settled: null,
    turn: null,
    initResult: null,
  });
  const dialogSeq = useRef(0);
  const permsRef = useRef<PendingPermission[]>([]);
  const asksRef = useRef<PendingAsk[]>([]);
  permsRef.current = permissions;
  asksRef.current = asks;

  // session/update notifications are queued and applied once per animation frame (a timer covers a
  // hidden window, where frames do not fire), so a long replay or a fast stream is not one render per update.
  const queue = useRef<QueuedUpdate[]>([]);
  const flushTimers = useRef({ raf: 0, timeout: 0 });
  const flushUpdates = useCallback(() => {
    const t = flushTimers.current;
    if (t.raf) cancelAnimationFrame(t.raf);
    if (t.timeout) window.clearTimeout(t.timeout);
    t.raf = 0;
    t.timeout = 0;
    const batch = queue.current;
    if (batch.length === 0) return;
    queue.current = [];
    rawDispatch({ t: "updates", updates: batch });
  }, []);
  const enqueueUpdate = useCallback(
    (update: SessionUpdate) => {
      queue.current.push({ update, at: Date.now() });
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

  /** Take a fresh switch token; synchronous, so it is set before the caller's first await. */
  const beginSwitch = useCallback((): number => {
    const l = live.current;
    l.switching = true;
    dispatch({ t: "switching", on: true });
    return ++l.switchSeq;
  }, [dispatch]);

  /** Abandon a switch that never reached startSession (nothing on screen changed). */
  const endSwitch = useCallback(
    (seq: number) => {
      const l = live.current;
      if (l.switchSeq !== seq) return;
      l.switching = false;
      dispatch({ t: "switching", on: false });
    },
    [dispatch],
  );

  const cancelDialogs = useCallback(() => {
    for (const p of permsRef.current) p.resolve({ outcome: "cancelled" });
    for (const a of asksRef.current) a.resolve({ outcome: "cancelled" });
    setPermissions([]);
    setAsks([]);
  }, []);

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
      dispatch({ t: "sessions", sessions: all });
    } catch {
      /* listing is optional; an agent without session/list just shows none */
    }
  }, [cwd]);

  const startSession = useCallback(
    async (client: AcpClient, loadId: string | null, gen: number, seq: number): Promise<boolean> => {
      const l = live.current;
      const current = () => l.gen === gen && l.switchSeq === seq;
      if (!current()) return false;
      const load = (sessionId: string) =>
        client.request<LoadSessionResult>("session/load", { sessionId, cwd, mcpServers: [] });
      const lost = () => {
        l.sessionId = null;
        l.settled = null;
        dispatch({ t: "sessionLost" });
      };
      /** Put the last settled session back so the composer never points at a half-loaded one. */
      const restore = async (target: string | null) => {
        if (!target) return lost();
        l.sessionId = target;
        l.replaying = true;
        dispatch({ t: "session", sessionId: target, replaying: true });
        try {
          const r = await load(target);
          if (!current()) return;
          l.settled = target;
          dispatch({ t: "meta", modes: r?.modes, configOptions: r?.configOptions });
        } catch {
          if (current()) lost();
        }
      };

      try {
        if (loadId) {
          const previous = l.settled;
          l.sessionId = loadId;
          l.replaying = true;
          dispatch({ t: "session", sessionId: loadId, replaying: true });
          try {
            const r = await load(loadId);
            if (!current()) return false;
            l.settled = loadId;
            dispatch({ t: "meta", modes: r?.modes, configOptions: r?.configOptions });
            return true;
          } catch (e) {
            if (!current()) return false;
            l.sessionId = null;
            if (isLeaseError(e)) {
              setFatal({ kind: "leased", sessionId: loadId });
            } else {
              dispatch({ t: "banner", level: "error", text: `Could not load the session: ${errMessage(e)}` });
            }
            if (previous && previous !== loadId) await restore(previous);
            else lost();
            return false;
          }
        }

        // The view still shows the session being left only when no superseded load replaced it.
        const intact = !l.replaying && l.sessionId !== null && l.sessionId === l.settled;
        const previous = l.settled;
        // From here on the old session's updates, prompts and dialogs are refused.
        l.sessionId = null;
        try {
          const r = await client.request<NewSessionResult>("session/new", { cwd, mcpServers: [] });
          if (!current()) return false;
          l.sessionId = r.sessionId;
          l.settled = r.sessionId;
          l.replaying = false;
          dispatch({
            t: "session",
            sessionId: r.sessionId,
            modes: r.modes,
            configOptions: r.configOptions,
            replaying: false,
          });
          return true;
        } catch (e) {
          if (!current()) return false;
          if (isLeaseError(e)) {
            dispatch({ t: "banner", level: "error", text: `The session is in use by another keryx: ${errMessage(e)}` });
          } else {
            dispatch({ t: "banner", level: "error", text: `Could not start a session: ${errMessage(e)}` });
          }
          if (intact) l.sessionId = previous;
          else await restore(previous);
          return false;
        }
      } finally {
        // Only the switch that still owns the token may end the replay and re-enable the composer.
        if (current()) {
          l.replaying = false;
          l.switching = false;
          dispatch({ t: "replayDone" });
        }
      }
    },
    [cwd, dispatch],
  );

  const handleUpdate = useCallback(
    (params: unknown) => {
      const p = params as { sessionId?: string; update?: SessionUpdate };
      if (!p?.update || p.sessionId !== live.current.sessionId) return;
      enqueueUpdate(p.update);
      if (p.update.sessionUpdate === "session_info_update") void refreshSessions();
    },
    [refreshSessions, enqueueUpdate],
  );

  const connect = useCallback(
    async (opts: { noProfile: boolean; loadSessionId: string | null; fallbackToNew: boolean }) => {
      const l = live.current;
      const gen = ++l.gen;
      l.unlisten?.();
      l.client?.close("restarting keryx");
      cancelDialogs();
      l.initialized = false;
      l.noProfile = opts.noProfile;
      l.sessionId = null;
      l.settled = null;
      l.replaying = false;
      l.switching = false;
      l.switchSeq++;
      l.turn = null;
      setFatal(null);
      dispatch({ t: "switching", on: false });
      dispatch({ t: "phase", phase: "starting" });
      dispatch({ t: "clearBanners" });

      const client = new AcpClient(acpTransport);
      l.client = client;
      client.onNotification = (method, params) => {
        if (method === "session/update") handleUpdate(params);
      };
      client.onRequest = async (method, params) => {
        // A dialog from a session the window has left must not appear over the current one.
        const sid = (params as { sessionId?: unknown } | null)?.sessionId;
        const stale = typeof sid === "string" && sid !== l.sessionId;
        if (method === "session/request_permission") {
          if (stale) return { outcome: { outcome: "cancelled" } satisfies PermissionOutcome };
          return new Promise<unknown>((resolve) => {
            setPermissions((q) => [...q, { id: ++dialogSeq.current, req: params as PermissionRequest, resolve: resolve as (o: PermissionOutcome) => void }]);
          }).then((outcome) => ({ outcome }));
        }
        if (method === "_keryx/ask_user") {
          if (stale) return { outcome: "cancelled" } satisfies AskUserResult;
          return new Promise<unknown>((resolve) => {
            setAsks((q) => [...q, { id: ++dialogSeq.current, req: params as AskUserRequest, resolve: resolve as (r: AskUserResult) => void }]);
          });
        }
        throw new RpcError(-32601, `Method not found: ${method}`);
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
            cancelDialogs();
            const usageError =
              info.code === 2 || /usage|unknown (value|option|profile)|unrecognized|invalid (value|profile)|--profile/i.test(info.stderrTail);
            if (!l.initialized && !opts.noProfile && usageError) {
              // An older keryx rejects --profile: run it without the flag.
              void connect({ ...opts, noProfile: true });
              return;
            }
            dispatch({ t: "phase", phase: "exited", exit: info });
          },
        });
        const start = await acpStart(cwd, opts.noProfile);
        if (l.gen !== gen) return;
        if (start.note) dispatch({ t: "banner", level: "info", text: start.note });
        if (opts.noProfile) dispatch({ t: "banner", level: "warn", text: "This keryx has no shell profile; running as an editor-profile agent." });

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
        l.initResult = init;

        const found = init.agentInfo?.version ?? "unknown";
        const profile = init._meta?.keryx?.profile === "shell" ? "shell" : "editor";
        dispatch({ t: "agent", profile, version: init.agentInfo?.version ?? null });
        if (!opts.noProfile && profile === "editor") {
          dispatch({ t: "banner", level: "warn", text: "This keryx has no shell profile; running as an editor-profile agent." });
        }
        const check = await versionCheck(found);
        if (l.gen !== gen) return;
        if (!check.ok) {
          setFatal({ kind: "incompatible", found: check.found, required: check.required });
          return;
        }
        await finishStart(client, gen, opts.loadSessionId, opts.fallbackToNew);
      } catch (e) {
        if (l.gen !== gen) return;
        dispatch({ t: "banner", level: "error", text: errMessage(e) });
        dispatch({ t: "phase", phase: "exited", exit: { code: null, stderrTail: errMessage(e) } });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, cancelDialogs, handleUpdate],
  );

  const finishStart = useCallback(
    async (client: AcpClient, gen: number, loadId: string | null, fallbackToNew: boolean) => {
      const l = live.current;
      let seq = beginSwitch();
      const ok = await startSession(client, loadId, gen, seq);
      if (!ok && loadId && fallbackToNew && l.gen === gen && l.switchSeq === seq) {
        dispatch({ t: "clearBanners" });
        seq = beginSwitch();
        const fellBack = await startSession(client, null, gen, seq);
        // The reload's lease dialog is moot once the fresh session is up.
        if (fellBack && l.gen === gen && l.switchSeq === seq) setFatal((f) => (f?.kind === "leased" ? null : f));
      }
      if (l.gen !== gen) return;
      dispatch({ t: "phase", phase: "ready" });
      void refreshSessions();
    },
    [startSession, refreshSessions, beginSwitch, dispatch],
  );

  useEffect(() => {
    void connect({ noProfile: false, loadSessionId: null, fallbackToNew: false });
    return () => {
      const l = live.current;
      l.gen++;
      const t = flushTimers.current;
      if (t.raf) cancelAnimationFrame(t.raf);
      if (t.timeout) window.clearTimeout(t.timeout);
      t.raf = 0;
      t.timeout = 0;
      queue.current = [];
      l.unlisten?.();
      l.client?.close("window closed");
      cancelDialogs();
      void acpStop();
    };
    // connect once per window/cwd
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useEffect(() => {
    const title = state.title && state.title.trim() ? state.title : "New session";
    void setWindowTitle(`${title} — ${basename(cwd)}`);
  }, [state.title, cwd]);

  // ---- user actions -------------------------------------------------------

  /** Starts a turn; returns true only when the prompt was accepted (the caller may then clear its draft). */
  const sendPrompt = useCallback(
    (text: string): boolean => {
      const l = live.current;
      const client = l.client;
      const sessionId = l.sessionId;
      if (!client || !sessionId || l.turn || l.replaying || l.switching || !l.initialized || !text.trim()) return false;
      dispatch({ t: "userSent", text });
      dispatch({ t: "busy", busy: true });
      let done!: Promise<void>;
      done = (async () => {
        try {
          const r = await client.request<{ stopReason?: string }>("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
          });
          // An old turn must not narrate into a session the user has since switched to.
          if (l.sessionId !== sessionId) return;
          if (r?.stopReason === "max_tokens") dispatch({ t: "notice", level: "warn", text: "Stopped: the model hit its token limit." });
          else if (r?.stopReason === "max_turn_requests") dispatch({ t: "notice", level: "warn", text: "Stopped: too many model requests in one turn." });
          else if (r?.stopReason === "refusal") dispatch({ t: "notice", level: "warn", text: "The model refused to continue." });
          else if (r?.stopReason === "cancelled") dispatch({ t: "notice", level: "info", text: "Stopped." });
        } catch (e) {
          if (l.client === client && l.sessionId === sessionId) dispatch({ t: "notice", level: "error", text: errMessage(e) });
        } finally {
          if (l.turn?.done === done) l.turn = null;
          // Only the session that owns this turn may clear its busy flag.
          if (l.client === client && l.sessionId === sessionId) {
            dispatch({ t: "busy", busy: false });
            void refreshSessions();
          }
        }
      })();
      l.turn = { sessionId, client, done };
      return true;
    },
    [refreshSessions],
  );

  const cancel = useCallback(() => {
    const l = live.current;
    // Stop the running turn in the session it runs in, which is not always the current one.
    if (l.turn) l.turn.client.notify("session/cancel", { sessionId: l.turn.sessionId });
    else if (l.client && l.sessionId) l.client.notify("session/cancel", { sessionId: l.sessionId });
    else return;
    cancelDialogs();
  }, [cancelDialogs]);

  /** Cancel a running turn and wait for its prompt to settle. False when it did not settle in time. */
  const settleTurn = useCallback(async (): Promise<boolean> => {
    const l = live.current;
    const turn = l.turn;
    if (!turn) return true;
    l.client?.notify("session/cancel", { sessionId: turn.sessionId });
    cancelDialogs();
    let timer = 0;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = window.setTimeout(() => resolve("timeout"), 8000);
    });
    const outcome = await Promise.race([turn.done.then(() => "done" as const), timeout]);
    window.clearTimeout(timer);
    if (outcome === "timeout") {
      dispatch({ t: "notice", level: "warn", text: "The current turn did not stop in time. Try again in a moment." });
      return false;
    }
    return true;
  }, [cancelDialogs]);

  /** A newer switch supersedes an older one: the older one's continuations see a stale token and stop. */
  const switchTo = useCallback(
    async (loadId: string | null): Promise<void> => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.initialized) return;
      const gen = l.gen;
      const seq = beginSwitch();
      if (!(await settleTurn())) {
        endSwitch(seq);
        return;
      }
      if (l.client !== client || l.gen !== gen || l.switchSeq !== seq) return;
      setFatal(null);
      dispatch({ t: "clearBanners" });
      await startSession(client, loadId, gen, seq);
    },
    [beginSwitch, endSwitch, settleTurn, startSession, dispatch],
  );

  const newSession = useCallback(async () => {
    await switchTo(null);
    void refreshSessions();
  }, [switchTo, refreshSessions]);

  const loadSession = useCallback(
    async (id: string) => {
      if (id === live.current.sessionId) return;
      await switchTo(id);
    },
    [switchTo],
  );

  const setMode = useCallback(async (modeId: string) => {
    const l = live.current;
    const client = l.client;
    const sessionId = l.sessionId;
    if (!client || !sessionId || l.switching) return;
    // The reply applies only while the session it was sent for is still on screen.
    const stillCurrent = () => l.client === client && l.sessionId === sessionId;
    try {
      await client.request("session/set_mode", { sessionId, modeId });
      if (stillCurrent()) dispatch({ t: "update", update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
    } catch (e) {
      if (stillCurrent()) dispatch({ t: "notice", level: "error", text: `Could not change mode: ${errMessage(e)}` });
    }
  }, [dispatch]);

  const setModel = useCallback(async (configId: string, value: string) => {
    const l = live.current;
    const client = l.client;
    const sessionId = l.sessionId;
    if (!client || !sessionId || l.switching) return;
    const stillCurrent = () => l.client === client && l.sessionId === sessionId;
    try {
      const r = await client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
        sessionId,
        configId,
        value,
      });
      if (r?.configOptions && stillCurrent()) dispatch({ t: "config", configOptions: r.configOptions });
    } catch (e) {
      if (stillCurrent()) dispatch({ t: "notice", level: "error", text: `Could not change model: ${errMessage(e)}` });
    }
  }, [dispatch]);

  const restart = useCallback(() => {
    const id = live.current.sessionId;
    void connect({ noProfile: live.current.noProfile, loadSessionId: id, fallbackToNew: true });
  }, [connect]);

  const continueAnyway = useCallback(() => {
    const l = live.current;
    const client = l.client;
    if (!client) return;
    setFatal(null);
    void finishStart(client, l.gen, null, false);
  }, [finishStart]);

  const answerPermission = useCallback((p: PendingPermission, outcome: PermissionOutcome) => {
    p.resolve(outcome);
    setPermissions((q) => q.filter((x) => x !== p));
  }, []);

  const answerAsk = useCallback((a: PendingAsk, result: AskUserResult) => {
    a.resolve(result);
    setAsks((q) => q.filter((x) => x !== a));
  }, []);

  return {
    state,
    permissions,
    asks,
    fatal,
    sendPrompt,
    cancel,
    newSession,
    loadSession,
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
