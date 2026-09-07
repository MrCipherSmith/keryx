import type {
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

  const brokenRequired = sources.filter((s) =>
    s.required && (
      s.status !== "available" ||
      s.execution === "failed" ||
      s.execution === "not-run" ||
      s.parse === "failed" ||
      s.parse === "not-run"
    ));
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

  if (status === "pass") {
    reasons.push("PASS: no gate conditions triggered");
  }

  return {
    status,
    reasons,
    coverage: brokenRequired.length > 0 ? "incomplete" : "complete",
  };
}
