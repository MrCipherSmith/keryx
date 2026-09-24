// `keryx learn apply` (W3 spec "Apply"; plan module table). STUB — T9 fills
// this in. Exported now, with its final signature, so `commands/learn.ts`
// (T8) and later tasks can wire against it without a second signature change.
//
// T9's job: `learnedPatternToProposal(record, skill)` (pure — carries
// `confidenceLevel`) plus `applyLearnedPattern`, which for a `domain` other
// than `review-conventions` renders the accepted pattern's `trigger`/`action`
// into a `LearningProposal` (`src/gdskills/learn.ts`'s existing shape) under
// `.metaproject/data/gdskills/proposals/`, then calls the existing
// `applyLearningProposal` — still the only writer, unchanged. A
// `review-conventions` record with a `reviewerProfile` is applied a different
// way (`keryx review learn --reviewer <id>`, also T9), not through this
// function.
export class LearningApplyError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningApplyError";
  }
}

export interface ApplyLearnedPatternOptions {
  /** `<module>/<name>` — the target project skill, same shape `keryx skills learn --skill` already takes. */
  skill: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * NOT IMPLEMENTED (T9). Always throws `LearningApplyError` with reason
 * `"not-implemented"`.
 */
export async function applyLearnedPattern(root: string, id: string, opts: ApplyLearnedPatternOptions): Promise<never> {
  void root;
  void id;
  void opts;
  throw new LearningApplyError("not-implemented", "applyLearnedPattern is not implemented yet (flow 312, T9)");
}
