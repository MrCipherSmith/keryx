import { createHash } from "node:crypto";
import { readReviewBoardDetail } from "./board-detail";
import { boardGraphql } from "./board-github";
import { repairPathAllowed } from "./pr-repair-git";
import type { OwnedPullRequest } from "./watcher-rebase";
import type { RepairReply } from "./watcher-repair-store";
import type { WatcherKey } from "./watcher-types";

interface Feedback {
  cause: string;
  reply: RepairReply;
  evidence: { body: string; path?: string; line?: number | null };
}

export const isActionableReview = (state: string) => state === "COMMENTED" || state === "CHANGES_REQUESTED";

async function readDiscussion(subject: OwnedPullRequest, key: WatcherKey, number: number) {
  const discussion = await readReviewBoardDetail(key.repo, number, subject.checkout,
    (query, variables) => boardGraphql(subject.checkout, query, variables, subject.auth));
  if (discussion.viewer.toLowerCase() !== key.viewer.toLowerCase() ||
      discussion.repositoryId !== key.repositoryId || discussion.headSha !== subject.pull.headRefOid ||
      discussion.warnings.length) throw new Error("Could not verify the conversation at the current pull request head.");
  return discussion;
}

function replyMarker(reply: RepairReply) {
  return "<!-- keryx-pr-repair:" + createHash("sha256").update(reply.id).digest("hex").slice(0, 24) + " -->";
}

export async function readReviewFeedback(
  subject: OwnedPullRequest, key: WatcherKey, number: number, seen: (cause: string) => boolean,
): Promise<Feedback | undefined> {
  const discussion = await readDiscussion(subject, key, number);
  const reviews = discussion.reviews.filter(review => !review.own && isActionableReview(review.state));
  const reviewers = new Set(reviews.map(review => review.author));
  const candidates: Feedback[] = [];
  for (const thread of discussion.threads) {
    const message = thread.messages.at(-1);
    if (!thread.resolved && !thread.outdated && repairPathAllowed(thread.path) && message &&
        !message.own && reviewers.has(message.author) && message.body.trim()) {
      candidates.push({
        cause: "thread:" + message.id, reply: { kind: "thread", id: thread.id, url: message.url },
        evidence: { body: message.body.slice(0, 8000), path: thread.path, line: thread.line },
      });
    }
  }
  for (const review of reviews) {
    if (!review.body.trim()) continue;
    const reply: RepairReply = { kind: "review", id: review.id, url: review.url };
    if (discussion.comments.some(comment => comment.own && comment.body.includes(replyMarker(reply)))) continue;
    candidates.push({ cause: "review:" + review.id, reply, evidence: { body: review.body.slice(0, 8000) } });
  }
  return candidates.find(candidate => !seen(candidate.cause));
}

const threadMutation = `mutation($id:ID!, $body:String!) {
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { id } }
}`;
const reviewMutation = `mutation($id:ID!, $body:String!) {
  addComment(input:{subjectId:$id,body:$body}) { commentEdge { node { id } } }
}`;

export async function publishRepairReply(
  subject: OwnedPullRequest, key: WatcherKey, number: number, reply: RepairReply,
  authorize: <T>(act: () => T) => T,
) {
  const discussion = await readDiscussion(subject, key, number);
  const thread = discussion.threads.find(entry => entry.id === reply.id);
  const marker = replyMarker(reply);
  const change = "Addressed this feedback in commit `" + subject.pull.headRefOid + "`.";
  if (reply.kind === "thread") {
    if (!thread) throw new Error("The original review thread is unavailable.");
    const comments = thread.messages;
    if (comments.some(message => message.own && message.body.includes(marker) && message.body.includes(subject.pull.headRefOid))) return;
    if (comments.at(-1)?.own) return;
    const data = await authorize(() => boardGraphql<{ addPullRequestReviewThreadReply?: { comment?: { id: string } } }>(
      subject.checkout, threadMutation, { id: reply.id, body: change + "\n\n" + marker }, subject.auth,
    ));
    if (!data.addPullRequestReviewThreadReply?.comment?.id) throw new Error("GitHub did not confirm the thread reply.");
    return;
  }
  const review = discussion.reviews.find(entry => entry.id === reply.id && !entry.own);
  if (!review) throw new Error("The original review is unavailable.");
  if (discussion.comments.some(message => message.own && message.body.includes(marker))) return;
  const url = new URL(review.url);
  if (url.origin !== "https://github.com" || url.pathname.toLowerCase() !== `/${key.repo}/pull/${number}`.toLowerCase() ||
      !/^#(?:pullrequestreview-\d+|discussion_r\d+)$/.test(url.hash)) throw new Error("The review link is invalid.");
  const body = "Follow-up to [the review](" + url.href + ").\n\n" + change + "\n\n" + marker;
  const data = await authorize(() => boardGraphql<{ addComment?: { commentEdge?: { node?: { id: string } } } }>(
    subject.checkout, reviewMutation, { id: subject.pull.id, body }, subject.auth,
  ));
  if (!data.addComment?.commentEdge?.node?.id) throw new Error("GitHub did not confirm the review reply.");
}
