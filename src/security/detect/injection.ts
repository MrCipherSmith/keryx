import type { DetectorMatch } from "../types";

// Prompt-injection heuristics (policies.md prompt-injection.default). These are
// intentionally low-confidence (< 0.5, §7a) so a lone injection signal is only a
// `warn`; escalation happens in resolve.ts when combined with an egress signal.
//
// S-7 (flow 355, AC3): the gaps below used to be `[^.\n]{0,N}` — a newline
// between the trigger word and the target word (a model or a pasted document
// commonly wraps "Ignore all previous\ninstructions" at the word boundary)
// defeated every pattern here, though nothing about the ATTACK changed at a
// line break. `.` still ends a gap (two genuinely separate sentences should
// not fuse into one match), but `\n` no longer does.

/**
 * A small, closed confusables map: Cyrillic and Greek letters that a phrase
 * evasion substitutes for their Latin look-alikes (`harness/web/web-content.ts`'s
 * `isUnsafeExternalInstruction` is `detectInjection`'s one consumer for
 * untrusted web content, which is exactly where a pasted homoglyph phrase
 * arrives). Each entry maps ONE UTF-16 code unit to ONE UTF-16 code unit so
 * folding never changes the string's length — match offsets stay valid
 * indices into the ORIGINAL content, which `location`/`value` below both rely
 * on.
 *
 * Deliberately narrow rather than a general confusables table: a table wide
 * enough to fold every Unicode look-alike also folds letters that appear in
 * ordinary non-English prose, which would turn this heuristic into a filter on
 * language rather than on evasion.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic → Latin.
  "а": "a", "А": "A",
  "е": "e", "Е": "E",
  "о": "o", "О": "O",
  "р": "p", "Р": "P",
  "с": "c", "С": "C",
  "х": "x", "Х": "X",
  "у": "y", "У": "Y",
  "ѕ": "s", "Ѕ": "S",
  "і": "o", "І": "O", // flow 355 AC3's own evasion: "Ignіre" (U+0456) for "Ignore".
  "ј": "j", "Ј": "J",
  // Greek → Latin.
  "α": "a", "Α": "A",
  "β": "b", "Β": "B",
  "ε": "e", "Ε": "E",
  "ι": "i", "Ι": "I",
  "κ": "k", "Κ": "K",
  "ο": "o", "Ο": "O",
  "ρ": "p", "Ρ": "P",
  "τ": "t", "Τ": "T",
  "υ": "u", "Υ": "Y",
  "χ": "x", "Χ": "X",
};

/**
 * Fold confusables, then NFKC — in THAT order, and only when NFKC does not
 * change the length. NFKC can expand a ligature (`"ﬁ"` → `"fi"`) or otherwise
 * move offsets, which would corrupt every match position after it, not just
 * the folded character's own span; skipping it on a length change keeps
 * `start`/`end` valid indices into the string actually matched against, at
 * the cost of not folding the rare compatibility form that also changes
 * length. The confusables map above never changes length by construction, so
 * it always applies.
 */
function foldForMatching(content: string): string {
  let folded = "";
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] as string;
    folded += CONFUSABLES[ch] ?? ch;
  }
  const nfkc = folded.normalize("NFKC");
  return nfkc.length === folded.length ? nfkc : folded;
}

const PATTERNS: Array<{ policyId: string; regex: RegExp; confidence: number }> = [
  {
    policyId: "prompt-injection.ignore-instructions",
    regex:
      /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(all\s+)?(previous|prior|above|earlier|system|developer)\b[^.]{0,20}\b(instructions?|prompts?|rules?|context)\b/gi,
    confidence: 0.4,
  },
  {
    policyId: "prompt-injection.reveal-context",
    regex:
      /\b(reveal|show|print|expose|leak|dump|repeat)\b[^.]{0,30}\b(your\s+)?(system\s+prompt|instructions?|memory|secrets?|hidden\s+context|api\s*keys?)\b/gi,
    confidence: 0.45,
  },
  {
    policyId: "prompt-injection.role-override",
    regex:
      /\b(you\s+are\s+now|from\s+now\s+on|act\s+as|pretend\s+to\s+be)\b[^.]{0,40}\b(unrestricted|jailbroken|dan|admin|developer\s+mode|no\s+rules)\b/gi,
    confidence: 0.4,
  },
  {
    policyId: "prompt-injection.priority-override",
    regex:
      /\b(treat|follow|obey)\b[^.]{0,30}\b(the\s+)?(following|external|below)\b[^.]{0,20}\b(as\s+)?(instructions?|higher\s+priority|commands?)\b/gi,
    confidence: 0.35,
  },
];

export function detectInjection(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  const folded = foldForMatching(content);
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(folded)) !== null) {
      // Reported against the ORIGINAL content — when folding changed nothing
      // at this span (the overwhelming common case: plain ASCII input), this
      // is byte-identical to `m[0]`. It only differs when a confusable inside
      // the matched span was folded, and then it is the ATTACKER'S actual
      // text, which is what a human reviewing a finding needs to see.
      const start = Math.min(m.index, content.length);
      const end = Math.min(m.index + m[0].length, content.length);
      matches.push({
        category: "prompt-injection",
        policyId: pattern.policyId,
        severity: "low",
        confidence: pattern.confidence,
        start,
        end,
        value: content.slice(start, end),
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
