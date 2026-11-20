// Browser dev mode only: talks to dev/bridge.ts over a local WebSocket.
// Imported behind `import.meta.env.DEV`, so it is absent from production builds.

import type { Backend } from "./backend";

const BRIDGE_URL = "ws://127.0.0.1:1421";

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
type EventFrame = { event: string; payload: unknown };

export function createDevBridge(): Backend {
  let socket: WebSocket | null = null;
  let opening: Promise<WebSocket> | null = null;
  let connecting: WebSocket | null = null;
  let nextId = 1;
  const pending = new Map<number, { socket: WebSocket; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const open = (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_URL);
      connecting = ws;
      ws.onopen = () => {
        connecting = null;
        socket = ws;
        opening = null;
        resolve(ws);
      };
      ws.onerror = () => {
        if (connecting === ws) { connecting = null; opening = null; }
        reject(new Error(`unavailable: The dev bridge is not running on ${BRIDGE_URL}. Start it with \`bun run dev:browser\`.`));
      };
      ws.onclose = () => {
        for (const [id, p] of pending) {
          if (p.socket === ws) {
            pending.delete(id);
            p.reject(new Error("unavailable: The dev bridge connection closed."));
          }
        }
        if (socket !== ws) {
          if (connecting === ws) { connecting = null; opening = null; }
          // A close before onopen must settle the outstanding connection promise as well.
          reject(new Error("unavailable: The dev bridge connection closed before opening."));
          return;
        }
        socket = null;
        // The keryx process lived on that connection: report it as exited.
        for (const h of listeners.get("acp://exit") ?? []) h({ code: null, stderrTail: "dev bridge disconnected" });
      };
      ws.onmessage = (ev) => {
        let frame: Reply | EventFrame;
        try {
          frame = JSON.parse(String(ev.data)) as Reply | EventFrame;
        } catch {
          return;
        }
        if ("event" in frame) {
          for (const h of listeners.get(frame.event) ?? []) h(frame.payload);
          return;
        }
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new Error(frame.error));
      };
    });
    return opening;
  };

  return {
    kind: "browser-dev",
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const ws = await open();
      const id = nextId++;
      const frame = JSON.stringify({ id, cmd: command, args: args ?? {} });
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { socket: ws, resolve: resolve as (v: unknown) => void, reject });
        try {
          if (ws.readyState !== WebSocket.OPEN) throw new Error();
          ws.send(frame);
        } catch {
          pending.delete(id);
          reject(new Error("unavailable: The dev bridge connection closed."));
        }
      });
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      const set = listeners.get(event) ?? new Set();
      const h = handler as (payload: unknown) => void;
      set.add(h);
      listeners.set(event, set);
      await open().catch(() => {});
      return () => {
        set.delete(h);
      };
    },
  };
}
