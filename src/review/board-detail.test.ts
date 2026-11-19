import { describe, expect, test } from "bun:test";
import { readReviewBoardDetail, type DetailQuery } from "./board-detail";

const message = (id: string, own = false) => ({
  id, body: id, viewerDidAuthor: own, author: { login: own ? "viewer" : "colleague" },
  createdAt: "2026-11-19T12:00:00Z", url: "https://github.com/org/repo/pull/1",
});

function page(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function fixture(failComments = false): DetailQuery {
  return async (query, vars) => {
    if (query.includes("query ReviewDetailIdentity")) return { viewer: { login: "viewer" }, repository: {
      id: "repo-id", pullRequest: { id: "pr-id", headRefOid: "abc", commits: { nodes: [{ commit: { id: "commit-id", oid: "abc" } }] } },
    } };
    if (query.includes("on PullRequestReviewThread")) return { viewer: { login: "viewer" }, node: { comments: page([message("reply", true)]) } };
    if (query.includes("on Commit")) return { viewer: { login: "viewer" }, node: { statusCheckRollup: { contexts: page([
      { __typename: "CheckRun", id: "check", name: "Build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci.example/run" },
    ]) } } };
    if (query.includes("reviewThreads(")) return { viewer: { login: "viewer" }, node: { reviewThreads: page([
      { id: "thread", path: "main.ts", line: 3, isOutdated: false, isResolved: true, comments: page([message("root")], "next") },
    ]) } };
    if (query.includes("reviews(")) return { viewer: { login: "viewer" }, node: { reviews: page([{ ...message("review"), state: "CHANGES_REQUESTED" }]) } };
    if (vars.cursor && failComments) throw new Error("unavailable: offline");
    return { viewer: { login: "viewer" }, node: { comments: vars.cursor ? page([message("c1"), message("c2")]) : page([message("c1")], "next") } };
  };
}

describe("readReviewBoardDetail", () => {
  test("paginates discussions and replies, retains self and resolved, separates checks and reviews", async () => {
    const d = await readReviewBoardDetail("org/repo", 1, ".", fixture());
    expect(d.comments.map(m => m.id)).toEqual(["c1", "c2"]);
    expect(d.threads[0]).toMatchObject({ resolved: true, messages: [messageShape("root", false), messageShape("reply", true)] });
    expect(d.reviews[0]?.state).toBe("CHANGES_REQUESTED");
    expect(d.checks[0]?.status).toBe("FAILURE");
    expect(d.headSha).toBe("abc");
    expect(d.warnings).toEqual([]);
  });
  test("a failing later page preserves successful items with an explicit partial warning", async () => {
    const d = await readReviewBoardDetail("org/repo", 1, ".", fixture(true));
    expect(d.comments.map(m => m.id)).toEqual(["c1"]);
    expect(d.threads).toHaveLength(1);
    expect(d.warnings.join(" ")).toContain("discussion");
  });
  test("large paginated discussions and inline replies share the Desktop response budget", async () => {
    const normal = fixture();
    const body = '🧪"'.repeat(12_000);
    const pages = { comments: 0, replies: 0 };
    const request: DetailQuery = async (query, vars) => {
      const kind = query.includes("on PullRequestReviewThread") ? "replies"
        : query.includes("on PullRequest { comments") ? "comments" : null;
      if (!kind) return normal(query, vars);
      pages[kind]++;
      const index = Number(vars.cursor === "next" ? 0 : vars.cursor ?? 0);
      const nodes = Array.from({ length: 50 }, (_, i) => ({ ...message(kind + (index * 50 + i)), body }));
      return { viewer: { login: "viewer" }, node: { comments: page(nodes, index < 7 ? String(index + 1) : null) } };
    };
    const detail = await readReviewBoardDetail("org/repo", 1, ".", request);
    expect(detail.comments.length).toBeGreaterThan(0);
    expect(detail.threads[0]?.messages.length).toBeGreaterThan(1);
    expect(detail.checks[0]?.status).toBe("FAILURE");
    expect(detail.reviews[0]?.state).toBe("CHANGES_REQUESTED");
    expect(detail.warnings.join(" ")).toContain("Open pull request");
    expect(pages.comments + pages.replies).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(detail)) + 1).toBeLessThan(32 * 1024 * 1024);
  });
  test("revoked access or a changed viewer invalidates all previously fetched detail", async () => {
    const read = fixture();
    const switched: DetailQuery = (query, vars) => query.includes("on Commit")
      ? Promise.resolve({ viewer: { login: "other" }, node: null }) : read(query, vars);
    await expect(readReviewBoardDetail("org/repo", 1, ".", switched)).rejects.toThrow("access:");
  });

  test("a missing head commit leaves discussion readable and checks explicitly incomplete", async () => {
    const read = fixture();
    const missingHead: DetailQuery = (query, vars) => query.includes("query ReviewDetailIdentity")
      ? Promise.resolve({ viewer: { login: "viewer" }, repository: { id: "repo-id", pullRequest: { id: "pr-id", headRefOid: "abc", commits: null } } })
      : read(query, vars);
    const data = await readReviewBoardDetail("org/repo", 1, ".", missingHead);
    expect(data.comments).toHaveLength(2);
    expect(data.checks).toEqual([]);
    expect(data.warnings.join(" ")).toContain("checks are unavailable");
  });
});

const messageShape = (id: string, own: boolean) => ({ id, own });
