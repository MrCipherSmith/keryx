import type { RoutingDecision } from "./decision";
import { modelRefKey, type ModelRef } from "./model-class";

/** `<provider>/<model>`, the form `keryx routing` commands take. */
function displayRef(target: ModelRef): string {
  return `${target.providerId}/${target.modelId}`;
}

/**
 * Operator-facing text for a model whose context length routing does not know. "Unknown" and
 * "too small" need different fixes — a profile or a different pin, not a bigger model — so the
 * text names the model and both fixes instead of the bare reason token.
 */
export function contextUnknownGuidance(target: ModelRef, category: string): string {
  const key = displayRef(target);
  return `${key} has no known context length (no model profile), so routing cannot show it fits this ${category} request. `
    + `Record it with \`keryx routing profile set ${key} --context <tokens>\`, `
    + `or route ${category} to the session model with \`keryx routing set ${category} baseline\`.`;
}

/** Notice for an explicit user pin that routing honoured although its context length is unknown. */
export function contextUnknownPinNotice(target: ModelRef, category: string): string {
  const key = displayRef(target);
  return `${category} uses ${key}, pinned by you, although its context length is unknown (no model profile); `
    + `routing could not check that it fits. Record it with \`keryx routing profile set ${key} --context <tokens>\` to have it checked.`;
}

/** Every operator-readable line a decision carries about an unknown context length: exclusions and honoured-pin notices. */
export function contextUnknownLines(decision: RoutingDecision, category: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const exclusion of decision.exclusions) {
    if (exclusion.reason !== "context-unknown" || exclusion.target === undefined) continue;
    const key = modelRefKey(exclusion.target);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(contextUnknownGuidance(exclusion.target, category));
  }
  for (const notice of decision.notices ?? []) lines.push(contextUnknownPinNotice(notice.target, category));
  return lines;
}
