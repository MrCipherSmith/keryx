import type {
  Finding,
  GateResult,
  GateStatus,
  HealthConfig,
  ScopeMetrics,
  SourceRunInfo,
} from "./types";

const RANK: Record<GateStatus, number> = { pass: 0, warn: 1, fail: 2 };

export function computeGate(input: {
  findings: Finding[];
  projectMetrics: ScopeMetrics | undefined;
  sources: SourceRunInfo[];
  config: HealthConfig;
  strict: boolean;
}): GateResult {
  const { findings, projectMetrics, sources, config, strict } = input;
  const reasons: string[] = [];
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

  const brokenRequired = sources.filter(
    (s) =>
      s.required && (s.status === "missing" || s.status === "configured-but-failed"),
  );
  if (brokenRequired.length > 0) {
    const names = brokenRequired.map((s) => s.source).join(", ");
    if (strict && config.gate.failOnMissingRequiredSource) {
      escalate("fail", `required source unavailable: ${names}`);
    } else {
      escalate("warn", `required source unavailable: ${names}`);
    }
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

  return { status, reasons };
}
