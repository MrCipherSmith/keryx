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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { isProviderIdExternal, loadExternalProvidersConfig } from "../lib/external-providers";
import { ExternalBlockedError, resolveExternalSetting } from "../lib/external-switch";
import { loadShellConfig, saveShellConfig } from "../lib/shell-config";
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

/**
 * One agent's recorded one-time consent (flow 357, AC6) — for a vendor whose
 * terms carry a residual risk beyond the generic `externalAgents.enabled`
 * opt-in (today: `antigravity-cli`, see {@link EXTERNAL_AGENTS_REQUIRING_CONSENT}).
 * Recorded once, at `externalAgents.consent[agentId]`, and never asked again.
 */
export interface ExternalAgentConsentRecord {
  /** ISO-8601 timestamp the operator accepted, for the record. */
  readonly acceptedAt: string;
  /** The keryx version that showed the consent text, so a later re-ask policy has a baseline. */
  readonly keryxVersion: string;
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
  /** One-time per-agent consent (flow 357, AC6), keyed by registry id. Absent means "never asked". */
  readonly consent: Readonly<Record<string, ExternalAgentConsentRecord>>;
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
  consent: {},
};

/**
 * Agents whose vendor terms/default data collection require the one-time
 * consent above, beyond the generic `externalAgents.enabled` opt-in (flow
 * 357, AC6). `antigravity-cli` is here because Google's Antigravity CLI sends
 * prompts and agent actions ("Interactions") to Google by default; neither
 * shipped codec agent needs it — `codex-cli`/`claude-cli` run entirely on the
 * operator's own OpenAI/Anthropic subscription with no comparable notice.
 */
export const EXTERNAL_AGENTS_REQUIRING_CONSENT: ReadonlySet<string> = new Set(["antigravity-cli"]);

/** Whether `agentId` needs {@link ExternalAgentConsentRecord} before it may be dispatched. */
export function agentRequiresConsent(agentId: string): boolean {
  return EXTERNAL_AGENTS_REQUIRING_CONSENT.has(agentId);
}

/** Whether `agentId` already has a recorded consent in `config`. */
export function hasRecordedConsent(config: ExternalAgentsConfig, agentId: string): boolean {
  return config.consent[agentId] !== undefined;
}

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

/** Parse one consent entry defensively. `undefined` for anything not shaped like a record — a malformed entry means "never asked", never a forged "yes". */
function parseConsentEntry(raw: unknown): ExternalAgentConsentRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as { acceptedAt?: unknown; keryxVersion?: unknown };
  if (typeof entry.acceptedAt !== "string" || entry.acceptedAt.length === 0) return undefined;
  if (typeof entry.keryxVersion !== "string" || entry.keryxVersion.length === 0) return undefined;
  return { acceptedAt: entry.acceptedAt, keryxVersion: entry.keryxVersion };
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
    consent?: unknown;
  };

  const agents: Record<string, ExternalAgentConfig> = {};
  if (typeof block.agents === "object" && block.agents !== null && !Array.isArray(block.agents)) {
    for (const [id, value] of Object.entries(block.agents as Record<string, unknown>)) {
      agents[id] = parseAgentEntry(value);
    }
  }

  const consent: Record<string, ExternalAgentConsentRecord> = {};
  if (typeof block.consent === "object" && block.consent !== null && !Array.isArray(block.consent)) {
    for (const [id, value] of Object.entries(block.consent as Record<string, unknown>)) {
      const parsed = parseConsentEntry(value);
      if (parsed !== undefined) consent[id] = parsed;
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
    consent,
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

/**
 * Persist one-time consent for `agentId` (flow 357, AC6) — merge-write over the
 * RAW `externalAgents` block, so every other agent's consent and every other
 * field survive exactly as the operator wrote them. Writing the parsed config
 * back instead would materialise every default (`enabled: false`, the timeout,
 * the prompt ceiling) into the file, freezing today's defaults for good.
 * `keryxVersion`
 * is a caller-supplied parameter rather than read here: this module is
 * `capability/` (core zone), which may not import the CLI's own `VERSION`
 * constant (`cli-registry.ts`, adapter zone — `import-zones.ts`'s "core never
 * imports client or adapter" rule has no exception). Best-effort, like every
 * other shell-config writer: a failed write means the operator is asked again
 * next time, not that the dispatch silently proceeds unrecorded.
 */
export function recordExternalAgentConsent(agentId: string, keryxVersion: string, dir?: string): ExternalAgentsConfig {
  const raw = loadShellConfig(dir).externalAgents;
  const block = isPlainObject(raw) ? raw : {};
  const consent = isPlainObject(block.consent) ? block.consent : {};
  const record: ExternalAgentConsentRecord = { acceptedAt: new Date().toISOString(), keryxVersion };
  saveShellConfig({ externalAgents: { ...block, consent: { ...consent, [agentId]: record } } }, dir);
  return loadExternalAgentsConfig(dir);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fix every capability refusal names (flow 373, AC5/AC6): one command in a
 * terminal, one slash command in the shell. Worded once so the two layers and
 * the `/delegate` refusal cannot drift apart.
 */
export const ENABLE_HINT = "run `keryx agents external enable` (in the shell: `/external-agents on`)";

/** Why {@link checkExternalAgentVendorGates} refused a dispatch. */
export interface VendorGateRefusal {
  readonly code: "external-blocked" | "consent-required";
  readonly reason: string;
}

/**
 * The two gates a subscription-vendor agent carries beyond `enabled` (flow
 * 357, AC6), shared by EVERY path that spawns one — `keryx agents external
 * run` and a model-initiated dispatch through `run-external-factory.ts` alike.
 * A gate held by one entry point only is a gate the other one walks around.
 *
 *   1. `/external off` with the agent on the block-list → `external-blocked`,
 *      worded as the same `ExternalBlockedError` a blocked LLM provider throws.
 *   2. An agent {@link agentRequiresConsent} names, with no recorded consent →
 *      `consent-required`. This function never asks: the interactive command
 *      asks on a TTY before calling it with the recorded result, and every
 *      other caller has no human to ask.
 */
export async function checkExternalAgentVendorGates(args: {
  readonly agentId: string;
  readonly cwd: string;
  readonly config: ExternalAgentsConfig;
  readonly configDir?: string;
}): Promise<VendorGateRefusal | undefined> {
  const { agentId, cwd, config, configDir } = args;
  const setting = await resolveExternalSetting({ cwd, ...(configDir === undefined ? {} : { dir: configDir }) });
  if (setting.value === "off") {
    const providers = loadExternalProvidersConfig(configDir).config;
    if (isProviderIdExternal(agentId, providers)) {
      const reason = providers.providers.find((p) => p.id.toLowerCase() === agentId.toLowerCase())?.reason;
      return { code: "external-blocked", reason: new ExternalBlockedError(`external agent "${agentId}"`, reason).message };
    }
  }
  if (agentRequiresConsent(agentId) && !hasRecordedConsent(config, agentId)) {
    return {
      code: "consent-required",
      reason:
        `refused: consent-required — "${agentId}" needs one-time consent before its first dispatch; run ` +
        `\`keryx agents external run ${agentId} --task "<a small read-only task>"\` in a terminal once to read and accept it.`,
    };
  }
  return undefined;
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
      reason: `the external agent runtime is disabled; ${ENABLE_HINT} to opt in`,
    };
  }

  // Consulted only when there IS a workspace: outside one the user-global switch
  // is the whole story (see the module header).
  const manifest = await manifestCapabilityState(input.cwd, EXTERNAL_AGENTS_CAPABILITY_ID);
  if (manifest === "disabled") {
    return {
      ok: false,
      reason: `this project has not enabled \`${EXTERNAL_AGENTS_CAPABILITY_ID}\`; ${ENABLE_HINT} to opt in`,
    };
  }
  if (manifest === "unlisted") {
    return {
      ok: false,
      reason:
        `this project has not enabled \`${EXTERNAL_AGENTS_CAPABILITY_ID}\` and its manifest does not list it yet; ` +
        `run \`keryx update\` to register it, then ${ENABLE_HINT}`,
    };
  }

  return { ok: true, config };
}

// ---------------------------------------------------------------------------
// One-step opt-in (flow 373): `keryx agents external enable|disable`, `/external-agents on|off`
// ---------------------------------------------------------------------------

/** What happened to the user-global flag. `skipped` = deliberately not touched (a refused manifest made `enable` all-or-nothing). */
export type UserToggleOutcome = "changed" | "unchanged" | "skipped" | "failed";

/** What happened to the project manifest's `gdskills.external-agents` entry. */
export type ProjectToggleOutcome =
  | "changed"
  | "unchanged"
  | "no-manifest"
  | "entry-absent"
  | "invalid-manifest"
  | "write-failed";

/** The structured answer both the CLI and the shell print. */
export interface ExternalAgentsToggleResult {
  /** The value asked for: true for enable, false for disable. */
  readonly target: boolean;
  readonly user: UserToggleOutcome;
  readonly project: ProjectToggleOutcome;
  /** Absolute path of the manifest that was looked at (present even when there was none). */
  readonly manifestPath: string;
}

function manifestPathFor(cwd: string): string {
  return path.join(cwd, ".metaproject", "metaproject.json");
}

/**
 * Change ONLY the `enabled` flag of the first `gdskills.external-agents` entry
 * (the one {@link manifestCapabilityState} reads). Read-modify-write that keeps
 * the file's own formatting: its indent, its trailing newline, its key order
 * and its file mode. A file that does not parse to an object is refused and never
 * written — overwriting a hand-edited manifest to flip a flag is the wrong trade.
 */
async function toggleManifestEntry(cwd: string, target: boolean): Promise<ProjectToggleOutcome> {
  const manifestPath = manifestPathFor(cwd);
  if (!(await pathExists(manifestPath))) return "no-manifest";
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return "invalid-manifest";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid-manifest";
  }
  if (!isPlainObject(parsed)) return "invalid-manifest";

  let entry: Record<string, unknown> | undefined;
  if (isPlainObject(parsed.modules)) {
    for (const moduleEntry of Object.values(parsed.modules)) {
      const capabilities = isPlainObject(moduleEntry) && Array.isArray(moduleEntry.capabilities) ? moduleEntry.capabilities : [];
      for (const capability of capabilities) {
        if (isPlainObject(capability) && capability.id === EXTERNAL_AGENTS_CAPABILITY_ID) {
          entry = capability;
          break;
        }
      }
      if (entry !== undefined) break;
    }
  }
  if (entry === undefined) return "entry-absent";
  if ((entry.enabled === true) === target) return "unchanged";

  entry.enabled = target;
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const next = `${JSON.stringify(parsed, null, indent)}${text.endsWith("\n") ? "\n" : ""}`;
  try {
    let mode: number | undefined;
    try {
      mode = (await stat(manifestPath)).mode & 0o777;
    } catch {
      mode = undefined;
    }
    await writeFileAtomic(manifestPath, next, mode === undefined ? {} : { mode });
  } catch {
    return "write-failed";
  }
  return "changed";
}

/** Set the user-global `externalAgents.enabled`, merging over the RAW block so no other field moves and no default is materialised. */
function toggleUserFlag(target: boolean, dir?: string): UserToggleOutcome {
  const raw = loadShellConfig(dir).externalAgents;
  const block = isPlainObject(raw) ? raw : {};
  if ((block.enabled === true) === target) return "unchanged";
  saveShellConfig({ externalAgents: { ...block, enabled: target } }, dir);
  // `saveShellConfig` is best-effort and never throws: read back rather than trust it.
  return loadExternalAgentsConfig(dir).enabled === target ? "changed" : "failed";
}

/**
 * Opt in: `externalAgents.enabled = true` in the user config and, when `cwd`
 * has a manifest, `enabled: true` on its `gdskills.external-agents` entry.
 * Touches nothing else. A manifest that is not valid JSON makes this
 * all-or-nothing: it is refused and the user config is left alone too, so the
 * operator is never told "on" while the project still says no.
 */
export async function enableExternalAgents(cwd: string, dir?: string): Promise<ExternalAgentsToggleResult> {
  const manifestPath = manifestPathFor(cwd);
  if ((await probeManifest(cwd)) === "invalid-manifest") {
    return { target: true, user: "skipped", project: "invalid-manifest", manifestPath };
  }
  const user = toggleUserFlag(true, dir);
  const project = await toggleManifestEntry(cwd, true);
  return { target: true, user, project, manifestPath };
}

/**
 * Reverse exactly what {@link enableExternalAgents} wrote. A manifest that cannot be
 * read does not stop the user-global switch from going off — turning the
 * capability off must never be harder than turning it on.
 */
export async function disableExternalAgents(cwd: string, dir?: string): Promise<ExternalAgentsToggleResult> {
  const user = toggleUserFlag(false, dir);
  const project = await toggleManifestEntry(cwd, false);
  return { target: false, user, project, manifestPath: manifestPathFor(cwd) };
}

/** `invalid-manifest` when the manifest exists but is not a JSON object; otherwise `undefined`. Writes nothing. */
async function probeManifest(cwd: string): Promise<"invalid-manifest" | undefined> {
  const manifestPath = manifestPathFor(cwd);
  if (!(await pathExists(manifestPath))) return undefined;
  try {
    return isPlainObject(JSON.parse(await readFile(manifestPath, "utf8"))) ? undefined : "invalid-manifest";
  } catch {
    return "invalid-manifest";
  }
}

/** Human output for a toggle: what changed, or that nothing did. Shared by the CLI and the shell. */
export function renderExternalAgentsToggle(result: ExternalAgentsToggleResult): string[] {
  const word = result.target ? "on" : "off";
  const lines: string[] = [];
  switch (result.user) {
    case "changed":
      lines.push(`user config: externalAgents.enabled set to ${result.target}`);
      break;
    case "unchanged":
      lines.push(`user config: externalAgents.enabled already ${result.target}`);
      break;
    case "skipped":
      lines.push("user config: left as it was (the project manifest was refused, see below)");
      break;
    case "failed":
      lines.push("user config: could not be written; externalAgents.enabled is unchanged");
      break;
  }
  switch (result.project) {
    case "changed":
      lines.push(`project manifest: ${EXTERNAL_AGENTS_CAPABILITY_ID} set to enabled: ${result.target}`);
      break;
    case "unchanged":
      lines.push(`project manifest: ${EXTERNAL_AGENTS_CAPABILITY_ID} already enabled: ${result.target}`);
      break;
    case "no-manifest":
      lines.push("no project manifest here; only the user config applies");
      break;
    case "entry-absent":
      lines.push(`project manifest has no ${EXTERNAL_AGENTS_CAPABILITY_ID} entry; run \`keryx update\` to register it`);
      break;
    case "invalid-manifest":
      lines.push(`project manifest (${result.manifestPath}) is not valid JSON; refused and left untouched`);
      break;
    case "write-failed":
      lines.push(`project manifest (${result.manifestPath}) could not be written; left as it was`);
      break;
  }
  const changed = result.user === "changed" || result.project === "changed";
  lines.push(changed ? `external agents: ${word}` : `nothing changed; external agents already ${word} as far as this command can tell`);
  return lines;
}

/** Whether the toggle succeeded as asked: no refusal and no failed write. */
export function externalAgentsToggleOk(result: ExternalAgentsToggleResult): boolean {
  return (
    result.user !== "failed" &&
    result.user !== "skipped" &&
    result.project !== "invalid-manifest" &&
    result.project !== "write-failed"
  );
}

/**
 * Bare `/external-agents`: the user-global flag, the project flag, and the
 * effective answer with its named reason when it is off.
 */
export async function externalAgentsStatusLines(
  cwd: string,
  dir?: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const config = loadExternalAgentsConfig(dir);
  const manifest = await manifestCapabilityState(cwd, EXTERNAL_AGENTS_CAPABILITY_ID);
  const projectWord: Record<ManifestCapabilityState, string> = {
    enabled: "on",
    disabled: "off",
    unlisted: "not listed (run `keryx update`)",
    "no-manifest": "no manifest here (the user config decides)",
  };
  const gate = await resolveExternalAgentsCapability({ cwd, config, ...(dir === undefined ? {} : { configDir: dir }), ...(env === undefined ? {} : { env }) });
  const lines = [
    `external agents: user config ${config.enabled ? "on" : "off"}, project ${projectWord[manifest]}`,
    gate.ok ? "effective: on" : `effective: off — ${gate.reason}`,
  ];
  if (!gate.ok || !config.enabled || manifest === "disabled") {
    lines.push(`to turn on: ${ENABLE_HINT.replace(/^run /, "")}`);
  } else {
    lines.push("to turn off: `keryx agents external disable` (in the shell: `/external-agents off`)");
  }
  return lines;
}
