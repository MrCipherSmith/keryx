// Flow 458 AC1/AC3: `review start` finds the previous round of the same target from five sources, picks the newest
// reviewed head by ancestry, and writes round.json + prior_findings.json. Every test runs on a throwaway git repository;
// the pull request read is always injected, so nothing here reaches GitHub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import type { ReviewRoundRecord } from "../flow/review-gate";
import type { CollectedComment, CollectedRoundBlock } from "./pr-comments";
import {
  choosePrevious,
  defaultGithubLookup,
  findPreviousRound,
  parseDiffHunks,
  pullRequestOf,
  relocateFinding,
  sameReviewTarget,
  skippedRound,
  type GithubLookup,
  type PriorRoundDeps,
  type RoundCandidate,
} from "./prior-round";
import { readRoundRecord, renderRoundLine } from "./round-record";
import { computeVerdict, renderVerdict } from "./verdict";

const PR = "https://github.com/acme/app/pull/7";
const TARGET = { kind: "pr", ref: PR };
const SCHEMA = path.join(path.resolve(import.meta.dir, "..", ".."), "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");

let root: string;
const originalCwd = process.cwd();

function git(...args: string[]): string {
  const email = process.env.GIT_AUTHOR_EMAIL ?? "t@example.com";
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

function commit(message: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

const lines = (count: number, tag = "line"): string => Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

function packageFiles(dir: string, options: { reviewId: string; head: string; ref?: string; at?: string; findings?: unknown[]; status?: string; round?: number }): Record<string, string> {
  const files: Record<string, string> = {
    [`${dir}/manifest.json`]: JSON.stringify({
      schemaVersion: 1,
      reviewId: options.reviewId,
      mode: "review-flow",
      status: options.status ?? "reviewed",
      target: { kind: "pr", ref: options.ref ?? PR, head: options.head },
      createdAt: options.at ?? "2026-10-01T00:00:00.000Z",
    }),
    [`${dir}/findings.json`]: JSON.stringify(options.findings ?? []),
  };
  if (options.round !== undefined) files[`${dir}/round.json`] = JSON.stringify({ v: 1, round: options.round });
  return files;
}

function writePackage(dir: string, options: Parameters<typeof packageFiles>[1]): void {
  for (const [rel, content] of Object.entries(packageFiles(dir, options))) write(rel, content);
}

const offline: PriorRoundDeps["github"] = async () => ({ status: "not-consulted", detail: "gh offline (test)" });
const consulted = (blocks: CollectedRoundBlock[], comments: CollectedComment[] = []): PriorRoundDeps["github"] => async (): Promise<GithubLookup> => ({ status: "consulted", blocks, comments });

const finding = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, reviewer: "review-logic", severity: "major", problem: `problem ${id}`, file: "src/a.ts", line: 5, ...extra });

const block = (head: string, at: string, round = 1): CollectedRoundBlock => ({
  v: 1,
  round,
  reviewId: `gh-r${round}`,
  reviewedHead: head,
  findings: [{ id: "F-9", file: "src/a.ts", line: 3, severity: "minor", status: "open" }],
  commentId: "review:1",
  submittedAt: at,
  url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
});

let A: string;
let B: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-prior-round-"));
  git("init", "-q", "-b", "main");
  A = commit("base", { "src/a.ts": lines(20), "README.md": "x\n" });
  git("checkout", "-q", "-b", "feature");
  B = commit("feature work", { "src/a.ts": lines(20).replace("line 5\n", "line five\n"), "src/new.ts": "export const n = 1;\n" });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("each source alone", () => {
  test("local-package: a package in this checkout for the same PR, at an ancestor head, makes a delta round", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, findings: [finding("F-1")], round: 1 });
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(round).toMatchObject({ round: 2, source: "local-package", mode: "delta", range: { base: A, head: B }, previous: { reviewId: "r1", reviewedHead: A } });
    expect(round.sourcesTried.map((t) => [t.source, t.result])).toEqual([
      ["local-package", "found"],
      ["git-history", "none"],
      ["github-block", "not-consulted"],
      ["github-comments", "not-consulted"],
      ["flow", "not-consulted"],
    ]);
    expect(priorFindings).toEqual([expect.objectContaining({ id: "F-1", status: "open", source: "local-package", file: "src/a.ts", line: 5 })]);
  });

  test("git-history: a package committed on another branch, absent from this checkout, is found", async () => {
    git("checkout", "-q", "-b", "elsewhere", A);
    commit("review package", packageFiles(".metaproject/flows/001-x/reviews/r-gh", { reviewId: "r-gh", head: A, findings: [finding("F-2")], round: 3 }));
    git("checkout", "-q", "feature");
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(round).toMatchObject({ round: 4, source: "git-history", mode: "delta", previous: { reviewId: "r-gh", reviewedHead: A } });
    expect(round.previous?.packagePath).toContain(".metaproject/flows/001-x/reviews/r-gh");
    expect(priorFindings[0]).toMatchObject({ id: "F-2", source: "git-history" });
  });

  test("github-block: the round block of our own published review is found", async () => {
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: consulted([block(A, "2026-10-02T00:00:00Z", 2)]) });
    expect(round).toMatchObject({ round: 3, source: "github-block", mode: "delta", previous: { reviewId: "gh-r2", reviewedHead: A } });
    expect(priorFindings).toEqual([expect.objectContaining({ id: "F-9", severity: "minor", source: "github-block", line: 3 })]);
  });

  test("github-comments: other people's comments are prior findings with no head; the round stays 1 and says so", async () => {
    const comment = { id: "review-comment:11", source: "review-comment", author: "carol", authorIsBot: false, url: "u", body: "This drops the error.\nmore", path: "src/a.ts", line: 4, threadId: "11", submittedAt: "2026-10-02T00:00:00Z", reviewState: null, severity: "minor", severityBasis: "default-minor", severityDetail: "", reopened: false } as CollectedComment;
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: consulted([], [comment]) });
    expect(round).toMatchObject({ round: 1, source: "github-comments", mode: "first", previous: null, range: { base: A, head: B } });
    expect(priorFindings).toEqual([expect.objectContaining({ id: "review-comment:11", reviewer: "carol", problem: "This drops the error.", source: "github-comments", status: "open" })]);
    expect(renderRoundLine(round)).toContain("round 1 — no previous round found; prior findings from PR comments");
  });

  test("flow: a round of the bound flow is found even when it reviewed a different ref", async () => {
    const record: ReviewRoundRecord = { reviewId: "flow-r1", dir: ".metaproject/flows/001-x/reviews/flow-r1", sortKey: "2026-10-01T00:00:00Z", ingested: true, problems: [], head: A, mode: "review-flow", coverage: [], findings: [{ id: "F-3", severity: "major", file: "src/a.ts", line: 5, symbol: null, dedupeKey: null, round: "flow-r1", disposition: { state: "acted-on", evidence: "fixed" } } as never], verification: null };
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline, flowDir: "001-x", flowRounds: async () => [record] });
    expect(round).toMatchObject({ round: 2, source: "flow", mode: "delta", previous: { reviewId: "flow-r1" } });
    expect(priorFindings[0]).toMatchObject({ id: "F-3", status: "acted-on", disposition: "acted-on", source: "flow" });
  });

  test("nothing anywhere: round 1, and the line names every source tried", async () => {
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(round).toMatchObject({ round: 1, source: "none", mode: "first", previous: null, fixHunks: [], carried: [] });
    expect(round.newHunks.map((h) => h.file).sort()).toEqual(["src/a.ts", "src/new.ts"]);
    expect(priorFindings).toEqual([]);
    const line = renderRoundLine(round);
    expect(line).toStartWith("round 1 — no previous round found (sources tried: local-package: none, git-history: none, github-block: not consulted (gh offline (test))");
    expect(line).toContain("flow: not consulted");
  });

  test("a package of another target, the package being created, and an abandoned empty draft are never the previous round", async () => {
    writePackage(".metaproject/reviews/other", { reviewId: "other", head: A, ref: "https://github.com/acme/app/pull/8" });
    writePackage(".metaproject/reviews/self", { reviewId: "self", head: A });
    writePackage(".metaproject/reviews/draft", { reviewId: "draft", head: A, status: "draft" });
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: offline, excludeReviewId: "self" });
    expect(round.previous).toBeNull();
  });
});

describe("choosing between sources", () => {
  test("disagreement: the newest ancestor wins, even when the other source's record is stamped later", async () => {
    const C = commit("second fix", { "src/a.ts": lines(20).replace("line 5\n", "line five\n").replace("line 12\n", "line twelve\n") });
    // local says A (stamped later), the PR block says B (closer to C): B is the newer reviewed head by ancestry.
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, at: "2026-10-09T00:00:00.000Z", round: 1 });
    const { round } = await findPreviousRound(TARGET, C, { cwd: root, github: consulted([block(B, "2026-10-05T00:00:00Z", 2)]) });
    expect(round).toMatchObject({ source: "github-block", mode: "delta", round: 3, range: { base: B, head: C }, previous: { reviewedHead: B } });
    expect(round.sourcesTried.find((t) => t.source === "local-package")?.result).toBe("found");
  });

  test("the same head in two sources goes to the earlier source, which holds the richer record", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, findings: [finding("F-1", { quote: "line 5" })] });
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: consulted([block(A, "2026-10-01T00:00:00Z")]) });
    expect(round.source).toBe("local-package");
  });

  test("a newer round at a non-ancestor head (force-push) falls back to a full round over merge-base..head", async () => {
    git("checkout", "-q", "-b", "old-feature", A);
    const X = commit("pre-rebase work", { "src/a.ts": lines(20).replace("line 7\n", "line seven\n") });
    git("checkout", "-q", "feature");
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, at: "2026-10-01T00:00:00.000Z" });
    writePackage(".metaproject/reviews/r2", { reviewId: "r2", head: X, at: "2026-10-03T00:00:00.000Z", findings: [finding("F-7")], round: 2 });
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(round).toMatchObject({ mode: "fallback-first", round: 3, previous: { reviewId: "r2", reviewedHead: X }, range: { base: A, head: B }, fixHunks: [], carried: [] });
    expect(round.newHunks.length).toBeGreaterThan(0);
    expect(priorFindings.map((f) => f.id)).toEqual(["F-7"]);
    expect(renderRoundLine(round)).toContain("fallback-first");
  });

  test("a head this clone has never fetched is not an ancestor", async () => {
    const candidate: RoundCandidate = { source: "github-block", reviewId: "x", reviewedHead: "f".repeat(40), round: 1, at: 1, findings: [] };
    const runner = async (args: string[]) => ({ stdout: "", exitCode: args[0] === "merge-base" ? 128 : 0 });
    expect((await choosePrevious(runner, [candidate], B)).mode).toBe("fallback-first");
  });
});

describe("the pull request read", () => {
  test("offline or missing gh: both GitHub sources are recorded as not consulted, and a throwing read is too", async () => {
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: async () => { throw new Error("ENOTFOUND api.github.com"); } });
    const github = round.sourcesTried.filter((t) => t.source.startsWith("github"));
    expect(github.map((t) => t.result)).toEqual(["not-consulted", "not-consulted"]);
    expect(github[0]!.detail).toContain("ENOTFOUND");
  });

  test("a target that is not a pull request is not looked up at all", async () => {
    expect(await defaultGithubLookup({ kind: "branch", ref: "feat/x" })).toEqual({ status: "not-consulted", detail: "the target is not a pull request" });
  });

  test("pull request refs compare however they are written", () => {
    expect(pullRequestOf("https://github.com/Acme/App/pull/7/files")).toEqual({ repo: "acme/app", number: 7 });
    expect(pullRequestOf("acme/app#7")).toEqual({ repo: "acme/app", number: 7 });
    expect(sameReviewTarget({ ref: "acme/app#7" }, TARGET)).toBe(true);
    expect(sameReviewTarget({ ref: "acme/app#8" }, TARGET)).toBe(false);
    expect(sameReviewTarget({ ref: "feat/x" }, { kind: "branch", ref: "feat/x" })).toBe(true);
  });
});

describe("the FIX / NEW split of a delta round", () => {
  test("a hunk over a relocated open finding, or in a commit naming a finding, is FIX; the rest is NEW; untouched findings carry", async () => {
    // r1 reviewed B. F-1 quotes "line 12" (it moves down by 2 when lines are inserted above it); F-2 is acted on;
    // F-3 sits on line 18, which nothing touches; F-4 is named by a commit message.
    writePackage(".metaproject/reviews/r1", {
      reviewId: "r1",
      head: B,
      findings: [
        finding("F-1", { line: 12, quote: "line 12" }),
        finding("F-2", { line: 3, disposition: { state: "acted-on" } }),
        finding("F-3", { line: 18 }),
        finding("F-4", { file: "src/new.ts", line: 1 }),
      ],
    });
    const base = lines(20).replace("line 5\n", "line five\n");
    commit("insert above", { "src/a.ts": base.replace("line 2\n", "line 2\nextra a\nextra b\n") });
    commit("fix F-1", { "src/a.ts": base.replace("line 2\n", "line 2\nextra a\nextra b\n").replace("line 12\n", "line 12 fixed\n") });
    commit("address F-4", { "src/new.ts": "export const n = 2;\n" });
    const head = commit("new feature", { "src/other.ts": "export const o = 1;\n" });
    const { round } = await findPreviousRound(TARGET, head, { cwd: root, github: offline });
    expect(round.mode).toBe("delta");
    expect(round.fixHunks).toEqual([
      { file: "src/a.ts", startLine: 14, endLine: 14, findingIds: ["F-1"] },
      { file: "src/new.ts", startLine: 1, endLine: 1, findingIds: ["F-4"] },
    ]);
    expect(round.newHunks).toEqual([
      { file: "src/a.ts", startLine: 3, endLine: 4 },
      { file: "src/other.ts", startLine: 1, endLine: 1 },
    ]);
    expect(round.carried).toEqual([
      { findingId: "F-2", disposition: "acted-on" },
      { findingId: "F-3", disposition: "open" },
    ]);
  });

  test("diff hunks: additions, a pure deletion, and a deleted file", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -3,0 +4,2 @@",
      "@@ -9,2 +10,0 @@",
      "@@ -20 +21 @@",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");
    expect(parseDiffHunks(diff)).toEqual([
      { file: "x.ts", startLine: 4, endLine: 5 },
      { file: "x.ts", startLine: 10, endLine: 10 },
      { file: "x.ts", startLine: 21, endLine: 21 },
      { file: "gone.ts", startLine: 1, endLine: 1 },
    ]);
  });

  test("relocation prefers the quote, then the symbol, then the recorded line", () => {
    const content = "a\nfunction load() {}\nb\nconst x = load();\n";
    const base = { id: "F", reviewer: "r", severity: "major", file: "f.ts", problem: "", status: "open", source: "local-package" as const };
    expect(relocateFinding({ ...base, line: 1, quote: "const x = load();" }, content)).toEqual({ start: 4, end: 4 });
    expect(relocateFinding({ ...base, line: 1, symbol: "load" }, content)).toEqual({ start: 2, end: 2 });
    expect(relocateFinding({ ...base, line: 3 }, content)).toEqual({ start: 3, end: 3 });
  });
});

describe("keryx review start writes the round record", () => {
  function prepare(): void {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(path.join(schemas, "managed-review-package.schema.json"), readFileSync(SCHEMA, "utf8"));
  }

  async function start(args: string[]): Promise<{ output: string; dir: string }> {
    process.chdir(root);
    const logged: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void logged.push(parts.join(" "));
    try {
      await reviewCommand(["start", "--target", "pr", "--ref", PR, "--head", B, ...args], { isTerminal: () => false, priorRound: { github: offline } });
    } finally {
      console.log = original;
    }
    const output = logged.join("\n");
    return { output, dir: path.join(root, output.match(/^path: (.+)$/m)![1]!) };
  }

  test("round 2 from the local package, printed and written", async () => {
    prepare();
    writePackage(".metaproject/reviews/r-old", { reviewId: "r-old", head: A, findings: [finding("F-1")] });
    const { output, dir } = await start(["--review-id", "r-new"]);
    expect(output).toContain("round 2 (source: local-package; previous r-old at");
    const record = readRoundRecord(dir);
    expect(record).toMatchObject({ v: 1, round: 2, source: "local-package", mode: "delta", range: { base: A, head: B } });
    const prior = JSON.parse(readFileSync(path.join(dir, "prior_findings.json"), "utf8"));
    expect(prior.map((f: { id: string }) => f.id)).toEqual(["F-1"]);
    // The interim verdict names the round and where it came from.
    expect(renderVerdict(await computeVerdict(dir), "r-new")).toContain("round 2 (source: local-package; previous r-old at");
  }, 60_000);

  test("--no-prior-round writes round 1 with every source not consulted; --prior forces a package", async () => {
    prepare();
    writePackage(".metaproject/reviews/r-old", { reviewId: "r-old", head: A, ref: "https://github.com/acme/app/pull/99" });
    const skipped = await start(["--review-id", "r-skip", "--no-prior-round"]);
    expect(readRoundRecord(skipped.dir)).toEqual(skippedRound(B).round);
    const forced = await start(["--review-id", "r-forced", "--prior", "r-old"]);
    expect(readRoundRecord(forced.dir)).toMatchObject({ round: 2, previous: { reviewId: "r-old" }, mode: "delta" });
    expect(readRoundRecord(forced.dir)?.sourcesTried[0]).toEqual({ source: "local-package", result: "found", detail: expect.stringContaining("forced by --prior r-old") });
  }, 60_000);
});
