// One seam between the web view and whatever hosts it.
//
// Inside Keryx.app the host is the Tauri Rust core (`invoke` / `listen`). In
// `bun run dev:browser` the host is `dev/bridge.ts`, a local WebSocket server
// that implements the same commands. The bridge client is imported only under
// `import.meta.env.DEV`, so production builds never contain it.

export type Unlisten = () => void;

export interface Backend {
  readonly kind: "tauri" | "browser-dev" | "none";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * Events for this window. `scope: "window"` (default) hears events addressed
   * to the current webview window; `"app"` hears events from any target.
   */
  listen<T>(event: string, handler: (payload: T) => void, scope?: "window" | "app"): Promise<Unlisten>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

const unavailable: Backend = {
  kind: "none",
  invoke: (command) =>
    Promise.reject(new Error(`"${command}" needs the Keryx app; open this page inside Keryx.app.`)),
  listen: () => Promise.resolve(() => {}),
};

let pending: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  if (pending) return pending;
  pending = (async (): Promise<Backend> => {
    if (isTauri()) {
      const { tauriBackend } = await import("./tauriBackend");
      return tauriBackend;
    }
    if (import.meta.env.DEV) {
      const { createDevBridge } = await import("./devBridge");
      return createDevBridge();
    }
    return unavailable;
  })();
  return pending;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return (await backend()).invoke<T>(command, args);
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
  scope: "window" | "app" = "window",
): Promise<Unlisten> {
  return (await backend()).listen<T>(event, handler, scope);
}
