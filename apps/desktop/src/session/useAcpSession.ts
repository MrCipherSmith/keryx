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
import { initialState, reducer } from "./reducer";

export interface PendingPermission {
  req: PermissionRequest;
  resolve: (o: PermissionOutcome) => void;
}
export interface PendingAsk {
  req: AskUserRequest;
  resolve: (r: AskUserResult) => void;
}
export type Fatal =
  | { kind: "incompatible"; found: string; required: string }
  | { kind: "leased"; sessionId: string };

const LEASE_PATTERN = /leas|lock|in use|held|another (process|keryx|client)|already (open|active|attached)/i;

export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
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
  replaying: boolean;
  initResult: InitializeResult | null;
}

export function useAcpSession(cwd: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
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
    initResult: null,
  });
  const permsRef = useRef<PendingPermission[]>([]);
  const asksRef = useRef<PendingAsk[]>([]);
  permsRef.current = permissions;
  asksRef.current = asks;

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
    async (client: AcpClient, loadId: string | null, gen: number): Promise<boolean> => {
      const l = live.current;
      if (loadId) {
        l.sessionId = loadId;
        l.replaying = true;
        dispatch({ t: "session", sessionId: loadId, replaying: true });
        try {
          const r = await client.request<LoadSessionResult>("session/load", {
            sessionId: loadId,
            cwd,
            mcpServers: [],
          });
          if (l.gen !== gen) return false;
          dispatch({ t: "meta", modes: r?.modes, configOptions: r?.configOptions });
          return true;
        } catch (e) {
          if (l.gen !== gen) return false;
          l.sessionId = null;
          if (LEASE_PATTERN.test(errMessage(e))) {
            setFatal({ kind: "leased", sessionId: loadId });
          } else {
            dispatch({ t: "banner", level: "error", text: `Could not load the session: ${errMessage(e)}` });
          }
          return false;
        } finally {
          l.replaying = false;
          dispatch({ t: "replayDone" });
        }
      }
      try {
        const r = await client.request<NewSessionResult>("session/new", { cwd, mcpServers: [] });
        if (l.gen !== gen) return false;
        l.sessionId = r.sessionId;
        dispatch({
          t: "session",
          sessionId: r.sessionId,
          modes: r.modes,
          configOptions: r.configOptions,
          replaying: false,
        });
        return true;
      } catch (e) {
        if (l.gen !== gen) return false;
        if (LEASE_PATTERN.test(errMessage(e))) {
          dispatch({ t: "banner", level: "error", text: `The session is in use by another keryx: ${errMessage(e)}` });
        } else {
          dispatch({ t: "banner", level: "error", text: `Could not start a session: ${errMessage(e)}` });
        }
        return false;
      }
    },
    [cwd],
  );

  const handleUpdate = useCallback(
    (params: unknown) => {
      const p = params as { sessionId?: string; update?: SessionUpdate };
      if (!p?.update || p.sessionId !== live.current.sessionId) return;
      dispatch({ t: "update", update: p.update });
      if (p.update.sessionUpdate === "session_info_update") void refreshSessions();
    },
    [refreshSessions],
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
      setFatal(null);
      dispatch({ t: "phase", phase: "starting" });
      dispatch({ t: "clearBanners" });

      const client = new AcpClient(acpTransport);
      l.client = client;
      client.onNotification = (method, params) => {
        if (method === "session/update") handleUpdate(params);
      };
      client.onRequest = async (method, params) => {
        if (method === "session/request_permission") {
          return new Promise<unknown>((resolve) => {
            setPermissions((q) => [...q, { req: params as PermissionRequest, resolve: resolve as (o: PermissionOutcome) => void }]);
          }).then((outcome) => ({ outcome }));
        }
        if (method === "_keryx/ask_user") {
          return new Promise<unknown>((resolve) => {
            setAsks((q) => [...q, { req: params as AskUserRequest, resolve: resolve as (r: AskUserResult) => void }]);
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
      let ok = await startSession(client, loadId, gen);
      if (!ok && loadId && fallbackToNew && live.current.gen === gen) {
        dispatch({ t: "clearBanners" });
        ok = await startSession(client, null, gen);
      }
      if (live.current.gen !== gen) return;
      dispatch({ t: "phase", phase: "ready" });
      void refreshSessions();
    },
    [startSession, refreshSessions],
  );

  useEffect(() => {
    void connect({ noProfile: false, loadSessionId: null, fallbackToNew: false });
    return () => {
      const l = live.current;
      l.gen++;
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

  const sendPrompt = useCallback(
    async (text: string) => {
      const l = live.current;
      const client = l.client;
      const sessionId = l.sessionId;
      if (!client || !sessionId || state.busy || !text.trim()) return;
      dispatch({ t: "userSent", text });
      dispatch({ t: "busy", busy: true });
      try {
        const r = await client.request<{ stopReason?: string }>("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        if (r?.stopReason === "max_tokens") dispatch({ t: "notice", level: "warn", text: "Stopped: the model hit its token limit." });
        else if (r?.stopReason === "max_turn_requests") dispatch({ t: "notice", level: "warn", text: "Stopped: too many model requests in one turn." });
        else if (r?.stopReason === "refusal") dispatch({ t: "notice", level: "warn", text: "The model refused to continue." });
        else if (r?.stopReason === "cancelled") dispatch({ t: "notice", level: "info", text: "Stopped." });
      } catch (e) {
        if (l.client === client) dispatch({ t: "notice", level: "error", text: errMessage(e) });
      } finally {
        if (l.client === client) {
          dispatch({ t: "busy", busy: false });
          void refreshSessions();
        }
      }
    },
    [state.busy, refreshSessions],
  );

  const cancel = useCallback(() => {
    const l = live.current;
    if (!l.client || !l.sessionId) return;
    l.client.notify("session/cancel", { sessionId: l.sessionId });
    cancelDialogs();
  }, [cancelDialogs]);

  const newSession = useCallback(async () => {
    const l = live.current;
    const client = l.client;
    if (!client || !l.initialized) return;
    setFatal(null);
    dispatch({ t: "clearBanners" });
    await startSession(client, null, l.gen);
    void refreshSessions();
  }, [startSession, refreshSessions]);

  const loadSession = useCallback(
    async (id: string) => {
      const l = live.current;
      const client = l.client;
      if (!client || !l.initialized || state.busy || id === l.sessionId) return;
      setFatal(null);
      dispatch({ t: "clearBanners" });
      await startSession(client, id, l.gen);
    },
    [startSession, state.busy],
  );

  const setMode = useCallback(async (modeId: string) => {
    const l = live.current;
    if (!l.client || !l.sessionId) return;
    try {
      await l.client.request("session/set_mode", { sessionId: l.sessionId, modeId });
      dispatch({ t: "update", update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
    } catch (e) {
      dispatch({ t: "notice", level: "error", text: `Could not change mode: ${errMessage(e)}` });
    }
  }, []);

  const setModel = useCallback(async (configId: string, value: string) => {
    const l = live.current;
    if (!l.client || !l.sessionId) return;
    try {
      const r = await l.client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
        sessionId: l.sessionId,
        configId,
        value,
      });
      if (r?.configOptions) dispatch({ t: "config", configOptions: r.configOptions });
    } catch (e) {
      dispatch({ t: "notice", level: "error", text: `Could not change model: ${errMessage(e)}` });
    }
  }, []);

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
  };
}
