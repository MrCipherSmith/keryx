// Thin typed wrappers over the Tauri commands and events of the Rust core.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Transport } from "./client";

export type KeryxSource = "bundled" | "path" | "custom";

export interface Settings {
  keryxSource: KeryxSource;
  customPath: string | null;
  recentProjects: string[];
}

export interface StartInfo {
  keryxPath: string;
  source: KeryxSource;
  note: string | null;
  logPath: string;
  minKeryxVersion: string;
}

export interface ExitInfo {
  code: number | null;
  stderrTail: string;
}

export const acpStart = (cwd: string, noProfile: boolean) =>
  invoke<StartInfo>("acp_start", { cwd, noProfile });
export const acpStop = () => invoke<void>("acp_stop");
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<Settings>("settings_set", { settings });
export const settingsAddRecent = (project: string) =>
  invoke<Settings>("settings_add_recent", { project });
export const versionCheck = (found: string) =>
  invoke<{ ok: boolean; found: string; required: string }>("version_check", { found });
export const windowOpenProject = (cwd: string) => invoke<void>("window_open_project", { cwd });
export const windowInitialCwd = () => invoke<string | null>("window_initial_cwd");

export const tauriTransport: Transport = {
  send: (message) => invoke<void>("acp_send", { message }),
};

export interface BridgeListeners {
  onMessage(line: string): void;
  onExit(info: ExitInfo): void;
  onError(message: string): void;
}

/** Subscribe this window to its keryx process. Returns an unsubscribe function. */
export async function listenBridge(l: BridgeListeners): Promise<() => void> {
  const win = getCurrentWebviewWindow();
  const offs = await Promise.all([
    win.listen<string>("acp://message", (e) => l.onMessage(e.payload)),
    win.listen<ExitInfo>("acp://exit", (e) => l.onExit(e.payload)),
    win.listen<string>("acp://error", (e) => l.onError(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export async function setWindowTitle(title: string): Promise<void> {
  try {
    await getCurrentWebviewWindow().setTitle(title);
  } catch {
    /* not critical */
  }
}
