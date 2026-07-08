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
  // Block E (E4): a checksum/range validator that GATES a candidate — a match is
  // only emitted when `validate(value)` is true, so invalid-checksum items (the
  // known regex false positives) are never flagged (AC4.1, AC4.2).
  validate?: (value: string) => boolean;
};

// ---------------------------------------------------------------------------
// Structured-PII checksum validators (E4). Pure, dependency-free, deterministic.
// ---------------------------------------------------------------------------

// IBAN: structural length by-country is not enforced; correctness is the ISO
// 7064 mod-97-10 check (rearrange, letters→digits, remainder must be 1).
export function isValidIban(value: string): boolean {
  const iban = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// Credit card: 13–19 digits passing the Luhn checksum (separators stripped).
export function isValidCreditCard(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// US SSN: valid area (not 000/666/900-999), group (not 00), serial (not 0000).
export function isValidSsn(value: string): boolean {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return false;
  const area = Number(m[1]);
  const group = Number(m[2]);
  const serial = Number(m[3]);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0) return false;
  if (serial === 0) return false;
  return true;
}

// IPv4 (octet range) or IPv6 (structural). Rejects malformed / out-of-range.
export function isValidIp(value: string): boolean {
  const v = value.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    return v4.slice(1, 5).every((oct) => {
      if (oct === undefined) return false;
      if (oct.length > 1 && oct.startsWith("0")) return false; // no leading zeros
      const n = Number(oct);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6: 2–8 hextet groups, optional single `::` compression.
  if (/^[0-9A-Fa-f:]+$/.test(v) && v.includes(":")) {
    const doubleColon = (v.match(/::/g) ?? []).length;
    if (doubleColon > 1) return false;
    const groups = v.split(":");
    if (doubleColon === 0 && groups.length !== 8) return false;
    if (doubleColon === 1 && groups.length > 8) return false;
    return groups.every((g) => g === "" || /^[0-9A-Fa-f]{1,4}$/.test(g));
  }
  return false;
}

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
  // E4 structured PII — each gated by a checksum/range validator so an
  // invalid-checksum candidate is NOT flagged (eliminates known false positives).
  {
    policyId: "pii.iban",
    mask: "iban",
    regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b/g,
    severity: "high",
    confidence: 0.9,
    validate: isValidIban,
  },
  {
    policyId: "pii.credit-card",
    mask: "cc",
    regex: /\b\d(?:[ -]?\d){12,18}\b/g,
    severity: "high",
    confidence: 0.9,
    validate: isValidCreditCard,
  },
  {
    policyId: "pii.ssn",
    mask: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: "high",
    confidence: 0.85,
    validate: isValidSsn,
  },
  {
    policyId: "pii.ip",
    mask: "ip",
    regex: /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}|::1)\b/g,
    severity: "low",
    confidence: 0.6,
    validate: isValidIp,
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
      // E4: gate structured-PII candidates by their checksum/range validator.
      if (rule.validate && !rule.validate(value)) {
        continue;
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
