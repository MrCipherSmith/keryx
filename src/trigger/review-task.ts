// Flow 457 (T7, audit row 16): a `flow-next` dispatch of a review task.
//
// An unattended agent is never offered `spawn_subagent` (./unattended.ts), and a managed review dispatches its
// reviewers as subagents, so a review task handed to that agent could only end BLOCKED. A review task is routed to
// the autonomous review runner instead (`keryx review run --autonomous`), which runs its own keryx shell in the
// review-autonomous profile with its own floors, over the flow's work: the range from the default branch to the
// commit checked out.
//
// Pure: no I/O.

export interface ReviewTaskLike {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}

/** Whether a flow task is a review the dispatcher hands to the autonomous runner rather than to an unattended agent. */
export function isReviewTask(task: ReviewTaskLike): boolean {
  return task.kind === "review";
}

/** The range an autonomous review of a flow task covers: `base...head`. */
export function reviewTaskRange(input: { readonly defaultBranch: string | undefined; readonly head: string | undefined }): { base: string; head?: string } {
  const base = input.defaultBranch !== undefined && input.defaultBranch.trim() !== "" ? input.defaultBranch.trim() : "main";
  return input.head === undefined || input.head.trim() === "" ? { base } : { base, head: input.head.trim() };
}

/** The command line an operator would type for the same review (shown in the run record). */
export function reviewTaskCommand(range: { base: string; head?: string }): string {
  return `keryx review run --autonomous --target branch --ref ${range.base}${range.head === undefined ? "" : ` --head ${range.head}`}`;
}
