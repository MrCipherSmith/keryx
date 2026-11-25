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

function nextMatch(pattern: RegExp, content: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(content);
}

// What may come before a key line in a tool's listing: a line number (`cat -n`, `grep -n`/`rg -n`
// with or without a path, keryx's own `ctx rg` summary item), then indentation (a YAML or JSON value).
const LINE_PREFIX = String.raw`(?:\s*\d+\t|(?:[^\s:]*:)?\d+[:-]|\s*- \d+:\d+ )?\s*`;
// A line of key body: base64, the PGP checksum line (`=abcd`) included.
const PEM_BODY_LINE = new RegExp(String.raw`^${LINE_PREFIX}=?[A-Za-z0-9+/]+={0,2}\s*$`);
// A header field between a key's BEGIN line and its body (RFC 1421 PEM, OpenPGP armor).
const PEM_HEADER_FIELD = new RegExp(String.raw`^${LINE_PREFIX}(?:Proc-Type|DEK-Info|Content-Domain|Version|Comment|Hash|Charset|MessageID): `);
// Nothing but a line prefix: the text an END line may have before its marker and still be a key line.
const LINE_PREFIX_ONLY = new RegExp(String.raw`^${LINE_PREFIX}$`);

const NEWLINE = 10;
const BACKSLASH = 92;

function isBase64Code(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
}

// True when the `n` or `r` at `index` ends a `\n` / `\r` escape: an odd number of backslashes before it.
function endsEscape(content: string, index: number, from: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= from && content.charCodeAt(i) === BACKSLASH; i--) slashes += 1;
  return slashes % 2 === 1;
}

// Where an END line with no header before it starts its mask (flow 523 review R2-SC-003): the start
// of the key body directly above it, never further back than `from`. On the END's own line the body
// is the run of base64 and `\n`/`\r` escapes before the marker (a key serialized into one line, as
// JSON does); the run ends at any other character, a quote included, so a JSON string stays whole.
// When that run fills the line (after a line prefix), the lines above that look like key body — base64
// lines, PEM header fields, blank lines between them — are masked too, each from its start, up to the
// first line that does not (the line a tail cut starts after, a frame keryx wrote, a record). Linear:
// each character between `from` and the END line is read at most once.
function orphanBodyStart(content: string, endIndex: number, from: number): number {
  let run = endIndex;
  while (run > from) {
    const code = content.charCodeAt(run - 1);
    if ((code === 110 || code === 114) && endsEscape(content, run - 1, from)) {
      run -= 2;
    } else if (isBase64Code(code)) {
      run -= 1;
    } else {
      break;
    }
  }
  let lineStart = run;
  while (lineStart > from && content.charCodeAt(lineStart - 1) !== NEWLINE) lineStart -= 1;
  if (!LINE_PREFIX_ONLY.test(content.slice(lineStart, run))) return run;
  let start = lineStart;
  let headerSeen = false;
  let below = lineStart;
  while (below > from) {
    const lineEnd = below - 1; // the newline that ends the line above
    let lineBegin = lineEnd;
    while (lineBegin > from && content.charCodeAt(lineBegin - 1) !== NEWLINE) lineBegin -= 1;
    const line = content.slice(lineBegin, lineEnd);
    below = lineBegin;
    if (line.trim().length === 0) continue; // masked only under a key line above it
    if (PEM_HEADER_FIELD.test(line)) {
      headerSeen = true; // header fields sit above the body: only more of them can follow
    } else if (headerSeen || !PEM_BODY_LINE.test(line)) {
      break;
    }
    start = lineBegin;
  }
  return start;
}

// Both cuts of a window fail closed. A header with no END line (`head -20 id_rsa`, a cut-off paste)
// masks to the end of the input. An END line with no header before it (`tail -20 id_rsa`, a terminal
// tail cut inside the key — flow 523 review SC3-001) masks the key body directly above it and the END
// line (`orphanBodyStart`): its body lines are key material whatever cut them, but the text above
// them is not (review R2-SC-003). Each pattern is searched forward from where the last block ended,
// and a header found ahead is kept until it is reached, so the scan stays linear.
function scanPrivateKeyBlocks(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  let begin = nextMatch(PRIVATE_KEY_BEGIN, content, 0);
  let end = nextMatch(PRIVATE_KEY_END, content, 0);
  while (begin !== null || end !== null) {
    if (end !== null && (begin === null || end.index < begin.index)) {
      const stop = end.index + end[0].length;
      spans.push([orphanBodyStart(content, end.index, from), stop]);
      from = stop;
      end = nextMatch(PRIVATE_KEY_END, content, stop);
      continue;
    }
    if (begin === null) break;
    const headerEnd = begin.index + begin[0].length;
    if (end !== null && end.index < headerEnd) end = nextMatch(PRIVATE_KEY_END, content, headerEnd);
    if (end === null) {
      // No later header can close either, so stop.
      spans.push([begin.index, content.length]);
      break;
    }
    const stop = end.index + end[0].length;
    spans.push([begin.index, stop]);
    from = stop;
    begin = nextMatch(PRIVATE_KEY_BEGIN, content, stop);
    end = nextMatch(PRIVATE_KEY_END, content, stop);
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
