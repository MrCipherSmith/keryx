import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagedReviewPackage } from "../managed";
import { createFixturePort } from "../pr-comments";
import { buildReviewPayload, parseDiffHunks, postBotReview, type PostBotReviewResult } from "./post";
import { readBotState, writeBotState, emptyBotState } from "./run";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = a + 1;",
  "-const old = 2;",
  " export {};",
  "+export const c = 3;",
  "",
].join("\n");

const TREE: Record<string, string> = {
  "src/a.ts": "const a = 1;\nconst b = a + 1;\nexport {};\nexport const c = 3;\n",
  "src/far.ts": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nthe far line\n",
};

function pullFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "open",
    merged_at: null,
    head: { sha: HEAD, ref: "feat/x", repo: { full_name: "acme/app", id: 7 } },
    base: { sha: BASE, ref: "main", repo: { full_name: "acme/app", id: 7 } },
    ...overrides,
  };
}

function finding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reviewer: "review-bot",
    severity: "minor",
    problem: `problem ${id}`,
    impact: `impact ${id}`,
    suggested_fix: `fix ${id}`,
    evidence: "evidence",
    confidence: "medium",
    file: "src/a.ts",
    quote: "const b = a + 1;",
    ...overrides,
  };
}

async function seed(
  findings: unknown[],
  options: { head?: string; state?: boolean } = {},
): Promise<{ root: string; reviewId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-bot-post-"));
  roots.push(root);
  const packaged = await createManagedReviewPackage({
    cwd: root,
    mode: "ingest",
    target: {
      kind: "pr",
      ref: "https://github.com/acme/app/pull/7",
      repository: "acme/app",
      base: BASE,
      head: options.head ?? HEAD,
    },
    reportText: "# Report",
    findings: findings as never,
    reviewers: ["review-bot"],
    readTreeFile: async (relative) => TREE[relative] ?? null,
    resolveHead: async () => options.head ?? HEAD,
    now: new Date("2026-09-29T10:00:00Z"),
  });
  if (options.state !== false) {
    const state = emptyBotState("acme/app", 7);
    state.reviews.push({
      reviewId: packaged.reviewId,
      headSha: options.head ?? HEAD,
      ranAt: "2026-09-29T10:00:00.000Z",
      postedAt: null,
      reviewUrl: null,
    });
    await writeBotState(root, state);
  }
  return { root, reviewId: packaged.reviewId };
}

async function post(
  root: string,
  overrides: Partial<Parameters<typeof postBotReview>[0]> = {},
  pull: unknown = pullFixture(),
): Promise<{ result: PostBotReviewResult; port: ReturnType<typeof createFixturePort> }> {
  const port = createFixturePort({ pull }, { postUrlPrefix: "https://github.com/acme/app/pull/7#pullrequestreview-" });
  const result = await postBotReview({
    cwd: root,
    repo: "acme/app",
    number: 7,
    port,
    getDiff: async () => DIFF,
    now: new Date("2026-09-29T11:00:00Z"),
    ...overrides,
  });
  return { result, port };
}

describe("parseDiffHunks", () => {
  test("added and context lines of the new side are commentable; deleted lines and lines outside hunks are not", () => {
    const hunks = parseDiffHunks(DIFF);
    const lines = hunks.get("src/a.ts");
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(lines?.has(5)).toBe(false);
  });

  test("several files and several hunks; a deleted file has no commentable lines", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,2 @@",
      " one",
      "+two",
      "@@ -20,1 +21,2 @@",
      " twenty",
      "+extra",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    expect([...(hunks.get("x.ts") ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 21, 22]);
    expect(hunks.has("gone.ts")).toBe(false);
    expect([...(hunks.get("new.ts") ?? [])]).toEqual([1, 2]);
  });
});

describe("buildReviewPayload", () => {
  test("a finding inside a hunk is an inline RIGHT-side comment; one outside is in the review body", () => {
    const payload = buildReviewPayload({
      headSha: HEAD,
      hunks: parseDiffHunks(DIFF),
      items: [
        { id: "F-001", file: "src/a.ts", line: 2, body: "inline body" },
        { id: "F-002", file: "src/far.ts", line: 10, body: "outside body" },
        { id: "F-003", file: null, line: null, body: "no location body" },
      ],
      withheld: 0,
    });
    expect(payload.commit_id).toBe(HEAD);
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "inline body" }]);
    expect(payload.body).toContain("outside body");
    expect(payload.body).toContain("no location body");
    expect(payload.body).not.toContain("inline body");
  });

  test("the payload carries exactly the four review keys", () => {
    const payload = buildReviewPayload({ headSha: HEAD, hunks: new Map(), items: [{ id: "F-1", file: null, line: null, body: "b" }], withheld: 0 });
    expect(Object.keys(payload).sort()).toEqual(["body", "comments", "commit_id", "event"]);
  });

  test("a withheld count is stated in the body without the withheld text", () => {
    const payload = buildReviewPayload({ headSha: HEAD, hunks: new Map(), items: [], withheld: 2 });
    expect(payload.body).toMatch(/2 finding\(s\) withheld/);
  });
});

describe("postBotReview", () => {
  test("the default is a dry run: the payload is built, nothing is sent", async () => {
    const { root, reviewId } = await seed([finding("F-001"), finding("F-002", { file: "src/far.ts", quote: "the far line" })]);
    const { result, port } = await post(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("dry-run");
    expect(result.reviewId).toBe(reviewId);
    expect(result.payload?.commit_id).toBe(HEAD);
    expect(result.payload?.event).toBe("COMMENT");
    expect(result.inline).toBe(1);
    expect(result.inBody).toBe(1);
    expect(result.payload?.comments[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "RIGHT" });
    expect(result.payload?.comments[0]?.body).toContain("problem F-001");
    expect(result.payload?.body).toContain("problem F-002");
    expect(port.posts).toEqual([]);
    expect((await readBotState(root, "acme/app", 7)).reviews[0]?.postedAt).toBeNull();
  });

  test("--post sends exactly one review to pulls/{n}/reviews and records it", async () => {
    const { root } = await seed([finding("F-001")]);
    const { result, port } = await post(root, { send: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("posted");
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]?.method).toBe("POST");
    expect(port.posts[0]?.path).toBe("repos/acme/app/pulls/7/reviews");
    expect(port.posts[0]?.body).toEqual(result.payload);
    expect(result.reviewUrl).toContain("pullrequestreview-");
    const state = await readBotState(root, "acme/app", 7);
    expect(state.reviews[0]?.postedAt).toBe("2026-09-29T11:00:00.000Z");
    expect(state.reviews[0]?.reviewUrl).toBe(result.reviewUrl ?? null);
  });

  test("the same review is not posted twice", async () => {
    const { root } = await seed([finding("F-001")]);
    await post(root, { send: true });
    const { result, port } = await post(root, { send: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("already-posted");
    expect(port.posts).toEqual([]);
  });

  test("a --sha that is not the pull request head is refused", async () => {
    const { root } = await seed([finding("F-001")]);
    const { result, port } = await post(root, { send: true, sha: "c".repeat(40) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("sha");
    expect(port.posts).toEqual([]);
  });

  test("a --sha that is a 7+ character prefix of the head is accepted", async () => {
    const { root } = await seed([finding("F-001")]);
    const { result } = await post(root, { sha: HEAD.slice(0, 8) });
    expect(result.ok).toBe(true);
  });

  test("a review made at an older commit than the pull request head is refused as stale", async () => {
    const { root } = await seed([finding("F-001")], { head: "d".repeat(40) });
    const { result, port } = await post(root, { send: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("stale-review");
    expect(result.reason).toContain("d".repeat(12));
    expect(port.posts).toEqual([]);
  });

  test("a closed, merged or fork pull request is refused", async () => {
    const { root } = await seed([finding("F-001")]);
    const closed = await post(root, { send: true }, pullFixture({ state: "closed" }));
    expect(closed.result.ok).toBe(false);
    expect(closed.port.posts).toEqual([]);
    const merged = await post(root, { send: true }, pullFixture({ state: "closed", merged_at: "2026-09-02T00:00:00Z" }));
    expect(merged.result.ok).toBe(false);
    const fork = await post(
      root,
      { send: true },
      pullFixture({ head: { sha: HEAD, ref: "x", repo: { full_name: "mallory/app", id: 99 } } }),
    );
    expect(fork.result.ok).toBe(false);
    if (fork.result.ok) return;
    expect(fork.result.stage).toBe("fork-guard");
    expect(fork.port.posts).toEqual([]);
  });

  test("a finding whose text fails the security output check is withheld and counted, the rest still post", async () => {
    const { root } = await seed([
      finding("F-001", { suggested_fix: `use the key ${AWS_KEY}` }),
      finding("F-002", { quote: "export const c = 3;" }),
    ]);
    const { result, port } = await post(root, { send: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]?.id).toBe("F-001");
    expect(JSON.stringify(port.posts[0]?.body)).not.toContain(AWS_KEY);
    expect(result.payload?.comments).toHaveLength(1);
    expect(result.payload?.body).toMatch(/1 finding\(s\) withheld/);
  });

  test("with nothing to say, nothing is posted even under --post", async () => {
    const { root } = await seed([]);
    const { result, port } = await post(root, { send: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("nothing-to-post");
    expect(port.posts).toEqual([]);
  });

  test("a finding somebody else wrote is never re-posted by the bot", async () => {
    const { root } = await seed([finding("F-001"), finding("F-002", { source: "external", external_ref: { id: "review-comment:1", author: "alice", url: "https://github.com/acme/app/pull/7#discussion_r1", submitted_at: "2026-09-29T09:00:00Z" } })]);
    const { result } = await post(root);
    if (!result.ok) throw new Error(result.reason);
    expect(result.inline + result.inBody).toBe(1);
  });

  test("a review that never ran through the bot for this pull request is refused with the reason", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-bot-post-"));
    roots.push(root);
    const { result } = await post(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("review");
  });
});
