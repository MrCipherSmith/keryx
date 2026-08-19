// External agent registry (flow 176, T6).
//
// Metadata only. Which CLIs exist, how to detect them, what they can do — the
// facts that are genuinely DATA and belong in one reviewable table, by the same
// argument `keryx-provider-auth` D-03 makes for authentication methods. Argv,
// parsing and failure classification live in `./codec/<agent>.ts`, because the
// two CLIs differ structurally rather than parametrically (package D-06).
//
// Nothing here spawns anything or reads a credential. keryx never opens a vendor
// token store — not even to answer "is the operator logged in?" — so availability
// has three states, and the third (`not-probed`) must be reported as itself: a
// green tick meaning "nobody asked" costs the operator a dispatch that cannot run
// (package security-policy §1).
//
// Pure and deterministic throughout: version text is INJECTED by the caller, this
// module only parses and compares it.
import type { ExternalAgentEntry, ExternalSandbox } from "./types";

/**
 * The shipped agents.
 *
 * `sandboxModes` records what each CLI can do, NOT what keryx has implemented.
 * Both support a writable sandbox natively, so both declare it; the read-only
 * release gate is a separate runtime refusal, which keeps "this agent cannot do
 * that" and "keryx does not do that yet" distinguishable (specification §4).
 */
export const EXTERNAL_AGENTS: readonly ExternalAgentEntry[] = [
  {
    id: "codex-cli",
    label: "Codex",
    binary: "codex",
    detect: ["--version"],
    versionPattern: "codex-cli (\\d+\\.\\d+\\.\\d+)",
    knownGoodRange: { min: "0.147.0" },
    sandboxModes: ["read-only", "worktree-write"],
    // No documented mid-run input channel; operator messages go through resume.
    streamingInput: false,
    resumable: true,
    reportsCost: false,
    budgetFlag: false,
    notes:
      "Resume requires NOT passing `--ephemeral`: an ephemeral thread fails resume with " +
      "`no rollout found for thread id … (code -32600)`. `codex exec resume` also takes a " +
      "narrower flag set than `codex exec` — no `-s`, no `-C` — so its sandbox level cannot " +
      "be re-asserted and it must be spawned with cwd already set to the worktree.",
  },
  {
    id: "claude-cli",
    label: "Claude",
    binary: "claude",
    detect: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    knownGoodRange: { min: "2.1.220" },
    sandboxModes: ["read-only", "worktree-write"],
    streamingInput: true,
    resumable: true,
    reportsCost: true,
    budgetFlag: true,
    notes:
      "Accepts a keryx-assigned `--session-id`, a native `--max-budget-usd` ceiling, and " +
      "streaming input. `--tools` is a genuine allow-list over the built-in roster (unlike " +
      "`--allowed-tools`, which is a permission rule and does not restrict it).",
  },
];

/** Look up an entry by dispatch id. Undefined for an unknown agent — callers fail closed. */
export function getExternalAgent(id: string): ExternalAgentEntry | undefined {
  return EXTERNAL_AGENTS.find((entry) => entry.id === id);
}

/** Every registered agent id, in registry order. */
export function externalAgentIds(): string[] {
  return EXTERNAL_AGENTS.map((entry) => entry.id);
}

/** Whether this agent's own CLI supports the requested sandbox level. Pure. */
export function supportsSandbox(entry: ExternalAgentEntry, sandbox: ExternalSandbox): boolean {
  return entry.sandboxModes.includes(sandbox);
}

/**
 * Extract a version from `detect` output using the entry's pattern. Undefined
 * when the output does not match — which is a warning, never a failure: a CLI
 * that renames its version banner must not become unusable.
 */
export function parseAgentVersion(entry: ExternalAgentEntry, detectOutput: string): string | undefined {
  const match = new RegExp(entry.versionPattern).exec(detectOutput);
  return match?.[1];
}

/**
 * Compare two dotted numeric versions. Returns <0, 0 or >0. Missing components
 * count as 0, and any non-numeric component compares as 0 rather than throwing —
 * a pre-release suffix must not crash a version check.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** How a detected version relates to the range this agent's fixtures were recorded against. */
export type VersionVerdict =
  | { readonly state: "in-range" }
  | { readonly state: "below-min"; readonly min: string }
  | { readonly state: "above-max"; readonly max: string }
  | { readonly state: "unknown" };

/**
 * Judge a detected version against the entry's known-good range.
 *
 * Deliberately advisory: every out-of-range verdict is a RECORDED WARNING on the
 * run, never a refusal. Neither CLI publishes a stable event schema, so pinning
 * an upper bound and hard-failing above it would break the feature on the
 * vendor's next release — the failure mode the parse-skip counter exists to
 * surface instead.
 */
export function judgeVersion(entry: ExternalAgentEntry, version: string | undefined): VersionVerdict {
  if (version === undefined) return { state: "unknown" };
  if (compareVersions(version, entry.knownGoodRange.min) < 0) {
    return { state: "below-min", min: entry.knownGoodRange.min };
  }
  const max = entry.knownGoodRange.max;
  if (max !== undefined && compareVersions(version, max) > 0) {
    return { state: "above-max", max };
  }
  return { state: "in-range" };
}

/**
 * Availability as keryx is allowed to know it.
 *
 * `not-probed` is a first-class state, not a placeholder. There is no cheap
 * liveness probe for the subscription path: `--version` proves a binary and
 * nothing about a login, and any real probe spends the operator's own quota.
 */
export type AgentAvailability =
  | { readonly state: "available"; readonly version?: string; readonly verdict: VersionVerdict }
  | { readonly state: "binary-missing" }
  | { readonly state: "not-probed" };

/** Detection result the caller supplies; keeps this module free of process spawning. */
export interface DetectionOutcome {
  readonly binaryFound: boolean;
  /** Combined stdout/stderr of the `detect` argv, when it ran. */
  readonly detectOutput?: string;
}

/**
 * Fold a detection outcome into an availability state. Note what this can NEVER
 * report: "logged in". A found binary with a parsed version is `available` in the
 * sense of *runnable*, and whether the operator's subscription answers is only
 * discovered by running (package security-policy §1).
 */
export function resolveAvailability(
  entry: ExternalAgentEntry,
  outcome: DetectionOutcome | undefined,
): AgentAvailability {
  if (outcome === undefined) return { state: "not-probed" };
  if (!outcome.binaryFound) return { state: "binary-missing" };
  const version = outcome.detectOutput === undefined ? undefined : parseAgentVersion(entry, outcome.detectOutput);
  const verdict = judgeVersion(entry, version);
  return version === undefined ? { state: "available", verdict } : { state: "available", version, verdict };
}
