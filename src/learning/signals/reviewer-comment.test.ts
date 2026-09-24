import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewerCommentSignal } from "./reviewer-comment";

function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-reviewer-comment-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeConfig(root: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(root, ".metaproject");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "review-learning.config.json"),
    JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["octocat"], ...extra }, null, 2),
  );
}

function writePrComments(root: string, seen: unknown[]): void {
  const dir = path.join(root, ".metaproject", "reviews", "pr-comments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "acme__widgets__42.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repo: "acme/widgets",
        number: 42,
        self: null,
        rounds_collected: 1,
        collected_sha: "deadbeef",
        collected_round: 1,
        replies_posted_at: null,
        seen,
        handled_comments: [],
        backlog: [],
        escalated: [],
      },
      null,
      2,
    ),
  );
}

describe("reviewerCommentSignal", () => {
  test("a configured-reviewer comment yields a candidate with no login in trigger/action", async () => {
    await withProjectRoot(async (root) => {
      writeConfig(root, { reviewerProfiles: ["octocat"] });
      writePrComments(root, [
        {
          id: "c1",
          thread_id: null,
          author: "octocat",
          url: "https://github.com/acme/widgets/pull/42#c1",
          first_seen_round: 1,
          last_seen_round: 1,
          submitted_at: "2026-09-20T00:00:00.000Z",
          body: "@octocat: please add a null check before dereferencing the pointer here.",
        },
      ]);

      const drafts = await reviewerCommentSignal(root, []);
      expect(drafts.length).toBeGreaterThanOrEqual(1);
      for (const draft of drafts) {
        expect(draft.domain).toBe("review-conventions");
        expect(draft.extractor).toBe("reviewer-comment");
        expect(draft.trigger.toLowerCase()).not.toContain("octocat");
        expect(draft.action.toLowerCase()).not.toContain("octocat");
        expect(draft.reviewerProfile).not.toBeNull();
        expect(draft.reviewerProfile?.reviewerId).toMatch(/^rv-[0-9a-f]{16}$/);
        expect(draft.evidence[0]?.sourceRef).toContain("#comment-c1");
      }
    });
  });

  test("an unprofiled but configured author still yields a candidate, with reviewerProfile null", async () => {
    await withProjectRoot(async (root) => {
      writeConfig(root); // no reviewerProfiles
      writePrComments(root, [
        {
          id: "c2",
          thread_id: null,
          author: "octocat",
          url: "https://github.com/acme/widgets/pull/42#c2",
          first_seen_round: 1,
          last_seen_round: 1,
          submitted_at: "2026-09-20T00:00:00.000Z",
          body: "This should use a constant instead of a magic number throughout the file.",
        },
      ]);

      const drafts = await reviewerCommentSignal(root, []);
      expect(drafts.length).toBeGreaterThanOrEqual(1);
      for (const draft of drafts) expect(draft.reviewerProfile).toBeNull();
    });
  });

  test("no config means no drafts", async () => {
    await withProjectRoot(async (root) => {
      expect(await reviewerCommentSignal(root, [])).toEqual([]);
    });
  });

  test("an unconfigured author's comments never appear", async () => {
    await withProjectRoot(async (root) => {
      writeConfig(root);
      writePrComments(root, [
        {
          id: "c3",
          thread_id: null,
          author: "someone-else",
          url: "https://github.com/acme/widgets/pull/42#c3",
          first_seen_round: 1,
          last_seen_round: 1,
          submitted_at: "2026-09-20T00:00:00.000Z",
          body: "This is a totally unrelated comment from an unconfigured author entirely.",
        },
      ]);
      expect(await reviewerCommentSignal(root, [])).toEqual([]);
    });
  });
});
