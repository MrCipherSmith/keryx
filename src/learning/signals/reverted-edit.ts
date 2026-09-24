// W3 spec, "Deterministic extraction signals" > "Reverted edit". Pure over
// the observation window's hash-only `edit` field (plan decision D3) — no
// diff content is ever read or stored.
import { basenameFromInputPreview, clampLearningText } from "./text";
import type { ObservationLine, SignalDraft, SignalRunner } from "./types";

/**
 * Same session, same `edit.pathDigest`: an earlier event A and a later event
 * B where B undoes A byte-for-byte (`B.removedDigest === A.addedDigest` AND
 * `B.addedDigest === A.removedDigest`, both non-null). One draft per (A, B)
 * pair found, evidence pointing at B.
 */
export async function revertedEditSignal(_root: string, window: ObservationLine[]): Promise<SignalDraft[]> {
  const drafts: SignalDraft[] = [];
  const bySession = new Map<string, ObservationLine[]>();
  for (const line of window) {
    if (line.event.event !== "tool-complete" || !line.event.edit) continue;
    const arr = bySession.get(line.event.sessionId);
    if (arr) arr.push(line);
    else bySession.set(line.event.sessionId, [line]);
  }

  for (const lines of bySession.values()) {
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i]!;
      const editA = a.event.edit!;
      if (editA.addedDigest === null || editA.removedDigest === null) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j]!;
        const editB = b.event.edit!;
        if (editB.pathDigest !== editA.pathDigest) continue;
        if (editB.removedDigest === null || editB.addedDigest === null) continue;
        if (editB.removedDigest !== editA.addedDigest || editB.addedDigest !== editA.removedDigest) continue;

        const basename = basenameFromInputPreview(b.event.inputPreview);
        drafts.push({
          domain: "workflow",
          trigger: clampLearningText(`When an edit to ${basename} is immediately reverted in this project`),
          action: clampLearningText(
            `Treat the revert as a signal the edit was wrong: reconsider the approach before editing ${basename} again.`,
          ),
          evidence: [
            {
              kind: "reinforcement",
              sourceType: "observation",
              sourceRef: b.sourceRef,
              observedAt: b.event.observedAt,
              weight: 1,
            },
          ],
          extractor: "reverted-edit",
        });
        break;
      }
    }
  }
  return drafts;
}

export const REVERTED_EDIT_SIGNAL: SignalRunner = {
  name: "reverted-edit",
  domain: "workflow",
  run: revertedEditSignal,
};
