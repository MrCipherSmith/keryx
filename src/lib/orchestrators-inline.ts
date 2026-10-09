/** One sentence, rendered verbatim into the managed CLAUDE.md/AGENTS.md block, routing.md and skills/catalog.md. */
export const ORCHESTRATORS_INLINE_NOTE =
  "The orchestrators (`review-orchestrator`, `flow-orchestrator`, `job-orchestrator`) run in the main session: the main agent reads the SKILL.md and runs it inline, and never hands a whole orchestrator to a subagent, because a subagent cannot spawn the reviewers and workers the orchestrator dispatches.";
