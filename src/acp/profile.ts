// `keryx acp --profile <editor|shell>` (Keryx Desktop Client M1, specification §3).
//
// `editor` is the narrowed editor agent flow 285–288 built, unchanged. `shell`
// is the profile the desktop client launches: the `keryx shell` roster, its
// permission modes, `ask_user`, plan/usage/title updates.
//
// Pure: importing this reads nothing and spawns nothing.

import { PERMISSION_MODES, type PermissionMode } from "../commands/permission-mode";
import type { AcpSessionMode, AcpSessionModeState } from "./protocol";

export type AcpProfile = "editor" | "shell";

export const ACP_PROFILES: readonly AcpProfile[] = ["editor", "shell"];

export const DEFAULT_ACP_PROFILE: AcpProfile = "editor";

export function isAcpProfile(value: string): value is AcpProfile {
  return (ACP_PROFILES as readonly string[]).includes(value);
}

/** keryx's own extension methods (ACP reserves the leading underscore for them). */
export const KERYX_ACP_EXTENSION_METHODS = {
  /** Agent method, any profile: `{ version, profile, profiles, extensions }`. */
  info: "_keryx/info",
  /** Agent → client request, shell profile, only when the client advertised `_meta.keryx.askUser`. */
  askUser: "_keryx/ask_user",
  /**
   * Agent → client notification, shell profile: `{ sessionId, reason }`. keryx
   * released a session the connection held (the idle cap, `reason:
   * "idle-cap"`); a later return to it needs `session/load`.
   */
  sessionReleased: "_keryx/session_released",
  /**
   * Client → agent notification, shell profile: `{ sessionId }`. The client
   * switched the session it shows to a held one locally; keryx counts it as
   * use for the idle cap. An unknown or not-held id is ignored; no reply.
   */
  sessionShown: "_keryx/session_shown",
  /**
   * Client → agent request, shell profile: `{ sessionId, name, args? }`. Runs one
   * command of the served table (`shell-commands.ts`) and answers `{ text, _meta:
   * { keryx: { effects?, refused? } } }`. Not a turn: no prompt slot, nothing added
   * to the model's history (specification §3.9.1).
   */
  command: "_keryx/command",
  /** Client → agent requests, shell profile (specification §3.9.3): connect a model provider without a terminal. */
  providersList: "_keryx/providers/list",
  providersTest: "_keryx/providers/test",
  providersDisconnect: "_keryx/providers/disconnect",
  providersConnect: "_keryx/providers/connect",
  /** Answered when the device login ends; `providersLoginChallenge` is sent while it runs. */
  providersLogin: "_keryx/providers/login",
  providersLoginCancel: "_keryx/providers/login_cancel",
  /** Agent → client notification, shell profile: `{ loginId, providerId, userCode, verificationUri, verificationUriComplete?, instructions? }`. */
  providersLoginChallenge: "_keryx/providers/login_challenge",
  /** Client → agent requests, shell profile (§3.9.3): the `/search-provider` dialog. */
  searchProvidersList: "_keryx/search_providers/list",
  searchProvidersConnect: "_keryx/search_providers/connect",
  searchProvidersSelect: "_keryx/search_providers/select",
  /** Agent → client notification, shell profile (§3.9.4): `{ sessionId, event }`, `event` the shell's `SpawnSubagentFleetEvent`. */
  subagent: "_keryx/subagent",
  /** Agent → client notification, shell profile (§3.9.5): `{ sessionId, event }` for a task's start, phase and exit (never output). */
  tasksEvent: "_keryx/tasks/event",
  /** Client → agent requests, shell profile (§3.9.5): `{ sessionId }`, `{ sessionId, taskId, since? }`, `{ sessionId, taskId }`. */
  tasksList: "_keryx/tasks/list",
  tasksOutput: "_keryx/tasks/output",
  tasksKill: "_keryx/tasks/kill",
} as const;

/** The extensions a profile speaks, as `initialize._meta.keryx.extensions` and `_keryx/info` list them. */
export function acpProfileExtensions(profile: AcpProfile): string[] {
  return profile === "shell"
    ? [
        KERYX_ACP_EXTENSION_METHODS.info,
        KERYX_ACP_EXTENSION_METHODS.askUser,
        KERYX_ACP_EXTENSION_METHODS.sessionReleased,
        KERYX_ACP_EXTENSION_METHODS.sessionShown,
        KERYX_ACP_EXTENSION_METHODS.command,
        KERYX_ACP_EXTENSION_METHODS.providersList,
        KERYX_ACP_EXTENSION_METHODS.providersTest,
        KERYX_ACP_EXTENSION_METHODS.providersDisconnect,
        KERYX_ACP_EXTENSION_METHODS.providersConnect,
        KERYX_ACP_EXTENSION_METHODS.providersLogin,
        KERYX_ACP_EXTENSION_METHODS.providersLoginCancel,
        KERYX_ACP_EXTENSION_METHODS.providersLoginChallenge,
        KERYX_ACP_EXTENSION_METHODS.searchProvidersList,
        KERYX_ACP_EXTENSION_METHODS.searchProvidersConnect,
        KERYX_ACP_EXTENSION_METHODS.searchProvidersSelect,
        KERYX_ACP_EXTENSION_METHODS.subagent,
        KERYX_ACP_EXTENSION_METHODS.tasksEvent,
        KERYX_ACP_EXTENSION_METHODS.tasksList,
        KERYX_ACP_EXTENSION_METHODS.tasksOutput,
        KERYX_ACP_EXTENSION_METHODS.tasksKill,
      ]
    : [KERYX_ACP_EXTENSION_METHODS.info];
}

/**
 * What `initialize._meta.keryx` and `_keryx/info` report for a profile.
 * `liveSessions` (shell profile only): every session a connection opens stays
 * held and running until the idle cap releases it (`_keryx/session_released`)
 * or the connection ends — switching between them releases nothing.
 */
export interface KeryxAcpProfileMeta {
  readonly profile: AcpProfile;
  readonly profiles: readonly AcpProfile[];
  readonly extensions: readonly string[];
  readonly liveSessions?: true;
}

export interface KeryxAcpInfo extends KeryxAcpProfileMeta {
  readonly version: string;
}

export function keryxAcpProfileMeta(profile: AcpProfile): KeryxAcpProfileMeta {
  return {
    profile,
    profiles: [...ACP_PROFILES],
    extensions: acpProfileExtensions(profile),
    ...(profile === "shell" ? { liveSessions: true as const } : {}),
  };
}

export function keryxAcpInfo(version: string, profile: AcpProfile): KeryxAcpInfo {
  return { version, ...keryxAcpProfileMeta(profile) };
}

/** The shell's three postures, as ACP session modes (`.metaproject/wiki/architecture/permission-modes.md`). */
const MODE_TEXT: Readonly<Record<PermissionMode, { name: string; description: string }>> = {
  ask: { name: "Ask", description: "Ask before every shell command, file write and other gated call" },
  trust: {
    name: "Trust",
    description: "Run gated calls without asking, except destructive, credential-touching and other escalated ones",
  },
  auto: {
    name: "Auto",
    description: "Run every gated call without asking, except credential-touching ones; questions are answered by the model",
  },
};

export const ACP_SESSION_MODES: readonly AcpSessionMode[] = PERMISSION_MODES.map((id) => ({
  id,
  name: MODE_TEXT[id].name,
  description: MODE_TEXT[id].description,
}));

export function acpModeState(current: PermissionMode): AcpSessionModeState {
  return { currentModeId: current, availableModes: ACP_SESSION_MODES };
}
