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

export function computeGate(input: {
  findings: Finding[];
  projectMetrics: ScopeMetrics | undefined;
  sources: SourceRunInfo[];
  config: HealthConfig;
  strict: boolean;
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

  // "This source did not produce a result." Extracted verbatim from the
  // `brokenRequired` filter below so that the required and optional sides ask
  // exactly the same question and can never drift apart. `execution`/`parse`
  // left `undefined` are deliberately not treated as failures -- callers that
  // predate those fields assert nothing about them, and inventing a failure
  // from silence is the mirror image of the defect this file is closing.
  const didNotProduceResult = (s: SourceRunInfo): boolean =>
    s.status !== "available" ||
    s.execution === "failed" ||
    s.execution === "not-run" ||
    s.parse === "failed" ||
    s.parse === "not-run";

  const brokenRequired = sources.filter((s) => s.required && didNotProduceResult(s));
  if (brokenRequired.length > 0) {
    for (const source of brokenRequired) {
      const detail = source.error ? `: ${source.error}` : "";
      escalate("incomplete", `required source unavailable: ${source.source}${detail}`);
    }
  }
  const skippedOptional = sources.filter((s) => !s.required && s.status === "skipped");
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
    reasons.push(`OPTIONAL: ${source.source} source missing`);
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
    (s) => !s.required && s.mode !== "disabled" && didNotProduceResult(s),
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
