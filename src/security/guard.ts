// Phase 3 write-seam guard (specification.md §11, §16).
//
// The shared, leak-safe entry point that consuming modules (memory, wiki,
// testing, gdctx, flow) call *before* a side-effecting write. It wraps the
// frozen Phase 1+2 engine (`createSecurityService`) and enforces the #1 rule:
//
//   advisory mode ONLY reports on a KNOWN posture - it never blocks, never
//   mutates, never adds a side effect there. Blocking happens strictly in
//   `enforced`/`ci`/`gateway` mode, and also for `incomplete` engine evidence
//   in those modes - a check that could not run is never treated as a pass.
//   The one
//   exception: when the workspace's own posture cannot be established at all
//   (an unreadable manifest or config file - present, but not readable as
//   the object it must be - or a config that declares a `mode` outside the
//   closed `SecurityMode` union), every mode blocks, including advisory. An
//   unknown posture is not a posture advisory can report on. The mandatory
//   deterministic output floor (`validateSerializedOutput`) always applies
//   first, even when the `security` module is disabled or advisory settings
//   would otherwise let the write through, so the guard is not a zero-cost
//   no-op in that case.
//
// This module imports only from the security engine + shared libs. It must
// never import from memory/wiki/testing/gdctx/flow, so the seam stays acyclic.

import path from "node:path";
export { validateOutputForTransport } from "./output-validation";
import type { OutputRedaction } from "./output-validation";
export type { OutputRedaction };
import { pathExists } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import { loadSecurityConfig, securityProjectRoot } from "./config";
import { createSecurityService, validateSerializedOutput } from "./service";
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

/**
 * Materialize content for a durable sink from its completed guard decision.
 * A redacted representation is authoritative whenever present; a blocked
 * decision never yields bytes that a caller could accidentally persist.
 *
 * The return also carries a `bytesPreserved` flag and the `redaction` outcome
 * of the floor pass this function ran. Read them knowing there are TWO passes
 * on the production path: `guardOutput` already ran the same floor and put its
 * cleaned text on `guard.redacted`, so the pass here re-validates text that is
 * usually already clean and reports `state: "none"` for content that WAS masked
 * and for a dropped duplicate member alike. `redaction` therefore does not, by
 * itself, tell apart the three shapes an "allowed" result can take — the
 * original bytes came back untouched, content was masked (a secret/PII/exfil
 * span was found and replaced), or the bytes were replaced by the safe
 * canonical form because the structural walk could not prove them a faithful
 * spelling of the validated value (T24 F-002's class — most commonly a
 * duplicate JSON member whose earlier value `JSON.parse` silently drops).
 * `bytesPreserved` is the reliable "did anything change" signal, because it
 * compares the final bytes against `original` — the caller's own input — rather
 * than against whatever `guard.redacted` happened to be, so it answers "did I
 * get back exactly what I started with" on both paths. WHAT changed and why
 * comes from `guard.decision.findings`. (A hand-built `GuardResult` with
 * `redacted` unset has only one pass, and there `redaction` does carry the
 * distinction — see T42-review.md#T42#F-004.) On the refused branch,
 * `redaction` is attached only when
 * the deterministic floor itself is what refused (`format-unsafe`): a refusal
 * from the security engine's own gate decision has no `OutputRedaction` to
 * report and leaves the key absent rather than fabricating one — `reason`
 * already describes that outcome in full. See T24-recheck2.md#T24R2#F-002 and
 * T41-implementation.md section 3.
 */
export function prepareOutputForPersistence(
  guard: GuardResult,
  original: string,
):
  | {
      allowed: true;
      content: string;
      redaction: Extract<OutputRedaction, { state: "none" | "redacted" }>;
      bytesPreserved: boolean;
    }
  | {
      allowed: false;
      reason: string;
      redaction?: Extract<OutputRedaction, { state: "format-unsafe" }>;
    } {
  if (!guard.allowed) {
    return { allowed: false, reason: guard.reason ?? "security gate blocked" };
  }
  const safe = validateSerializedOutput(guard.redacted ?? original);
  return safe.ok
    ? {
        allowed: true,
        content: safe.text,
        redaction: safe.redaction,
        bytesPreserved: safe.text === original,
      }
    : {
        allowed: false,
        reason: "format-unsafe: output cannot be persisted safely",
        redaction: safe.redaction,
      };
}

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

// The decision for a check that could not run. Not a pass, and not a finding
// either: there is nothing to report except that there is nothing to report.
const INCOMPLETE_DECISION: SecurityDecision = {
  gate: "incomplete",
  action: "warn",
  findings: [],
};

// Constant, leak-safe strings for the two "the module is on but cannot read its
// own posture" branches. No error text, no path, no source bytes.
const POSTURE_UNAVAILABLE_REASON = "security posture unavailable: check could not complete";

// What `.metaproject/metaproject.json` says about this workspace's security
// posture. Two independent axes, because they mean different things to a
// caller: `enabled` is the ordinary opt-in flag, and `manifestUnreadable` is
// true ONLY when the manifest file EXISTS but could not be read as the
// object it must be (T35 F-001) - the same shape T30 F-001 described for
// `security.config.json`, in the sibling reader. A missing manifest is not
// "unreadable": it is the ordinary, non-blocking "never configured" case
// (`enabled: false`, `manifestUnreadable: false`), unchanged from before.
//
// Neither is an ABSENT `modules` block (T39 F-005). A manifest that is a
// well-formed object saying nothing about modules is perfectly readable, and
// what it says is "no modules are configured" - which is how every other
// manifest reader in this repository reads it (`capability/seam.ts`,
// `commands/ctx.ts`, `testing/capability.ts`, `gdskills/project-skills.ts`,
// `gdskills/export.ts`). Treating it as a fault made a present, well-formed
// manifest harsher than an absent one, which is strictly more information
// producing a strictly harsher verdict. A `modules` block that IS present but
// is not a plain object stays unreadable: that file states something about
// modules that cannot be read.
async function resolveManifestSecurityState(
  cwd: string,
): Promise<{ enabled: boolean; manifestUnreadable: boolean }> {
  // Resolved against the enclosing project, not the raw `cwd`: a seam invoked
  // from a subdirectory otherwise found no manifest, reported the module as
  // disabled, and silently skipped the check it exists to perform.
  const manifestPath = path.join(securityProjectRoot(cwd), ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return { enabled: false, manifestUnreadable: false };
  }
  // "Did it parse" and "is it the object it must be" are one question with one
  // answer here, and `readJsonObjectFile` (`../lib/json`) returns both. It
  // replaces a module-local `Symbol` sentinel that existed only because
  // `readJsonFileOr` collapses a read/parse failure into whatever fallback is
  // passed: the former `{}` fallback made an unparseable manifest
  // indistinguishable from a readable one with no `modules` key, and the two
  // shared a verdict by the accident of the fallback value rather than by a
  // guard (T39 "Judgement calls" #4). The verdicts are unchanged.
  const read = await readJsonObjectFile(manifestPath);
  if (read.state !== "object") {
    return { enabled: false, manifestUnreadable: true };
  }
  const modules = read.value.modules;
  if (modules === undefined) {
    return { enabled: false, manifestUnreadable: false };
  }
  if (typeof modules !== "object" || modules === null || Array.isArray(modules)) {
    return { enabled: false, manifestUnreadable: true };
  }
  const enabled =
    (modules as Record<string, { enabled?: boolean }>).security?.enabled === true;
  return { enabled, manifestUnreadable: false };
}

// Whether the `security` module is enabled for this workspace. Mirrors the
// `modules.<name>.enabled` convention used across the CLI (see `moduleEnabled`
// in commands/update.ts and commands/rules.ts). When there is no manifest, the
// module is treated as disabled and every seam becomes a no-op. Never throws:
// a manifest that parses but is not the object this reads (`null`, an array,
// a primitive) resolves to `false` here too - callers that need to tell that
// apart from "never configured" use `resolveManifestSecurityState` directly
// (`guardOutput`, `securityFlowGate`), because a boolean cannot carry the
// distinction.
export async function isSecurityEnabled(cwd: string): Promise<boolean> {
  return (await resolveManifestSecurityState(cwd)).enabled;
}

// Whether this mode may stop a controlled write (§7a). `advisory` alone
// reports and continues; `enforced`, `ci` and `gateway` block.
//
// `gateway` moved to the blocking side by T61 (T57 F-002 / "Judgement calls"
// #4): it used to be grouped with `advisory` here while `MODE_RANK`
// (`self-protect.ts`) ranked it strictest of the four recognized modes -- two
// classifications of the same mode that cannot both be right. `MODE_RANK`
// is the one anchored by committed, must-keep-passing behavior (T58's
// `gateway -> ci` genuine-downgrade regression, T57's own probe), and this
// module's own fail-closed discipline elsewhere (the `default` arm below,
// `loadSecurityConfig`'s forced-strictest fallback) argues against a
// not-yet-fully-specified ("Phase 4") mode silently defaulting to the MOST
// permissive behavior of any recognized mode. So `isBlockingMode` was the
// stale half; it now agrees with the rank table instead of the reverse. See
// T61-spec.md for the full argument.
//
// Exhaustive over `SecurityMode`, with the default arm on the BLOCKING side -
// the same discipline `securityFlowGate`'s gate switch below, `isPassGate`
// (`commands/security.ts`), `runGate` (`security/service.ts`) and `gateExitCode`
// (`health/service.ts`) now carry on the gate axis. This used to be a two-value
// allowlist for blocking whose fallthrough was permissive, so a mode outside
// the union silently meant "does not block" (T39 F-002). `loadSecurityConfig`
// now refuses such a value before it can reach here; this arm is the second
// line, so a fifth mode added to the union later cannot inherit "does not
// block" by omission.
function isBlockingMode(mode: string): boolean {
  switch (mode) {
    case "advisory":
      return false;
    case "gateway":
    case "enforced":
    case "ci":
      return true;
    default:
      return true;
  }
}

// The shared write seam. Runs the engine's `check` before a controlled write.
//
// - the mandatory deterministic floor (`validateSerializedOutput`) always
//   applies first, even when the module is disabled - a format-unsafe output
//   is blocked regardless of mode.
// - security disabled OR empty content  -> `{ allowed: true }` beyond that
//   floor, no further side effects.
// - advisory                             -> `allowed: true` always (report-only),
//   truthful diagnostics (including an `incomplete` gate) stay on the decision.
//   The caller decides whether to print `formatGuardWarning(decision)`.
// - enforced / ci / gateway              -> `allowed: false` when the decision
//   gate is `fail`, `needs-approval`, or `incomplete` (evidence that could not
//   be produced is never treated as a pass), with a masked, leak-safe `reason`.
//
// Never throws, and never resolves an unknown toward "everything is fine": a
// workspace whose manifest exists but cannot be read as one, or that has
// ENABLED security but cannot read its own mode/config, has incomplete
// evidence about its own posture, so the write is refused (every mode,
// including advisory - an unknown posture is not one advisory can report on)
// rather than granted a mode nobody could verify. An engine analysis error
// surfaces as an `incomplete` decision, which advisory reports and
// enforced/ci blocks through the gate check below.
export async function guardOutput(input: GuardInput): Promise<GuardResult> {
  const { cwd, content } = input;
  const safe = validateSerializedOutput(content);
  if (!safe.ok) {
    return { allowed: false, decision: { gate: "fail", action: "block", findings: [] },
      reason: "format-unsafe: output cannot be represented safely" };
  }
  const safeRepresentation = safe.text === content ? {} : { redacted: safe.text };

  if (content.length === 0) {
    return { allowed: true, decision: ALLOW_DECISION, ...safeRepresentation };
  }

  const manifestState = await resolveManifestSecurityState(cwd);
  if (manifestState.manifestUnreadable) {
    return {
      allowed: false,
      decision: INCOMPLETE_DECISION,
      reason: POSTURE_UNAVAILABLE_REASON,
      ...safeRepresentation,
    };
  }
  if (!manifestState.enabled) {
    return { allowed: true, decision: ALLOW_DECISION, ...safeRepresentation };
  }

  // The mode/config is loaded in its OWN try, because the two failures are
  // not the same failure. This one leaves the workspace's posture unknown,
  // and the permissive branch below is chosen BY the mode - so degrading to
  // it here would let a config that cannot be read decide that nothing
  // blocks. `configUnreadable` (T35 F-003) is the non-throwing twin of the
  // catch below: `loadSecurityConfig` is total, but a present-and-unusable
  // config must reach the same posture-unavailable outcome as a load that
  // actually throws, not the permissive default the merge otherwise takes.
  let mode: string;
  try {
    const config = await loadSecurityConfig(cwd);
    if (config.configUnreadable) {
      return {
        allowed: false,
        decision: INCOMPLETE_DECISION,
        reason: POSTURE_UNAVAILABLE_REASON,
        ...safeRepresentation,
      };
    }
    mode = config.mode;
  } catch {
    return {
      allowed: false,
      decision: INCOMPLETE_DECISION,
      reason: POSTURE_UNAVAILABLE_REASON,
      ...safeRepresentation,
    };
  }

  let decision: SecurityDecision;
  try {
    decision = await createSecurityService(cwd).check({
      content,
      source: input.source ?? "generated",
      target: input.target,
      ...(input.path !== undefined ? { path: input.path } : {}),
    });
  } catch {
    // An engine error is a check that could not run, not a clean one. Advisory
    // still does not block; enforced/ci refuses it at the gate fold below.
    decision = INCOMPLETE_DECISION;
  }

  const base: GuardResult = { allowed: true, decision };
  Object.assign(base, safeRepresentation);

  // Report-only modes never block.
  if (!isBlockingMode(mode)) {
    return base;
  }

  // enforced / ci: stop the write on a fail / needs-approval / incomplete
  // gate. Incomplete engine evidence (e.g. an unreadable HMAC key) is a check
  // that could not run, not a pass - strict modes refuse it the same as fail.
  if (
    decision.gate === "fail" ||
    decision.gate === "needs-approval" ||
    decision.gate === "incomplete"
  ) {
    return { ...base, allowed: false, reason: guardReason(decision) };
  }
  return base;
}

// Mandatory deterministic redaction applies independently of advisory module
// enablement. Diagnostics may be unavailable; that cannot restore raw secrets.
export async function redactRaw(input: RedactRawInput): Promise<RedactRawResult> {
  const { cwd, content } = input;
  const safe = validateSerializedOutput(content);
  if (!safe.ok) return { content: safe.text, findings: [] };
  try {
    if (content.length === 0 || !(await isSecurityEnabled(cwd))) {
      return { content: safe.text, findings: [] };
    }
    const { findings } = await createSecurityService(cwd).redact(content, {
      source: input.source ?? "tool-output",
    });
    return { content: safe.text, findings };
  } catch {
    return { content: safe.text, findings: [] };
  }
}

// A masked, leak-safe one-line summary of a decision: categories + counts only.
// NEVER includes raw content, redacted previews, or hashes. Returns `null` when
// there is nothing to report, so callers can `if (warning) console.warn(...)`.
// An `incomplete` gate is always reported, even with zero findings: a check
// that could not run must stay visible and must never read as a silent pass.
export function formatGuardWarning(
  decision: SecurityDecision,
  label = "security",
): string | null {
  if (decision.findings.length === 0) {
    return decision.gate === "incomplete"
      ? `[${label}] incomplete: security evidence unavailable`
      : null;
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

// Flow-completion security gate (§11). Returns `null` for exactly ONE case: the
// `security` module is disabled for this workspace, so a normal advisory `flow
// complete` is never blocked or even annotated. Every other outcome is a gate
// entry, because `src/flow/service.ts` pushes nothing for `null` and folds with
// `gates.every((gate) => gate.status !== "fail")` - a `null`, a `pass` and a
// `skipped` are all indistinguishable there, so a gate that vanishes is not a
// gate. Advisory -> informational `pass`; enforced/ci/gateway -> maps the
// engine's gate over the latest security scan exhaustively, and only a verified
// `pass` is non-blocking. A gate the engine could not run at all (a manifest
// that exists but is not readable as one, a posture load failure, or a
// present-but-unusable config, or a report read failure) is itself incomplete
// evidence and reports `fail`, with a constant, leak-safe detail that never
// echoes the underlying error text, a path, or source bytes. Never throws.
export async function securityFlowGate(
  cwd: string,
): Promise<{ status: "pass" | "fail" | "skipped"; detail: string } | null> {
  const manifestState = await resolveManifestSecurityState(cwd);
  if (manifestState.manifestUnreadable) {
    // NOT `null`: that value means "module disabled", and a manifest that
    // exists but cannot be read is not evidence the module was ever off.
    return { status: "fail", detail: POSTURE_UNAVAILABLE_REASON };
  }
  if (!manifestState.enabled) {
    return null;
  }

  let mode: string;
  try {
    const config = await loadSecurityConfig(cwd);
    if (config.configUnreadable) {
      return { status: "fail", detail: POSTURE_UNAVAILABLE_REASON };
    }
    mode = config.mode;
  } catch {
    // NOT `null`: that value means "module disabled", and this module is
    // enabled - it just could not read its own posture. Returning `null` here
    // removed the security gate from flow completion with no trace at all.
    return { status: "fail", detail: POSTURE_UNAVAILABLE_REASON };
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
    // Exhaustive over `SecurityGateStatus`, with the default arm on the
    // blocking side: a status this function has not been taught yet must never
    // inherit `pass` from a fallthrough.
    switch (result.status) {
      case "pass":
        return { status: "pass", detail };
      case "fail":
      case "needs-approval":
      case "incomplete":
        return { status: "fail", detail };
      default:
        return { status: "fail", detail };
    }
  } catch {
    // The catch branch must not pretend a verified result: a gate that could
    // not run is incomplete evidence, and strict mode refuses it like a fail.
    // No raw error message, file path, or source bytes leave this branch.
    return {
      status: "fail",
      detail: "security gate unavailable: check could not complete",
    };
  }
}
