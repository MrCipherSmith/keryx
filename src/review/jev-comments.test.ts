// flow 333 — pure-function tests for `src/review/jev-comments.ts` (AC3/AC4
// of the frozen acceptance criteria). No I/O, no Jev, no network.

import { describe, expect, test } from "bun:test";
import {
  batchOpenComments,
  commentFactLines,
  commentsFindingStats,
  renderJevCommentsMarkdown,
  synthesizeCommentFinding,
  type OpenCommentFacts,
} from "./jev-comments";

function facts(overrides: Partial<OpenCommentFacts> = {}): OpenCommentFacts {
  return {
    id: "12345",
    path: "src/widget.ts",
    line: 10,
    author: "reviewer1",
    body: "This function is missing a null check.",
    submittedAt: "2026-01-01T00:00:00Z",
    threadId: "12345",
    resolved: "unresolved",
    commitsAfter: [],
    replies: [],
    laterHunks: [],
    ...overrides,
  };
}

describe("AC3: commentFactLines — deterministic facts, computed before Jev", () => {
  test("names the author, resolved state, commit count and reply count", () => {
    const lines = commentFactLines(
      facts({ commitsAfter: [{ sha: "abc1234", date: "2026-01-02T00:00:00Z" }], replies: [{ author: "author1", body: "fixed", submittedAt: "2026-01-02T00:00:00Z" }] }),
    );
    expect(lines.join("\n")).toContain("reviewer1");
    expect(lines.join("\n")).toContain("NOT marked resolved");
    expect(lines.join("\n")).toContain("commits after this comment");
    expect(lines.join("\n")).toContain("1");
    expect(lines.join("\n")).toContain("replies on the ledger: 1");
  });

  test("resolved and unknown states render distinct lines", () => {
    expect(commentFactLines(facts({ resolved: "resolved" })).join("\n")).toContain("IS marked resolved");
    expect(commentFactLines(facts({ resolved: "unknown" })).join("\n")).toContain("could not be read");
  });
});

describe("AC3: batchOpenComments — one choice question per comment, batched", () => {
  test("one comment makes one batch with one choice question", () => {
    const batches = batchOpenComments([facts()]);
    expect(batches).toHaveLength(1);
    const questions = batches[0]!.questions;
    expect(Object.keys(questions)).toEqual(["12345"]);
    expect(questions["12345"]!.type).toBe("choice");
    expect(Object.keys(questions["12345"]!.criteria).sort()).toEqual(
      ["needs-escalation", "not-actionable", "resolved-by-fix", "still-open"].sort(),
    );
  });

  test("no comments makes no batches", () => {
    expect(batchOpenComments([])).toEqual([]);
  });

  test("state includes the redacted comment body and fact lines", () => {
    const batches = batchOpenComments([facts({ body: "please fix this" })]);
    expect(batches[0]!.state).toContain("please fix this");
    expect(batches[0]!.state).toContain("comment 12345");
  });
});

describe("AC4: synthesizeCommentFinding — still-open/needs-escalation only", () => {
  test("resolved-by-fix produces no finding", () => {
    expect(synthesizeCommentFinding(facts(), "resolved-by-fix")).toBeUndefined();
  });

  test("not-actionable produces no finding", () => {
    expect(synthesizeCommentFinding(facts(), "not-actionable")).toBeUndefined();
  });

  test("still-open produces a minor finding at the comment's site", () => {
    const finding = synthesizeCommentFinding(facts(), "still-open");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("minor");
    expect(finding!.file).toBe("src/widget.ts");
    expect(finding!.line).toBe(10);
    expect(finding!.reviewer).toBe("review-jev-comments");
    expect(finding!.class_scope).toBeUndefined();
  });

  test("needs-escalation produces a major finding WITH class_scope (schema requires it for major)", () => {
    const finding = synthesizeCommentFinding(facts(), "needs-escalation");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("major");
    expect(finding!.class_scope).toBeDefined();
    expect(finding!.class_scope!.sites).toEqual(["src/widget.ts:10"]);
  });

  test("a comment with no known path/line still gets a finding, with null file/line", () => {
    const finding = synthesizeCommentFinding(facts({ path: null, line: null }), "still-open");
    expect(finding!.file).toBeNull();
    expect(finding!.line).toBeNull();
  });
});

describe("commentsFindingStats / renderJevCommentsMarkdown", () => {
  test("stats separate major from minor", () => {
    const minor = synthesizeCommentFinding(facts({ id: "1" }), "still-open")!;
    const major = synthesizeCommentFinding(facts({ id: "2" }), "needs-escalation")!;
    expect(commentsFindingStats([minor, major])).toEqual({ blocker: 0, major: 1, minor: 1, info: 0 });
  });

  test("renders a no-findings line when empty", () => {
    const markdown = renderJevCommentsMarkdown({
      status: "DONE",
      reviewer: "review-jev-comments",
      summary: "nothing open",
      findings: [],
      stats: commentsFindingStats([]),
    });
    expect(markdown).toContain("_no still-open or escalation-worthy comments_");
  });

  test("renders a header and one section per finding", () => {
    const finding = synthesizeCommentFinding(facts(), "still-open")!;
    const markdown = renderJevCommentsMarkdown({
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-comments",
      summary: "one open",
      findings: [finding],
      stats: commentsFindingStats([finding]),
    });
    expect(markdown).toContain("# review-jev-comments");
    expect(markdown).toContain(finding.id);
  });
});
