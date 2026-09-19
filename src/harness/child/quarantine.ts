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
    // Imitations of harness control tags (e.g. <system-reminder>, </system>),
    // including the agent-bus/child-notification wrappers a forged summary or
    // peer message could imitate to look like a real delivery (review r1 F8):
    // <peer-message> (agent.ts's bus-delivery wrapper) and
    // <task-notification> (its task-completion-inbox counterpart).
    name: "control-tag",
    test: (t) =>
      /<\/?\s*(system-reminder|system|important|assistant|human|tool_result|function_calls|peer-message|task-notification)\b[^>]*>/i.test(
        t,
      ),
  },
  {
    // Conversation turn markers that try to inject a new role turn.
    name: "turn-marker",
    test: (t) => /(^|\n)\s*(human|assistant|system)\s*:/i.test(t),
  },
  {
    // Permission / capability configuration mentions.
    name: "permission-config",
    // `readonly`/`readOnly` (a compact identifier, as specific as `permissionMode`)
    // always matches; the spaced/hyphenated "read only"/"read-only" form is common
    // in ordinary English (e.g. "this field is read-only"), so it only matches
    // paired with "mode" to avoid flagging innocuous text.
    test: (t) =>
      /\b(allowed[- ]?tools|disallowed[- ]?tools|permission[- ]?mode|bypass[- ]?permissions|dangerously[- ]?skip|readonly|read[- ]only[- ]?mode)\b|\/plan\b/i.test(
        t,
      ),
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
 * Scan `text` for instruction-shaped patterns (shared by every quarantine
 * entry point below). When any match, prepend a
 * `[keryx: quarantined <label> — instruction-shaped patterns: ...]` marker
 * line and return `flagged: true`; otherwise return the text unchanged. Pure.
 */
function quarantine(text: string, label: string): QuarantineResult {
  const markers = PATTERNS.filter((p) => p.test(text)).map((p) => p.name);
  if (markers.length === 0) {
    return { flagged: false, markers: [], text };
  }
  const marker = `[keryx: quarantined ${label} — instruction-shaped patterns: ${markers.join(", ")}]`;
  return { flagged: true, markers, text: `${marker}\n${text}` };
}

/**
 * Scan a child summary for instruction-shaped patterns. When any match, prepend a
 * `[keryx: quarantined child summary — instruction-shaped patterns: ...]` marker
 * line and return `flagged: true`; otherwise return the text unchanged. Pure.
 */
export function quarantineChildSummary(summary: string): QuarantineResult {
  return quarantine(summary, "child summary");
}

/**
 * Scan a bus peer message body for the same instruction-shaped patterns
 * `quarantineChildSummary` looks for (flow 274, D-10): a peer agent's message
 * is free text from another process and can equally embed fake control tags,
 * turn markers, or permission-config mentions to try to steer the reading
 * agent. Shares {@link PATTERNS} so the two entry points can never drift
 * apart; only the marker's label differs ("peer message" vs "child summary").
 */
export function quarantinePeerMessage(body: string): QuarantineResult {
  return quarantine(body, "peer message");
}
