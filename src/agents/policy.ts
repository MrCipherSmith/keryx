// `policy_profile` resolution (W2 §Design, OQ-W2.1 resolved as a per-target
// lookup table rather than one vocabulary shared across every target — a
// Claude Code `permissionMode` value is not the same vocabulary as a
// keryx-shell policy-engine profile name).
//
// This module resolves NAMES only, never the actual `PolicyProfile` object
// from `src/harness/policy/profiles.ts`: that module lives in the `harness`
// (client) import zone, and `src/agents` is core — a core owner never
// imports a client module (`src/lib/import-policy.ts`, no exception). The
// compiled `policy.profile` string (`"shellChildReadOnlyProfile"` /
// `"shellParentProfile"`) is the SAME name that module's own exported
// functions carry, so whichever caller actually threads the compiled result
// into `spawn_subagent`'s child policy path resolves it by calling that
// function directly — this module only decides WHICH name applies.

/** The two canonical `policy_profile` values a definition may declare. */
export type AgentPolicyProfile = "read-only" | "workspace-write";

export const AGENT_POLICY_PROFILES: readonly AgentPolicyProfile[] = ["read-only", "workspace-write"];

export function isAgentPolicyProfile(value: string): value is AgentPolicyProfile {
  return (AGENT_POLICY_PROFILES as readonly string[]).includes(value);
}

/** `spawn_subagent`'s own `mode` input values (`spawn-subagent-tool.ts`'s `SubagentMode`). */
export type KeryxShellMode = "read_only" | "general";

/** Name of the `src/harness/policy/profiles.ts` function that resolves the actual `PolicyProfile`. */
export type KeryxShellProfileName = "shellChildReadOnlyProfile" | "shellParentProfile";

export interface KeryxShellPolicyResolution {
  readonly mode: KeryxShellMode;
  readonly profileName: KeryxShellProfileName;
}

/**
 * `read-only` → the read-only child tools profile (mode `read_only`);
 * `workspace-write` → the parent-equivalent profile (mode `general`) — the
 * child still goes through `inheritPolicy` on the caller's side, so it can
 * never exceed the parent regardless of which name is threaded through here.
 */
const KERYX_SHELL_POLICY_TABLE: Readonly<Record<AgentPolicyProfile, KeryxShellPolicyResolution>> = {
  "read-only": { mode: "read_only", profileName: "shellChildReadOnlyProfile" },
  "workspace-write": { mode: "general", profileName: "shellParentProfile" },
};

export type AgentPolicyErrorReason = "unknown-policy-profile";

export interface AgentPolicyError {
  readonly reason: AgentPolicyErrorReason;
  readonly message: string;
}

export type KeryxShellPolicyResult =
  | { readonly ok: true; readonly resolution: KeryxShellPolicyResolution }
  | { readonly ok: false; readonly error: AgentPolicyError };

/** Resolve a definition's `policy_profile` into the keryx-shell mode + profile name. Never throws. */
export function resolveKeryxShellPolicy(profile: string): KeryxShellPolicyResult {
  if (!isAgentPolicyProfile(profile)) {
    return {
      ok: false,
      error: {
        reason: "unknown-policy-profile",
        message: `unknown policy_profile "${profile}" for target keryx-shell (expected one of ${AGENT_POLICY_PROFILES.join(", ")})`,
      },
    };
  }
  return { ok: true, resolution: KERYX_SHELL_POLICY_TABLE[profile] };
}
