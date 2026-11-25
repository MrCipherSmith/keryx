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
/** A tab whose process is `argv` itself (`/delegate`'s vendor CLI, D-14), in `cwd`. Rejects when the program cannot start. */
export const ptyOpenRun = (cwd: string, argv: readonly string[], title: string, cols: number, rows: number) =>
  invoke<PtyTab>("pty_open_run", { cwd, argv, title, cols, rows });
/**
 * A tab whose process is the user's login shell running exactly `command` (`<shell> -l -i -c <command>`,
 * the Run button), in `cwd`, with a shell tab's environment; its end arrives through `onPtyExit`.
 * Rejects an empty command and a shell that cannot start.
 */
export const ptyOpenCommand = (cwd: string, command: string, title: string, cols: number, rows: number) =>
  invoke<PtyTab>("pty_open_command", { cwd, command, title, cols, rows });
/** A tab's output tail (`pty_tail`). */
export interface PtyTail {
  /** The last lines as plain text, escape sequences removed, whole lines only. */
  text: string;
  /** The host's buffer (the last 1 MiB of raw output) dropped earlier output, so the text is not all of it. */
  truncated: boolean;
}
/** The last `lines` lines (1–2000) of a tab's output; also after its process exited, until the tab is closed. */
export const ptyTail = (id: number, lines: number) => invoke<PtyTail>("pty_tail", { id, lines });
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

/** A tab opened by `ptyOpenRun` or `ptyOpenCommand` ended; delivered whether or not its view is on screen. */
export const onPtyExit = (handler: (e: { id: number; code: number | null }) => void): Promise<Unlisten> =>
  listen<{ id: number; code: number | null }>("panel://pty-exit", handler);

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

export type BrowserEvent =
  | { kind: "tab"; tab: BrowserTab }
  | { kind: "closed"; id: number }
  | { kind: "show"; id: number }
  /** The project's browser engine changed (Chromium could not start: WebKit from now on). */
  | { kind: "engine"; engine: "webkit" | "chromium" };

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
  invoke<void>("browser_layout", { bounds, visible, seq: ++layoutSeq, scale: typeof window === "undefined" ? 2 : window.devicePixelRatio || 1 });

/** Which engine this project's browser runs on (decided by the host on first use). */
export type BrowserEngine = "webkit" | "chromium";
export const browserEngine = () => invoke<BrowserEngine>("browser_engine");

/**
 * A notice of a new Chromium screencast frame of `tab`, showing `width`×`height` CSS pixels of the
 * page; its JPEG is fetched with `browserFrame`. (The notice is small so the channel always sends it
 * inline: a large channel message goes through a fetch, and one failed fetch held back every later
 * message, freezing the canvas.)
 */
export interface BrowserFrame {
  tab: number;
  seq: number;
  width: number;
  height: number;
}

/** The JPEG of the newest frame of `tab` (empty when there is none). */
export const browserFrame = (tab: number) => invoke<ArrayBuffer>("browser_frame", { tab });

/** Stream notices of the active Chromium tab's frames to `onFrame` (replaces an earlier stream). */
export async function browserFrames(onFrame: (f: BrowserFrame) => void): Promise<void> {
  if (!isTauri()) throw new Error("The browser needs the Keryx app.");
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<BrowserFrame>();
  channel.onmessage = onFrame;
  return invoke<void>("browser_frames", { onFrame: channel });
}

/** The user's input on the Chromium canvas, in the page's CSS pixels. */
export type BrowserInput =
  | { kind: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "middle" | "right" | "none"; buttons?: number; clicks?: number; modifiers?: number }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number; modifiers?: number }
  | { kind: "key"; type: "keyDown" | "keyUp"; key: string; code: string; text?: string; keyCode?: number; modifiers?: number }
  | { kind: "text"; text: string };
export const browserInput = (id: number, event: BrowserInput) => invoke<void>("browser_input", { id, event });

/** A profile of the installed Google Chrome. */
export interface ChromeProfile {
  dir: string;
  name: string;
}
export interface CookieDomain {
  domain: string;
  count: number;
}
export interface CookieImportResult {
  imported: number;
  skipped: number;
  domains: string[];
}
export const cookieProfiles = () => invoke<ChromeProfile[]>("cookie_profiles");
/** The domains in a Chrome profile with cookie counts (nothing is decrypted, no Keychain prompt). */
export const cookieScan = (profile: string) => invoke<CookieDomain[]>("cookie_scan", { profile });
/** Copy the picked domains' cookies into this project's Chromium profile (macOS asks for Keychain access). */
export const cookieImport = (profile: string, domains: string[]) => invoke<CookieImportResult>("cookie_import", { profile, domains });

/** The host asks before the agent acts on a site that is not local. */
export interface ConsentRequest {
  id: number;
  action: string;
  origin: string;
  url: string;
}
export const onConsent = (handler: (r: ConsentRequest) => void): Promise<Unlisten> => listen<ConsentRequest>("panel://consent", handler);
export const onConsentClosed = (handler: (id: number) => void): Promise<Unlisten> => listen<number>("panel://consent-closed", handler);
export const browserConsentAnswer = (id: number, allow: boolean, remember: boolean) =>
  invoke<void>("browser_consent_answer", { id, allow, remember });
/** An element the user picked on a page (`pick.js` in the host). Text, attributes and HTML are the page's. */
export interface PickedElement {
  url: string;
  title: string;
  tag: string;
  selector: string;
  role: string;
  name: string;
  text: string;
  attributes: Record<string, string>;
  html: string;
  styles: Record<string, string>;
  components: Array<{ framework: "react" | "vue" | "svelte"; name?: string; file?: string; line?: number }>;
  rect: Bounds;
  viewport: { width: number; height: number; scale: number };
  /** PNG of the element's visible part, when one could be taken. */
  screenshot?: string;
}

export type PickResult = PickedElement | { cancelled: true };

export const isPicked = (r: PickResult): r is PickedElement => !("cancelled" in r);

/** Let the user pick an element on tab `id`; resolves when they click one or cancel. */
export const browserPick = (id: number) => invoke<PickResult>("browser_pick", { id });
export const browserPickCancel = (id: number) => invoke<void>("browser_pick_cancel", { id });
export const onBrowserEvent =(handler: (e: BrowserEvent) => void): Promise<Unlisten> => listen<BrowserEvent>("panel://browser", handler);

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
