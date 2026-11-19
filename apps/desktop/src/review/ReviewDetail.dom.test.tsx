import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { ReviewDetailSnapshot } from "./ReviewDetailTypes";
import type { ReviewCard } from "./types";

let root: Root;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ReviewDetail: typeof import("./ReviewDetail").ReviewDetail;
let trigger: HTMLButtonElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ReviewDetail = (await import("./ReviewDetail")).ReviewDetail;
  const host = document.createElement("div");
  trigger = document.createElement("button");
  document.body.append(trigger, host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await unregisterDom();
});

const time = "2026-05-03T01:00:00Z";
function card(number: number): ReviewCard {
  return { number, title: "Pull request " + number, url: "https://github.com/org/repo/pull/" + number, state: "open",
    draft: false, author: "author", assignees: [], reviewers: [], decision: null, ci: "passed", baseSha: "base", headSha: "head", updatedAt: time };
}

test("read receipts preserve existing reads and independent acknowledgements from another view", async () => {
  const { markRepliesRead, readReplies } = await import("./reviewReadState");
  localStorage.setItem(JSON.stringify(["keryx.review.read", "me", "test-repo", 4]), JSON.stringify(["old"]));
  markRepliesRead("me", "test-repo", 4, ["reply-a"]);
  markRepliesRead("me", "test-repo", 4, ["reply-b"]);
  const ids = ["old", "reply-a", "reply-b"];
  expect(readReplies("me", "test-repo", 4, ids)).toEqual(new Set(ids));
  expect(readReplies("someone", "test-repo", 4, ids).size).toBe(0);
});

function detail(number: number): ReviewDetailSnapshot {
  const comment = { id: "comment", body: "Comment for PR " + number, author: "author", own: false, createdAt: time, url: "https://example.com/comment" };
  return {
    version: 1, viewer: "me", repositoryId: "repo-node", number, fetchedAt: time, headSha: "head",
    comments: [comment], reviews: [], threads: [{ id: "thread", path: "file.ts", line: 3, resolved: true, outdated: false,
      messages: [{ ...comment, id: "thread-root" }, { ...comment, id: "reply", body: "My reply", own: true, author: "me" }] }],
    checks: [{ id: "check", name: "Verify", status: "SUCCESS", url: "javascript:alert(1)" }], warnings: [],
  };
}

async function show(number: number, load: NonNullable<ComponentProps<typeof ReviewDetail>["load"]>) {
  await act(async () => root.render(createElement(ReviewDetail, {
    cwd: "/project", repo: "org/repo", repositoryId: "repo-node", viewer: "me", card: card(number), load, onClose: () => root.render(null),
  })));
}

const button = (name: string) => Array.from(document.querySelectorAll("button")).find(b => b.textContent === name)!;

test("own replies, local unread markers and GitHub resolution remain independent", async () => {
  trigger.focus();
  await show(1, async () => detail(1));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close details");
  expect(document.body.textContent).toContain("You");
  expect(document.body.textContent).toContain("Resolved");
  const ownReply = [...document.querySelectorAll(".review-detail-message")].find(el => el.textContent?.includes("My reply"));
  expect(ownReply?.textContent).toContain("Reply");
  expect(ownReply?.textContent).not.toContain("Unread");
  await act(async () => button("Mark 2 as read").click());
  expect(document.body.textContent).not.toContain("Unread");
  expect(document.body.textContent).toContain("Resolved");
  await act(async () => button("Checks").click());
  expect(document.body.textContent).toContain("Verify");
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click());
  expect(document.activeElement).toBe(trigger);
});

test("late PR detail and identity mismatches never expose another request's discussion", async () => {
  let finish!: (data: ReviewDetailSnapshot) => void;
  await show(2, () => new Promise(resolve => { finish = resolve; }));
  await show(3, async () => detail(3));
  await act(async () => finish(detail(2)));
  expect(document.body.textContent).toContain("Comment for PR 3");
  expect(document.body.textContent).not.toContain("Comment for PR 2");
  await show(3, async () => ({ ...detail(3), repositoryId: "replacement" }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Refresh the board");
  expect(document.body.textContent).not.toContain("Comment for PR 3");
});

test("an authenticated detail exposes primary-checkout Flow evidence and an agent command for standalone PRs", async () => {
  await show(4, async () => ({ ...detail(4), projectContext: { totalFlows: 1, flows: [{
    id: "007", title: "Migrate rows", status: "done", checkout: "primary", directory: "007-migrate", documents: { "plan.md": "copy rows" },
  }] } }));
  expect(document.querySelector(".review-flow-context summary")?.textContent).toContain("1 linked Flow");
  expect(document.querySelector(".review-flow-context article")?.textContent).toContain("copy rows");
  await show(5, async () => ({ ...detail(5), projectContext: { totalFlows: 0, flows: [] } }));
  expect(document.querySelector(".review-flow-context summary")?.textContent).toBe("Standalone review context");
  expect(document.querySelector(".review-flow-context code")?.textContent).toBe("keryx review pr-context --pr https://github.com/org/repo/pull/5");
  expect(document.body.textContent).not.toContain("copy rows");
});
