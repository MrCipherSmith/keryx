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
  // For assignment-style rules the captured group 1 is the sensitive value; the
  // whole match otherwise.
  valueGroup?: number;
};

const RULES: Rule[] = [
  // Provider-shaped API keys.
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
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: "critical",
    confidence: 0.99,
    remediation: "Remove the private key and rotate the corresponding key pair.",
  },
  // URL credentials (scheme://user:pass@host).
  {
    policyId: "secrets.url-credentials",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s:@]+)@[^\s/]+/gi,
    severity: "high",
    confidence: 0.92,
    remediation: "Remove inline credentials from URLs; use a secrets store.",
  },
  // JWT-like tokens.
  {
    policyId: "secrets.jwt",
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    severity: "high",
    confidence: 0.9,
    remediation: "Treat the JWT as a live credential; do not persist it.",
  },
  // `.env`-style assignments of sensitive keys.
  {
    policyId: "secrets.env-assignment",
    regex:
      /\b([A-Z0-9_]*(?:DATABASE_URL|JWT_SECRET|SECRET(?:_KEY)?|API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PASSWORD|PRIVATE_?KEY|TOKEN))\s*[:=]\s*["']?([^\s"'#]{6,})/g,
    severity: "high",
    confidence: 0.85,
    remediation: "Move the secret to an untracked env file or secrets manager.",
    valueGroup: 2,
  },
];

export function detectSecrets(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(content)) !== null) {
      const group = rule.valueGroup ?? 0;
      const value = m[group];
      if (value === undefined || value.length === 0) {
        continue;
      }
      // Span covers only the sensitive value so redaction never reveals a prefix.
      const start = group === 0 ? m.index : m.index + m[0].indexOf(value);
      matches.push({
        category: "secret",
        policyId: rule.policyId,
        severity: rule.severity,
        confidence: rule.confidence,
        start,
        end: start + value.length,
        value,
        mask: "secret",
        remediation: rule.remediation,
      });
      if (m.index === rule.regex.lastIndex) {
        rule.regex.lastIndex += 1;
      }
    }
  }
  return matches;
}
