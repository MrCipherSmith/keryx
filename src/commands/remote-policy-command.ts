// Flow 396: `/remote-policy`, the saved defaults for a turn that came from Telegram, and the one
// description of them every surface prints (the slash command, the sidebar, the /settings group,
// `keryx serve status`).
//
// What it changes: the saved config (`permissionMode`, `runTimeoutMs`, `approvalTimeoutMs` in the
// remote config file) and, in a running full-screen shell, that shell's copy of them. What it never
// changes: the shell's own permission mode and the "changed this session" flag. `/mode` owns those;
// once `/mode` has been used, the shell's mode wins for every turn and the saved default is moot.

import { loadRemoteConfig, updateRemotePolicy, type RemotePermissionMode, type RemotePolicyPatch } from "../remote/config";
import { loadPermissionsView } from "./permissions-command";

export const REMOTE_POLICY_COMMAND = "/remote-policy";
export const REMOTE_POLICY_USAGE = `Usage: ${REMOTE_POLICY_COMMAND} [mode ask|trust] [limit none|<minutes>] [wait <minutes>]`;

/** `none` for no limit, else `30m`, `1h`, `45s`: the unit that reads shortest. */
export function formatPolicyDuration(ms: number): string {
  if (ms <= 0) return "none";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (rest !== 0) return `${minutes}m ${rest}s`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** What the surfaces show about Telegram permissions. Built once, formatted by the helpers below. */
export interface PolicyPosture {
  /** Saved default (and the running shell's copy): the mode a Telegram turn starts with. */
  defaultMode: RemotePermissionMode;
  /** `trust (Telegram default)`: the mode in force with its source, when a shell is running. */
  inForce?: string;
  /** 0 is no limit. */
  runTimeoutMs: number;
  approvalTimeoutMs: number;
  /** Saved shell rules that run without asking. */
  savedRules: number;
}

export function countSavedRules(dir?: string): number {
  try {
    return loadPermissionsView(dir !== undefined ? { dir } : {}).rows.filter((row) => row.kind === "active").length;
  } catch {
    return 0;
  }
}

export function postureLines(posture: PolicyPosture): string[] {
  const lines = [
    `Mode: ${posture.defaultMode} - a Telegram turn starts with it until /mode changes the shell's mode`,
    `Run limit: ${formatPolicyDuration(posture.runTimeoutMs)}${posture.runTimeoutMs === 0 ? " (/stop ends a run)" : ""}`,
    `Approval wait: ${formatPolicyDuration(posture.approvalTimeoutMs)}`,
    `Saved shell rules: ${posture.savedRules} (${"/permissions"} lists and removes them)`,
  ];
  if (posture.inForce !== undefined) lines.unshift(`In force now: ${posture.inForce}`);
  return lines;
}

/** The sidebar lines: `trust · no limit · wait 15m`, then `3 saved shell rules` when there are any. */
export function postureSidebarText(posture: PolicyPosture): string {
  const limit = posture.runTimeoutMs > 0 ? `limit ${formatPolicyDuration(posture.runTimeoutMs)}` : "no limit";
  const first = `${posture.defaultMode} · ${limit} · wait ${formatPolicyDuration(posture.approvalTimeoutMs)}`;
  return posture.savedRules > 0 ? `${first}\n${posture.savedRules} saved shell rule${posture.savedRules === 1 ? "" : "s"}` : first;
}

export type RemotePolicyRequest =
  | { action: "show" }
  | { action: "set"; patch: RemotePolicyPatch }
  | { action: "invalid"; message: string };

const MAX_LIMIT_MINUTES = 7 * 24 * 60;
const MAX_WAIT_MINUTES = 60;

function wholeMinutes(word: string | undefined): number | undefined {
  if (word === undefined || !/^\d{1,6}$/.test(word)) return undefined;
  return Number(word);
}

/** The text after `/remote-policy`. */
export function parseRemotePolicyArgs(rest: string): RemotePolicyRequest {
  const words = rest.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return { action: "show" };
  const patch: RemotePolicyPatch = {};
  let index = 0;
  while (index < words.length) {
    const key = (words[index] ?? "").toLowerCase();
    const value = words[index + 1];
    if (value === undefined) return { action: "invalid", message: REMOTE_POLICY_USAGE };
    const lower = value.toLowerCase();
    if (key === "mode") {
      if (patch.permissionMode !== undefined) return { action: "invalid", message: REMOTE_POLICY_USAGE };
      if (lower === "auto") {
        return { action: "invalid", message: "auto is not available as a Telegram default: it skips every confirmation. Use /mode auto in the shell if you mean it." };
      }
      if (lower !== "ask" && lower !== "trust") return { action: "invalid", message: `Unknown mode '${value}'. Choose ask or trust.` };
      patch.permissionMode = lower;
    } else if (key === "limit") {
      if (patch.runTimeoutMs !== undefined) return { action: "invalid", message: REMOTE_POLICY_USAGE };
      if (lower === "none" || lower === "off" || lower === "0") {
        patch.runTimeoutMs = 0;
      } else {
        const minutes = wholeMinutes(value);
        if (minutes === undefined || minutes < 1 || minutes > MAX_LIMIT_MINUTES) {
          return { action: "invalid", message: `limit must be none or a whole number of minutes from 1 to ${MAX_LIMIT_MINUTES}.` };
        }
        patch.runTimeoutMs = minutes * 60_000;
      }
    } else if (key === "wait") {
      if (patch.approvalTimeoutMs !== undefined) return { action: "invalid", message: REMOTE_POLICY_USAGE };
      const minutes = wholeMinutes(value);
      if (minutes === undefined || minutes < 1 || minutes > MAX_WAIT_MINUTES) {
        return { action: "invalid", message: `wait must be a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}.` };
      }
      patch.approvalTimeoutMs = minutes * 60_000;
    } else {
      return { action: "invalid", message: REMOTE_POLICY_USAGE };
    }
    index += 2;
  }
  return { action: "set", patch };
}

export interface RemotePolicyDeps {
  /** User-global directory override (test seam). */
  dir?: string;
  /** The running shell takes the new values now; absent in the readline shell, which has no bridge. */
  applyPolicy?: (patch: RemotePolicyPatch) => void;
  /** The mode in force with its source, when a shell session is running. */
  inForce?: () => string | undefined;
  /** What the running shell holds now, when it has a bridge; the file is read when absent. */
  running?: () => Pick<PolicyPosture, "defaultMode" | "runTimeoutMs" | "approvalTimeoutMs"> | undefined;
}

/** The posture from the running shell when there is one, else from the saved file. `undefined` when Telegram is not set up. */
export function loadPosture(deps: RemotePolicyDeps = {}): PolicyPosture | undefined {
  const base = deps.running?.() ?? (() => {
    const loaded = loadRemoteConfig(deps.dir);
    return loaded.ok
      ? { defaultMode: loaded.value.permissionMode, runTimeoutMs: loaded.value.runTimeoutMs, approvalTimeoutMs: loaded.value.approvalTimeoutMs }
      : undefined;
  })();
  if (base === undefined) return undefined;
  const inForce = deps.inForce?.();
  return { ...base, ...(inForce !== undefined ? { inForce } : {}), savedRules: countSavedRules(deps.dir) };
}

const SHELL_MODE_NOTE =
  "A /mode in the shell (or typed in the topic) changes the shell's mode and wins for every turn after that; /remote-policy never changes it.";

/** The whole text of `/remote-policy`, for the readline shell and the TUI transcript. Never contains a secret. */
export function remotePolicyText(rest: string, deps: RemotePolicyDeps = {}): string {
  const request = parseRemotePolicyArgs(rest);
  if (request.action === "invalid") return `${request.message}\n`;
  if (request.action === "set") {
    const saved = updateRemotePolicy(request.patch, deps.dir);
    if (!saved.ok) return `Not changed: ${saved.reason}\n`;
    deps.applyPolicy?.(request.patch);
    const posture = loadPosture(deps);
    const lines = [
      "Saved. Telegram defaults:",
      ...(posture !== undefined ? postureLines(posture) : []),
      deps.applyPolicy !== undefined
        ? "This shell uses them from the next Telegram turn; a shell that registers later gets them when keryx serve restarts."
        : "Open shells keep their values until they are restarted; keryx serve delivers these to a shell that registers after it restarts.",
      SHELL_MODE_NOTE,
    ];
    return `${lines.join("\n")}\n`;
  }
  const posture = loadPosture(deps);
  if (posture === undefined) {
    return `Telegram is not connected, so there is nothing to change yet. Connect it with /channels.\n${REMOTE_POLICY_USAGE}\n`;
  }
  return `${["Telegram permissions:", ...postureLines(posture), SHELL_MODE_NOTE, REMOTE_POLICY_USAGE].join("\n")}\n`;
}

export function isRemotePolicyCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === REMOTE_POLICY_COMMAND;
}
