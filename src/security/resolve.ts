import {
  applyRedaction,
  buildRedactedPreview,
  locationFor,
} from "./redact";
import { detectSecrets } from "./detect/secrets";
import { detectPii } from "./detect/pii";
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

// Query-parameter NAMES that are credential-shaped regardless of their value
// (GDCTX-2 design §2), normalized (lowercased, non-alphanumeric stripped) so
// `api_key`, `API-Key` and `apikey` all match one entry. This list is
// deliberately broader than the four examples the design doc gives
// (`token`/`key`/`auth`) so the common spellings of the same idea (
// `access_token` vs `accessToken`, `client_secret`, `session_id`, …) do not
// each need their own regression before they are caught.
const CREDENTIAL_QUERY_PARAM_NAMES: ReadonlySet<string> = new Set([
  "token",
  "key",
  "auth",
  "secret",
  "sig",
  "signature",
  "password",
  "pass",
  "pwd",
  "passwd",
  "session",
  "credential",
  "credentials",
  "accesstoken",
  "apikey",
  "accesskey",
  "authtoken",
  "secretkey",
  "clientsecret",
  "apisecret",
  "sessionid",
  "sessiontoken",
  "refreshtoken",
  "idtoken",
  "csrftoken",
  "csrf",
  "bearer",
  "jwt",
]);

function normalizeQueryParamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The query string of a URL that may not itself be absolute (a relative or
// protocol-relative `src`/`href` still fetches, and `<img>`/markdown-image
// destinations are routinely written that way). `URL` only parses absolute
// URLs, so a relative destination falls back to a plain `?`/`#` split rather
// than being treated as having no query string at all.
function extractQueryString(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    const qIndex = url.indexOf("?");
    if (qIndex === -1) return "";
    const hashIndex = url.indexOf("#", qIndex);
    return hashIndex === -1 ? url.slice(qIndex) : url.slice(qIndex, hashIndex);
  }
}

/**
 * Is `url` safe to release from under a `redact`/`block` egress finding
 * despite a matching source override (GDCTX-2 design §2)?
 *
 * Judgement call, recorded here rather than left implicit: the gate is on
 * CREDENTIAL-SHAPED query content, not on "has a query string at all". A
 * badge URL routinely carries a harmless query (`?style=flat`, `?branch=main`,
 * a cache-busting `?v=3`) and the design doc's own examples require those to
 * pass, so refusing every URL with any `?` would fail the acceptance criteria
 * this override exists to satisfy. What must still redact is a query that
 * could itself be the leak — a credential-shaped PARAMETER NAME (checked
 * case-insensitively against `CREDENTIAL_QUERY_PARAM_NAMES` above, independent
 * of that parameter's value), or a query string whose bytes trip the existing
 * secret/PII detectors (an attacker- or model-controlled URL with a token
 * pasted into an unrelated-looking parameter, or a leaked email/phone). Only
 * the query component is scanned — the host/path of an exfil destination is
 * already what `detectExfil` classified the match on, and is not sensitive by
 * itself.
 */
function hasCredentialShapedQuery(url: string): boolean {
  const query = extractQueryString(url);
  if (!query) return false;
  const params = new URLSearchParams(query);
  for (const name of params.keys()) {
    if (CREDENTIAL_QUERY_PARAM_NAMES.has(normalizeQueryParamName(name))) {
      return true;
    }
  }
  return detectSecrets(query).length > 0 || detectPii(query).length > 0;
}

/**
 * The (policy id, source) override table (GDCTX-2 design §2) is egress-only
 * today (`schemas.ts#EGRESS_POLICY_SCHEMA`) and only ever applies to a match
 * `detectExfil` produced — a `secret`/`pii` finding never consults it, even if
 * a future config accidentally sets `sourceOverrides` on another policy block
 * (the schema for those blocks does not accept the field, so that config would
 * already fail validation before reaching here; this is defense in depth, not
 * the primary guard).
 *
 * Returns the override action to apply, or `undefined` when no override
 * applies and the caller should fall back to the policy's own `action`. An
 * `allow` override is additionally gated on `hasCredentialShapedQuery`: a
 * credential-shaped query string keeps the policy's ordinary (stricter)
 * action even though a `trusted-project -> allow` entry exists, because the
 * override exists to stop static badge markup from being masked, not to widen
 * what an attacker-controlled or model-generated URL can carry unmasked.
 * Non-`allow` overrides (a project tightening its own policy, e.g. forcing
 * `redact` for a source that would otherwise be more permissive) are not
 * gated — there is nothing unsafe about a project asking for MORE redaction.
 */
export function egressSourceOverrideAction(
  policy: PolicyConfig,
  match: Pick<DetectorMatch, "category" | "policyId" | "value">,
  source: SecuritySource,
): SecurityAction | undefined {
  if (match.category !== "egress") return undefined;
  const overrideAction = policy.sourceOverrides?.[match.policyId]?.[source];
  if (overrideAction === undefined) return undefined;
  if (overrideAction === "allow" && hasCredentialShapedQuery(match.value)) {
    return undefined;
  }
  return overrideAction;
}

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
  const baseAction: SecurityAction =
    match.confidence >= minConfidence ? policy.action : "warn";
  // GDCTX-2: a per-(policyId, source) override (egress only) can replace the
  // policy's own action — gated on the URL's query string when it would
  // relax to `allow` (see `egressSourceOverrideAction`). The finding is still
  // built and recorded below either way; this only changes which `action` it
  // carries, never whether it exists (§2, "no silent skip").
  const action: SecurityAction =
    egressSourceOverrideAction(policy, match, opts.source) ?? baseAction;

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

  // A match is masked in `decision.redacted` only when ITS OWN finding still
  // calls for it. Before GDCTX-2 this filtered on `mask !== undefined` alone,
  // so a match whose action had been resolved to `allow` (an operator setting
  // a policy's `action` to `allow` outright, or — the case this fix adds — an
  // egress source override) was masked anyway: the redaction pass never
  // looked at the action it had just computed. `findings` is `opts.matches`
  // mapped 1:1 in the same order (see above), so index alignment is exact.
  const redactable = opts.matches.filter((m, i) => m.mask !== undefined && findings[i]?.action !== "allow");
  if (redactable.length > 0) {
    decision.redacted = applyRedaction(opts.content, redactable);
  }
  return decision;
}
