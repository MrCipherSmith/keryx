// The pure, OpenTUI-free half of `remote-control-surface.ts`: the /remote-control command parsing and
// status text the readline shell and the ACP `shell` profile print. `remote-control-surface.ts` re-exports it.

import { HISTORY_COMMAND } from "../commands/agent-commands";
import { REMOTE_EVENT_LIMIT, type RemoteEvent, type RemoteState, type RemoteStatus, TG_SOURCE } from "../remote/shell-bridge";


export const REMOTE_CONTROL_COMMAND = "/remote-control";
export const REMOTE_CONTROL_SUMMARY = "Mirror this session into a Telegram topic: /remote-control [name|off|status]";
export const hubShareUsage = "Usage: /remote-control hub on|off|status";
export type HubShareAction = "on" | "off" | "status" | "usage";

export function parseHubShareCommand(line: string): HubShareAction | undefined {
  const [command, target, action, ...extra] = line.trim().split(/\s+/);
  // Keep `/remote-control hub` available as a Telegram topic name.
  if (command !== REMOTE_CONTROL_COMMAND || target !== "hub" || action === undefined) return;
  if (extra.length === 0 && (action === "on" || action === "off" || action === "status")) return action;
  return "usage";
}

/** The label a line from Telegram carries in the transcript echo and the queue. */
export const TG_LABEL = TG_SOURCE;
/** The echo marker for a Telegram line (the user's own lines keep `❯`). */
export const TG_ECHO_MARKER = `${TG_LABEL} ❯`;

/** `[tg] text`, for the queue panel and any plain-text listing. */
/** The transcript line for a typed slash command: `❯ /model`, or `tg ❯ /model` when it came from the topic. */
export function commandEchoText(line: string, source?: string): string {
  return source === TG_SOURCE ? `${TG_ECHO_MARKER} ${line}` : `❯ ${line}`;
}

export function labelTelegramLine(text: string): string {
  return `[${TG_LABEL}] ${text}`;
}

export const REMOTE_FOOTER = [
  { key: "o", label: "turn on/off" },
  { key: "h", label: "post history" },
  { key: "←/→", label: "tab" },
  { key: "esc", label: "close" },
] as const;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function isRemoteControlCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === REMOTE_CONTROL_COMMAND;
}

export type RemoteControlRequest =
  | { action: "status" }
  | { action: "off" }
  | { action: "on"; name?: string }
  | { action: "invalid"; message: string };

export const REMOTE_CONTROL_USAGE = `Usage: ${REMOTE_CONTROL_COMMAND} [name|off|status]`;

/**
 * `/remote-control` and `/remote-control status` read; `off` stops; anything
 * else is the topic name to start with (`on` starts with a name serve picks).
 * Starting always needs the explicit word: the bare command never starts it.
 */
export function parseRemoteControlArgs(line: string): RemoteControlRequest {
  const words = line.trim().split(/\s+/).slice(1);
  if (words.length === 0) return { action: "status" };
  if (words.length > 1) return { action: "invalid", message: REMOTE_CONTROL_USAGE };
  const word = words[0] as string;
  const lower = word.toLowerCase();
  if (lower === "status") return { action: "status" };
  if (lower === "off") return { action: "off" };
  if (lower === "on") return { action: "on" };
  return { action: "on", name: word };
}

// ---------------------------------------------------------------------------
// Shared text
// ---------------------------------------------------------------------------

/** `12s`, `3m`, `2h`; the unit that reads shortest. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

const STATE_WORDS: Record<RemoteState, string> = { off: "off", on: "on", offline: "offline" };

/** `History: 10 messages posted at 06:52:11 (restored automatically)`, or how to post it. */
export function formatHistoryStatus(status: RemoteStatus): string {
  const history = status.history;
  if (history === undefined) return `History: not posted yet. Press h here or send ${HISTORY_COMMAND} [N] in the topic.`;
  return `History: ${history.count} message${history.count === 1 ? "" : "s"} posted at ${clock(history.at)} (${history.auto ? "restored automatically" : HISTORY_COMMAND}). Press h here to post again.`;
}

/** One status block: state, topic, heartbeat age and what turns it on or off. `posture` adds the Telegram permission lines (flow 396). */
export function formatRemoteStatusLines(status: RemoteStatus, posture?: readonly string[], confirmations?: readonly string[]): string[] {
  const lines = [`Remote control: ${STATE_WORDS[status.state]}`];
  if (status.state === "off") {
    lines.push("Topic: none");
    lines.push(`Turn it on with ${REMOTE_CONTROL_COMMAND} <name>, or press o here.`);
    return lines;
  }
  lines.push(`Topic: ${status.name ?? "registering"}`);
  lines.push(`Last heartbeat: ${status.heartbeatAgeMs === undefined ? "none yet" : `${formatAge(status.heartbeatAgeMs)} ago`}`);
  lines.push(formatHistoryStatus(status));
  if (status.state === "offline") lines.push("Serve is not reachable. The shell keeps retrying; nothing is lost from Telegram.");
  if (status.unconfirmedApprovals !== undefined && status.unconfirmedApprovals > 0) {
    const n = status.unconfirmedApprovals;
    lines.push(`Approvals not confirmed: ${n}. The topic shows ${n === 1 ? "it" : "them"} as "not confirmed" until serve takes the shell's ack.`);
  }
  // Flow 464 (AC6): the operator cards put to the topic and not answered yet, and who pressed the recent ones.
  if (confirmations !== undefined && confirmations.length > 0) lines.push("", ...confirmations);
  lines.push(`Turn it off with ${REMOTE_CONTROL_COMMAND} off, or press o here. Rename: ${REMOTE_CONTROL_COMMAND} off, then ${REMOTE_CONTROL_COMMAND} <name>.`);
  if (posture !== undefined && posture.length > 0) {
    lines.push("", "Telegram permissions (change with /remote-policy):", ...posture.map((line) => `  ${line}`));
  }
  return lines;
}

export function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** Recent events, newest first; one line each. */
export function formatRemoteEventLines(status: RemoteStatus): string[] {
  if (status.events.length === 0) return ["No remote events yet."];
  return [...status.events].reverse().slice(0, REMOTE_EVENT_LIMIT).map((event: RemoteEvent) => `${clock(event.at)}  ${event.kind.padEnd(8)} ${event.text}`);
}

/**
 * Flow 387: the recent slash commands that came from the topic, newest first. Refused commands and
 * confirmations still waiting for a press are in it, because the router records both as "command"
 * events. A confirmation that was answered or has expired is followed by a later line for the same
 * command; the waiting line stays in the list as the history of what was asked.
 */
export function formatRemoteCommandLines(status: RemoteStatus): string[] {
  const commands = status.events.filter((event) => event.kind === "command");
  if (commands.length === 0) return ["No remote commands yet."];
  return [...commands].reverse().slice(0, REMOTE_EVENT_LIMIT).map((event: RemoteEvent) => `${clock(event.at)}  ${event.text}`);
}

/** The readline shell's `/remote-control`: the status block, then the recent events. */
export function renderRemoteControlText(status: RemoteStatus): string {
  return `${[...formatRemoteStatusLines(status), "", "Recent events:", ...formatRemoteEventLines(status)].join("\n")}\n`;
}

/**
 * The readline shell's whole `/remote-control`. That shell has no session bridge, so remote
 * control is always off there and cannot be started from it: it says so and points at the
 * full-screen shell, where the same command turns it on.
 */
export function readlineRemoteControlText(line: string): string {
  const hub = parseHubShareCommand(line);
  if (hub === "usage") return `${hubShareUsage}\n`;
  if (hub !== undefined) return "Hub sharing starts in the full-screen shell. Run `keryx shell --tui` and enter /remote-control hub on.\n";
  const request = parseRemoteControlArgs(line);
  if (request.action === "invalid") return `${request.message}\n`;
  const off = renderRemoteControlText({ state: "off", events: [] });
  if (request.action === "on") {
    return `Remote control starts only in the full-screen shell: run \`keryx shell\` and use ${REMOTE_CONTROL_COMMAND} <name> there. Here it is off.\n${off}`;
  }
  return off;
}
