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
} as const;

/** The extensions a profile speaks, as `initialize._meta.keryx.extensions` and `_keryx/info` list them. */
export function acpProfileExtensions(profile: AcpProfile): string[] {
  return profile === "shell"
    ? [KERYX_ACP_EXTENSION_METHODS.info, KERYX_ACP_EXTENSION_METHODS.askUser]
    : [KERYX_ACP_EXTENSION_METHODS.info];
}

export interface KeryxAcpInfo {
  readonly version: string;
  readonly profile: AcpProfile;
  readonly profiles: readonly AcpProfile[];
  readonly extensions: readonly string[];
}

export function keryxAcpInfo(version: string, profile: AcpProfile): KeryxAcpInfo {
  return { version, profile, profiles: [...ACP_PROFILES], extensions: acpProfileExtensions(profile) };
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
