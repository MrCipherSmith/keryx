// Injection quarantine for child free-text (flow 090, multi-agent engine
// Phase 3 / AC5).
//
// A child result is `trustLevel: "derived"` and its summary flows into the
// parent's evidence and can steer the parent's NEXT dispatch. A malicious or
// compromised child (especially one running on an untrusted third-party
// provider) could embed instruction-shaped text — fake control tags, turn
// markers, or permission-config mentions — to hijack the orchestrator.
//
// `quarantineChildSummary` scans the summary BEFORE the orchestrator plans a
// next dispatch from it. Matches are FLAGGED with a prepended marker line; the
// original text is NEVER removed or reworded (defense that preserves evidence,
// mirroring Claude Code's output-scanning posture). This is not a substitute for
// tool/policy restrictions — it is a last-line quarantine so child free-text can
// never silently become orchestrator instructions.
//
// Pure and deterministic: no clock/RNG/network/fs; identical input yields
// identical output.

/** One named instruction-shaped pattern the scanner looks for. */
interface QuarantinePattern {
  name: string;
  test: (text: string) => boolean;
}

const PATTERNS: readonly QuarantinePattern[] = [
  {
    // Imitations of harness control tags (e.g. <system-reminder>, </system>).
    name: "control-tag",
    test: (t) => /<\/?\s*(system-reminder|system|important|assistant|human|tool_result|function_calls)\b[^>]*>/i.test(t),
  },
  {
    // Conversation turn markers that try to inject a new role turn.
    name: "turn-marker",
    test: (t) => /(^|\n)\s*(human|assistant|system)\s*:/i.test(t),
  },
  {
    // Permission / capability configuration mentions.
    name: "permission-config",
    test: (t) =>
      /\b(allowed[- ]?tools|disallowed[- ]?tools|permission[- ]?mode|bypass[- ]?permissions|dangerously[- ]?skip)\b/i.test(t),
  },
];

/** Outcome of {@link quarantineChildSummary}. */
export interface QuarantineResult {
  /** True when at least one instruction-shaped pattern matched. */
  flagged: boolean;
  /** Names of the matched patterns (stable order; empty when not flagged). */
  markers: string[];
  /**
   * The summary the orchestrator may read next. Identical to the input when not
   * flagged; when flagged, the ORIGINAL text with a single marker line prepended
   * (never removed, never reworded).
   */
  text: string;
}

/**
 * Scan a child summary for instruction-shaped patterns. When any match, prepend a
 * `[keryx: quarantined child summary — instruction-shaped patterns: ...]` marker
 * line and return `flagged: true`; otherwise return the text unchanged. Pure.
 */
export function quarantineChildSummary(summary: string): QuarantineResult {
  const markers = PATTERNS.filter((p) => p.test(summary)).map((p) => p.name);
  if (markers.length === 0) {
    return { flagged: false, markers: [], text: summary };
  }
  const marker = `[keryx: quarantined child summary — instruction-shaped patterns: ${markers.join(", ")}]`;
  return { flagged: true, markers, text: `${marker}\n${summary}` };
}
