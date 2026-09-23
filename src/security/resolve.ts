import {
  applyRedaction,
  buildRedactedPreview,
  locationFor,
} from "./redact";
import { detectSecrets } from "./detect/secrets";
import { detectPii } from "./detect/pii";
import { mergeSourceOverrides, SHIPPED_EGRESS_SOURCE_OVERRIDES } from "./config";
import { renderableUrl } from "./detect/exfil";
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

// R3-1 (flow 304, fix round 3): three review rounds running found a
// credential-shaped query PARAMETER NAME the denylist this replaced did not
// cover — round 1 shipped `token`/`key`/`auth`/… plus a segment/stem/affix
// splitter for compounds, round 2 added `APIToken`/`XTOKEN`/`pw`/`sid`, and
// round 3's own review still found `authorization`, `Authorization`,
// `privatekey`, `authkey`, `accesskeyid` and `accesskey_id` slipping through.
// A denylist of credential-shaped names is an unwinnable game against
// attacker- or model-chosen spellings — there is always one more compound or
// casing to add. This is the opposite shape: a small, explicit ALLOWLIST of
// the query parameters a real status-badge renderer (shields.io, GitHub
// Actions workflow badges, and similar) actually accepts. The override may
// keep `allow` only when EVERY query parameter name is on this list; anything
// else — a name this list does not recognize, not just one that looks
// credential-shaped — keeps the policy's stricter action. Compared
// case-insensitively (`?Style=flat` and `?style=flat` are the same control).
const SAFE_BADGE_QUERY_PARAMS: ReadonlySet<string> = new Set(
  [
    "style",
    "logo",
    "logoColor",
    "logoWidth",
    "label",
    "labelColor",
    "color",
    "colorA",
    "colorB",
    "branch",
    "event",
    "cacheSeconds",
    "link",
    "maxAge",
    "v",
    "version",
    "include_prereleases",
    "sort",
    "display_name",
    "query",
    "prefix",
    "suffix",
    "service",
    "workflow",
    "status",
    "flat",
    "compact",
    "width",
    "height",
    "s",
    "size",
  ].map((name) => name.toLowerCase()),
);

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

// F2 (review round 1): a query string's parameter PAIRS are separated by `&` OR
// `;` — `application/x-www-form-urlencoded` and every renderer's own query
// parser accept both (`URLSearchParams` only splits on `&`, which is exactly
// the gap `?a=1;token=abc123` bypassed the old check through) — and a NAME is
// read up to the first `=` and then percent-decoded, because a renderer decodes
// it before ever comparing it to anything. A name that fails to percent-decode
// (a lone `%` or a truncated escape) is kept as written rather than dropped:
// dropping it would silently remove a candidate this gate must still see.
const QUERY_PAIR_SEPARATOR = /[&;]+/;

function queryParamNames(query: string): string[] {
  const body = query.startsWith("?") ? query.slice(1) : query;
  if (!body) return [];
  return body
    .split(QUERY_PAIR_SEPARATOR)
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const raw = eq === -1 ? pair : pair.slice(0, eq);
      try {
        return decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        return raw;
      }
    });
}

/**
 * Is `url` safe to release from under a `redact`/`block` egress finding
 * despite a matching source override (GDCTX-2 design §2)?
 *
 * R3-1 (flow 304, fix round 3) replaced a credential-shaped-name DENYLIST
 * here with the opposite shape: the override may keep `allow` only when the
 * URL has NO query string at all, or EVERY query parameter name is one of the
 * small, explicit `SAFE_BADGE_QUERY_PARAMS` a real status-badge renderer
 * actually accepts (`?style=flat`, `?branch=main&event=push`, a cache-busting
 * `?v=3`, …). Anything else — a name this list does not recognize (not just
 * one that happens to look credential-shaped), an empty parameter name, a
 * malformed query, or userinfo in the URL itself (`https://user:pass@host/…`)
 * — keeps the policy's stricter action. Only the query/userinfo components are
 * scanned — the host/path of an exfil destination is already what
 * `detectExfil` classified the match on, and is not sensitive by itself.
 *
 * A SAFE-named parameter can still carry a credential in its VALUE (a
 * confused or attacker-controlled `?color=<secret>`), so the query string is
 * additionally run through the existing secret/PII detectors regardless of
 * how its names checked out — this is unchanged from the denylist version.
 *
 * This reads the DECODED destination a renderer would actually fetch
 * (`exfil.ts#renderableUrl`: HTML character references resolved, tab/LF/CR
 * stripped, leading/trailing C0-or-space trimmed), not `match.value`'s raw
 * span, so a credential-shaped param cannot survive entity-encoding it
 * (`?a=1&amp;amp;token=…`, `?&amp;#116;oken=…`) into reading as query-free to
 * this gate while still reaching a renderer unmasked (F2, review round 1).
 */
function queryIsSafeForTrustedOverride(url: string): boolean {
  try {
    const renderable = renderableUrl(url);
    // Userinfo (`user:pass@host`) only parses on an absolute URL; `new URL`
    // throws for a relative/protocol-relative destination, which has no such
    // syntax to fail closed over — fall through to the plain query-string
    // extraction below for those.
    try {
      const parsed = new URL(renderable);
      if (parsed.username || parsed.password) {
        return false;
      }
    } catch {
      // Not an absolute URL: no userinfo is possible.
    }
    const query = extractQueryString(renderable);
    if (!query) return true;
    const names = queryParamNames(query);
    for (const name of names) {
      // An empty parameter name (`?=x`, `?&=y`) is malformed enough to fail
      // closed rather than guess at what it names.
      if (name.length === 0 || !SAFE_BADGE_QUERY_PARAMS.has(name.toLowerCase())) {
        return false;
      }
    }
    return detectSecrets(query).length === 0 && detectPii(query).length === 0;
  } catch {
    // Fail-closed: an unexpected decoding/parsing failure must never be read
    // as "safe" — it keeps the policy's stricter action, exactly like a
    // disallowed name would.
    return false;
  }
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
 * `allow` override is additionally gated on `queryIsSafeForTrustedOverride`: a
 * query string that is not entirely made of known-safe badge parameters (or a
 * safe-named parameter carrying a flagged value, or userinfo in the URL)
 * keeps the policy's ordinary (stricter) action even though a
 * `trusted-project -> allow` entry exists, because the override exists to
 * stop static badge markup from being masked, not to widen what an
 * attacker-controlled or model-generated URL can carry unmasked. Non-`allow`
 * overrides (a project tightening its own policy, e.g. forcing `redact` for a
 * source that would otherwise be more permissive) are not gated — there is
 * nothing unsafe about a project asking for MORE redaction.
 *
 * F1 (review round 1): `policy.sourceOverrides` is now ONLY what the operator
 * actually wrote in `security.config.json` (see `config.ts#mergeEgressPolicy`
 * — the shipped default is deliberately kept OUT of it, so it never enters
 * `configChecksum`). The shipped default (`SHIPPED_EGRESS_SOURCE_OVERRIDES`)
 * is applied HERE, at resolution time, merged UNDER the operator's own table
 * with `mergeSourceOverrides` — same semantics as before this fix, and the
 * same function `mergeEgressPolicy` already used to combine the two: an
 * operator's own entry for a (policyId, source) pair replaces the shipped
 * one; every pair they do not mention keeps the shipped default.
 */
export function egressSourceOverrideAction(
  policy: PolicyConfig,
  match: Pick<DetectorMatch, "category" | "policyId" | "value">,
  source: SecuritySource,
): SecurityAction | undefined {
  if (match.category !== "egress") return undefined;
  const effectiveOverrides = mergeSourceOverrides(
    SHIPPED_EGRESS_SOURCE_OVERRIDES,
    policy.sourceOverrides,
  );
  const overrideAction = effectiveOverrides?.[match.policyId]?.[source];
  if (overrideAction === undefined) return undefined;
  if (overrideAction === "allow" && !queryIsSafeForTrustedOverride(match.value)) {
    return undefined;
  }
  return overrideAction;
}

// F10 (review round 1): does ANY (policyId, source) pair — shipped default
// included — resolve to an override for this source at all? `guard.ts#redactRaw`
// uses this to skip its second, config-aware `validateSerializedOutput` pass
// (which reruns exfil detection over the same content) when the answer is
// `false`: no override can possibly change the outcome for this source, so the
// unconditional first pass already IS the answer, and a caller checking every
// source on every call — not knowing in advance which one carries an override —
// would otherwise pay the detection cost twice on every single call.
export function egressSourceHasOverride(policy: PolicyConfig, source: SecuritySource): boolean {
  const effectiveOverrides = mergeSourceOverrides(
    SHIPPED_EGRESS_SOURCE_OVERRIDES,
    policy.sourceOverrides,
  );
  if (!effectiveOverrides) return false;
  return Object.values(effectiveOverrides).some((bySource) => bySource?.[source] !== undefined);
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
