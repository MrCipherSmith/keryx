import { resolveProjectRoot } from "../lib/contained-path";
import { completeManagedReview, resolveReviewPackagePath, type CompleteManagedReviewOptions, type CompleteManagedReviewResult } from "./managed";
import { runProfileRefusal } from "./run-profile";
import { packageRoutingRefusal } from "./routing-check";

/**
 * `keryx review complete` and the `review_complete` card close a round through this one function, so both meet the same
 * gates: the run profile, the narrowed-routing check, then the head, evidence-level, research and readiness gates inside
 * `completeManagedReview`. A refusal throws before anything is recorded.
 */
export async function completeReviewGated(cwd: string, ref: string, options: CompleteManagedReviewOptions): Promise<CompleteManagedReviewResult> {
  const packageDir = await resolveReviewPackagePath(cwd, ref);
  const profileMissing = runProfileRefusal(packageDir);
  if (profileMissing !== undefined) throw new Error(`review complete refused: ${profileMissing}`);
  const narrowedRouting = packageRoutingRefusal(packageDir, resolveProjectRoot(cwd), { refuseUnreadable: true });
  if (narrowedRouting !== undefined) throw new Error(`review complete refused: ${narrowedRouting}`);
  return completeManagedReview(cwd, ref, options);
}
