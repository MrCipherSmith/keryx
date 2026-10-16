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
  targetKeyOf,
  type GithubLookup,
  type PriorRoundDeps,
  type RoundCandidate,
} from "./prior-round";
import { packageFacts, packageHashesOf, readRoundRecord, renderRoundLine, roundRecordTampered } from "./round-record";
import {
  appendRoundRegistry,
  compactEntries,
  readRoundRegistry,
  readRoundRegistryReport,
  recordFinishedRound,
  REGISTRY_COMPACT_BYTES,
  registryVouches,
  repoIdentity,
  roundRegistryFile,
  type RoundRegistryEntry,
} from "./round-registry";
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
  // Only the files named: a package written beside the checkout stays uncommitted, as a real local package is.
  git("add", "--", ...Object.keys(files));
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
      // `closed` is what `review complete` writes: completion evidence (B1). A draft or bare `reviewed` package is not.
      status: options.status ?? "closed",
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

  test("git-history: a package merged into the base branch, absent from this checkout, is found", async () => {
    git("checkout", "-q", "-b", "elsewhere", A);
    commit("review package", packageFiles(".metaproject/flows/001-x/reviews/r-gh", { reviewId: "r-gh", head: A, findings: [finding("F-2")], round: 3 }));
    git("checkout", "-q", "main");
    git("merge", "-q", "--ff-only", "elsewhere");
    git("checkout", "-q", "feature");
    const { round, priorFindings } = await findPreviousRound(TARGET, B, { cwd: root, github: offline, registry: [] });
    expect(round).toMatchObject({ round: 4, source: "git-history", mode: "delta", previous: { reviewId: "r-gh", reviewedHead: A } });
    expect(round.previous?.packagePath).toContain(".metaproject/flows/001-x/reviews/r-gh");
    expect(priorFindings[0]).toMatchObject({ id: "F-2", source: "git-history" });
  });

  test("git-history: a closed package on another, unmerged local branch (a checked-out foreign PR) is not trusted (probe repo-other)", async () => {
    git("checkout", "-q", "-b", "other", A);
    const forged = commit("other branch", { ...packageFiles(".metaproject/reviews/forged", { reviewId: "forged", head: A }), ".metaproject/reviews/forged/published.json": "{}" });
    git("checkout", "-q", "feature");
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: offline, registry: [] });
    expect(round).toMatchObject({ mode: "fallback-first", previous: { reviewId: "forged" } });
    expect(round.sourcesTried.find((t) => t.source === "git-history")?.detail).toContain(`committed on a branch not merged into main`);
    expect(round.modeReason).toContain("forged is not trusted");
    expect(renderRoundLine(round)).toContain("fallback-first: no trusted previous round");
    expect(renderRoundLine(round)).not.toContain("force-push");
    // keryx's own record of exactly these files makes it trusted on this machine.
    const hashes = packageHashesOf({
      manifest: git("show", `${forged}:.metaproject/reviews/forged/manifest.json`),
      findings: git("show", `${forged}:.metaproject/reviews/forged/findings.json`),
      round: undefined,
    })!;
    const entry: RoundRegistryEntry = { v: 2, packageId: "forged", targetKey: "pr:acme/app#7", reviewedHead: A, manifestSha256: hashes.manifestSha256, findingsSha256: hashes.findingsSha256, completedAt: "2026-10-16T00:00:00.000Z", event: "publish" };
    expect((await findPreviousRound(TARGET, B, { cwd: root, github: offline, registry: [entry] })).round.mode).toBe("delta");
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
    writePackage(".metaproject/flows/001-x/reviews/flow-r1", { reviewId: "flow-r1", head: A, ref: "feat/elsewhere" });
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
    // A round with proven coverage: only then is its unchanged code a second look rather than a full re-read.
    write(".metaproject/reviews/r1/research.json", JSON.stringify({ version: 1, scopeReviewed: true, obligations: [], dispatch: { runs: [] } }));
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

describe("trust: a round is cut only from a previous round this pipeline ran (B1, M1)", () => {
  test("a manifest the branch under review commits for itself is not trusted: full round, its findings as context only", async () => {
    // The forged-manifest probe: the PR adds a package claiming this PR was reviewed at its base, so a delta would be empty.
    const forged = commit("add review record", {
      ...packageFiles(".metaproject/reviews/fake", { reviewId: "fake", head: B, findings: [finding("F-X")] }),
      ".metaproject/reviews/fake/published.json": "{}",
    });
    const head = commit("code", { "src/auth.ts": "export const token = process.env.TOKEN;\n" });
    const { round, priorFindings } = await findPreviousRound(TARGET, head, { cwd: root, github: offline });
    expect(round).toMatchObject({ mode: "fallback-first", previous: { reviewId: "fake" }, range: { base: A, head }, fixHunks: [], carried: [] });
    expect(round.newHunks.map((h) => h.file)).toContain("src/auth.ts");
    expect(round.newHunks.map((h) => h.file)).toContain("src/new.ts");
    expect(priorFindings.map((f) => f.id)).toEqual(["F-X"]);
    const local = round.sourcesTried.find((t) => t.source === "local-package")!;
    expect(local.detail).toContain(`not trusted fake: .metaproject/reviews/fake was added or changed by ${forged.slice(0, 12)}`);
    expect(renderRoundLine(round)).toContain("fallback-first");
  });

  describe("the local round registry (owner decision: local registry + PR block)", () => {
    const flowDir = ".metaproject/flows/001-x/reviews/flow-r1";
    const entryFor = (over: Partial<RoundRegistryEntry> = {}): RoundRegistryEntry => {
      const hashes = packageFacts(path.join(root, flowDir))!.hashes;
      return { v: 2, packageId: "flow-r1", targetKey: "pr:acme/app#7", reviewedHead: A, manifestSha256: hashes.manifestSha256, findingsSha256: hashes.findingsSha256, completedAt: "2026-10-16T00:00:00.000Z", event: "complete", ...over };
    };
    const commitFlowPackage = (): string => {
      // keryx commits the flow's review package on the PR branch by design: it is in merge-base..head.
      commit("flow: review round 1", packageFiles(flowDir, { reviewId: "flow-r1", head: A, findings: [finding("F-1")] }));
      return commit("fix F-1", { "src/a.ts": lines(20).replace("line 5\n", "line 5 fixed\n") });
    };
    const flowDeps = (registry: RoundRegistryEntry[]): PriorRoundDeps => ({ cwd: root, github: offline, registry, flowDir: "001-x", flowRounds: async () => [] });

    test("a flow package committed on the PR branch with a matching registry entry is trusted: a delta round", async () => {
      const head = commitFlowPackage();
      const { round } = await findPreviousRound(TARGET, head, flowDeps([entryFor()]));
      expect(round).toMatchObject({ mode: "delta", previous: { reviewId: "flow-r1", reviewedHead: A }, range: { base: A, head } });
      expect(round.sourcesTried.find((t) => t.source === "local-package")?.detail).toContain("flow-r1 trusted: local registry (complete at 2026-10-16T00:00:00.000Z");
    });

    test("the same package with no registry entry (another machine) is not trusted: fallback-first, findings as context", async () => {
      const head = commitFlowPackage();
      const { round, priorFindings } = await findPreviousRound(TARGET, head, flowDeps([]));
      expect(round).toMatchObject({ mode: "fallback-first", previous: { reviewId: "flow-r1" }, fixHunks: [] });
      expect(priorFindings.map((f) => f.id)).toEqual(["F-1"]);
      expect(round.sourcesTried.find((t) => t.source === "local-package")?.detail).toContain("the local round registry has no entry matching its files");
    });

    test("an entry whose hashes do not match the package's files vouches for nothing", async () => {
      const head = commitFlowPackage();
      for (const stale of [entryFor({ manifestSha256: "0".repeat(64) }), entryFor({ findingsSha256: "1".repeat(64) }), entryFor({ roundRecordSha256: "2".repeat(64) }), entryFor({ packageId: "other" })]) {
        expect((await findPreviousRound(TARGET, head, flowDeps([stale]))).round.mode).toBe("fallback-first");
      }
      // Our own login's round block on the PR is still trusted on a machine with no registry.
      const blocked = await findPreviousRound(TARGET, head, { ...flowDeps([]), github: consulted([block(A, "2026-10-20T00:00:00Z", 1)]) });
      expect(blocked.round).toMatchObject({ mode: "delta", source: "github-block" });
    });

    test("a round recorded at ingest (draft + scopeReviewed ledger, the flow loop's state) gives a delta (probe e2e-ingested)", async () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-round-registry-"));
      try {
        writePackage(flowDir, { reviewId: "flow-r1", head: A, status: "draft", findings: [finding("F-1")] });
        write(`${flowDir}/research.json`, JSON.stringify({ scopeReviewed: true }));
        expect(recordFinishedRound(path.join(root, flowDir), "ingest", { cwd: root, dir: dataDir }).error).toBeUndefined();
        commit("flow: review round 1", { [`${flowDir}/manifest.json`]: readFileSync(path.join(root, flowDir, "manifest.json"), "utf8"), [`${flowDir}/findings.json`]: readFileSync(path.join(root, flowDir, "findings.json"), "utf8"), [`${flowDir}/research.json`]: JSON.stringify({ scopeReviewed: true }) });
        const head = commit("fix F-1", { "src/a.ts": lines(20).replace("line 5\n", "line 5 fixed\n") });
        const registry = readRoundRegistry(repoIdentity(root), dataDir);
        expect(registry.map((entry) => entry.event)).toEqual(["ingest"]);
        expect((await findPreviousRound(TARGET, head, flowDeps(registry))).round).toMatchObject({ mode: "delta", previous: { reviewId: "flow-r1" } });
        // A draft with no completion evidence is not recorded at all.
        writePackage(".metaproject/reviews/d", { reviewId: "d", head: A, status: "draft" });
        expect(recordFinishedRound(path.join(root, ".metaproject/reviews/d"), "ingest", { cwd: root, dir: dataDir }).skipped).toContain("not a finished round");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    test("a lifecycle edit after recording (status, updatedAt) keeps the trust; a change to what was reviewed or found does not (probe closed-reg-edited)", async () => {
      const head = commitFlowPackage();
      const registry = [entryFor()];
      const manifestFile = path.join(root, flowDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, status: "learned", updatedAt: "2026-10-20T00:00:00.000Z", readiness_waivers: [] }, null, 4));
      expect((await findPreviousRound(TARGET, head, flowDeps(registry))).round.mode).toBe("delta");
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, target: { ...manifest.target, head: B } }));
      expect((await findPreviousRound(TARGET, head, flowDeps(registry))).round.mode).not.toBe("delta");
      writeFileSync(manifestFile, JSON.stringify(manifest));
      write(`${flowDir}/findings.json`, JSON.stringify([finding("F-1", { severity: "minor" })]));
      expect((await findPreviousRound(TARGET, head, flowDeps(registry))).round.mode).toBe("fallback-first");
    });

    test("the registry compacts to the newest entry per package past 512 KB, and a read over the cap warns", () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-round-registry-"));
      try {
        const make = (packageId: string, at: string): RoundRegistryEntry => ({ v: 2, packageId, targetKey: "pr:acme/app#7", reviewedHead: A, manifestSha256: "a".repeat(64), findingsSha256: null, completedAt: at, event: "complete" });
        expect(compactEntries([make("p", "1"), make("q", "2"), make("p", "3")]).map((e) => `${e.packageId}${e.completedAt}`)).toEqual(["q2", "p3"]);
        const file = roundRegistryFile("remote:big", dataDir);
        mkdirSync(path.dirname(file), { recursive: true });
        const line = `${JSON.stringify(make("p", "x".repeat(300)))}\n`;
        writeFileSync(file, line.repeat(Math.ceil(REGISTRY_COMPACT_BYTES / line.length) + 10));
        const written = appendRoundRegistry("remote:big", make("q", "now"), dataDir);
        expect(written.compacted).toBeGreaterThan(500);
        expect(readRoundRegistry("remote:big", dataDir).map((e) => e.packageId)).toEqual(["p", "q"]);
        writeFileSync(file, line.repeat(Math.ceil((1_100_000) / line.length)));
        expect(readRoundRegistryReport("remote:big", dataDir).warning).toContain("over the 1 MB read cap");
        expect(appendRoundRegistry("remote:big", make("r", "now"), dataDir).warning).toContain("started again");
        expect(readRoundRegistry("remote:big", dataDir).map((e) => e.packageId)).toEqual(["r"]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    test("the registry file lives outside the repository, one per repository identity, and round-trips", () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-round-registry-"));
      try {
        writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, findings: [finding("F-1")] });
        git("remote", "add", "origin", "https://token@github.com/Acme/App.git");
        expect(repoIdentity(root)).toBe("remote:https://github.com/acme/app");
        const recorded = recordFinishedRound(path.join(root, ".metaproject/reviews/r1"), "publish", { cwd: root, dir: dataDir });
        expect(recorded.error).toBeUndefined();
        expect(recorded.file!.startsWith(dataDir)).toBe(true);
        expect(recorded.file!.startsWith(root)).toBe(false);
        const entries = readRoundRegistry(repoIdentity(root), dataDir);
        expect(entries).toEqual([expect.objectContaining({ v: 2, packageId: "r1", reviewedHead: A, event: "publish" })]);
        expect(registryVouches(entries, "r1", packageFacts(path.join(root, ".metaproject/reviews/r1"))!.hashes)).toBeDefined();
        write(".metaproject/reviews/r1/findings.json", "[]");
        expect(registryVouches(entries, "r1", packageFacts(path.join(root, ".metaproject/reviews/r1"))!.hashes)).toBeUndefined();
        expect(readRoundRegistry("remote:another", dataDir)).toEqual([]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  test("a forced --prior package is held to the same rule", async () => {
    commit("add review record", { ...packageFiles(".metaproject/reviews/fake", { reviewId: "fake", head: A }) });
    const head = commit("code", { "src/auth.ts": "x\n" });
    const { round } = await findPreviousRound(TARGET, head, { cwd: root, github: offline, forced: "fake" });
    expect(round.mode).toBe("fallback-first");
  });

  test("M1: a draft is never a previous round, even with findings; `reviewed` without completion evidence is context only", async () => {
    writePackage(".metaproject/reviews/draft", { reviewId: "draft", head: A, status: "draft", findings: [finding("F-1")] });
    expect((await findPreviousRound(TARGET, B, { cwd: root, github: offline })).round.previous).toBeNull();
    writePackage(".metaproject/reviews/partial", { reviewId: "partial", head: A, status: "reviewed", findings: [finding("F-2")] });
    const partial = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(partial.round).toMatchObject({ mode: "fallback-first", previous: { reviewId: "partial" } });
    expect(partial.round.sourcesTried[0]!.detail).toContain("no completion evidence");
    // published.json is completion evidence.
    write(".metaproject/reviews/partial/published.json", "{}");
    expect((await findPreviousRound(TARGET, B, { cwd: root, github: offline })).round).toMatchObject({ mode: "delta", previous: { reviewId: "partial" } });
  });

  test("a ledger that established scopeReviewed is completion evidence; one that did not is not", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, status: "draft" });
    write(".metaproject/reviews/r1/research.json", JSON.stringify({ scopeReviewed: false }));
    expect((await findPreviousRound(TARGET, B, { cwd: root, github: offline })).round.previous).toBeNull();
    write(".metaproject/reviews/r1/research.json", JSON.stringify({ scopeReviewed: true }));
    expect((await findPreviousRound(TARGET, B, { cwd: root, github: offline })).round.mode).toBe("delta");
  });

  test("git history reads the local branches only: a package reachable from a remote-tracking ref alone is not searched", async () => {
    git("checkout", "-q", "-b", "tmp", A);
    const remoteOnly = commit("review package", packageFiles(".metaproject/reviews/r-remote", { reviewId: "r-remote", head: A }));
    git("checkout", "-q", "feature");
    git("branch", "-q", "-D", "tmp");
    git("update-ref", "refs/remotes/origin/other", remoteOnly);
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: offline });
    expect(round.previous).toBeNull();
    expect(round.sourcesTried.find((t) => t.source === "git-history")?.detail).toContain("180 days");
  });
});

describe("target identity", () => {
  test("bare pull request numbers match the same pull request in any spelling; a branch named 7 does not", () => {
    expect(pullRequestOf("7")).toEqual({ repo: "", number: 7 });
    expect(pullRequestOf("#7")).toEqual({ repo: "", number: 7 });
    expect(sameReviewTarget({ kind: "pr", ref: "7" }, TARGET)).toBe(true);
    expect(sameReviewTarget({ kind: "pr", ref: "#7" }, { kind: "pr", ref: "acme/app#7" })).toBe(true);
    expect(sameReviewTarget({ kind: "branch", ref: "7" }, TARGET)).toBe(false);
    expect(sameReviewTarget({ kind: "pr", ref: "8" }, TARGET)).toBe(false);
    expect(targetKeyOf({ kind: "pr", ref: PR })).toBe("pr:acme/app#7");
    expect(targetKeyOf({ kind: "branch", ref: "feat/x" })).toBe("branch:feat/x");
    expect(targetKeyOf({ kind: "branch", ref: A.slice(0, 8) }, "main")).toBe("range:main");
  });

  test("a branch target recorded as a commit is found from the branch name on the same branch line, never from another line", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, ref: A.slice(0, 8), findings: [finding("F-1")] });
    const manifest = JSON.parse(readFileSync(path.join(root, ".metaproject/reviews/r1/manifest.json"), "utf8"));
    writeFileSync(path.join(root, ".metaproject/reviews/r1/manifest.json"), JSON.stringify({ ...manifest, target: { ...manifest.target, kind: "branch" } }));
    const branch = { kind: "branch", ref: "feature" };
    const { round } = await findPreviousRound(branch, B, { cwd: root, github: offline });
    expect(round).toMatchObject({ mode: "delta", previous: { reviewId: "r1" }, range: { base: A, head: B } });

    // Another line: a branch package reviewed at a head this branch does not contain.
    git("checkout", "-q", "-b", "other", A);
    const X = commit("other line", { "src/x.ts": "x\n" });
    git("checkout", "-q", "feature");
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: X, ref: "other" });
    const off = JSON.parse(readFileSync(path.join(root, ".metaproject/reviews/r1/manifest.json"), "utf8"));
    writeFileSync(path.join(root, ".metaproject/reviews/r1/manifest.json"), JSON.stringify({ ...off, target: { ...off.target, kind: "branch" } }));
    const other = await findPreviousRound(branch, B, { cwd: root, github: offline });
    expect(other.round.previous).toBeNull();
    expect(other.round.sourcesTried[0]!.detail).toContain("not on this branch line: r1");
  });

  test("a pull request package never matches a branch target, and a branch package never a pull request", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A });
    expect((await findPreviousRound({ kind: "branch", ref: "feature" }, B, { cwd: root, github: offline })).round.previous).toBeNull();
  });
});

describe("PR comments are context, never fix hunks (M2)", () => {
  test("a comment on changed code does not make a hunk FIX and is carried", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A });
    const comment = { id: "review-comment:11", source: "review-comment", author: "carol", authorIsBot: false, url: "u", body: "This drops the error.", path: "src/a.ts", line: 5, threadId: "11", submittedAt: "2026-10-02T00:00:00Z", reviewState: null, severity: "minor", severityBasis: "default-minor", severityDetail: "", reopened: false } as CollectedComment;
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: consulted([], [comment]) });
    expect(round.mode).toBe("delta");
    expect(round.fixHunks).toEqual([]);
    expect(round.carried).toEqual([{ findingId: "review-comment:11", disposition: "open" }]);
  });

  test("a comment on a hunk a prior finding already made FIX is attached to it for the resolution check", async () => {
    writePackage(".metaproject/reviews/r1", { reviewId: "r1", head: A, findings: [finding("F-1", { line: 5, quote: "line five" })] });
    const comment = { id: "review-comment:12", source: "review-comment", author: "carol", authorIsBot: false, url: "u", body: "Same line.", path: "src/a.ts", line: 5, threadId: "12", submittedAt: "2026-10-02T00:00:00Z", reviewState: null, severity: "minor", severityBasis: "default-minor", severityDetail: "", reopened: false } as CollectedComment;
    const { round } = await findPreviousRound(TARGET, B, { cwd: root, github: consulted([], [comment]) });
    expect(round.fixHunks).toEqual([{ file: "src/a.ts", startLine: 5, endLine: 5, findingIds: ["F-1", "review-comment:12"] }]);
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
    // The manifest carries the target key and the hashes of the round record; an edit afterwards is detected.
    const stampRecord = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).roundRecord;
    expect(stampRecord).toMatchObject({ targetKey: "pr:acme/app#7", targetBase: "main", roundSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(roundRecordTampered(dir)).toBeUndefined();
    writeFileSync(path.join(dir, "prior_findings.json"), "[]\n");
    expect(roundRecordTampered(dir)).toContain("prior_findings.json");
  }, 60_000);

  test("a malformed round.json is refused, not read leniently", () => {
    const dir = path.join(root, "pkg");
    mkdirSync(dir, { recursive: true });
    const good = { ...skippedRound(B).round };
    writeFileSync(path.join(dir, "round.json"), JSON.stringify({ ...good, fixHunks: [{ file: "a.ts", startLine: 1, endLine: 2, findingIds: [3] }] }));
    expect(() => readRoundRecord(dir)).toThrow(/fixHunks/);
    writeFileSync(path.join(dir, "round.json"), JSON.stringify({ ...good, carried: "none" }));
    expect(() => readRoundRecord(dir)).toThrow(/carried/);
    writeFileSync(path.join(dir, "round.json"), JSON.stringify(good));
    expect(readRoundRecord(dir)).toEqual(good);
  });

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
