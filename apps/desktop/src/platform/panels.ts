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
