import { boardGraphql } from "./board-github";
import type { OwnedPullRequest } from "./watcher-rebase";

const draftMutation = `mutation($id:ID!) {
  convertPullRequestToDraft(input:{pullRequestId:$id}) { pullRequest { id isDraft } }
}`;
const readyMutation = `mutation($id:ID!) {
  markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id isDraft } }
}`;
type DraftResult = { pullRequest?: { id: string; isDraft: boolean } };

export async function setRepairDraft(
  subject: OwnedPullRequest, draft: boolean, authorize: <T>(act: () => T) => T,
) {
  const { pull, checkout, auth } = subject;
  if (typeof pull.isDraft !== "boolean") throw new Error("GitHub did not report the pull request draft status.");
  if (pull.isDraft === draft) return false;
  const mutation = draft ? draftMutation : readyMutation;
  const result = await authorize(() => boardGraphql<{
    convertPullRequestToDraft?: DraftResult;
    markPullRequestReadyForReview?: DraftResult;
  }>(checkout, mutation, { id: pull.id }, auth));
  const updated = (draft ? result.convertPullRequestToDraft : result.markPullRequestReadyForReview)?.pullRequest;
  if (updated?.id !== pull.id || updated.isDraft !== draft) throw new Error("GitHub did not confirm the pull request draft status.");
  return true;
}
