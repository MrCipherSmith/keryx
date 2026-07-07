import type { DetectorMatch, SecurityConfig } from "../types";
import { detectSecrets } from "./secrets";
import { detectEntropy } from "./entropy";
import { detectPii } from "./pii";
import { detectInjection } from "./injection";
import { detectEgress } from "./egress";

export { detectSecrets } from "./secrets";
export { detectEntropy } from "./entropy";
export { detectPii } from "./pii";
export { detectInjection } from "./injection";
export { detectEgress } from "./egress";

// Run every enabled detector over `content` and return raw matches. Policy
// enable flags gate which detector categories run; entropy is additionally gated
// by the entropy backend flag. De-duplicates overlapping secret spans so an
// entropy hit never doubles a precise secret hit at the same offset.
export function runDetectors(content: string, config: SecurityConfig): DetectorMatch[] {
  const matches: DetectorMatch[] = [];

  if (config.policies.secrets.enabled) {
    matches.push(...detectSecrets(content));
    if (config.backends.entropy.enabled) {
      matches.push(...detectEntropy(content));
    }
  }
  if (config.policies.pii.enabled) {
    matches.push(...detectPii(content));
  }
  if (config.policies.promptInjection.enabled) {
    matches.push(...detectInjection(content));
  }
  if (config.policies.egress.enabled) {
    matches.push(...detectEgress(content));
  }

  return dedupeOverlaps(matches);
}

// Drop a lower-confidence match whose span is fully contained by a
// higher-confidence match of the same category (e.g. entropy inside an exact
// secret). Keeps the strongest signal per region.
function dedupeOverlaps(matches: DetectorMatch[]): DetectorMatch[] {
  const kept: DetectorMatch[] = [];
  const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
  for (const candidate of sorted) {
    const covered = kept.some(
      (existing) =>
        existing.category === candidate.category &&
        candidate.start >= existing.start &&
        candidate.end <= existing.end,
    );
    if (!covered) {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}
