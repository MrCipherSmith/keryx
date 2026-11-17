// Typed wrappers over the side panel's host commands (D-13): terminal tabs and browser tabs.

import { invoke, isTauri, listen, type Unlisten } from "./backend";

export interface PtyTab {
  id: number;
  title: string;
  owner: "user" | "agent";
  cwd: string;
  running: boolean;
  exitCode: number | null;
}

export type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

export const ptyOpen = (cwd: string, cols: number, rows: number) => invoke<PtyTab>("pty_open", { cwd, cols, rows });
export const ptyList = () => invoke<PtyTab[]>("pty_list");
export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptyClose = (id: number) => invoke<void>("pty_close", { id });

/** Stream a tab's output (the kept output first) to `onEvent`. */
export async function ptyAttach(id: number, onEvent: (e: PtyEvent) => void): Promise<PtyTab> {
  if (!isTauri()) throw new Error("The terminal needs the Keryx app.");
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<PtyTab>("pty_attach", { id, onEvent: channel });
}

/** A tab the agent opened through the panel MCP server. */
export const onAgentTerminal = (handler: (tab: PtyTab) => void): Promise<Unlisten> => listen<PtyTab>("panel://terminal", handler);

// ---- browser tabs ----------------------------------------------------------

export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserEvent = { kind: "tab"; tab: BrowserTab } | { kind: "closed"; id: number } | { kind: "show"; id: number };

export const browserList = () => invoke<BrowserTab[]>("browser_list");
export const browserOpen = (cwd: string, url: string) => invoke<BrowserTab>("browser_open", { cwd, url });
export const browserNavigate = (id: number, url: string) => invoke<void>("browser_navigate", { id, url });
export const browserGo = (id: number, action: "back" | "forward" | "reload") => invoke<void>("browser_go", { id, action });
export const browserClose = (id: number) => invoke<void>("browser_close", { id });
export const browserSelect = (id: number) => invoke<void>("browser_select", { id });
// Layout calls carry a sequence number: the host runs commands concurrently and drops a call older
// than one it already applied, so a hide issued before a show cannot land after it.
let layoutSeq = 0;
export const browserLayout = (bounds: Bounds | null, visible: boolean) =>
  invoke<void>("browser_layout", { bounds, visible, seq: ++layoutSeq });
export const onBrowserEvent = (handler: (e: BrowserEvent) => void): Promise<Unlisten> => listen<BrowserEvent>("panel://browser", handler);

// ---- the panel's MCP server, for keryx sessions -----------------------------

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

const entries = new Map<string, Promise<McpServerEntry[]>>();

/** `mcpServers` for session/new and session/load: the side panel's tools inside the app, none elsewhere. */
export function panelMcpServers(cwd: string): Promise<McpServerEntry[]> {
  if (!isTauri()) return Promise.resolve([]);
  let p = entries.get(cwd);
  if (!p) {
    p = invoke<McpServerEntry>("panel_mcp_entry", { cwd })
      .then((e) => [e])
      .catch((err: unknown) => {
        entries.delete(cwd);
        console.warn("side panel tools unavailable:", err);
        return [];
      });
    entries.set(cwd, p);
  }
  return p;
}
