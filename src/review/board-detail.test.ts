import { describe, expect, test } from "bun:test";
import { readReviewBoardDetail, type DetailQuery } from "./board-detail";

const message = (id: string, own = false) => ({
  id, body: id, viewerDidAuthor: own, author: { login: own ? "viewer" : "colleague" },
  createdAt: "2026-11-19T12:00:00Z", url: "https://github.com/org/repo/pull/1",
});

function page(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

const checks = () => ({ statusCheckRollup: { contexts: page([
  { __typename: "CheckRun", id: "check", name: "Build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci.example/run" },
]) } });

function fixture(failComments = false): DetailQuery {
  return async (query, vars) => {
    if (query.includes("query ReviewDetailIdentity")) return { viewer: { login: "viewer" }, repository: {
      id: "repo-id", pullRequest: { id: "pr-id", body: "## PR description", headRefOid: "abc", commits: { nodes: [{ commit: { id: "commit-id", oid: "abc" } }] } },
    } };
    if (query.includes("on PullRequestReviewThread")) return { viewer: { login: "viewer" }, node: { comments: page([message("reply", true)]) } };
    if (query.includes("on Commit")) return { viewer: { login: "viewer" }, node: checks() };
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
    expect(d.description).toBe("## PR description");
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
  test.each([
    ["revoked access with the same viewer", { viewer: { login: "viewer" }, node: null }],
    ["a changed viewer with a valid checks node", { viewer: { login: "other" }, node: checks() }],
  ] as const)("%s invalidates pull request detail", async (_scenario, checksPage) => {
    const read = fixture();
    const switched: DetailQuery = (query, vars) => query.includes("on Commit")
      ? Promise.resolve(checksPage) : read(query, vars);
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

test("thread overflow workers preserve source order, identity checks and independent reply cursors", async () => {
  const threads = Array.from({length:30}, (_, i) => ({
    id:"t"+i, path:"path"+i, line:i, isOutdated:false, isResolved:false,
    comments:page([message("root"+i)], "first"),
  }));
  const initial = fixture();
  const cursors = new Map<string,string[]>();
  let active = 0, peak = 0, changeViewer = false;
  const query: DetailQuery = async (doc, vars) => {
    if (doc.includes("reviewThreads(")) return {viewer:{login:"viewer"},node:{reviewThreads:page(threads)}};
    if (!doc.includes("on PullRequestReviewThread")) return initial(doc,vars);
    const id = String(vars.id), cursor = String(vars.cursor);
    cursors.set(id,[...(cursors.get(id) ?? []),cursor]);
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (id === "t0") await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return { viewer:{login:changeViewer && id === "t1" ? "other" : "viewer"}, node:{
      comments:page([message(id + cursor)], cursor === "first" ? "last" : null),
    }};
  };
  const result = await readReviewBoardDetail("org/repo", 1, ".", query);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(result.threads.map(t => t.id)).toEqual(threads.map(t => t.id));
  expect([...cursors.values()].every(chain => chain.join(",") === "first,last")).toBe(true);
  for (const [i,thread] of result.threads.entries())
    expect(thread.messages.map(m => m.id)).toEqual(["root"+i, thread.id+"first", thread.id+"last"]);
  expect(result.warnings).toEqual([]);
  changeViewer = true;
  await expect(readReviewBoardDetail("org/repo", 1, ".", query)).rejects.toThrow("access:");
});

test("a malformed thread does not discard the inline messages on either side of it", async () => {
  const read = fixture();
  const thread = (id: string) => ({id, path:"path", line:1, isOutdated:false, isResolved:false, comments:page([message(id+"root")])});
  const data = await readReviewBoardDetail("org/repo", 1, ".", (doc, vars) => doc.includes("reviewThreads(")
    ? Promise.resolve({viewer:{login:"viewer"},node:{reviewThreads:page([thread("a"), {}, thread("b")])}}) : read(doc,vars));
  expect(data.threads.map(t => t.messages.map(m => m.id))).toEqual([["aroot"],["broot"]]);
  expect(data.warnings).toContain("Could not read all review threads.");
});
