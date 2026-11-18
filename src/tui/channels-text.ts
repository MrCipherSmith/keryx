// The pure, OpenTUI-free half of `channels-surface.ts`: the /channels command, snapshot and status
// text the readline shell and the ACP `shell` profile print. `channels-surface.ts` re-exports it.

import type { ChannelsClient, ChannelsLocalFiles } from "../remote/channels-client";
import type { ChannelsRendering } from "../remote/protocol";
import type { TextRole } from "./theme";


export const CHANNELS_COMMAND = "/channels";
export const CHANNELS_SUMMARY = "Connect, test or disconnect Telegram for this machine: /channels [status]";
export const CHANNELS_USAGE = `Usage: ${CHANNELS_COMMAND} [status]`;

export function isChannelsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === CHANNELS_COMMAND;
}

export type ChannelsRequest = { action: "open" } | { action: "invalid"; message: string };

/** `/channels` and `/channels status` open the modal; anything else is a usage error. */
export function parseChannelsArgs(line: string): ChannelsRequest {
  const words = line.trim().split(/\s+/).slice(1);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "status")) return { action: "open" };
  return { action: "invalid", message: CHANNELS_USAGE };
}

// ---------------------------------------------------------------------------
// Snapshot: what every surface draws
// ---------------------------------------------------------------------------

export type ChannelsApi = Pick<
  ChannelsClient,
  "localFiles" | "status" | "startPairing" | "pairingStatus" | "cancelPairing" | "connectFinish" | "reload" | "test" | "disconnect"
>;

export type ChannelsSnapshotState = "not-connected" | "pairing" | "connected" | "off" | "serve-down" | "error";

export interface ChannelsSnapshot {
  state: ChannelsSnapshotState;
  /** A token or config file is on this machine, whether or not serve could be reached. */
  configured: boolean;
  machine?: string;
  sessions?: number;
  /** Flow 395: the rendering mode in effect and the last fallback, when serve reported them. */
  rendering?: ChannelsRendering;
  /** Serve's or the client's own plain-language reason. */
  reason?: string;
}

export async function loadChannelsSnapshot(client: Pick<ChannelsApi, "status" | "localFiles">): Promise<ChannelsSnapshot> {
  const status = await client.status();
  const local: ChannelsLocalFiles = client.localFiles();
  if (status.ok) {
    const { machine, telegram } = status.value;
    return {
      state: telegram.state,
      // A token or config left on disk counts even when serve says nothing is connected (a crash between the two writes).
      configured: telegram.state !== "not-connected" || local.tokenFile || local.configFile,
      machine,
      sessions: telegram.sessions,
      ...(telegram.rendering !== undefined ? { rendering: telegram.rendering } : {}),
      ...(telegram.reason !== undefined ? { reason: telegram.reason } : {}),
    };
  }
  const configured = local.tokenFile || local.configFile;
  const down = status.code === "serve-down" || status.code === "unsafe-endpoint";
  return { state: down ? "serve-down" : "error", configured, reason: status.reason };
}

export interface ChannelsRow {
  /** The value shown after the "Telegram" label. */
  readonly text: string;
  readonly role: TextRole;
  readonly action: "open";
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `Telegram: off | pairing | connected | serve down`, as the value half of the row. */
export function projectChannelsRow(snapshot: ChannelsSnapshot | undefined, width: number): ChannelsRow {
  if (snapshot === undefined) return { text: fit("…", width), role: "muted", action: "open" };
  switch (snapshot.state) {
    case "connected":
      return { text: fit("connected", width), role: "ok", action: "open" };
    case "pairing":
      return { text: fit("pairing", width), role: "attention", action: "open" };
    case "off":
      return { text: fit("off", width), role: "attention", action: "open" };
    case "serve-down":
      return snapshot.configured
        ? { text: fit("serve down", width), role: "attention", action: "open" }
        : { text: fit("off", width), role: "muted", action: "open" };
    case "error":
      return { text: fit("error", width), role: "attention", action: "open" };
    default:
      return { text: fit("off", width), role: "muted", action: "open" };
  }
}

/** What each mode does, in the words the operator sees next to it. */
const RENDERING_MEANING: Record<ChannelsRendering["mode"], string> = {
  auto: "rich for a reply with a table, HTML otherwise",
  rich: "every reply as a rich message",
  html: "every reply as Telegram HTML",
  plain: "every reply as plain text",
};

/** `HH:MM:SS` UTC of an epoch, the one clock a fallback line needs. */
function clock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)} UTC`;
}

/** Flow 395: the rendering mode in effect and the last fallback (step, reason, time). */
export function renderingLines(rendering: ChannelsRendering | undefined): string[] {
  if (rendering === undefined) return [];
  const last = rendering.lastFallback;
  const step = last?.step === "rich-to-html" ? "rich to HTML" : "HTML to plain text";
  return [
    `Rendering: ${rendering.mode} (${RENDERING_MEANING[rendering.mode]}). Change it in /settings.`,
    last === undefined
      ? "Last fallback: none since keryx serve started."
      : `Last fallback: ${step} at ${clock(last.at)}: ${last.reason}`,
  ];
}

/** The status block shared by the modal's list view and the readline text. */
export function channelsStatusLines(snapshot: ChannelsSnapshot): string[] {
  const machine = snapshot.machine === undefined ? [] : [`Machine: ${snapshot.machine}`];
  switch (snapshot.state) {
    case "not-connected":
      return [
        "Telegram: not connected",
        ...machine,
        ...(snapshot.configured
          ? ["A bot token is left on this machine from an unfinished connection. Connect starts over; Disconnect erases it."]
          : [
              "This machine has no bot yet. Connect it to drive keryx sessions from Telegram topics.",
              "You need a bot token from @BotFather and a Telegram group with topics turned on.",
            ]),
      ];
    case "pairing":
      return [
        "Telegram: pairing in progress",
        ...machine,
        "Resume shows the one-time code again, or connects a pairing that already finished; Cancel pairing abandons it and erases the token.",
      ];
    case "connected":
      return [
        "Telegram: connected",
        ...machine,
        `Sessions in Telegram: ${snapshot.sessions ?? 0}`,
        ...renderingLines(snapshot.rendering),
        "Test sends one message to the General topic. Disconnect deletes the topics and erases the token.",
        "Sessions join through /remote-control in each shell.",
      ];
    case "off":
      return [
        "Telegram: configured, but not running",
        ...machine,
        ...(snapshot.reason === undefined ? [] : [`Why: ${snapshot.reason}`]),
        ...renderingLines(snapshot.rendering),
        "Retry starts it again from the saved token and config. Disconnect erases them. Test works once Telegram is running.",
      ];
    case "serve-down":
      return [
        "Telegram: keryx serve is not running",
        ...(snapshot.reason === undefined ? [] : [snapshot.reason]),
        snapshot.configured
          ? "A bot is configured on this machine; it works again once `keryx serve` runs. Disconnect still erases the token."
          : "Start `keryx serve`, then connect.",
      ];
    case "error":
      return ["Telegram: status unavailable", ...(snapshot.reason === undefined ? [] : [snapshot.reason])];
  }
}

/**
 * The readline shell's whole `/channels`. That shell has no hidden input, so it cannot take a
 * bot token: it shows the state and points at the full-screen shell, where Connect is.
 */
export function readlineChannelsText(line: string, snapshot: ChannelsSnapshot): string {
  const request = parseChannelsArgs(line);
  if (request.action === "invalid") return `${request.message}\n`;
  const how =
    snapshot.state === "not-connected" || snapshot.state === "serve-down" || snapshot.state === "error"
      ? "Connecting needs a hidden token entry, which this line-based shell cannot give: run `keryx shell` (the full-screen shell) and use /channels there."
      : "Test and Disconnect are in the full-screen shell: run `keryx shell` and use /channels there.";
  return `${[...channelsStatusLines(snapshot), "", how].join("\n")}\n`;
}
