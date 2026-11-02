import type { DetectorMatch, SecuritySeverity } from "../types";

// Secret / credential detectors (specification.md §10, policies.md secrets.default).
// Each match carries the raw span value plus a "secret" mask so the value can be
// HMAC-hashed and fixed-width redacted downstream — the raw value never reaches a
// finding or a committable artifact.

type Rule = {
  policyId: string;
  regex: RegExp;
  severity: SecuritySeverity;
  confidence: number;
  remediation: string;
  // For assignment-style rules the sensitive value is the first defined capture
  // group from `valueGroup` on (the quoted and unquoted value forms are separate
  // alternatives); the whole match otherwise.
  valueGroup?: number;
  // A non-regex scanner returning [start, end) spans, for shapes a regex cannot
  // scan in linear time. `regex` is unused when this is set.
  scan?: (content: string) => Array<[number, number]>;
};

// Private key blocks. `-----BEGIN (RSA |EC |…)PRIVATE KEY-----`, PGP's
// `PRIVATE KEY BLOCK`, and PKCS#8 `ENCRYPTED PRIVATE KEY`. Public keys and
// certificates are not matched. The headers are bounded literals; the body is
// found by searching forward for the END line once per block, never by a lazy
// `[\s\S]*?` from every header. A lazy scan made k unclosed headers cost k*n
// (review-performance-slice-35:F-002).
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g;

function scanPrivateKeyBlocks(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let begin: RegExpExecArray | null;
  while ((begin = PRIVATE_KEY_BEGIN.exec(content)) !== null) {
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(content);
    if (end === null) {
      // No END line (`head -20 id_rsa`, a cut-off paste): fail closed and mask
      // to the end of the input. No later header can close either, so stop.
      spans.push([begin.index, content.length]);
      break;
    }
    const stop = end.index + end[0].length;
    spans.push([begin.index, stop]);
    PRIVATE_KEY_BEGIN.lastIndex = stop;
  }
  return spans;
}

// The value of a `NAME = value` assignment. A quoted value runs to its closing
// quote, so a passphrase with spaces or a `#` is masked whole; an unquoted one
// stops at whitespace or `#` (a trailing comment is kept). The last alternative
// keeps an unclosed opening quote (`PASSWORD="abcdefgh`) masked as before.
const ASSIGNED_VALUE = String.raw`(?:"([^"\n]{6,})"|'([^'\n]{6,})'|["']?([^\s"'#]{6,}))`;

const RULES: Rule[] = [
  // Provider-shaped API keys.
  // NOTE (R3-F5, flow 313 W4 review round 3): `detectSecrets` is a shared
  // choke point (output-validation, redact.ts, export-audit.ts, resolve.ts,
  // the audit-harness) — an AWS-shaped key is matched here UNCONDITIONALLY,
  // deliberately including AWS's own documented placeholder shape
  // (`AKIAIOSFODNN7EXAMPLE`), because the output-redaction consumers of this
  // detector fail closed on ANYTHING AWS-key-shaped on purpose (see
  // `output-validation.test.ts`'s "no safe representation" fail-closed
  // case). The documented-placeholder EXEMPTION belongs only where a false
  // positive on that specific literal actually blocks a legitimate W4
  // bundle import — that is `checkSecretsInText` in
  // `security/audit-harness/checks.ts`, which filters this rule's matches
  // down before turning them into findings. Do not add an exemption here:
  // it would silently weaken every other consumer's fail-closed guarantee.
  {
    policyId: "secrets.aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: "critical",
    confidence: 0.98,
    remediation: "Revoke the AWS key and rotate credentials; never commit keys.",
  },
  {
    policyId: "secrets.github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    severity: "critical",
    confidence: 0.97,
    remediation: "Revoke the GitHub token and rotate it.",
  },
  {
    // Fine-grained personal access tokens.
    policyId: "secrets.github-token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g,
    severity: "critical",
    confidence: 0.97,
    remediation: "Revoke the GitHub token and rotate it.",
  },
  {
    policyId: "secrets.google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: "critical",
    confidence: 0.95,
    remediation: "Revoke the Google API key in the cloud console.",
  },
  {
    policyId: "secrets.slack-token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    severity: "critical",
    confidence: 0.95,
    remediation: "Revoke the Slack token.",
  },
  {
    policyId: "secrets.stripe-key",
    regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
    severity: "critical",
    confidence: 0.95,
    remediation: "Roll the Stripe secret key.",
  },
  {
    policyId: "secrets.openai-key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    severity: "high",
    confidence: 0.9,
    remediation: "Rotate the API key.",
  },
  // Private key blocks.
  {
    policyId: "secrets.private-key-block",
    regex: PRIVATE_KEY_BEGIN,
    scan: scanPrivateKeyBlocks,
    severity: "critical",
    confidence: 0.99,
    remediation: "Remove the private key and rotate the corresponding key pair.",
  },
  // URL credentials (scheme://user:pass@host). The scheme is bounded and has
  // no `\b`: `[a-z0-9+.-]*` after `\b` restarted at every `.`/`-`/`+` of a long
  // run with no `://` and backtracked over the rest of it, which is quadratic
  // (review-performance-slice-35:F-001). A longer scheme still matches, from a
  // later start, and the credentials are inside the span either way.
  {
    policyId: "secrets.url-credentials",
    regex: /[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:([^/\s:@]+)@[^\s/]+/gi,
    severity: "high",
    confidence: 0.92,
    remediation: "Remove inline credentials from URLs; use a secrets store.",
  },
  // Credentials embedded in a URL query or in an explicitly sensitive path
  // segment. The span covers only the value, preserving the safe URL shape.
  //
  // R3-F5: a documentation example such as `` `?token=` `` (empty, backticked
  // — describing the QUERY PARAMETER NAME, not a live value) used to still
  // match: the old value class `[^&#\s]+` happily captured the closing
  // backtick itself as a one-character "value". The value class now excludes
  // markdown/quote delimiters (backtick, both quote kinds, angle brackets)
  // and requires at least 3 characters, so an empty or punctuation-only
  // "value" fails to match at all, while a real token (always alphanumeric-
  // shaped, always longer) still does.
  {
    policyId: "secrets.url-sensitive-query",
    regex:
      /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)=([^&#\s`'"<>]{3,})/gi,
    severity: "high",
    confidence: 0.9,
    remediation: "Remove credentials from URL query parameters.",
    valueGroup: 1,
  },
  {
    policyId: "secrets.url-sensitive-path",
    regex:
      /\/(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\/([^/?#\s]{6,})/gi,
    severity: "high",
    confidence: 0.88,
    remediation: "Remove credentials from URL path segments.",
    valueGroup: 1,
  },
  // JWT-like tokens.
  {
    policyId: "secrets.jwt",
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    severity: "high",
    confidence: 0.9,
    remediation: "Treat the JWT as a live credential; do not persist it.",
  },
  // `.env`-style assignments of sensitive keys, and the JSON/YAML form where the
  // NAME itself is quoted (`"ZAI_API_KEY": "…"`). Without the optional closing
  // quote after the name, `\s*[:=]` never reached the colon, so a credential
  // store read back as JSON — which is exactly how keryx persists provider keys
  // in `auth.json` — was not an assignment at all. A key whose VALUE happened to
  // carry a recognised prefix (`sk-…`) was still masked by the provider-shaped
  // rules above, which is why one key in a two-key file could be redacted while
  // the other was printed in full (keryx session 4a24a760).
  // The lowercase credential-file form, restricted to names that mean one thing.
  //
  // `redactSensitiveText`'s own contract names `cat ~/.aws/credentials` as the
  // case it exists to stop, and that file writes `aws_secret_access_key = …` in
  // lower case — which the uppercase env-assignment rule below could never
  // match. Verified before this rule existed: the value passed through to the
  // model context untouched.
  //
  // Deliberately a short, unambiguous list rather than a case-insensitive
  // version of the rule below. `[A-Z0-9_]*SECRET` lowercased would fire on
  // ordinary prose and on identifiers like `client_secret_name`, and a redactor
  // that mangles legitimate text gets turned off.
  {
    policyId: "secrets.credential-file-assignment",
    regex: new RegExp(
      String.raw`\b((?:aws_)?secret_access_key|aws_session_token|aws_secret_key|client_secret)\s*[:=]\s*` +
        ASSIGNED_VALUE,
      "gid",
    ),
    severity: "critical",
    confidence: 0.95,
    remediation: "Rotate the credential; it was read from a credentials file into agent-visible output.",
    valueGroup: 2,
  },
  {
    policyId: "secrets.env-assignment",
    regex: new RegExp(
      String.raw`\b([A-Z0-9_]*(?:DATABASE_URL|JWT_SECRET|SECRET(?:_KEY)?|API_?KEY|ACCESS_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PASSWORD|PRIVATE_?KEY|TOKEN))["']?\s*[:=]\s*` +
        ASSIGNED_VALUE,
      "gd",
    ),
    severity: "high",
    confidence: 0.85,
    remediation: "Move the secret to an untracked env file or secrets manager.",
    valueGroup: 2,
  },
];

export function detectSecrets(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  const push = (rule: Rule, start: number, end: number): void => {
    matches.push({
      category: "secret",
      policyId: rule.policyId,
      severity: rule.severity,
      confidence: rule.confidence,
      start,
      end,
      value: content.slice(start, end),
      mask: "secret",
      remediation: rule.remediation,
    });
  };
  for (const rule of RULES) {
    if (rule.scan) {
      for (const [start, end] of rule.scan(content)) {
        push(rule, start, end);
      }
      continue;
    }
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(content)) !== null) {
      const group = valueGroupOf(rule, m);
      const value = group === undefined ? undefined : m[group];
      if (group === undefined || value === undefined || value.length === 0) {
        continue;
      }
      // Span covers only the sensitive value so redaction never reveals a prefix.
      // The `d` flag gives the group's own offset; `indexOf` would find the value
      // inside the name when they are equal (`PASSWORD=PASSWORD`).
      const start = group === 0 ? m.index : (m.indices?.[group]?.[0] ?? m.index + m[0].indexOf(value));
      push(rule, start, start + value.length);
      if (m.index === rule.regex.lastIndex) {
        rule.regex.lastIndex += 1;
      }
    }
  }
  return matches;
}

function valueGroupOf(rule: Rule, m: RegExpExecArray): number | undefined {
  if (rule.valueGroup === undefined) {
    return 0;
  }
  for (let group = rule.valueGroup; group < m.length; group += 1) {
    if (m[group] !== undefined) {
      return group;
    }
  }
  return undefined;
}
