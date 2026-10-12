import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PR_CONTEXT_JSON,
  PR_CONTEXT_MD,
  collectPrContext,
  extractBackendPins,
  parseGhChecks,
  readPrContext,
  summariseChecks,
} from "./context-collect";
import { createFixturePort } from "./pr-comments";

const LONG = `${"The listener is attached before the store is disposed, so a stale handler fires. ".repeat(30)}END-OF-LONG-COMMENT`;

function fixture(headSha: string, title = "Add pipeline filters", body = "Adds filters.\nBackend: needs backend PR #412 and v2.14.0 deployed") {
  return createFixturePort({
    pull: { title, body, head: { sha: headSha } },
    "pull-comments": [
      { id: 11, body: LONG, path: "src/a.ts", line: 7, html_url: "u/11", created_at: "2026-10-01T10:00:00Z", user: { login: "claude-reviewer", type: "User" } },
    ],
    "pull-reviews": [{ id: 21, state: "CHANGES_REQUESTED", body: "Please pin the BE branch `feature/filters-api`", submitted_at: "2026-10-01T11:00:00Z", user: { login: "lead" } }],
    "issue-comments": [{ id: 31, body: "CI is red on lint", created_at: "2026-10-01T12:00:00Z", user: { login: "ci-bot[bot]", type: "Bot" } }],
  });
}

describe("the pull request context collector (flow 428 AC7)", () => {
  test("keeps every comment whole, with no 800-character cut", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ac7-"));
    try {
      const { context } = await collectPrContext({ port: fixture("AAA1111"), repo: "o/r", number: 5, self: "me", packageDir: dir });
      const long = context.comments.find((c) => c.id === "review-comment:11");
      expect(long?.body.length).toBeGreaterThan(2000);
      expect(long?.body.endsWith("END-OF-LONG-COMMENT")).toBe(true);
      expect(context.comments).toHaveLength(3);
      expect(await readFile(path.join(dir, PR_CONTEXT_MD), "utf8")).toContain("END-OF-LONG-COMMENT");
      expect(JSON.parse(await readFile(path.join(dir, PR_CONTEXT_JSON), "utf8")).schemaVersion).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the round-1 intent survives a later round with a new head", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ac7-"));
    try {
      await collectPrContext({ port: fixture("aaa1111"), repo: "o/r", number: 5, self: "me", packageDir: dir });
      const second = await collectPrContext({ port: fixture("bbb2222", "Rewrite filters", "Different story now"), repo: "o/r", number: 5, self: "me", packageDir: dir });
      expect(second.context.round).toBe(2);
      expect(second.context.intent).toEqual({ round: 1, title: "Add pipeline filters", body: "Adds filters.\nBackend: needs backend PR #412 and v2.14.0 deployed" });
      const same = await collectPrContext({ port: fixture("bbb2222"), repo: "o/r", number: 5, self: "me", packageDir: dir });
      expect(same.context.round).toBe(2);
      expect((await readPrContext(dir))?.round).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("names the backend pins the pull request mentions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ac7-"));
    try {
      const { context } = await collectPrContext({ port: fixture("aaa1111"), repo: "o/r", number: 5, self: "me", packageDir: dir });
      const refs = context.backendPins.map((p) => `${p.kind}:${p.ref}`);
      expect(refs).toContain("pull:#412");
      expect(refs).toContain("version:v2.14.0");
      expect(refs).toContain("branch:feature/filters-api");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a line that does not talk about the backend contributes no pin", () => {
    expect(extractBackendPins([{ source: "x", text: "Fixes #12 and bumps to 1.2.3" }])).toEqual([]);
    const pins = extractBackendPins([{ source: "x", text: "Backend https://github.com/o/be/pull/9 at deadbee1234" }]);
    expect(pins.map((p) => p.kind).sort()).toEqual(["sha", "url"]);
  });

  test("the CI status is a summary of the checks, and unknown when nobody asked", () => {
    expect(summariseChecks(undefined).state).toBe("unknown");
    expect(summariseChecks([]).state).toBe("none");
    expect(summariseChecks([{ name: "lint", state: "failing" }, { name: "t", state: "passing" }])).toMatchObject({ state: "failing", failing: ["lint"] });
    expect(summariseChecks([{ name: "t", state: "pending" }, { name: "u", state: "passing" }]).state).toBe("pending");
    expect(summariseChecks([{ name: "t", state: "passing" }, { name: "u", state: "skipped" }]).state).toBe("passing");
  });

  test("gh pr checks buckets map to check states", () => {
    expect(parseGhChecks([{ name: "a", bucket: "pass" }, { name: "b", bucket: "fail" }, { name: "c", bucket: "pending" }, { name: "d", bucket: "skipping" }, { bucket: "pass" }]))
      .toEqual([{ name: "a", state: "passing" }, { name: "b", state: "failing" }, { name: "c", state: "pending" }, { name: "d", state: "skipped" }]);
    expect(parseGhChecks("nope")).toEqual([]);
  });
});
