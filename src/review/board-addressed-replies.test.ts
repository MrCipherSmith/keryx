import { expect, test } from "bun:test";
import { attachAddressedReplies } from "./board-addressed-replies";
import type { ReviewBoardSnapshot, ReviewCard } from "./board-types";

function board(): ReviewBoardSnapshot {
  const card: ReviewCard = { number: 1, title: "Review", url: "", draft: false, state: "open", author: "author",
    ci: "passed", headSha: "head", baseSha: "base", updatedAt: "", decision: null, assignees: [], reviewers: [] };
  return { version: 1, repo: "org/project", repositories: ["org/project"], repositoryId: "repo", viewer: "Lee", fetchedAt: "", cards: [card], warnings: [] };
}
const since = "2026-10-01T00:00:00Z";
const notice = { repository: { node_id: "repo" }, subject: { type: "PullRequest", url: "https://api.github.com/repos/org/project/pulls/1" }, last_read_at: since };
const comment = (id: number, body: string, login = "bob") => ({ id, node_id: "C" + id, body, user: { login }, created_at: "2026-10-02T00:00:00Z" });

test("attributes unread mentions and direct replies, including an earlier reply followed by an ordinary comment", async () => {
  const result = board();
  const calls: string[] = [];
  await attachAddressedReplies(result, async <T>(path: string) => {
    calls.push(path);
    const value = path.includes("/notifications?") ? [notice, notice] : path.includes("issues/1/comments?") ?
      [comment(1, "@Lee please check"), comment(2, "Thanks"), comment(3, "@lee-team"), comment(4, "@lee", "LEE"),
        { ...comment(5, "@lee"), created_at: since }] :
      path.includes("/pulls/1/comments?") ? [{ ...comment(6, "Updated"), in_reply_to_id: 9 }, comment(7, "Another thread")] :
      path.endsWith("/pulls/comments/9") ? comment(9, "My comment", "Lee") : { login: "lee" };
    return value as T;
  });
  expect(result.cards[0]!.addressedReplyIds).toEqual(["C1", "C6"]);
  expect(calls).toHaveLength(5);
  expect(result.warnings).toEqual([]);
});

test("optional notification permission or loss of connectivity keeps the original board with a warning", async () => {
  const result = board();
  await attachAddressedReplies(result, async () => { throw new Error("access: notifications permission missing"); });
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]!.addressedReplyIds).toBeUndefined();
  expect(result.warnings).toHaveLength(1);
});

test("a changed GitHub viewer cannot attach another account's reply signals", async () => {
  const result = board();
  await expect(attachAddressedReplies(result, async <T>(path: string) => (path === "user" ? {login:"new"} :
    path.includes("notifications?") ? [notice] : [comment(1, "@lee")]) as T)).rejects.toThrow("access:");
  expect(result.cards[0]!.addressedReplyIds).toBeUndefined();
});
