// The `runtime` block on `subagent-dispatch`, and its fail-closed validator
// (flow 176, T7). Package: docs/requirements/keryx-external-agent-runtime §6.1.
//
// The JSON Schema in `.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json`
// pins the SHAPE of this block. Three constraints it cannot express are enforced
// here, and all three are fail-closed:
//
//   1. the named agent must resolve in the registry;
//   2. the requested sandbox must be one the AGENT's own CLI supports;
//   3. `read-only` must be consistent with the dispatch's `allowed_actions`.
//
// Plus one release gate: `worktree-write` is schema-valid and REFUSED, because
// its prerequisite is a credible audit boundary for writes rather than more spawn
// machinery (package decisions.md D-04). Implemented for ACP agents (flow 292)
// and for claude-cli and codex-cli among the line-stream agents (flows 370, 371).
//
// Refusal reasons carry a `code` so callers — and tests — can tell the two
// look-alike refusals apart. "This agent cannot do that" and "keryx does not do
// that yet" are different facts about the world, and collapsing them into one
// string is how an operator ends up debugging the wrong thing.
//
// Pure: no registry mutation, no process, no clock.
import { compareVersions, getExternalAgent, supportsSandbox, transportOf } from "./registry";
import type { ExternalAgentEntry, ExternalSandbox } from "./types";

/** The `runtime` block as it appears on a dispatch. Absent means the native runtime. */
export interface RuntimeBlock {
  readonly kind: "keryx" | "external";
  readonly agent?: string;
  readonly sandbox?: ExternalSandbox;
  readonly model?: string | null;
  readonly timeoutMs?: number | null;
  readonly maxCostUnits?: number | null;
}

/**
 * Actions that make `read-only` a contradiction.
 *
 * `run-command` is deliberately ABSENT. An external CLI necessarily runs commands
 * inside its own sandbox — that is what it is for — so rejecting the action would
 * refuse every dispatch. That axis is governed by the CLI's sandbox flag and the
 * disposable worktree, not by this check.
 *
 * `spawn-subagent` is present: an external child that delegates produces a
 * grandchild outside every cap keryx holds.
 */
export const READ_ONLY_FORBIDDEN_ACTIONS: readonly string[] = ["write", "network", "spawn-subagent"];

/** Why a runtime block was refused. Distinct codes for look-alike refusals. */
export type RuntimeRefusalCode =
  | "unknown-agent"
  | "agent-cannot"
  | "not-implemented"
  | "inconsistent-actions"
  | "missing-field";

/** Result of {@link validateRuntimeBlock}. */
export type ValidateRuntimeResult =
  | { readonly ok: true; readonly runtime: "keryx" }
  | {
      readonly ok: true;
      readonly runtime: "external";
      readonly entry: ExternalAgentEntry;
      readonly sandbox: ExternalSandbox;
    }
  | { readonly ok: false; readonly code: RuntimeRefusalCode; readonly reason: string };

/** Sandbox levels this release actually implements for a line-stream (codec) agent. */
export const IMPLEMENTED_SANDBOX_MODES: readonly ExternalSandbox[] = ["read-only"];

/**
 * Sandbox levels implemented for an ACP agent (flow 292).
 *
 * `worktree-write` is implemented HERE and nowhere else, and the difference is
 * the audit boundary D-04 asked for rather than more spawn machinery: an ACP
 * agent's writes that reach keryx arrive as `fs/write_text_file` requests, which
 * keryx itself executes — confined by real path to the disposable worktree,
 * gated as risk `write` — and the worktree's diff leaves the run as a patch
 * artifact that is never applied. The operator's project tree is untouched on
 * every path. What the agent writes through its OWN tools is contained by the
 * same disposable worktree and is not seen at all (D-08).
 */
export const IMPLEMENTED_ACP_SANDBOX_MODES: readonly ExternalSandbox[] = ["read-only", "worktree-write"];

/**
 * The line-stream agents whose `worktree-write` is implemented; the write run captures
 * the worktree diff for review. claude (flow 370) is confined by a verified tool
 * allow-list; codex (flow 371) by its OS sandbox, whose flags were measured live. antigravity
 * stays out: its edit tool writes outside the worktree.
 */
export const CODEC_WRITE_AGENT_IDS: readonly string[] = ["claude-cli", "codex-cli"];

/**
 * The CLI versions whose write confinement was measured, for a write agent whose confinement
 * is the CLI's own sandbox rather than a tool allow-list: `min` inclusive, `before` exclusive.
 * The ceiling matters because codex ignores an unknown `-c` key without a word, so a release
 * that renamed a confinement key would silently run unconfined. An older, newer, pre-release or
 * unreadable version is refused before anything spawns (flow 371).
 */
export const CODEC_WRITE_VERIFIED_VERSIONS: Readonly<Record<string, { readonly min: string; readonly before: string }>> = {
  "codex-cli": { min: "0.159.2", before: "0.160.0" },
};

/** Why a write run must not start on this detected version, or undefined when the version is verified. */
export function codecWriteVersionRefusal(entry: ExternalAgentEntry, version: string | undefined): string | undefined {
  const verified = CODEC_WRITE_VERIFIED_VERSIONS[entry.id];
  if (verified === undefined) return undefined;
  const range = `\`${entry.binary}\` ${verified.min} up to, but not including, ${verified.before}`;
  const prefix = `${entry.label} write mode needs ${range}, the versions whose sandbox confinement was measured; `;
  if (version === undefined) return `${prefix}the installed version could not be read`;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `${prefix}found ${version}, a pre-release`;
  if (compareVersions(version, verified.min) < 0) return `${prefix}found ${version}, which is older`;
  if (compareVersions(version, verified.before) >= 0) {
    return `${prefix}found ${version}, which is newer and not yet verified: update keryx, or use \`--task\` without \`--write\``;
  }
  return undefined;
}

/** Who is asking: `ownsWriteCapture` is true only for the caller that captures and stores the worktree diff (`runExternalWriteChild`). */
export interface ValidateRuntimeOptions {
  readonly ownsWriteCapture?: boolean;
}

/**
 * The sandbox levels keryx implements for this entry's transport. A line-stream agent's
 * `worktree-write` needs a caller that captures the diff; the model-initiated path has none,
 * so its edits would be thrown away with the worktree.
 */
export function implementedSandboxModesFor(entry: ExternalAgentEntry, options: ValidateRuntimeOptions = {}): readonly ExternalSandbox[] {
  if (transportOf(entry) === "acp") return IMPLEMENTED_ACP_SANDBOX_MODES;
  return CODEC_WRITE_AGENT_IDS.includes(entry.id) && options.ownsWriteCapture === true ? IMPLEMENTED_ACP_SANDBOX_MODES : IMPLEMENTED_SANDBOX_MODES;
}

/**
 * Validate a dispatch's `runtime` block against the registry and the dispatch's
 * own `allowed_actions`.
 *
 * An absent block resolves to the native keryx runtime, which is what keeps every
 * dispatch authored before this package valid.
 *
 * Order matters and is fixed: identity (does this agent exist) before capability
 * (can it do this) before release gate (do we do this yet) before consistency
 * (does the dispatch contradict itself). Each step's refusal names the narrowest
 * true reason rather than the first one that happens to match.
 */
export function validateRuntimeBlock(
  runtime: RuntimeBlock | undefined,
  allowedActions: readonly string[],
  options: ValidateRuntimeOptions = {},
): ValidateRuntimeResult {
  if (runtime === undefined || runtime.kind === "keryx") {
    return { ok: true, runtime: "keryx" };
  }

  const agentId = runtime.agent;
  if (agentId === undefined || agentId.length === 0) {
    return {
      ok: false,
      code: "missing-field",
      reason: 'runtime.kind is "external" but runtime.agent is missing',
    };
  }

  const entry = getExternalAgent(agentId);
  if (entry === undefined) {
    return {
      ok: false,
      code: "unknown-agent",
      reason: `unknown external agent "${agentId}"`,
    };
  }

  const sandbox = runtime.sandbox;
  if (sandbox === undefined) {
    return {
      ok: false,
      code: "missing-field",
      reason: 'runtime.kind is "external" but runtime.sandbox is missing',
    };
  }

  if (!supportsSandbox(entry, sandbox)) {
    return {
      ok: false,
      code: "agent-cannot",
      reason: `agent "${entry.id}" does not support sandbox "${sandbox}"`,
    };
  }

  const implemented = implementedSandboxModesFor(entry, options);
  if (!implemented.includes(sandbox)) {
    return {
      ok: false,
      code: "not-implemented",
      reason:
        `sandbox "${sandbox}" is not implemented in this release; only ${implemented.join(", ")} is available` +
        (sandbox === "worktree-write" && transportOf(entry) !== "acp"
          ? `; write mode is available for ${CODEC_WRITE_AGENT_IDS.join(", ")} only` +
            (entry.id === "antigravity-cli" ? ": antigravity-cli's edit tool writes outside the worktree" : "")
          : ""),
    };
  }

  if (sandbox === "read-only") {
    const offending = READ_ONLY_FORBIDDEN_ACTIONS.filter((action) => allowedActions.includes(action));
    if (offending.length > 0) {
      return {
        ok: false,
        code: "inconsistent-actions",
        reason: `sandbox "read-only" contradicts allowed_actions [${offending.join(", ")}]`,
      };
    }
  }

  return { ok: true, runtime: "external", entry, sandbox };
}

/**
 * Narrow a dispatch-shaped object to its `runtime` block without trusting it.
 *
 * Dispatches arrive as parsed JSON, so this reads defensively and returns
 * undefined for anything that is not an object with a known `kind`. A malformed
 * block resolves to "no block", i.e. the native runtime — the schema is what
 * rejects malformed input, and this function must not become a second, divergent
 * parser of the same contract.
 */
export function readRuntimeBlock(dispatch: unknown): RuntimeBlock | undefined {
  if (typeof dispatch !== "object" || dispatch === null) return undefined;
  const raw = (dispatch as { runtime?: unknown }).runtime;
  if (typeof raw !== "object" || raw === null) return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind !== "keryx" && kind !== "external") return undefined;
  return raw as RuntimeBlock;
}
