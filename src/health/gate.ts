import type {
  CoverageStatus,
  Finding,
  GateResult,
  GateStatus,
  HealthConfig,
  ScopeMetrics,
  SourceRunInfo,
} from "./types";

const RANK: Record<GateStatus, number> = {
  pass: 0,
  warn: 1,
  incomplete: 2,
  fail: 3,
};

// T64: `loadHealthConfig` (T59) forces the strictest reachable `gate` and
// `sources[*].required` when the config file exists but is unusable, and
// sets `config.configUnreadable` to say so (mirrors
// `SecurityConfig.configUnreadable`, consumed by `guard.ts` through its own
// constant `POSTURE_UNAVAILABLE_REASON`). Constant and non-interpolated by
// design: no path, no raw error text, no file contents -- naming the FACT
// that the read was not trusted, not any detail of why.
const CONFIG_UNREADABLE_REASON =
  "CONFIG: health configuration is unreadable; gate forced to strictest thresholds";

// "This source did not produce a result." One predicate for the required and
// optional sides of the gate, and for which sources a baseline measured
// (`baseline.ts`), so none of them can drift apart. `execution`/`parse` left
// `undefined` are deliberately not treated as failures -- callers that
// predate those fields assert nothing about them, and inventing a failure
// from silence is the mirror image of the defect this file is closing.
export function didNotProduceResult(s: SourceRunInfo): boolean {
  return (
    s.status !== "available" ||
    s.execution === "failed" ||
    s.execution === "not-run" ||
    s.parse === "failed" ||
    s.parse === "not-run"
  );
}

export function computeGate(input: {
  findings: Finding[];
  projectMetrics: ScopeMetrics | undefined;
  sources: SourceRunInfo[];
  config: HealthConfig;
  strict: boolean;
  /**
   * Sources this run measured that the baseline did not; their findings are
   * left out of the regression comparison (scopes.ts). Named here so the
   * exclusion is visible and the operator knows how to end it.
   */
  newSources?: readonly string[];
}): GateResult {
  const { findings, projectMetrics, sources, config } = input;
  const reasons: string[] = [];
  // Legibility, not escalation: this never calls `escalate` and never moves
  // `status` by itself. `config.gate`/`config.sources[*].required` are
  // already forced to their strictest values upstream (T59) when this flag
  // is set, so the verdict this produces is unchanged by this line -- it
  // only explains a verdict already reached by the unmodified logic below.
  if (config.configUnreadable) {
    reasons.push(CONFIG_UNREADABLE_REASON);
  }
  // Informational, like the lint-family NOTE below: it never escalates.
  if (input.newSources !== undefined && input.newSources.length > 0) {
    reasons.push(
      `NOTE: not in the baseline yet, so not compared for regression: ${[...input.newSources].sort().join(", ")}; run \`keryx health baseline update\` to include them`,
    );
  }
  let status: GateStatus = "pass";
  const escalate = (next: GateStatus, reason: string) => {
    reasons.push(`${next.toUpperCase()}: ${reason}`);
    if (RANK[next] > RANK[status]) {
      status = next;
    }
  };

  const failPriorities = new Set(config.gate.failOnPriorities);
  const critical = findings.filter((f) => failPriorities.has(f.priority));
  if (critical.length > 0) {
    escalate(
      "fail",
      `${critical.length} finding(s) at ${[...failPriorities].join("/")}`,
    );
  }

  const regression = projectMetrics?.regression_score ?? 0;
  if (regression >= config.gate.failOnRegressionDrop) {
    escalate("fail", `health regression ${regression} vs baseline`);
  } else if (regression >= config.gate.warnOnRegressionDrop) {
    escalate("warn", `health regression ${regression} vs baseline`);
  }

  // Flow 352 AC3: lint is a CAPABILITY, and the project chooses which tool
  // provides it. `sources.eslint.required: true` encodes "this project is
  // linted", not "it is linted by ESLint specifically" -- so a project that
  // adopted oxlint and switched ESLint off was blocked with
  // `INCOMPLETE: required source unavailable: eslint` while its lint check was
  // in fact running and parsing. When one linter produced a result, the other
  // members of the family that are `skipped` are excused below, for the same
  // reason `mode: "disabled"` already is: an unused tool is a configuration
  // fact, not an unmeasured check. Deliberately narrow:
  //   * only `status: "skipped"` is excused. `missing` (a config for that tool
  //     exists but its binary does not) and `configured-but-failed` stay
  //     blocking -- a half-installed tool is a broken check, not an unused one.
  //   * `required` itself is unchanged, so a project with NEITHER linter keeps
  //     the existing required-eslint INCOMPLETE behavior (AC2).
  // The family is whatever declares `capability: "lint"` (copied from the
  // adapter by `runAdapter`), not a list of ids here: a linter added later is
  // in the family by declaring it, and cannot be forgotten in this file.
  const isLinter = (s: SourceRunInfo): boolean => s.capability === "lint";
  const lintSatisfied = sources.some((s) => isLinter(s) && !didNotProduceResult(s));
  //   * a source a `--sources` filter left out is never excused: the operator
  //     chose not to look at it this run, and a filtered run cannot report a
  //     clean gate (health-truthful-gate.test.ts).
  const excusedByLintFamily = (s: SourceRunInfo): boolean =>
    lintSatisfied && isLinter(s) && s.status === "skipped" && s.filtered !== true;

  const brokenRequired = sources.filter(
    (s) => s.required && didNotProduceResult(s) && !excusedByLintFamily(s),
  );
  // Say the excuse out loud. Silently dropping a REQUIRED source from the
  // blocking list would leave a reader of `latest.md` wondering why `eslint:
  // skipped` produced no complaint, which is the same invisibility defect
  // F-240-03 closed for optional sources -- and it would hide the fact that
  // the lint check is running under a different tool. Informational only:
  // like `OPTIONAL:`/`COVERAGE:`, this line never calls `escalate`.
  const lintProvider = sources.find((s) => isLinter(s) && !didNotProduceResult(s));
  const excusedLinter = sources.find((s) => s.required && excusedByLintFamily(s));
  if (excusedLinter && lintProvider) {
    reasons.push(
      `NOTE: ${excusedLinter.source} skipped; lint capability provided by ${lintProvider.source}`,
    );
  }
  if (brokenRequired.length > 0) {
    for (const source of brokenRequired) {
      const detail = source.error ? `: ${source.error}` : "";
      escalate("incomplete", `required source unavailable: ${source.source}${detail}`);
    }
  }
  // An optional linter excused by a sibling that ran is not an absence worth a
  // line: coverage already counts it as measured, and the reasons must agree.
  const skippedOptional = sources.filter(
    (s) => !s.required && s.status === "skipped" && !excusedByLintFamily(s),
  );
  for (const source of skippedOptional) {
    reasons.push(`OPTIONAL: ${source.source} source skipped`);
  }

  // Flow 237 T6 defect 2 (AFC-28/AC-28): a MISSING optional source (tool not
  // installed / not importable) fell through both the `brokenRequired` branch
  // above (it is not required) and this one (its status is "missing", not
  // "skipped") and produced no reason line at all — its absence was
  // invisible to a reader of the gate's own output. Whether missing should
  // BLOCK is a separate policy question already answered by the
  // required/optional split above; this only makes the absence visible, the
  // same way a skipped optional source already is. Never escalates status.
  const missingOptional = sources.filter((s) => !s.required && s.status === "missing");
  for (const source of missingOptional) {
    // Flow 353 AC6 (second clause): say which check failed, not just that
    // one did — the same `detail` pattern `brokenRequired` above already
    // uses for `source.error`. `run.ts`'s `missingSourceReason` is what
    // populates it; a source with none keeps the unchanged, name-only line.
    const detail = source.error ? `: ${source.error}` : "";
    reasons.push(`OPTIONAL: ${source.source} source missing${detail}`);
  }

  const brokenOptional = sources.filter(
    (s) => !s.required && s.status === "configured-but-failed",
  );
  if (brokenOptional.length > 0) {
    escalate(
      "warn",
      `optional source failed: ${brokenOptional.map((s) => s.source).join(", ")}`,
    );
  }

  const coverage = projectMetrics?.coverage;
  if (typeof coverage === "number" && coverage < config.metrics.coverageSoftFloor) {
    escalate("warn", `coverage ${coverage}% below soft floor ${config.metrics.coverageSoftFloor}%`);
  }

  // F-240-03 (flow 240 T7). `coverage` was `brokenRequired.length > 0 ?
  // "incomplete" : "complete"`, so the default configuration -- where
  // `dependencyAudit` is optional (`config.ts`) -- reported
  //
  //   dependencyAudit MISSING -> status=pass coverage=complete
  //
  // A dependency audit that never ran was recorded as a run that found nothing,
  // which is precisely the claim a security check must never make on its own
  // behalf. An enabled OPTIONAL source that produced no result now makes
  // coverage `partial`: not a block (that decision belongs to
  // `sources[*].required`, and is unchanged), but no longer a claim of
  // completeness. A `mode: "disabled"` source is excluded -- switched off by an
  // operator is a configuration fact, not an unmeasured check.
  const unmeasuredOptional = sources.filter(
    (s) =>
      !s.required &&
      s.mode !== "disabled" &&
      didNotProduceResult(s) &&
      !excusedByLintFamily(s),
  );

  if (status === "pass") {
    reasons.push("PASS: no gate conditions triggered");
  }

  const coverageStatus: CoverageStatus = brokenRequired.length > 0
    ? "incomplete"
    : unmeasuredOptional.length > 0
      ? "partial"
      : "complete";

  // Say which, in the gate's own output. The per-source `OPTIONAL: ...` lines
  // above name each absence; this line is what turns those into the coverage
  // verdict a reader of `latest.md` sees, so the two can never disagree
  // silently.
  if (coverageStatus === "partial") {
    reasons.push(
      `COVERAGE: partial — optional source(s) produced no result: ${unmeasuredOptional
        .map((s) => s.source)
        .join(", ")}`,
    );
  }

  return { status, reasons, coverage: coverageStatus };
}
