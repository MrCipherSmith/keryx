import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { securityDataRoot, verifyConfigChecksum } from "./config";
import type {
  IncidentEntry,
  PolicyConfig,
  SecurityConfig,
  SecurityFinding,
  SecurityMode,
} from "./types";

// Self-protection (§14). The module must never be silently disabled or weakened:
// a checksum mismatch (policies edited outside the tool) emits a `high`
// artifact-safety finding + incident; a mode downgrade or a disabled policy is
// always surfaced (warn + incident). All of this is derived deterministically
// from the current config and the previously-seen state.

export type SecurityState = {
  mode: SecurityMode;
  policies: Record<string, boolean>;
};

export type SelfProtectionResult = {
  warnings: string[];
  incidents: IncidentEntry[];
  findings: SecurityFinding[];
  checksumMatch: boolean;
};

// T61 made `isBlockingMode` (`guard.ts`) agree with this table's DIRECTION --
// `gateway` at least as strict as `enforced`/`ci` -- but left the table's own
// VALUES unrevisited: `gateway` still ranked strictly above `enforced`/`ci`
// (3 vs 2), while T61 (`isBlockingMode`) and T65 (`exitCodeFor`/
// `reportExitCode`) made `gateway` behaviourally IDENTICAL to them at every
// site that branches on mode -- the write seam, the flow gate, and all four
// command exit codes (T62 F-002, measured cell-for-cell at four command
// surfaces and two module seams; `T62-mode.ts` M1/M2). A stale strict
// ordering over three modes that now behave the same made a
// `gateway -> enforced`/`gateway -> ci` reconfiguration write a durable
// `mode-downgrade` incident and an "(enforcement weakened)" warning for a
// change that weakens nothing.
//
// This table now expresses what the code actually has: three modes that
// block identically, ranked together, and one (`advisory`) that does not,
// ranked below them. A transition between any two of `{gateway, enforced,
// ci}` is same-rank and stays silent -- correctly, nothing moved. A
// transition from any of the three down to `advisory` is still a strict rank
// drop and is still detected -- the invariant this table exists for
// (`gateway -> advisory`, `enforced -> advisory`, `ci -> advisory` all still
// fire `mode-downgrade`; verified in `T62-state.ts`'s M3 matrix and
// `security.test.ts`).
const MODE_RANK: Record<SecurityMode, number> = {
  gateway: 2,
  enforced: 2,
  ci: 2,
  advisory: 1,
};

export function currentState(config: SecurityConfig): SecurityState {
  const policies: Record<string, boolean> = {};
  for (const [name, policy] of Object.entries(config.policies)) {
    policies[name] = (policy as PolicyConfig).enabled;
  }
  return { mode: config.mode, policies };
}

export function evaluateSelfProtection(
  config: SecurityConfig,
  previous: SecurityState | null,
  now: string = new Date().toISOString(),
): SelfProtectionResult {
  const warnings: string[] = [];
  const incidents: IncidentEntry[] = [];
  const findings: SecurityFinding[] = [];

  // Checksum: policies edited outside `keryx security policy set`.
  const checksum = verifyConfigChecksum(config);
  if (!checksum.match) {
    warnings.push(
      "configChecksum mismatch: security policies were edited outside keryx (expected " +
        `${checksum.expected}, found ${checksum.actual ?? "none"}).`,
    );
    incidents.push({
      at: now,
      type: "config-checksum-mismatch",
      message: "Security policy block was modified outside the tool.",
      details: { expected: checksum.expected, actual: checksum.actual },
    });
    findings.push({
      // Fail closed: a tampered policy block must not be able to weaken detection
      // of its own tampering, so this finding hard-codes severity `critical` +
      // action `block` (not the configurable artifactSafety action). This makes
      // the gate `fail` and `ci` mode exit non-zero on config tampering (§14).
      id: `artifact-safety.config-checksum:${now}`,
      policyId: "artifact-safety.config-checksum",
      severity: "critical",
      category: "artifact-safety",
      source: { kind: "trusted-project" },
      action: "block",
      confidence: 1,
      remediation:
        "Restore the policy block via `keryx security policy set` to refresh the checksum.",
      createdAt: now,
    });
  }

  // Mode downgrade (e.g. enforced -> advisory). Skipped while the config is
  // unreadable (`config.configUnreadable`, T37/T54's forced-strictest
  // fallback): `config.mode` here is a derived, momentary substitute this run
  // could not verify, not the operator's choice, so comparing it against a
  // REAL `previous` would append a durable incident for a window in which
  // nothing was actually weakened. Both grounds are measured, not assumed
  // (T57 F-002): the append is not a mere warning -- it lands in the
  // append-only `incidents.jsonl` before any repair, and survives a repair
  // back to the very same mode; and the statement itself is false of this
  // run -- `guardOutput`/`securityFlowGate` refuse EVERY write while
  // `configUnreadable` is set, so effective enforcement during this window is
  // stricter than any recognized mode, not weaker. The comparison resumes on
  // the next run whose config is genuinely readable, real `previous` against
  // real `config.mode` -- see T61-spec.md.
  if (!config.configUnreadable && previous && MODE_RANK[config.mode] < MODE_RANK[previous.mode]) {
    warnings.push(
      `security mode downgraded: ${previous.mode} -> ${config.mode} (enforcement weakened).`,
    );
    incidents.push({
      at: now,
      type: "mode-downgrade",
      message: `Mode changed from ${previous.mode} to ${config.mode}.`,
      details: { from: previous.mode, to: config.mode },
    });
  }

  // Disabled policies. This loop does NOT need the mode arm's
  // `!config.configUnreadable` guard, and giving it that guard anyway
  // suppressed a true §14 signal (T62 F-003). `config.configUnreadable`
  // covers two different shapes (`config.ts:238-267`) whose `policies` are
  // not the same kind of value:
  //   - An UNUSABLE payload (unparseable, or parses to something other than
  //     an object) yields `mergeSecurityConfig({})` -- the built-in
  //     defaults, where every policy is `enabled: true`
  //     (`DEFAULT_SECURITY_CONFIG.policies`, `config.ts:22-28`). The
  //     comparison below only fires on `enabled === false`, which this
  //     shape can never produce -- guarded or not, this arm is a
  //     mathematical no-op for it (measured: T62-state.ts B3).
  //   - An UNRECOGNIZED-MODE payload (the file parsed as an object, but its
  //     declared `mode` is not one this build recognizes) yields
  //     `mergeSecurityConfig(parsed)` -- the operator's REAL, parsed
  //     `policies` (`config.ts:257-267`, the loader's own comment: "the
  //     operator's own `policies`... are still theirs"). A policy the
  //     operator genuinely disabled in that very file is real news about
  //     their own bytes, not a derived substitute -- exactly the case the
  //     mode arm's guard exists to exclude, and this arm was wrongly
  //     excluding it too (T62-state.ts B1:
  //     `trueDisableSuppressedDuringWindow: true` before this fix).
  // No second flag or default-comparison is needed to tell the two apart:
  // the unusable-payload shape is unconditionally all-`true`, not merely
  // usually so, so simply not gating this loop on `configUnreadable` stays
  // silent for that shape and correctly re-enables detection for the other.
  if (previous) {
    for (const [name, enabled] of Object.entries(currentState(config).policies)) {
      if (previous.policies[name] === true && enabled === false) {
        warnings.push(`security policy "${name}" was disabled.`);
        incidents.push({
          at: now,
          type: "policy-disabled",
          message: `Policy "${name}" was disabled.`,
          details: { policy: name },
        });
      }
    }
  }

  return { warnings, incidents, findings, checksumMatch: checksum.match };
}

// ---------------------------------------------------------------------------
// Local-only state persistence (data/security/raw/, gitignored).
// ---------------------------------------------------------------------------

function stateFile(cwd: string): string {
  return path.join(securityDataRoot(cwd), "raw", "state.json");
}

export async function readState(cwd: string): Promise<SecurityState | null> {
  const file = stateFile(cwd);
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as SecurityState;
  } catch {
    return null;
  }
}

/**
 * Persist `state` as `previous` for the NEXT `evaluateSelfProtection` call.
 *
 * Invariant the caller must uphold (T39 F-008): `state.mode`/`state.policies`
 * must be the operator's actual, currently-readable configuration -- never a
 * forced-closed substitute a broken config produced (`SecurityConfig.configUnreadable`).
 * A forced posture is a derived, momentary fact about a config this run could
 * not read; writing it here would make it indistinguishable from a real prior
 * reading on the next comparison, which can both fabricate a downgrade
 * incident (repairing back to the same real mode) and mask a genuine one
 * (a real downgrade compared against the wrong, forced `previous`). The one
 * caller, `analyze()` in `service.ts`, skips this call entirely when
 * `config.configUnreadable` is true -- see T58-spec.md for the full argument
 * and the two failure shapes.
 */
export async function writeState(cwd: string, state: SecurityState): Promise<void> {
  const file = stateFile(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
