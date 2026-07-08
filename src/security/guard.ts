// Phase 3 write-seam guard (specification.md §11, §16).
//
// The shared, leak-safe entry point that consuming modules (memory, wiki,
// testing, gdctx, flow) call *before* a side-effecting write. It wraps the
// frozen Phase 1+2 engine (`createSecurityService`) and enforces the #1 rule:
//
//   advisory mode ONLY reports - it never blocks, never mutates, never adds a
//   side effect. Blocking happens strictly in `enforced`/`ci` mode. When the
//   `security` module is disabled the guard is a zero-cost no-op.
//
// This module imports only from the security engine + shared libs. It must
// never import from memory/wiki/testing/gdctx/flow, so the seam stays acyclic.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { loadSecurityConfig } from "./config";
import { createSecurityService } from "./service";
import type {
  SecurityDecision,
  SecurityFinding,
  SecuritySource,
  SecurityTarget,
} from "./types";

export type GuardInput = {
  cwd: string;
  content: string;
  target: SecurityTarget;
  source?: SecuritySource;
  path?: string;
};

export type GuardResult = {
  allowed: boolean;
  decision: SecurityDecision;
  redacted?: string;
  reason?: string;
};

export type RedactRawInput = {
  cwd: string;
  content: string;
  source?: SecuritySource;
};

export type RedactRawResult = {
  content: string;
  findings: SecurityFinding[];
};

// A pass/allow decision with no findings - returned on every no-op path so the
// caller always has a well-formed decision to inspect.
const ALLOW_DECISION: SecurityDecision = { gate: "pass", action: "allow", findings: [] };

// Whether the `security` module is enabled for this workspace. Mirrors the
// `modules.<name>.enabled` convention used across the CLI (see `moduleEnabled`
// in commands/update.ts and commands/rules.ts). When there is no manifest, the
// module is treated as disabled and every seam becomes a no-op.
export async function isSecurityEnabled(cwd: string): Promise<boolean> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return false;
  }
  const manifest = await readJsonFileOr<{
    modules?: Record<string, { enabled?: boolean }>;
  }>(manifestPath, {});
  return manifest.modules?.security?.enabled === true;
}

// True only for the modes that may stop a controlled write (§7a). `advisory`
// and the (Phase 4) `gateway` mode report and continue.
function isBlockingMode(mode: string): boolean {
  return mode === "enforced" || mode === "ci";
}

// The shared write seam. Runs the engine's `check` before a controlled write.
//
// - security disabled OR empty content  -> `{ allowed: true }`, no side effects.
// - advisory / gateway                   -> `allowed: true` always (report-only).
//   The caller decides whether to print `formatGuardWarning(decision)`.
// - enforced / ci                        -> `allowed: false` when the decision
//   gate is `fail` or `needs-approval`, with a masked, leak-safe `reason`.
//
// Never throws: an analysis error degrades to allow, so a seam is never broken.
export async function guardOutput(input: GuardInput): Promise<GuardResult> {
  const { cwd, content } = input;

  if (content.length === 0 || !(await isSecurityEnabled(cwd))) {
    return { allowed: true, decision: ALLOW_DECISION };
  }

  let mode: string;
  let decision: SecurityDecision;
  try {
    mode = (await loadSecurityConfig(cwd)).mode;
    decision = await createSecurityService(cwd).check({
      content,
      source: input.source ?? "generated",
      target: input.target,
      ...(input.path !== undefined ? { path: input.path } : {}),
    });
  } catch {
    // Advisory-safe: an engine error must not break the caller.
    return { allowed: true, decision: ALLOW_DECISION };
  }

  const base: GuardResult = { allowed: true, decision };
  if (decision.redacted !== undefined) {
    base.redacted = decision.redacted;
  }

  // Report-only modes never block.
  if (!isBlockingMode(mode)) {
    return base;
  }

  // enforced / ci: stop the write on a fail / needs-approval gate.
  if (decision.gate === "fail" || decision.gate === "needs-approval") {
    return { ...base, allowed: false, reason: guardReason(decision) };
  }
  return base;
}

// Redact raw output before it is persisted/summarized (gdctx seam, §11). Returns
// byte-identical content whenever security is disabled, the content is empty, or
// no redactable secret was detected - so it is a pure safety improvement that
// never alters output that had nothing sensitive in it. Never throws.
export async function redactRaw(input: RedactRawInput): Promise<RedactRawResult> {
  const { cwd, content } = input;

  if (content.length === 0 || !(await isSecurityEnabled(cwd))) {
    return { content, findings: [] };
  }

  try {
    const { redacted, findings } = await createSecurityService(cwd).redact(content, {
      source: input.source ?? "tool-output",
    });
    // Only substitute when the engine actually detected something; otherwise the
    // redacted string equals the input, but we return the original to be safe.
    if (findings.length === 0) {
      return { content, findings: [] };
    }
    return { content: redacted, findings };
  } catch {
    return { content, findings: [] };
  }
}

// A masked, leak-safe one-line summary of a decision: categories + counts only.
// NEVER includes raw content, redacted previews, or hashes. Returns `null` when
// there is nothing to report, so callers can `if (warning) console.warn(...)`.
export function formatGuardWarning(
  decision: SecurityDecision,
  label = "security",
): string | null {
  if (decision.findings.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const finding of decision.findings) {
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, count]) => `${category}:${count}`)
    .join(", ");
  return `[${label}] ${decision.gate}: ${decision.findings.length} finding(s) (${breakdown})`;
}

// The `reason` string attached to a blocked enforced/ci decision. Reuses the
// masked summary so a raw secret can never leak into a reason or a log line.
function guardReason(decision: SecurityDecision): string {
  return formatGuardWarning(decision) ?? `security gate: ${decision.gate}`;
}

// Flow-completion security gate (§11). Returns `null` to OMIT the gate entirely
// when the module is disabled, so a normal advisory `flow complete` is never
// blocked or even annotated. Advisory/gateway -> informational `pass`;
// enforced/ci -> maps the engine's `gate` (over the latest security scan of the
// flow's touched artifacts) to pass/fail. Never throws.
export async function securityFlowGate(
  cwd: string,
): Promise<{ status: "pass" | "fail" | "skipped"; detail: string } | null> {
  if (!(await isSecurityEnabled(cwd))) {
    return null;
  }

  let mode: string;
  try {
    mode = (await loadSecurityConfig(cwd)).mode;
  } catch {
    return null;
  }

  if (!isBlockingMode(mode)) {
    return {
      status: "pass",
      detail: `security ${mode}: informational (advisory does not block)`,
    };
  }

  try {
    const result = await createSecurityService(cwd).gate({ cwd });
    const detail = result.reasons.join("; ") || `security gate: ${result.status}`;
    return result.status === "fail"
      ? { status: "fail", detail }
      : { status: "pass", detail };
  } catch (error) {
    return {
      status: "skipped",
      detail: `security gate unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
