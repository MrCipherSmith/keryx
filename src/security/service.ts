import path from "node:path";
import {
  validateSerializedContentForTransport,
  type OutputValidationResult,
} from "./output-validation";
import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { loadSecurityConfig } from "./config";
import { runDetectorsAsync } from "./detect";
import { getHmacKey, hmacHash } from "./redact";
import {
  computeGate,
  resolveDecision,
  strongestAction,
  type BuildFindingOptions,
} from "./resolve";
import {
  buildReport,
  writeSecurityArtifacts,
  artifactsDir,
} from "./report";
import { appendIncidents } from "./incidents";
import {
  currentState,
  evaluateSelfProtection,
  readState,
  writeState,
} from "./self-protect";
import type {
  SecurityCheck,
  SecurityConfig,
  SecurityDecision,
  SecurityFinding,
  SecurityGateStatus,
  SecurityReport,
  SecurityService,
  SecuritySource,
} from "./types";
import { scanContainedPath, type SecurityScanOptions } from "./path-scan";

/**
 * Validate serialized JSON structurally, or ordinary text without changing its format.
 * The rule itself lives with the floor in `output-validation.ts` so this adapter and the
 * MCP compatibility wrapper cannot drift apart again (T24 F-002): byte preservation is
 * decided there, after the structural walk, by canonical structural equivalence.
 */
/**
 * Scrub secrets, PII and exfiltration spans from free text.
 *
 * Re-exported here because this is the security module's facade and callers
 * outside it should not reach past it: importing `security/redact` directly
 * reaches everything behind the facade too, which is what the import policy
 * counts as a bypass. The implementation stays where it is.
 */
export { redactSensitiveText } from "./redact";

export function validateSerializedOutput(content: string): OutputValidationResult {
  return validateSerializedContentForTransport(content);
}

// Result of a full analysis: the decision plus the surfaced self-protection
// warnings (§14) that the CLI prints. This is the richer, non-contract entry
// point; `createSecurityService().check` is the thin contract wrapper over it.
export type AnalysisResult = {
  decision: SecurityDecision;
  warnings: string[];
  config: SecurityConfig;
};

async function hashFnFor(cwd: string): Promise<(value: string) => string> {
  const key = await getHmacKey(cwd);
  return (value: string) => hmacHash(value, key);
}

// Core analysis: run detectors, resolve the decision, and apply self-protection
// (checksum/downgrade/disabled-policy). Persists incidents + state. Findings from
// self-protection are folded into the decision so they gate.
export async function analyze(
  cwd: string,
  input: SecurityCheck,
): Promise<AnalysisResult> {
  const config = await loadSecurityConfig(cwd);
  const matches = await runDetectorsAsync(cwd, input.content, config);
  const hashFn = await hashFnFor(cwd);

  const buildOpts: BuildFindingOptions = {
    source: input.source,
    content: input.content,
    hashFn,
  };
  if (input.target !== undefined) {
    buildOpts.target = input.target;
  }
  if (input.path !== undefined) {
    buildOpts.path = input.path;
  }

  const decision = resolveDecision(config, { ...buildOpts, matches });

  const previous = await readState(cwd);
  const selfProtection = evaluateSelfProtection(config, previous);
  if (selfProtection.incidents.length > 0) {
    await appendIncidents(cwd, selfProtection.incidents);
  }
  // A forced-closed posture (`config.configUnreadable`) is a derived, momentary
  // fact about a config THIS run could not read -- not the operator's
  // configured mode or policies (T39 F-008). Recording it as `previous` would
  // make the NEXT comparison (a repair to the same mode, or a genuine change)
  // read a synthetic value as if it were real, which can both fabricate a
  // downgrade that never happened and mask one that did (T58-spec.md). Leave
  // `previous` for the next run exactly as it is: the last config this loader
  // could actually read.
  if (!config.configUnreadable) {
    await writeState(cwd, currentState(config));
  }

  if (selfProtection.findings.length > 0) {
    decision.findings.push(...selfProtection.findings);
    decision.gate = computeGate(decision.findings, config).gate;
    decision.action = strongestAction(decision.findings.map((f) => f.action));
  }

  return { decision, warnings: selfProtection.warnings, config };
}

// Scan a file/content, build a report, and write committable artifacts.
export async function runScan(
  cwd: string,
  input: SecurityCheck,
): Promise<{
  decision: SecurityDecision;
  report: SecurityReport;
  warnings: string[];
  markdownPath: string;
  jsonPath: string;
}> {
  const { decision, warnings, config } = await analyze(cwd, input);
  const report = buildReport(decision.findings, config, decision.gate);
  const paths = await writeSecurityArtifacts(cwd, report, config);
  return { decision, report, warnings, ...paths };
}

/** Scan a contained file or directory and retain independent per-file coverage. */
export async function runScanPath(
  cwd: string,
  input: Omit<SecurityCheck, "content"> & Pick<SecurityScanOptions, "targetPath"> & {
    ownerRoot: string;
    exclusions?: string[];
    recursive?: boolean;
    limits?: SecurityScanOptions["limits"];
  },
): Promise<{
  decision: SecurityDecision;
  report: SecurityReport;
  warnings: string[];
  markdownPath: string;
  jsonPath: string;
}> {
  const traversal = await scanContainedPath({
    ownerRoot: input.ownerRoot,
    targetPath: input.targetPath,
    ...(input.exclusions !== undefined ? { exclusions: input.exclusions } : {}),
    ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });
  const findings: SecurityFinding[] = [];
  const warnings: string[] = [];
  let config: SecurityConfig | undefined;
  const files = traversal.files.map((file) => ({ ...file }));
  for (const item of traversal.contents) {
    try {
      const result = await analyze(cwd, {
        content: item.content,
        source: input.source,
        path: item.path,
        ...(input.target !== undefined ? { target: input.target } : {}),
      });
      config ??= result.config;
      findings.push(...result.decision.findings);
      warnings.push(...result.warnings);
    } catch {
      const file = files.find((entry) => entry.path === item.path && entry.status === "scanned");
      if (file !== undefined) {
        file.status = "failed";
        file.reason = "security analysis unavailable";
      }
      traversal.coverage.status = "incomplete";
      if (!traversal.coverage.reasons.includes("security analysis unavailable")) {
        traversal.coverage.reasons.push("security analysis unavailable");
      }
    }
  }
  config ??= await loadSecurityConfig(cwd);
  const computed = computeGate(findings, config);
  const gate = computed.gate === "pass" && traversal.coverage.status === "incomplete"
    ? "incomplete"
    : computed.gate;
  const action = strongestAction(findings.map((finding) => finding.action));
  const decision: SecurityDecision = { gate, action, findings };
  const report = buildReport(findings, config, gate, undefined, {
    scope: traversal.scope,
    coverage: traversal.coverage,
    files,
  });
  const paths = await writeSecurityArtifacts(cwd, report, config);
  return { decision, report, warnings: [...new Set(warnings)], ...paths };
}

/**
 * What the stored scan artifact turned out to be.
 *
 * `readLatestReport` used to answer `SecurityReport | null`, which collapsed
 * "there is no evidence" and "the evidence is unreadable" into the same value
 * as each other — and, one call up, into a `pass`. The absence of evidence is
 * not evidence of absence, so the caller gets the distinction.
 */
type LatestReportOutcome =
  | { kind: "report"; report: SecurityReport }
  | { kind: "absent" }
  | { kind: "unusable" };

/** The four values a stored `gate` may carry (`SecurityGate`, types.ts). */
const RECOGNIZED_GATES = new Set(["pass", "needs-approval", "incomplete", "fail"]);

/**
 * Validate the shape the gate decision actually reads: a non-null, non-array
 * object carrying a recognized `gate`.
 *
 * Deliberately narrower than `SECURITY_REPORT_SCHEMA`. Full-schema rejection
 * buys nothing against tampering — anyone who can write `latest.json` can write
 * a fully schema-valid report with `gate: "pass"` just as cheaply as a
 * malformed one — while it would collapse the distinction between a violation,
 * an approval requirement and unavailable evidence for every artifact that is
 * merely older or narrower than the current schema.
 */
function hasRecognizedGate(value: unknown): value is SecurityReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const gate = (value as { gate?: unknown }).gate;
  return typeof gate === "string" && RECOGNIZED_GATES.has(gate);
}

async function readLatestReport(cwd: string): Promise<LatestReportOutcome> {
  const file = path.join(artifactsDir(cwd), "latest.json");
  if (!(await pathExists(file))) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Unreadable and unparseable alike: the check did not produce evidence.
    return { kind: "unusable" };
  }
  return hasRecognizedGate(parsed) ? { kind: "report", report: parsed } : { kind: "unusable" };
}

// Constant, leak-safe reasons: no error text, no path, no source bytes.
const NO_REPORT_REASON = "no security report; run `keryx security scan` first";
const UNUSABLE_REPORT_REASON = "security report unusable; re-run `keryx security scan`";
const INCOMPLETE_COVERAGE_REASON = "security gate: incomplete (coverage incomplete)";

/**
 * Whether a stored artifact's `coverage` contradicts a `pass` gate.
 *
 * Absent or `null` coverage makes no coverage claim at all — a normal
 * single-content scan never sets this field, and that must still read as a
 * clean `pass` (T33 D2b). Anything else that is PRESENT is a claim, and the
 * claim must be a well-formed `{status:"complete"}` object to be believed:
 * a different status string (`"partial"`), a bare string in place of the
 * object, an array, a number — every shape that is not exactly a complete
 * coverage object — reads as incomplete. This mirrors the `runGate` switch's
 * own default-to-blocking discipline one level up (T35 F-004), and is shared
 * by `runGate` and `runReport` so the two surfaces cannot disagree about the
 * same artifact.
 */
function hasIncompleteCoverage(coverage: unknown): boolean {
  if (coverage === undefined || coverage === null) {
    return false;
  }
  if (typeof coverage !== "object" || Array.isArray(coverage)) {
    return true;
  }
  return (coverage as { status?: unknown }).status !== "complete";
}

// Build a report from the latest scan artifact. When none exists, or the stored
// one cannot be read as a report, the synthesized report is `incomplete` — a
// scan that never ran must never be aggregated into a clean bill of health.
// `report` never re-scans the tree; it aggregates the last scan. A stored
// `pass` whose own `coverage` contradicts it is reported as `incomplete` too
// (`hasIncompleteCoverage`), so this surface agrees with `runGate` about the
// same artifact instead of handing back the permissive half of the
// contradiction (T35 F-004).
export async function runReport(input: {
  cwd: string;
  since?: string;
}): Promise<SecurityReport> {
  const config = await loadSecurityConfig(input.cwd);
  const latest = await readLatestReport(input.cwd);
  if (latest.kind === "report") {
    if (latest.report.gate === "pass" && hasIncompleteCoverage(latest.report.coverage)) {
      return { ...latest.report, gate: "incomplete" };
    }
    return latest.report;
  }
  return buildReport([], config, "incomplete");
}

/**
 * The gate over the latest stored scan.
 *
 * Every state that is not a recognized `pass` is reported as itself: a
 * violation stays `fail`, an approval requirement stays `needs-approval`, and
 * missing, unreadable, unparseable, shape-invalid or unrecognized evidence is
 * `incomplete` with a constant reason (policies.md: a required check that is
 * missing, skipped, unparsed or unfinished is INCOMPLETE, and strict CI accepts
 * only PASS).
 */
export async function runGate(input: {
  cwd: string;
}): Promise<{ status: SecurityGateStatus; reasons: string[] }> {
  const latest = await readLatestReport(input.cwd);
  if (latest.kind === "absent") {
    return { status: "incomplete", reasons: [NO_REPORT_REASON] };
  }
  if (latest.kind === "unusable") {
    return { status: "incomplete", reasons: [UNUSABLE_REPORT_REASON] };
  }
  switch (latest.report.gate) {
    case "pass":
      // The same fold `runScanPath` applies before it writes (`pass` over
      // incomplete coverage is `incomplete`), applied again at read time: an
      // artifact that claims a pass over coverage it also calls incomplete
      // contradicts itself, and only a hand-written or tampered artifact can.
      return hasIncompleteCoverage(latest.report.coverage)
        ? { status: "incomplete", reasons: [INCOMPLETE_COVERAGE_REASON] }
        : { status: "pass", reasons: ["security gate: pass"] };
    case "fail":
      return { status: "fail", reasons: ["security gate: fail"] };
    case "needs-approval":
      return { status: "needs-approval", reasons: ["security gate: needs-approval"] };
    case "incomplete":
      return { status: "incomplete", reasons: ["security gate: incomplete"] };
    default:
      // Unreachable while `hasRecognizedGate` guards the parse, and kept so a
      // future member of `SecurityGate` cannot fall through to a pass.
      return { status: "incomplete", reasons: [UNUSABLE_REPORT_REASON] };
  }
}

/**
 * Remember a resolved value, and NOT a rejection.
 *
 * Both memoised loads read the filesystem — the config file, and the HMAC key —
 * and the first version of this cache was `once ??= load()`, which stores the
 * PROMISE. A promise that rejects is still a value, so one transient fault
 * poisoned the instance: every later `redact` in that turn re-awaited the same
 * rejection, where an uncached caller retried the read and would have succeeded.
 * On a 10,000-event turn that is one unlucky `EINTR` costing the whole turn's
 * redaction, which is the control this memo was added underneath.
 *
 * Clearing the slot in the rejection handler is what makes the next call retry.
 * Concurrent callers already awaiting the failed promise all see the same
 * rejection, which is correct — they asked at the same time and got the same
 * answer — and the call after it starts fresh.
 */
export function memoizeResolved<T>(load: () => Promise<T>): () => Promise<T> {
  let once: Promise<T> | undefined;
  return () => {
    if (once === undefined) {
      once = load().catch((error: unknown) => {
        once = undefined;
        throw error;
      });
    }
    return once;
  };
}

// The in-process service contract (specification.md §6a). `check` never throws
// in advisory mode; the caller may proceed after logging. In enforced/ci mode a
// fail/needs-approval decision must stop the controlled write.
export function createSecurityService(cwd: string = process.cwd()): SecurityService {
  // Per-INSTANCE, resolved once and reused. `redact` used to reload the config
  // and the HMAC key on every call, which is invisible while every caller
  // constructs a service per call — and is not once a caller has a loop.
  //
  // `keryx serve` made that loop production: the remote turn runner redacts
  // every `assistant.delta` before it is appended, so a 10,000-event turn paid
  // 10,000 config loads and 10,000 key reads. Measured at 80 microseconds per
  // event, which was two thirds of the 121 microseconds the whole per-event path
  // cost.
  //
  // Instance-scoped rather than module-scoped, deliberately. A module cache
  // would outlive a config change on disk for the life of the process; an
  // instance is held for one turn by the one caller that holds one at all, and
  // every other caller still constructs per call and sees exactly the behaviour
  // it saw before.
  const configFor = memoizeResolved(() => loadSecurityConfig(cwd));
  const hashOnce = memoizeResolved(() => hashFnFor(cwd));

  return {
    async check(input: SecurityCheck): Promise<SecurityDecision> {
      try {
        const { decision } = await analyze(cwd, input);
        return decision;
      } catch {
        // Advisory-safe: an analysis error must not break the caller.
        return { gate: "incomplete", action: "warn", findings: [] };
      }
    },

    async redact(
      content: string,
      opts?: { source?: SecuritySource },
    ): Promise<{ redacted: string; findings: SecurityFinding[] }> {
      const config = await configFor();
      const matches = await runDetectorsAsync(cwd, content, config);
      const hashFn = await hashOnce();
      const source: SecuritySource = opts?.source ?? "generated";
      const decision = resolveDecision(config, {
        matches,
        source,
        content,
        hashFn,
      });
      const safe = validateSerializedOutput(content);
      if (!safe.ok) throw new Error("format-unsafe: output cannot be represented safely");
      return {
        redacted: safe.text,
        findings: decision.findings,
      };
    },

    report: (input) => runReport(input),

    gate: (input) => runGate(input),
  };
}
