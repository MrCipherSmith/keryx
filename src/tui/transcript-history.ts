// UI retention is independent of session persistence and model context pruning.
export const TRANSCRIPT_HISTORY_LIMIT = 256;
type Policy = { protected: () => boolean; evict?: () => void };
const policies = new WeakMap<object, Policy>();
/** Install before mounting: add() may synchronously evict older children. */
export function trackTranscriptNode(node: object, policy: Policy): void { policies.set(node, policy); }
export function transcriptNodeProtected(node: object): boolean { return policies.get(node)?.protected() === true; }
export function forgetTranscriptNode(node: object): void {
  policies.get(node)?.evict?.();
  policies.delete(node);
}
