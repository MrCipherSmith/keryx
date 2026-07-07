import type { DetectorMatch } from "../types";

// Egress / exfiltration heuristics (policies.md egress.default). Detects
// instructions to send data to an external URL and attempts to publish private
// project files. These are the escalation trigger for prompt-injection (§7a).

const SEND_VERB =
  /\b(send|post|upload|exfiltrate|transmit|forward|leak|curl|wget|fetch|email|share)\b/i;
const EXTERNAL_URL = /\bhttps?:\/\/[^\s"'<>)]+/gi;

const PRIVATE_FILE =
  /(\.metaproject\/memory\b|\.metaproject\/data\/[^\s"']*\/raw\b|raw\s+logs?\b|\.env\b|local\s+config)/gi;

const SEND_WINDOW = 60;

export function detectEgress(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];

  EXTERNAL_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXTERNAL_URL.exec(content)) !== null) {
    const url = m[0];
    const before = content.slice(Math.max(0, m.index - SEND_WINDOW), m.index);
    const hasSendVerb = SEND_VERB.test(before);
    if (!hasSendVerb) {
      continue;
    }
    matches.push({
      category: "egress",
      policyId: "egress.external-url-send",
      severity: "critical",
      confidence: 0.75,
      start: m.index,
      end: m.index + url.length,
      value: url,
      remediation:
        "Do not send project data to external URLs without explicit approval.",
    });
    if (m.index === EXTERNAL_URL.lastIndex) {
      EXTERNAL_URL.lastIndex += 1;
    }
  }

  PRIVATE_FILE.lastIndex = 0;
  while ((m = PRIVATE_FILE.exec(content)) !== null) {
    const value = m[0];
    // Only treat a private-file reference as egress when paired with a send verb
    // somewhere in the surrounding window (otherwise it is a benign mention).
    const window = content.slice(
      Math.max(0, m.index - SEND_WINDOW),
      Math.min(content.length, m.index + value.length + SEND_WINDOW),
    );
    if (!SEND_VERB.test(window)) {
      continue;
    }
    matches.push({
      category: "egress",
      policyId: "egress.private-file-publish",
      severity: "high",
      confidence: 0.65,
      start: m.index,
      end: m.index + value.length,
      value,
      remediation: "Never publish private memory/raw/config files externally.",
    });
    if (m.index === PRIVATE_FILE.lastIndex) {
      PRIVATE_FILE.lastIndex += 1;
    }
  }

  return matches;
}
