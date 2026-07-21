// Dual-axis verification report helpers (Verify phase).
//
// Pure utilities for building REPORT.md tables and scanning RUN_DIR artifacts
// for secret leaks. No I/O — callers write files. Live network dual-axis remains
// operator-run / flag-gated; these helpers stay CI-safe.

/** Axis labels used in the dual-axis protocol (metrics-and-validation.md). */
export type DualAxisId = "Preflight" | "A" | "B" | "C";

export type DualAxisVerdict = "PASS" | "FAIL" | "SKIP";

export interface DualAxisRow {
  axis: DualAxisId;
  verdict: DualAxisVerdict;
  notes: string;
}

/**
 * Contract: Axis A (model/subagent network) is NEVER sufficient proof of
 * credential masking. Axis B (shell_exec mask) is the mask proof axis.
 * Used by tests and runbook documentation generators.
 */
export const DUAL_AXIS_CONTRACT = {
  /** Model / spawn_subagent path — may need real provider credentials. */
  axisA: {
    id: "A" as const,
    name: "subagent / model network",
    isMaskProof: false,
    description:
      "Child agent LLM turn under policy. Success is NOT credential-mask proof.",
  },
  /** shell_exec restricted + mask/TLS — sentinel in child env. */
  axisB: {
    id: "B" as const,
    name: "shell_exec credential mask",
    isMaskProof: true,
    description:
      "Restricted sandboxed shell hides real keys (sentinel) with TLS unmask on inject hosts.",
  },
  /** Harness CLI parity with shell resolution. */
  axisC: {
    id: "C" as const,
    name: "harness CLI parity",
    isMaskProof: false,
    description: "Equivalent inputs → same MaskResolution as shell_exec path.",
  },
} as const;

/**
 * Build REPORT.md body (summary table only). Never embeds secret values —
 * callers must pass notes that are already redacted.
 */
export function buildDualAxisReportMarkdown(rows: DualAxisRow[]): string {
  const lines = [
    "# Dual-axis verification REPORT",
    "",
    "| Axis | Verdict | Notes |",
    "|------|---------|-------|",
  ];
  for (const row of rows) {
    const notes = row.notes.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${row.axis} | ${row.verdict} | ${notes} |`);
  }
  lines.push("");
  lines.push(
    "Redaction gate: if a real secret substring appears anywhere under RUN_DIR, the run is FAIL.",
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Count occurrences of each secret substring in artifact text.
 * Returns total hits (0 = clean). Case-sensitive exact substring match.
 */
export function countSecretLeaks(artifactText: string, secretSubstrings: string[]): number {
  let hits = 0;
  for (const secret of secretSubstrings) {
    if (secret.length === 0) continue;
    let from = 0;
    while (true) {
      const idx = artifactText.indexOf(secret, from);
      if (idx < 0) break;
      hits += 1;
      from = idx + secret.length;
    }
  }
  return hits;
}

/**
 * Scan multiple artifact bodies (e.g. RUN_DIR files). Returns total leak hits
 * across all texts. Used for AC-V3 / AC10 redaction gate.
 */
export function scanArtifactsForSecrets(
  artifacts: ReadonlyArray<{ name: string; text: string }>,
  secretSubstrings: string[],
): { totalHits: number; byArtifact: Record<string, number> } {
  const byArtifact: Record<string, number> = {};
  let totalHits = 0;
  for (const a of artifacts) {
    const n = countSecretLeaks(a.text, secretSubstrings);
    byArtifact[a.name] = n;
    totalHits += n;
  }
  return { totalHits, byArtifact };
}

/**
 * Overall run verdict: FAIL if any axis is FAIL or any redaction hit; else
 * PASS if all of A/B/C that are present are PASS or SKIP; Preflight FAIL also fails.
 * Axis A PASS alone never yields overall PASS when Axis B is FAIL or missing when required.
 */
export function overallDualAxisVerdict(input: {
  rows: DualAxisRow[];
  redactionHits: number;
  /** When true, Axis B must be present and PASS for overall PASS. */
  requireAxisBPass?: boolean;
}): "PASS" | "FAIL" {
  if (input.redactionHits > 0) return "FAIL";
  for (const row of input.rows) {
    if (row.verdict === "FAIL") return "FAIL";
  }
  if (input.requireAxisBPass) {
    const b = input.rows.find((r) => r.axis === "B");
    if (b === undefined || b.verdict !== "PASS") return "FAIL";
  }
  // Explicit: Axis A PASS does not imply mask success.
  const a = input.rows.find((r) => r.axis === "A");
  const b = input.rows.find((r) => r.axis === "B");
  if (a?.verdict === "PASS" && b?.verdict === "FAIL") return "FAIL";
  if (a?.verdict === "PASS" && b === undefined && input.requireAxisBPass) return "FAIL";
  return "PASS";
}
