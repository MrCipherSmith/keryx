import {
  applyRedaction,
  buildRedactedPreview,
  locationFor,
} from "./redact";
import type {
  DetectorMatch,
  PolicyConfig,
  SecurityAction,
  SecurityCategory,
  SecurityConfig,
  SecurityDecision,
  SecurityFinding,
  SecurityGate,
  SecuritySeverity,
  SecuritySource,
  SecuritySourceRef,
  SecurityTarget,
} from "./types";

const ACTION_PRECEDENCE: Record<SecurityAction, number> = {
  block: 5,
  "require-approval": 4,
  redact: 3,
  warn: 2,
  allow: 1,
};

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function policyFor(category: SecurityCategory, config: SecurityConfig): PolicyConfig {
  switch (category) {
    case "secret":
    case "raw-retention":
      return config.policies.secrets;
    case "pii":
      return config.policies.pii;
    case "prompt-injection":
      return config.policies.promptInjection;
    case "egress":
      return config.policies.egress;
    case "artifact-safety":
      return config.policies.artifactSafety;
  }
}

export function strongestAction(actions: SecurityAction[]): SecurityAction {
  return actions.reduce<SecurityAction>(
    (best, action) =>
      ACTION_PRECEDENCE[action] > ACTION_PRECEDENCE[best] ? action : best,
    "allow",
  );
}

export type BuildFindingOptions = {
  source: SecuritySource;
  target?: SecurityTarget;
  content: string;
  path?: string;
  hashFn?: (value: string) => string;
  createdAt?: string;
  allMatches?: DetectorMatch[];
};

// Turn a raw detector match into a committable finding. The raw value is used
// only to derive the (local-only, HMAC) hash and the masked preview — it never
// becomes a field on the finding.
export function buildFinding(
  match: DetectorMatch,
  config: SecurityConfig,
  opts: BuildFindingOptions,
): SecurityFinding {
  const policy = policyFor(match.category, config);
  const minConfidence = policy.minConfidence ?? config.gate.minConfidence;
  const action: SecurityAction =
    match.confidence >= minConfidence ? policy.action : "warn";

  const source: SecuritySourceRef = { kind: opts.source };
  if (opts.path !== undefined) {
    source.path = opts.path;
  }

  const finding: SecurityFinding = {
    id: `${match.policyId}:${match.start}-${match.end}`,
    policyId: match.policyId,
    severity: match.severity,
    category: match.category,
    source,
    action,
    confidence: match.confidence,
    redactedPreview: buildRedactedPreview(opts.content, match, opts.allMatches ?? [match]),
    location: locationFor(opts.content, match),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
  if (opts.target !== undefined) {
    finding.target = opts.target;
  }
  if (match.remediation !== undefined) {
    finding.remediation = match.remediation;
  }
  if (opts.hashFn) {
    finding.hash = opts.hashFn(match.value);
  }
  return finding;
}

// Apply the injection→egress escalation (§7a / policies.md): a lone injection
// signal stays `warn`; when an egress signal co-occurs, injection findings are
// escalated to the prompt-injection policy action (require-approval by default).
function escalateInjection(
  findings: SecurityFinding[],
  config: SecurityConfig,
): void {
  const hasEgress = findings.some((f) => f.category === "egress");
  if (!hasEgress) {
    return;
  }
  const escalatedAction = config.policies.promptInjection.action;
  for (const finding of findings) {
    if (finding.category === "prompt-injection" && finding.action === "warn") {
      finding.action = escalatedAction;
    }
  }
}

export function computeGate(
  findings: SecurityFinding[],
  config: SecurityConfig,
): { gate: SecurityGate; reasons: string[] } {
  const reasons: string[] = [];
  const failOn = SEVERITY_ORDER[config.gate.failOn];

  const blockers = findings.filter((f) => f.action === "block");
  const severe = findings.filter((f) => SEVERITY_ORDER[f.severity] >= failOn);
  if (blockers.length > 0 || severe.length > 0) {
    for (const f of blockers) {
      reasons.push(`${f.policyId} (${f.category}) requires block`);
    }
    for (const f of severe) {
      if (f.action !== "block") {
        reasons.push(`${f.policyId} severity ${f.severity} >= ${config.gate.failOn}`);
      }
    }
    return { gate: "fail", reasons };
  }

  const strongest = strongestAction(findings.map((f) => f.action));
  if (strongest === "require-approval") {
    for (const f of findings.filter((f) => f.action === "require-approval")) {
      reasons.push(`${f.policyId} (${f.category}) needs approval`);
    }
    return { gate: "needs-approval", reasons };
  }

  return { gate: "pass", reasons };
}

export type ResolveOptions = BuildFindingOptions & {
  matches: DetectorMatch[];
};

// Resolve raw matches into a full decision: findings, escalation, strongest
// action, gate, and (when a redactable span applied) the redacted content.
export function resolveDecision(
  config: SecurityConfig,
  opts: ResolveOptions,
): SecurityDecision {
  const findings = opts.matches.map((match) =>
    buildFinding(match, config, { ...opts, allMatches: opts.matches }),
  );
  escalateInjection(findings, config);

  const action = strongestAction(findings.map((f) => f.action));
  const { gate } = computeGate(findings, config);

  const decision: SecurityDecision = { gate, action, findings };

  const redactable = opts.matches.filter((m) => m.mask !== undefined);
  if (redactable.length > 0) {
    decision.redacted = applyRedaction(opts.content, opts.matches);
  }
  return decision;
}
