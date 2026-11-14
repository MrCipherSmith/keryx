// The wire request of the quick-start dialog, kept free of React so the root-level surface parity
// test (src/hub/work/surface-parity.test.ts) can import it without the web toolchain.
import { buildAnswers, type QuickModeId, type QuickStartRequest } from "./quick-contract";

/** What the dialog form holds; own criteria are one string, one criterion per line. */
export type QuickDraft = {
  mode: QuickModeId;
  description: string;
  answers: Record<string, string>;
  skipped: Record<string, boolean>;
  criteria: string;
};

/** The wire request for a draft: skipped and blank questions are recorded as skipped, never as empty answers. */
export function quickStartRequest(draft: QuickDraft): QuickStartRequest {
  const answered = Object.fromEntries(
    Object.entries(draft.answers)
      .filter(([id]) => draft.skipped[id] !== true)
      .map(([id, text]) => [id, text.trim()]),
  );
  return {
    mode: draft.mode,
    description: draft.description.trim(),
    answers: [...buildAnswers(draft.mode, answered)],
    criteria: draft.criteria
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}
