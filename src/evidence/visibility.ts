import { createHash } from "node:crypto";
import { isVerifiedVisibleProjection, verifiedVisibleRequest, type VisibleProjection, type VisibleLocator } from "../harness/provider/visible-context";
interface Candidate { sourceId: string; versionHash: string; contentHash: string; locator: VisibleLocator; text: string }
function sameLocator(a: VisibleLocator, b: VisibleLocator): boolean {
  return a.kind === b.kind && a.startByte === b.startByte && a.endByte === b.endByte &&
    (a.kind === "file" && b.kind === "file" ? a.startLine === b.startLine && a.endLine === b.endLine :
      a.kind === "archive" && b.kind === "archive" && a.recordId === b.recordId);
}
/** Conservative exact-span proof: no substring/topic/session-prefix heuristics. */
export function filterVisibleEvidence<T extends Candidate>(items: readonly T[], projection: VisibleProjection | undefined,
  requestHash: string): { items: T[]; suppressed: T[]; diagnostics: string[] } {
  if (!projection || !isVerifiedVisibleProjection(projection, requestHash))
    return { items: [...items], suppressed: [], diagnostics: [] };
  const kept: T[] = [], suppressed: T[] = [];
  for (const item of items) {
    const exact = createHash("sha256").update(item.text).digest("hex") === item.contentHash && projection.spans.some(span =>
      span.coverage === "exact" && span.sourceId === item.sourceId && span.versionHash === item.versionHash &&
      span.contentHash === item.contentHash && sameLocator(span.locator, item.locator));
    (exact ? suppressed : kept).push(item);
  }
  return { items: kept, suppressed, diagnostics: suppressed.length ? ["visible-filtered"] : [] };
}
/** At most two assemblies, no retrieval/network retry. Base MUST be the retained
 * evidence-free request. Only returned request.body may be sent: speculative
 * assemblies are discarded. Caller preserves required context in every assembly.
 */
export async function verifyVisibleRepack<T extends Candidate>(original: readonly T[], base: VisibleProjection,
  assemble: (items: readonly T[]) => Promise<VisibleProjection>): Promise<{ items: T[]; diagnostics: string[]; request: ReturnType<typeof verifiedVisibleRequest> }> {
  const fallback = verifiedVisibleRequest(base);
  let selection = filterVisibleEvidence(original, base, base.requestHash);
  for (let attempt = 0; attempt < 2; attempt++) {
    const final = await assemble(selection.items);
    const verified = filterVisibleEvidence(selection.suppressed, final, final.requestHash);
    if (!verified.items.length) return { items: selection.items, diagnostics: selection.diagnostics, request: verifiedVisibleRequest(final) };
    if (attempt === 1) return { items: [], diagnostics: ["visibility-unstable"], request: fallback };
    const restored = new Set(verified.items);
    selection = { items: original.filter(item => selection.items.includes(item) || restored.has(item)),
      suppressed: selection.suppressed.filter(item => !restored.has(item)), diagnostics: selection.diagnostics };
  }
  return { items: [], diagnostics: ["visibility-unstable"], request: fallback };
}
