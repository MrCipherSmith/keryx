// The external agent runtime's opt-in gate (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §3; security-policy §5;
// prd R13, R14, R25.
//
// This module answers exactly one question — "may this machine, right now, hand
// work to a vendor coding CLI?" — and it answers it with a NAMED reason on every
// refusal. That is not politeness. A silent no-op leaves the operator believing
// an external agent ran and reading its absence as a quiet success
// (security-policy §5), which is the one failure mode this whole subsystem
// cannot tolerate: the parent owns completion, so a dispatch that never happened
// must be visibly a dispatch that never happened.
//
// Three layers compose here, and the ORDER is the design:
//
//   1. The hard disable (remote transport, CI). Checked FIRST, because §5 says
//      "regardless of configuration": a configuration read that could flip the
//      answer must not run before the answer is already fixed.
//   2. The operator's user-global opt-in (`externalAgents.enabled`, default
//      false). This is the switch §3 specifies, and it lives in the user-global
//      shell config rather than a project file because a subscription belongs to
//      a person, not to a checkout.
//   3. The per-project opt-in through `src/capability/`'s manifest contract —
//      `{id: "gdskills.external-agents", enabled: true}`, written by
//      `keryx init --external-agents`.
//
// Layer 3 carries one decision the specification did not make, and it is worth
// stating plainly. `seam.ts`'s `isCapabilityEnabled` reads "missing manifest =
// off", which is right for a ceiling that costs a dependency or an asset.
// Applied literally here it would make a capability whose configuration is
// explicitly USER-GLOBAL silently unavailable in every directory that is not a
// Metaproject workspace — `keryx shell` runs anywhere. So the manifest is
// consulted only when there IS one:
//
//   no manifest        neutral; the user-global switch decides.
//   entry enabled      the project opted in.
//   entry disabled     the project has not opted in.
//   entry absent       the project has not opted in.
//
// The last two are the same answer on purpose. `reconcileCapabilitiesOnUpdate`
// materialises a newly-registered ceiling as `enabled: false` on every `keryx
// update`, so a disabled entry means "nobody has said yes yet" and NOT "someone
// said no" — reading it as a veto would have flipped the switch under every
// workspace that ever ran `update`, which is exactly the kind of silent
// state change this subsystem must not produce.
//
// Nothing here spawns a process, reads a credential store, or touches the
// network. Availability of an individual CLI is a separate, three-state question
// answered by `resolveAvailability` in `src/harness/external/registry.ts`.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { loadShellConfig } from "../lib/shell-config";
import type { CapabilityDescriptor } from "./wiring";

/** Capability id for the external agent runtime, in the seam's `module.name` form. */
export const EXTERNAL_AGENTS_CAPABILITY_ID = "gdskills.external-agents";

/**
 * The registry descriptor.
 *
 * Owned by `gdskills` because that is the module this project already files
 * agent orchestration under; the capability is a delegation surface, not a graph
 * or a wiki feature. `kind: "ceiling"` — ceilings default OFF, which is what
 * makes `--external-agents` an opt-in rather than a way to switch something off.
 *
 * Deliberately declares NO `optionalDependency`, NO `asset` and NO `config`:
 * the runtime has zero npm dependencies, ships no model, and its configuration
 * is user-global (see {@link ExternalAgentsConfig}), not a project file. Adding a
 * `config` here would materialise a second, project-scoped copy of settings that
 * §3 places in one place on purpose.
 */
export const EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR: CapabilityDescriptor = {
  id: EXTERNAL_AGENTS_CAPABILITY_ID,
  flag: "external-agents",
  module: "gdskills",
  kind: "ceiling",
};

// ---------------------------------------------------------------------------
// Configuration (§3)
// ---------------------------------------------------------------------------

/** One agent's slice of the user-global config. */
export interface ExternalAgentConfig {
  /** Whether this agent may be dispatched to at all. */
  readonly enabled: boolean;
  /**
   * `null` means "let the CLI resolve its own default under the active
   * subscription". keryx must never pin a model the operator's account may not
   * be entitled to: a pinned id that the subscription does not cover fails at
   * the vendor, after the run has already been announced to the parent.
   */
  readonly model: string | null;
}

/** The `externalAgents` block of the user-global shell config (§3). */
export interface ExternalAgentsConfig {
  /** Master switch. Nothing spawns while false. */
  readonly enabled: boolean;
  /**
   * Applies to MODEL-initiated spawns. `"ask"` by default because subscription
   * quota is a finite resource the operator paid for and an agent they are not
   * watching can exhaust it (security-policy §6).
   */
  readonly spawnDecision: "ask" | "allow";
  /** Wall-clock ceiling for a run whose dispatch does not name one. */
  readonly defaultTimeoutMs: number;
  /** Single-argv prompt ceiling (§7.3). */
  readonly maxPromptBytes: number;
  /** Per-agent overrides, keyed by registry id. Absent ids fall back to {@link DEFAULT_AGENT_CONFIG}. */
  readonly agents: Readonly<Record<string, ExternalAgentConfig>>;
}

/** What an agent with no explicit config entry gets. */
export const DEFAULT_AGENT_CONFIG: ExternalAgentConfig = { enabled: true, model: null };

/** The shipped defaults. `enabled: false` is the whole point of the block. */
export const EXTERNAL_AGENTS_DEFAULTS: ExternalAgentsConfig = {
  enabled: false,
  spawnDecision: "ask",
  defaultTimeoutMs: 600_000,
  maxPromptBytes: 65_536,
  agents: {},
};

/**
 * Bounds on the two numeric knobs.
 *
 * Not decoration: `defaultTimeoutMs: 0` read literally would kill every run the
 * instant it started and look exactly like the CLI failing to launch, and a
 * `maxPromptBytes` under a kilobyte cannot hold the runtime directive, so every
 * dispatch would be refused by `buildExternalPrompt` for a reason that points at
 * the prompt rather than at the config that caused it. Out-of-range values
 * therefore fall back to the default rather than being clamped silently.
 */
const TIMEOUT_MS_RANGE = { min: 1_000, max: 24 * 60 * 60 * 1_000 };
const PROMPT_BYTES_RANGE = { min: 1_024, max: 4 * 1_024 * 1_024 };

/** A positive integer inside `[min, max]`, else undefined. Rejects NaN/Infinity/floats. */
function boundedInteger(value: unknown, range: { min: number; max: number }): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= range.min && value <= range.max ? value : undefined;
}

/** Parse one agent entry defensively; anything unrecognised falls back to the default. */
function parseAgentEntry(raw: unknown): ExternalAgentConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_AGENT_CONFIG;
  const entry = raw as { enabled?: unknown; model?: unknown };
  // `enabled` defaults TRUE per-agent: the feature-level switch above is what
  // defaults off, and requiring both to be set would make the sample config in
  // §3 (which lists agents as enabled) misleading.
  const enabled = entry.enabled === undefined ? true : entry.enabled === true;
  const model = typeof entry.model === "string" && entry.model.trim().length > 0 ? entry.model.trim() : null;
  return { enabled, model };
}

/**
 * Parse the `externalAgents` block from whatever was on disk.
 *
 * Reads defensively and NEVER resolves to enabled on malformed input: `enabled`
 * is true only for the literal boolean `true`, so a config that was
 * half-written, hand-edited into invalidity, or produced by a different version
 * degrades to the safe default instead of to an enabled capability. Pure.
 */
export function parseExternalAgentsConfig(raw: unknown): ExternalAgentsConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return EXTERNAL_AGENTS_DEFAULTS;
  }
  const block = raw as {
    enabled?: unknown;
    spawnDecision?: unknown;
    defaultTimeoutMs?: unknown;
    maxPromptBytes?: unknown;
    agents?: unknown;
  };

  const agents: Record<string, ExternalAgentConfig> = {};
  if (typeof block.agents === "object" && block.agents !== null && !Array.isArray(block.agents)) {
    for (const [id, value] of Object.entries(block.agents as Record<string, unknown>)) {
      agents[id] = parseAgentEntry(value);
    }
  }

  return {
    enabled: block.enabled === true,
    // Anything that is not the literal "allow" is "ask" — the conservative side.
    spawnDecision: block.spawnDecision === "allow" ? "allow" : "ask",
    defaultTimeoutMs:
      boundedInteger(block.defaultTimeoutMs, TIMEOUT_MS_RANGE) ?? EXTERNAL_AGENTS_DEFAULTS.defaultTimeoutMs,
    maxPromptBytes:
      boundedInteger(block.maxPromptBytes, PROMPT_BYTES_RANGE) ?? EXTERNAL_AGENTS_DEFAULTS.maxPromptBytes,
    agents,
  };
}

/** Read the persisted `externalAgents` block. `dir` overrides the config directory (tests). */
export function loadExternalAgentsConfig(dir?: string): ExternalAgentsConfig {
  return parseExternalAgentsConfig(loadShellConfig(dir).externalAgents);
}

/** This agent's config, or the default for an id the operator never mentioned. */
export function agentConfig(config: ExternalAgentsConfig, agentId: string): ExternalAgentConfig {
  return config.agents[agentId] ?? DEFAULT_AGENT_CONFIG;
}

// ---------------------------------------------------------------------------
// The hard disable (security-policy §5)
// ---------------------------------------------------------------------------

/** How the active keryx session is reached. */
export type ExternalTransport = "local" | "remote";

/**
 * Env var naming the active transport.
 *
 * The repository had NO transport marker when this was written (`keryx serve` is
 * the only non-local door and it distinguishes callers per request, not per
 * process), so one is defined here rather than inferred. It sits in the `KERYX_`
 * namespace, which `buildExternalChildEnv` sweeps wholesale — a nested CLI must
 * never inherit its parent's transport identity, the exact failure
 * security-policy §2.3 records.
 */
export const ENV_KERYX_TRANSPORT = "KERYX_TRANSPORT";

/**
 * Values that mean "an operator is sitting in front of this process".
 *
 * An unrecognised value resolves to `remote`, not `local`. The compliance
 * boundary §5 draws is between a local operator-run capability and one reachable
 * over a chat transport, and a marker this build has never heard of is much more
 * likely to be a transport added later than a typo.
 */
export const LOCAL_TRANSPORT_MARKERS: readonly string[] = ["local", "cli", "shell", "tui"];

/** Resolve the active transport from an environment. Pure. */
export function detectTransport(env: Readonly<Record<string, string | undefined>>): ExternalTransport {
  const raw = env[ENV_KERYX_TRANSPORT];
  if (raw === undefined || raw.trim().length === 0) return "local";
  return LOCAL_TRANSPORT_MARKERS.includes(raw.trim().toLowerCase()) ? "local" : "remote";
}

/**
 * Environment variables that mean "this is a CI runner".
 *
 * The usual conventions, not an exhaustive list — an unlisted provider means the
 * capability is reachable in that runner, which is why the transport check above
 * carries the compliance boundary and this one is defence in depth.
 */
export const CI_ENV_VARS: readonly string[] = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "BUILDKITE",
  "DRONE",
  "APPVEYOR",
  "CODEBUILD_BUILD_ID",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
];

/**
 * Values of `CI`-style variables that mean "not CI".
 *
 * `CI=false` is a real thing local tooling sets, and treating a present-but-false
 * marker as CI would disable the capability on developer machines that happen to
 * export it. Presence alone is therefore not enough for a variable whose value
 * is a boolean word.
 */
const FALSEY_CI_VALUES: readonly string[] = ["false", "0", "no", "off"];

/** The name of the variable that identified this as CI, or undefined. Pure. */
export function detectCi(env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const name of CI_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (FALSEY_CI_VALUES.includes(raw.trim().toLowerCase())) continue;
    return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Project opt-in
// ---------------------------------------------------------------------------

/**
 * How a workspace manifest speaks about a capability.
 *
 * `no-manifest` is a distinct state from `unlisted` because the two mean
 * opposite things: no workspace at all cannot have an opinion, while a workspace
 * that never listed the capability has simply not opted in.
 */
export type ManifestCapabilityState = "enabled" | "disabled" | "unlisted" | "no-manifest";

type ManifestSlice = {
  modules?: Record<string, { capabilities?: unknown } | undefined>;
};

/**
 * Read a capability's state from `metaproject.json`, distinguishing "there is no
 * workspace here" from "this workspace has not opted in".
 *
 * `seam.ts`'s `isCapabilityEnabled` collapses both into `false`, which is
 * correct for a dependency-or-asset ceiling and wrong for a capability whose
 * configuration is user-global (see the module header). This is the narrowest
 * possible additional reader — same manifest shape, same never-throws contract —
 * rather than a change to the seam, whose semantics other capabilities depend on.
 */
export async function manifestCapabilityState(cwd: string, id: string): Promise<ManifestCapabilityState> {
  try {
    const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
    if (!(await pathExists(manifestPath))) return "no-manifest";
    const manifest = await readJsonFileOr<ManifestSlice>(manifestPath, {});
    for (const moduleEntry of Object.values(manifest.modules ?? {})) {
      const capabilities = Array.isArray(moduleEntry?.capabilities) ? moduleEntry.capabilities : [];
      for (const capability of capabilities) {
        if (capability && typeof capability === "object") {
          const entry = capability as { id?: unknown; enabled?: unknown };
          if (entry.id === id) return entry.enabled === true ? "enabled" : "disabled";
        }
      }
    }
    return "unlisted";
  } catch {
    // A manifest we cannot read is a manifest that is not there, not a workspace
    // that opted in. Fail towards refusal, with the same reason `unlisted` gets.
    return "unlisted";
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Inputs to {@link resolveExternalAgentsCapability}. */
export interface ExternalAgentsGateInput {
  /** Project root whose manifest may veto. */
  readonly cwd: string;
  /** Environment the transport and CI markers are read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit transport, when the host knows it without an env marker (`keryx serve`). */
  readonly transport?: ExternalTransport;
  /** Pre-loaded config, so a caller that already read it does not read it twice. */
  readonly config?: ExternalAgentsConfig;
  /** Shell-config directory override (tests). */
  readonly configDir?: string;
}

/** Whether the capability is available, and the reason when it is not. */
export type ExternalAgentsGateResult =
  | { readonly ok: true; readonly config: ExternalAgentsConfig }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the capability.
 *
 * Order is fixed: hard disable, then the operator's switch, then the project
 * opt-in. The hard disable runs first so that §5's "regardless of
 * configuration" is structural rather than a property of how the branches happen
 * to be written.
 *
 * Never throws — every failure resolves to a refusal with a named reason.
 */
export async function resolveExternalAgentsCapability(
  input: ExternalAgentsGateInput,
): Promise<ExternalAgentsGateResult> {
  const env = input.env ?? process.env;

  const transport = input.transport ?? detectTransport(env);
  if (transport === "remote") {
    return {
      ok: false,
      reason:
        "external agents are hard disabled on a remote transport: the operator's subscription " +
        "may not be offered over a channel that reaches other people (security-policy §5)",
    };
  }

  const ci = detectCi(env);
  if (ci !== undefined) {
    return {
      ok: false,
      reason: `external agents are hard disabled under CI (\`${ci}\` is set); a subscription is an operator's, not a runner's`,
    };
  }

  const config = input.config ?? loadExternalAgentsConfig(input.configDir);
  if (!config.enabled) {
    return {
      ok: false,
      reason:
        "the external agent runtime is disabled; set `externalAgents.enabled` to true in the keryx " +
        "user config to opt in",
    };
  }

  // Consulted only when there IS a workspace: outside one the user-global switch
  // is the whole story (see the module header).
  const manifest = await manifestCapabilityState(input.cwd, EXTERNAL_AGENTS_CAPABILITY_ID);
  if (manifest === "disabled" || manifest === "unlisted") {
    return {
      ok: false,
      reason: `this project has not enabled \`${EXTERNAL_AGENTS_CAPABILITY_ID}\`; run \`keryx init --${EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.flag}\` in the project root to opt in`,
    };
  }

  return { ok: true, config };
}
