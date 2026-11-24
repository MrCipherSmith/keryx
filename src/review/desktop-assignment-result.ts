import { splitUsage } from "./dispatch-usage";
import { isReviewerResult, parseReviewResult, unreadableInputClaim } from "./ledger";
import { readSliceIds } from "./retry-plan";

export function finishedDesktopAssignment(raw: string, reviewer: string, key: string, slices: readonly string[], models?: ReadonlySet<string>): boolean {
  const { body, assignment, incomplete } = splitUsage(raw);
  if (incomplete || assignment?.key !== key || (models !== undefined && !models.has(assignment.model))) return false;
  const reply = parseReviewResult(body);
  if (!isReviewerResult(reply) || reply.reviewer !== reviewer ||
      !["DONE", "DONE_WITH_CONCERNS"].includes(String(reply.status)) || unreadableInputClaim(reply)) return false;
  const coverage = readSliceIds(reply.slices);
  return !coverage.unusable && !coverage.notCovered.length &&
    coverage.ids.length === slices.length && coverage.ids.every(id => slices.includes(id));
}
