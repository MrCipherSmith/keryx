// Pure logic for the status bar item (spec.md §2.3, AC4). Zero `vscode`
// import so this is unit-testable with `bun test` — same house pattern as
// `status-logic.ts`/`version-logic.ts`: parse plain shell-out text, make a
// total decision, hand the `vscode`-calling glue in `status-bar.ts` exactly
// what to render.
//
// Data source decision (T7): `keryx serve`'s HTTP backend
// (`GET /v1/status`) is off by default (spec.md Finding 2 — nothing in this
// scaffold starts it, and starting a background server as a side effect of
// activation is out of scope for this task). Per the dispatch brief, this
// shells three existing read-only CLI commands instead, through the same
// `runKeryx` seam `status-logic.ts`/`extension.ts` already use:
//   - `keryx status`      (3-state Metaproject readiness, via `interpretStatus`)
//   - `keryx health status` (gate: pass|warn|fail|n/a — `src/health/gate.ts`'s
//     `GateStatus` union, printed verbatim by `src/commands/health.ts:96`)
//   - `keryx security status` (no numeric verdict on this CLI surface; the
//     best available whole-project security signal is `configChecksum: ok`
//     from `src/commands/security.ts:171`'s `handleStatus` — anything else,
//     including a missing/garbled line, is treated as unhealthy so a broken
//     config never silently reads as "fine")
//
// AC4's literal requirement — "click-through names the SPECIFIC failing
// check, never a bare unexplained color change" — is why this module exposes
// a `failingChecks()` helper that names each unhealthy input by label, not
// just an aggregate glyph.

import type { KeryxStatusState } from "./status-logic";

export type HealthGateState = "pass" | "warn" | "fail" | "unknown";

/** Parse `keryx health status`'s stdout (`src/commands/health.ts:96`, `gate: <value>`). */
export function parseHealthGate(healthStatusOutput: string): HealthGateState {
  const match = /^gate:\s*(\S+)/m.exec(healthStatusOutput);
  const value = match?.[1];
  if (value === "pass" || value === "warn" || value === "fail") return value;
  // "n/a" (health module disabled/never run) and anything unrecognised both
  // land here — never crash the status bar over a missing/stale health run.
  return "unknown";
}

export type SecurityConfigState = "ok" | "broken" | "unknown";

// The known-bad checksum token `src/commands/security.ts:183`'s `handleStatus`
// actually prints (verified by reading the command, not guessed — it prints
// literal "MISMATCH", uppercase). Matched case-insensitively since a future
// CLI revision could change casing without changing meaning. Anything else —
// including a value this module has never seen because the CLI's output
// format changed — must NOT be classified as "broken": that would conflate a
// real config mismatch with an unrecognized token and produce a false
// security warning in the status bar.
const KNOWN_BROKEN_CHECKSUM_VALUES = new Set(["mismatch"]);

/** Parse `keryx security status`'s stdout (`src/commands/security.ts`, `configChecksum: <value>`). */
export function parseSecurityConfigState(securityStatusOutput: string): SecurityConfigState {
  const match = /^\s*configChecksum:\s*(\S+)/m.exec(securityStatusOutput);
  const value = match?.[1];
  if (value === "ok") return "ok";
  if (value === undefined) return "unknown";
  if (KNOWN_BROKEN_CHECKSUM_VALUES.has(value.toLowerCase())) return "broken";
  // An unrecognized-but-matched token (e.g. a future CLI output format this
  // module doesn't know about yet) is neutral, not a false alarm.
  return "unknown";
}

export interface StatusBarInputs {
  readonly metaprojectState: KeryxStatusState;
  readonly healthGate: HealthGateState;
  readonly securityConfig: SecurityConfigState;
}

export type StatusBarSeverity = "healthy" | "warning" | "error";

/**
 * Roll up the three signals into one severity. Any single "bad" signal wins:
 * not-initialized/incomplete Metaproject state or a failing health gate is an
 * error; a warn-level health gate or a broken security config checksum is a
 * warning; everything else (including genuinely "unknown"/not-yet-run
 * signals) is healthy — an extension that has never run `health run` must
 * not present as broken by default.
 */
export function computeStatusBarSeverity(inputs: StatusBarInputs): StatusBarSeverity {
  if (inputs.metaprojectState === "not-initialized" || inputs.healthGate === "fail") {
    return "error";
  }
  if (
    inputs.metaprojectState === "incomplete" ||
    inputs.healthGate === "warn" ||
    inputs.securityConfig === "broken"
  ) {
    return "warning";
  }
  return "healthy";
}

const SEVERITY_ICON: Record<StatusBarSeverity, string> = {
  healthy: "$(check)",
  warning: "$(warning)",
  error: "$(error)",
};

/** The `StatusBarItem.text` glyph+label for a given severity. */
export function statusBarText(severity: StatusBarSeverity): string {
  return `${SEVERITY_ICON[severity]} Keryx`;
}

export interface FailingCheck {
  readonly label: string;
  readonly detail: string;
}

/**
 * AC4: name every specific check that is not green, in the order a human
 * would triage them (Metaproject readiness first — nothing else means much
 * until it's initialized — then the health gate, then security config).
 * Returns an empty array when everything is healthy (the "healthy" case).
 */
export function failingChecks(inputs: StatusBarInputs): FailingCheck[] {
  const checks: FailingCheck[] = [];

  if (inputs.metaprojectState === "not-initialized") {
    checks.push({
      label: "Metaproject",
      detail: "Not initialized in this workspace. Run “Keryx: Initialize Project”.",
    });
  } else if (inputs.metaprojectState === "incomplete") {
    checks.push({
      label: "Metaproject",
      detail: "Workspace setup looks incomplete. Run “Keryx: Initialize Project” to repair it.",
    });
  }

  if (inputs.healthGate === "fail") {
    checks.push({
      label: "Health gate",
      detail: "Quality gate is failing. Run `keryx health run` for details.",
    });
  } else if (inputs.healthGate === "warn") {
    checks.push({
      label: "Health gate",
      detail: "Quality gate has warnings. Run `keryx health run` for details.",
    });
  }

  if (inputs.securityConfig === "broken") {
    checks.push({
      label: "Security config",
      detail: "Security config checksum mismatch. Run `keryx security policy validate`.",
    });
  }

  return checks;
}

/** Detail-popup/quick-pick body when the status bar is fully healthy. */
export const HEALTHY_DETAIL_MESSAGE = "Keryx: Metaproject ready, health gate passing, security config OK.";

/**
 * The full message set shown on status-bar click-through: either the
 * healthy message, or one line per failing check (AC4 — never a bare color
 * change with no explanation).
 */
export function statusBarDetailLines(inputs: StatusBarInputs): string[] {
  const failing = failingChecks(inputs);
  if (failing.length === 0) {
    return [HEALTHY_DETAIL_MESSAGE];
  }
  return failing.map((check) => `${check.label}: ${check.detail}`);
}
