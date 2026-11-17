// Typed wrappers over the host commands (Rust core, or dev/bridge.ts in the browser).

import type { Transport } from "../acp/client";
import { backend, invoke, isTauri, listen, type Unlisten } from "./backend";

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

export interface VersionCheck {
  ok: boolean;
  found: string;
  required: string;
}

export const acpStart = (cwd: string, noProfile: boolean) => invoke<StartInfo>("acp_start", { cwd, noProfile });
export const acpStop = () => invoke<void>("acp_stop");
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<Settings>("settings_set", { settings });
export const settingsAddRecent = (project: string) => invoke<Settings>("settings_add_recent", { project });
export const versionCheck = (found: string) => invoke<VersionCheck>("version_check", { found });

export const acpTransport: Transport = {
  send: (message) => invoke<void>("acp_send", { message }),
};

export interface BridgeListeners {
  onMessage(line: string): void;
  onExit(info: ExitInfo): void;
  onError(message: string): void;
}

/** Subscribe this window to its keryx process. Returns an unsubscribe function. */
export async function listenBridge(l: BridgeListeners): Promise<Unlisten> {
  const offs = await Promise.all([
    listen<string>("acp://message", l.onMessage),
    listen<ExitInfo>("acp://exit", l.onExit),
    listen<string>("acp://error", l.onError),
  ]);
  return () => offs.forEach((off) => off());
}

// ---- window / host helpers ------------------------------------------------

export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) {
    document.title = title;
    return;
  }
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().setTitle(title);
  } catch {
    /* not critical */
  }
}

/** The folder this window should open, if it was created for one. */
export async function windowInitialCwd(): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("window_initial_cwd");
  return new URLSearchParams(window.location.search).get("cwd");
}

/** Open a project in a new window (one keryx process per window). */
export async function windowOpenProject(cwd: string): Promise<void> {
  if (isTauri()) return invoke<void>("window_open_project", { cwd });
  window.open(`${window.location.pathname}?cwd=${encodeURIComponent(cwd)}`, "_blank");
}

/** Open an http(s) URL in the system browser (the Tauri opener plugin; a new tab in browser dev mode). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https links can be opened.");
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

type FolderPrompter =(title: string) => Promise<string | null>;
let folderPrompter: FolderPrompter | null = null;

/** Browser dev mode has no native folder picker; the app registers an in-app one. */
export function setFolderPrompter(p: FolderPrompter | null): void {
  folderPrompter = p;
}

export async function pickFolder(title = "Open a project folder"): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  }
  return folderPrompter ? folderPrompter(title) : window.prompt(title);
}

export async function pickFile(title: string): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: false, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  }
  return folderPrompter ? folderPrompter(title) : window.prompt(title);
}

export async function hostKind(): Promise<"tauri" | "browser-dev" | "none"> {
  return (await backend()).kind;
}

// ---- flows (docs/requirements/keryx-desktop-client/flows-board.md §6) -----

export interface FlowCard {
  id: string;
  /** Whether `id` is 1-9 digits and may appear in a command; false keeps the card visible only. */
  idValid: boolean;
  /** Package directory name under .metaproject/flows: the unique key and the action address. */
  dir: string;
  /** `dir` when it is safe to paste into a shell command (`\d{3}-` then only `[A-Za-z0-9._+-]`), else null. */
  commandRef: string | null;
  title: string;
  status: string;
  previousStatus: string | null;
  blocked: boolean;
  owner: string | null;
  prUrl: string | null;
  baseBranch: string | null;
  tasksDone: number;
  tasksTotal: number;
  acTotal: number;
  acConfirmed: number;
  updatedAt: string | null;
  completionExceptions: boolean;
  error: string | null;
}

export interface FlowCriterion {
  id: string;
  text: string;
  verify: string | null;
  kind: string | null;
  confirmed: { at: string; note: string | null } | null;
}

export interface FlowTaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  dependsOn: string[];
  attempts: number;
  lastAttempt: { at: string; outcome: string; detail: string | null } | null;
  disposition: string | null;
  dispositionReason: string | null;
}

export interface FlowJournalEntry {
  at: string;
  event: string;
  detail: string | null;
}

export interface FlowDetail {
  card: FlowCard;
  criteria: FlowCriterion[];
  tasks: FlowTaskRow[];
  /** Newest first. */
  journal: FlowJournalEntry[];
  docs: { description: string | null; plan: string | null; context: string | null };
  signatures: unknown[];
  completionAttempts: unknown[];
}

export type TaskKind = "context" | "implement" | "test" | "verify" | "review" | "docs";
export type AttemptOutcome = "started" | "failed" | "blocked";

export type FlowAction =
  | { type: "start" }
  | { type: "block"; reason: string }
  | { type: "unblock" }
  | { type: "taskAdd"; title: string; kind: TaskKind }
  | { type: "taskAttempt"; taskId: string; outcome: AttemptOutcome; detail: string }
  | { type: "taskDone"; taskId: string }
  | { type: "freeze" }
  | { type: "next" };

export interface ActionResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const flowsList = (cwd: string) => invoke<FlowCard[]>("flows_list", { cwd });
export const flowsGet = (cwd: string, dir: string) => invoke<FlowDetail>("flows_get", { cwd, dir });
export const flowsAction = (cwd: string, dir: string, action: FlowAction) =>
  invoke<ActionResult>("flows_action", { cwd, dir, action });
export const flowsWatch = (cwd: string) => invoke<void>("flows_watch", { cwd });
export const onFlowsChanged = (handler: (p: { cwd: string }) => void) =>
  listen<{ cwd: string }>("flows://changed", handler, "app");

/** The project's git checkout as the session panel shows it (`git status --porcelain=v2 --branch`). */
export interface GitInfo {
  branch: string | null;
  commit: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
}

/** `null` outside a git checkout, or when git is missing or slow. */
export const gitInfo = (cwd: string) => invoke<GitInfo | null>("git_info", { cwd });
