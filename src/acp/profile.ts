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

/**
 * The oldest Keryx desktop app (`apps/desktop`, `desktop-v*` releases) this
 * keryx works with (decision D-15). Raise it when a `shell`-profile change
 * needs a newer client; an older app then shows its update banner as
 * required. Reported in `initialize._meta.keryx` and by `keryx app status`.
 */
export const MIN_DESKTOP_VERSION = "0.1.0";

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
   * Client → agent request, shell profile: `{ sessionId, cwd?, archived?,
   * pinned?, flow? }` → `{ archivedAt?, pinnedAt?, flow? }`. Archives, pins or
   * links to a flow package a stored session (`<sessionDir>/flags.json`;
   * `flow: null` unlinks); `session/list` reports the flags as `_meta.keryx`.
   */
  sessionFlags: "_keryx/session_flags",
  /**
   * Client → agent request, shell profile: `{ sessionId, cwd? }` → `{ trashedTo }`.
   * Moves a stored session to the system trash. A session this connection
   * holds is released first; one with a running turn or task, or held by
   * another keryx process, is refused.
   */
  sessionTrash: "_keryx/session_trash",
} as const;

/** The extensions a profile speaks, as `initialize._meta.keryx.extensions` and `_keryx/info` list them. */
export function acpProfileExtensions(profile: AcpProfile): string[] {
  return profile === "shell"
    ? [
        KERYX_ACP_EXTENSION_METHODS.info,
        KERYX_ACP_EXTENSION_METHODS.askUser,
        KERYX_ACP_EXTENSION_METHODS.sessionReleased,
        KERYX_ACP_EXTENSION_METHODS.sessionShown,
        KERYX_ACP_EXTENSION_METHODS.sessionFlags,
        KERYX_ACP_EXTENSION_METHODS.sessionTrash,
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
  readonly minDesktopVersion?: string;
}

export interface KeryxAcpInfo extends KeryxAcpProfileMeta {
  readonly version: string;
}

export function keryxAcpProfileMeta(profile: AcpProfile): KeryxAcpProfileMeta {
  return {
    profile,
    profiles: [...ACP_PROFILES],
    extensions: acpProfileExtensions(profile),
    ...(profile === "shell" ? { liveSessions: true as const, minDesktopVersion: MIN_DESKTOP_VERSION } : {}),
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
