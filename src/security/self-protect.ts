import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { securityDataRoot } from "./config";
import { verifyConfigChecksum } from "./config";
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

const MODE_RANK: Record<SecurityMode, number> = {
  gateway: 3,
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

  // Checksum: policies edited outside `gd-metapro security policy set`.
  const checksum = verifyConfigChecksum(config);
  if (!checksum.match) {
    warnings.push(
      "configChecksum mismatch: security policies were edited outside gd-metapro (expected " +
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
        "Restore the policy block via `gd-metapro security policy set` to refresh the checksum.",
      createdAt: now,
    });
  }

  // Mode downgrade (e.g. enforced -> advisory).
  if (previous && MODE_RANK[config.mode] < MODE_RANK[previous.mode]) {
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

  // Disabled policies.
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

export async function writeState(cwd: string, state: SecurityState): Promise<void> {
  const file = stateFile(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
