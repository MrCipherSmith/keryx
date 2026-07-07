import type { DetectorMatch, SecuritySeverity } from "../types";

// PII detectors (policies.md pii.default). Emails/phones are near-exact; address
// and person-name are context heuristics with lower confidence. Each match uses a
// typed mask ("email"/"phone"/"address"/"name") so redaction is length-hiding and
// typed per §10a.

type Rule = {
  policyId: string;
  mask: string;
  regex: RegExp;
  severity: SecuritySeverity;
  confidence: number;
  valueGroup?: number;
};

const RULES: Rule[] = [
  {
    policyId: "pii.email",
    mask: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: "medium",
    confidence: 0.85,
  },
  {
    policyId: "pii.phone",
    mask: "phone",
    // International or grouped phone numbers with at least 9 digits of signal.
    regex: /(?<![\w.])(\+?\d[\d\s().-]{7,}\d)(?![\w.])/g,
    severity: "medium",
    confidence: 0.7,
    valueGroup: 1,
  },
  {
    policyId: "pii.address",
    mask: "address",
    regex:
      /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b\.?/g,
    severity: "low",
    confidence: 0.55,
  },
  {
    policyId: "pii.person-name",
    mask: "name",
    // Only when context suggests user/customer identity.
    regex:
      /\b(?:name\s+is|customer|client|user|patient|employee)\s*:?\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g,
    severity: "low",
    confidence: 0.45,
    valueGroup: 1,
  },
];

function countDigits(value: string): number {
  let n = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") n += 1;
  }
  return n;
}

export function detectPii(content: string): DetectorMatch[] {
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
      // Guard the loose phone pattern: require enough digits and reject
      // year-like or short runs.
      if (rule.policyId === "pii.phone") {
        const digits = countDigits(value);
        if (digits < 9 || digits > 15) {
          continue;
        }
      }
      const start = group === 0 ? m.index : m.index + m[0].indexOf(value);
      matches.push({
        category: "pii",
        policyId: rule.policyId,
        severity: rule.severity,
        confidence: rule.confidence,
        start,
        end: start + value.length,
        value,
        mask: rule.mask,
        remediation: "Redact personal data before persisting or publishing.",
      });
      if (m.index === rule.regex.lastIndex) {
        rule.regex.lastIndex += 1;
      }
    }
  }
  return matches;
}
