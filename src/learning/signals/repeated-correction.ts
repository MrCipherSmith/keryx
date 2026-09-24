// W3 spec, "Deterministic extraction signals" > "Repeated correction". Like
// `reverted-edit.ts`, pure over the observation window's hash-only `edit`
// field — never diff content.
import { basenameFromInputPreview, clampLearningText } from "./text";
import type { ObservationLine, SignalDraft, SignalRunner } from "./types";

const MAX_TURN_STOPS_BETWEEN = 3;

/**
 * Same session, same `edit.pathDigest`: an earlier event A and a later event
 * B where B's diff removes what A added (`B.removedDigest === A.addedDigest`)
 * but B is NOT a plain revert of A (`B.addedDigest !== A.removedDigest` —
 * that shape belongs to `reverted-edit.ts`), and B falls within at most 3
 * `turn-stop` events after A in the same session.
 */
export async function repeatedCorrectionSignal(_root: string, window: ObservationLine[]): Promise<SignalDraft[]> {
  const drafts: SignalDraft[] = [];
  const bySession = new Map<string, ObservationLine[]>();
  for (const line of window) {
    const arr = bySession.get(line.event.sessionId);
    if (arr) arr.push(line);
    else bySession.set(line.event.sessionId, [line]);
  }

  for (const lines of bySession.values()) {
    const editIndexes: number[] = [];
    lines.forEach((line, index) => {
      if (line.event.event === "tool-complete" && line.event.edit) editIndexes.push(index);
    });

    for (let ai = 0; ai < editIndexes.length; ai++) {
      const aIndex = editIndexes[ai]!;
      const a = lines[aIndex]!;
      const editA = a.event.edit!;
      if (editA.addedDigest === null) continue;

      for (let bi = ai + 1; bi < editIndexes.length; bi++) {
        const bIndex = editIndexes[bi]!;
        const b = lines[bIndex]!;
        const editB = b.event.edit!;
        if (editB.pathDigest !== editA.pathDigest) continue;
        if (editB.removedDigest === null) continue;
        if (editB.removedDigest !== editA.addedDigest) continue;
        if (editA.removedDigest !== null && editB.addedDigest === editA.removedDigest) continue; // plain revert, not a correction

        const turnStopsBetween = lines
          .slice(aIndex + 1, bIndex + 1)
          .filter((line) => line.event.event === "turn-stop").length;
        if (turnStopsBetween > MAX_TURN_STOPS_BETWEEN) continue;

        const basename = basenameFromInputPreview(b.event.inputPreview);
        drafts.push({
          domain: "workflow",
          trigger: clampLearningText(`When ${basename} needs correcting again soon after an edit in this project`),
          action: clampLearningText(`Check the first edit's assumptions before writing a second one to ${basename}.`),
          evidence: [
            {
              kind: "reinforcement",
              sourceType: "observation",
              sourceRef: b.sourceRef,
              observedAt: b.event.observedAt,
              weight: 1,
            },
          ],
          extractor: "repeated-correction",
        });
        break;
      }
    }
  }
  return drafts;
}

export const REPEATED_CORRECTION_SIGNAL: SignalRunner = {
  name: "repeated-correction",
  domain: "workflow",
  run: repeatedCorrectionSignal,
};
