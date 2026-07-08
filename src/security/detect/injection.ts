import type { DetectorMatch } from "../types";

// Prompt-injection heuristics (policies.md prompt-injection.default). These are
// intentionally low-confidence (< 0.5, §7a) so a lone injection signal is only a
// `warn`; escalation happens in resolve.ts when combined with an egress signal.

const PATTERNS: Array<{ policyId: string; regex: RegExp; confidence: number }> = [
  {
    policyId: "prompt-injection.ignore-instructions",
    regex:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all\s+)?(previous|prior|above|earlier|system|developer)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|context)\b/gi,
    confidence: 0.4,
  },
  {
    policyId: "prompt-injection.reveal-context",
    regex:
      /\b(reveal|show|print|expose|leak|dump|repeat)\b[^.\n]{0,30}\b(your\s+)?(system\s+prompt|instructions?|memory|secrets?|hidden\s+context|api\s*keys?)\b/gi,
    confidence: 0.45,
  },
  {
    policyId: "prompt-injection.role-override",
    regex:
      /\b(you\s+are\s+now|from\s+now\s+on|act\s+as|pretend\s+to\s+be)\b[^.\n]{0,40}\b(unrestricted|jailbroken|dan|admin|developer\s+mode|no\s+rules)\b/gi,
    confidence: 0.4,
  },
  {
    policyId: "prompt-injection.priority-override",
    regex:
      /\b(treat|follow|obey)\b[^.\n]{0,30}\b(the\s+)?(following|external|below)\b[^.\n]{0,20}\b(as\s+)?(instructions?|higher\s+priority|commands?)\b/gi,
    confidence: 0.35,
  },
];

export function detectInjection(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(content)) !== null) {
      matches.push({
        category: "prompt-injection",
        policyId: pattern.policyId,
        severity: "low",
        confidence: pattern.confidence,
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
        remediation:
          "Treat external content as data, not instruction; require human review.",
      });
      if (m.index === pattern.regex.lastIndex) {
        pattern.regex.lastIndex += 1;
      }
    }
  }
  return matches;
}
