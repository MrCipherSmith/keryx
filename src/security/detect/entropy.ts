import type { DetectorMatch } from "../types";

// High-entropy string heuristic (specification.md §10). Flags long tokens with
// high Shannon entropy that sit near a sensitive label. Confidence is kept in the
// heuristic band (0.4-0.7) per §7a so it does not over-block.

const SENSITIVE_LABEL = /(key|secret|token|password|passwd|api|credential|auth)/i;
const TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;
const LABEL_WINDOW = 40;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function detectEntropy(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(content)) !== null) {
    const value = m[0];
    const entropy = shannonEntropy(value);
    if (entropy < 3.6) {
      continue;
    }
    const before = content.slice(Math.max(0, m.index - LABEL_WINDOW), m.index);
    if (!SENSITIVE_LABEL.test(before)) {
      continue;
    }
    // Map entropy 3.6..5.0 into confidence 0.4..0.7.
    const confidence = Math.min(0.7, 0.4 + (entropy - 3.6) * 0.21);
    matches.push({
      category: "secret",
      policyId: "secrets.high-entropy",
      severity: "medium",
      confidence: Number(confidence.toFixed(2)),
      start: m.index,
      end: m.index + value.length,
      value,
      mask: "secret",
      remediation: "Verify this high-entropy value is not a live credential.",
    });
  }
  return matches;
}
