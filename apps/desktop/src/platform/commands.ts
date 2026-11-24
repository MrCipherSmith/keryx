// Typed wrappers over the host commands (Rust core, or dev/bridge.ts in the browser).

import type { Transport } from "../acp/client";
import { backend, invoke, isTauri, listen, type Unlisten } from "./backend";

export type KeryxSource = "auto" | "bundled" | "path" | "custom";

/** The browser panel's engine: `auto` is Chromium when a Chrome is installed, else WebKit. */
export type BrowserEngineSetting = "auto" | "chromium" | "webkit";

export interface Settings {
  keryxSource: KeryxSource;
  customPath: string | null;
  recentProjects: string[];
  browserEngine?: BrowserEngineSetting;
}

export interface StartInfo {
  keryxPath: string;
  source: KeryxSource;
  note: string | null;
  logPath: string;
  minKeryxVersion: string;
  /** Automatic ran the keryx on PATH and a bundled one exists: the app may start again on it. */
  canFallBack: boolean;
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

export const acpStart = (cwd: string, noProfile: boolean, preferBundled = false, sshHost?: string) =>
  invoke<StartInfo>("acp_start", { cwd, noProfile, preferBundled, ...(sshHost === undefined ? {} : { sshHost }) });
export const acpStop = () => invoke<void>("acp_stop");
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<Settings>("settings_set", { settings });
export const settingsAddRecent = (project: string) => invoke<Settings>("settings_add_recent", { project });
export interface TelegramServeStatus {
  state: "not_configured" | "needs_setup" | "stopped" | "starting" | "stopping" | "running" | "blocked" | "failed";
  ownership?: "desktop" | "external";
  reason?: string;
  activeSessions?: number;
}
export const telegramServeStatus = () => invoke<TelegramServeStatus>("telegram_serve_status");
export const telegramServeStart = (completeSetup = false) => invoke<TelegramServeStatus>("telegram_serve_start", { completeSetup });
export const telegramServeStop = () => invoke<TelegramServeStatus>("telegram_serve_stop");
export const telegramServeRestart = () => invoke<TelegramServeStatus>("telegram_serve_restart");
export const versionCheck = (found: string) => invoke<VersionCheck>("version_check", { found });

/** The update banner's input (decision D-15); `null` when there is nothing to check. */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  releaseUrl: string | null;
  available: boolean;
  required: boolean;
  keryxVersion: string;
  minDesktopVersion: string;
}

export const appUpdateCheck = () => invoke<UpdateCheck | null>("app_update_check");
/** Starts `keryx app update --wait-pid <app> --relaunch` and quits the app. */
export const appUpdateRun = () => invoke<void>("app_update_run");

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

/**
 * The title this project view wants for its window. Several views share one window, so the host
 * applies it only while this view is in front, and again whenever it comes back to the front.
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) {
    document.title = title;
    return;
  }
  try {
    await invoke<void>("project_title", { title });
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
/** A local image the agent linked to, as a data: URL (the host reads image files inside the project only). */
export const localImage = (path: string) => invoke<string>("local_image", { path });
export const saveChatImage = (mimeType: string, data: string) => invoke<string>("save_chat_image", { mimeType, data });
export const saveChatFile = (extension: string, data: string) => invoke<string>("save_chat_file", { extension, data });
export const discardChatAttachment = (path: string) => invoke<void>("discard_chat_attachment", { path });
export const commitChatAttachments = (paths: string[]) => invoke<void>("commit_chat_attachments", { paths });

export async function openExternal(url: string, browser?: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https links can be opened.");
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url, browser);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openPullRequest(url: string): Promise<void> {
  try {
    await openExternal(url, "Google Chrome");
  } catch {
    await openExternal(url);
  }
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
  hasIssue?: boolean;
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
  /** The folder's name when it is a linked git worktree, `null` in the main checkout. */
  worktree: string | null;
}

/** `null` outside a git checkout, or when git is missing or slow. */
export const gitInfo = (cwd: string) => invoke<GitInfo | null>("git_info", { cwd });

/** The project's file paths (relative, `/`-separated); with a query, up to 200 ranked matches. */
export interface ProjectFiles {
  files: string[];
  truncated: boolean;
}

/** One project file as the Files tab shows it: `text` is null for a binary file. */
export interface ProjectFileContent {
  path: string;
  text: string | null;
  binary: boolean;
  size: number;
}

export const projectFiles = (cwd: string, query?: string) => invoke<ProjectFiles>("project_files", { cwd, query });
export const projectFileRead = (cwd: string, path: string) => invoke<ProjectFileContent>("project_file_read", { cwd, path });
/** One changed file of the checkout: `R` carries the old path, `?` is untracked. */
export interface ChangedFile {
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  origPath?: string;
  staged: boolean;
}

export interface FileDiff {
  path: string;
  status: ChangedFile["status"];
  binary: boolean;
  tooLarge: boolean;
  /** Unified diff text; absent for a binary or too large file. */
  text?: string;
}

/** The files that differ from HEAD. `truncated` when the host stopped at its cap. */
export const gitChanges = (cwd: string) => invoke<{ files: ChangedFile[]; truncated: boolean }>("git_changes", { cwd });

/** The diff of one file the last `gitChanges` returned (the host refuses any other path). */
export const gitFileDiff = (cwd: string, path: string) => invoke<FileDiff>("git_file_diff", { cwd, path });

/** The current checkout's GitHub origin, as owner/repo; null when unknown. */
export const gitRepository = (cwd: string) => invoke<string | null>("git_repository", { cwd });

/** The open GitHub PR of the project's branch, summarized from the `gh` CLI. */
export interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or empty. */
  reviewDecision: string;
  ci: "passed" | "failed" | "pending" | "none";
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  unresolvedThreads: number;
}

/** `null` when there is no open PR, or `gh` is missing, signed out, offline or slow. */
export const prInfo = (cwd: string) => invoke<PrInfo | null>("pr_info", { cwd });
