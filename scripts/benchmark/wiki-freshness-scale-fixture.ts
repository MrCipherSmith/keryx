// Fixture + independent oracle for the AC3/AC-22 freshness-cost-at-scale benchmark
// (flow 236, phase 4, T10). See fixtures/wiki-freshness-scale/README.md for the
// corpus shape and fixtures/wiki-freshness-scale/manifest.json for the numbers this
// file reads.
//
// GROUND TRUTH, AND WHY IT DOES NOT DEPEND ON THE CODE UNDER TEST
// -----------------------------------------------------------------------------
// The code under test is `evaluatePageFreshness`
// (src/wiki/freshness/page-freshness.ts) — specifically its git-subprocess cost at
// scale and its verdict (`basis`/`changed`/`gitFailure`). This module never calls
// that function, or `buildFreshnessReport`, to decide what the "right" answer is:
//
//   - For the `git-log` family the oracle is the fixture's OWN bookkeeping of which
//     files it touched in the one mutation commit it makes. That is ground truth by
//     construction, not by re-derivation: this file is the one thing that knows,
//     with certainty, which files changed after which checkpoint commit, because it
//     is the thing that did the changing.
//   - For the `scope-hash` family (`git-log-unreachable` and `scope-hash`
//     categories) the oracle needs a frozen `VerifiedScope` value comparable to
//     whatever `computeVerifiedScope` (src/wiki/provenance.ts) computes at
//     evaluation time. Rather than import and call that function — which would make
//     the oracle trivially agree with a broken implementation of the same function
//     — `expectedVerifiedScope` below is an INDEPENDENT reimplementation, written
//     directly from `computePageNodeHash`'s documented algorithm
//     (src/wiki/staleness.ts:50-58): sha256 of sorted `{path}:{sha256(content)}`
//     pairs joined by "\n", a missing/unreadable path hashing as the literal string
//     `<missing>`. Two independent implementations of a fully-specified,
//     deterministic hash agreeing is real evidence; one implementation calling
//     itself is not.
//   - `undecidable` ground truth (no VerifiedAt, no VerifiedScope) is a property of
//     the INPUT this file constructs, not an inference about the implementation:
//     the freshness contract itself (page-freshness.ts's own doc comment) says "no
//     evidence, never fresh" is the only defensible answer when neither pointer
//     exists, so asserting `undecidable` here is reading the contract, not the code.
//   - `git-failure` ground truth is a transform of the above: ANY page carrying a
//     `verifiedAt` depends on git and must resolve to `undecidable` with a
//     `gitFailure` reason when git is unavailable this run (flow 236 T7, already
//     landed — see page-freshness.ts:91-102). A page with neither pointer never
//     touches git and is unaffected. This is the ALREADY-CLOSED contract this
//     benchmark re-verifies at scale; it is not re-derived here.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../../src/gdgraph/types";

// --- deterministic PRNG (mulberry32; no external dependency, reproducible) ------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- independent VerifiedScope reimplementation (see header note) --------------

export function expectedVerifiedScope(files: ReadonlyArray<{ path: string; content: string | null }>): string {
  const entries = files
    .map((f) => ({
      path: f.path,
      digest: f.content === null ? "<missing>" : createHash("sha256").update(f.content).digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const combined = entries.map((e) => `${e.path}:${e.digest}`).join("\n");
  return `sha256:${createHash("sha256").update(combined).digest("hex")}`;
}

// --- oracle verdict --------------------------------------------------------------

/**
 * The MEANING-level ground truth this benchmark checks the real implementation
 * against. Deliberately coarser than `PageFreshness` (page-freshness.ts): it does
 * not distinguish which basis produced "unchanged" vs "changed", because AC-22 asks
 * for agreement "in meaning", and the meaning that matters to a caller is whether
 * the page needs another look, not which measurement path proved it.
 */
export type OracleVerdict =
  | { kind: "unchanged" }
  | { kind: "changed" }
  | { kind: "undecidable" }
  | { kind: "git-failure" };

export type FixturePageCategory = "git-log" | "git-log-unreachable" | "scope-hash" | "undecidable";

export interface FreshnessFixturePage {
  /** Synthetic wiki page id — never written to disk as a real markdown file. */
  page: string;
  category: FixturePageCategory;
  describePath: string;
  verifiedAt: string | null;
  verifiedScope: string | null;
  changed: boolean;
  /** Ground truth under a healthy, fully-available git. */
  oracle: OracleVerdict;
  /** Ground truth under a run where git is wholly unavailable (rev-parse fails). */
  oracleUnderGitFailure: OracleVerdict;
}

export interface FreshnessFixtureCorpus {
  size: number;
  seed: number;
  root: string;
  pages: FreshnessFixturePage[];
  graph: GraphData;
  rootCommit: string;
  headCommit: string;
  /** Removes the temp git repository this corpus was built in. */
  cleanup: () => void;
}

export interface FreshnessFixtureManifest {
  seed: number;
  scales: number[];
  categoryShares: {
    gitLogReachable: number;
    gitLogUnreachable: number;
    scopeHashOnly: number;
    undecidable: number;
  };
  changedShareWithinGitLike: number;
  changedShareWithinScopeHashOnly: number;
}

function runGit(cwd: string, args: string[], env?: Record<string, string>): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8").trim();
}

/**
 * A commit's sha is a function of its tree, parent, message AND author/committer
 * date — real wall-clock commit dates would make two separate runs of this
 * generator (same seed) produce DIFFERENT commit shas even though every byte of
 * content is identical, breaking "the same seed must give the same corpus"
 * (fixtures/wiki-freshness-scale/README.md). Every commit below is stamped with a
 * fixed, index-derived date instead of "now".
 */
const FIXTURE_EPOCH_SECONDS = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000);

function commitEnv(commitIndex: number): Record<string, string> {
  const date = `${FIXTURE_EPOCH_SECONDS + commitIndex} +0000`;
  return {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: "keryx freshness fixture",
    GIT_AUTHOR_EMAIL: "fixture@keryx.test",
    GIT_COMMITTER_NAME: "keryx freshness fixture",
    GIT_COMMITTER_EMAIL: "fixture@keryx.test",
  };
}

function writeGenFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A syntactically-valid but never-committed 40-hex sha, deterministic per input. */
function fakeSha(seed: number, index: number): string {
  return createHash("sha1").update(`keryx-freshness-fixture:${seed}:${index}`).digest("hex");
}

/**
 * Build a throwaway git repository with `size` synthetic pages, classified and
 * mutated deterministically from `seed` per `manifest`'s proportions. Same
 * (size, seed, manifest) in ⇒ byte-identical repository history out.
 */
export function generateFreshnessScaleCorpus(
  size: number,
  seed: number,
  manifest: FreshnessFixtureManifest,
  opts: { baseDir?: string } = {},
): FreshnessFixtureCorpus {
  const root = mkdtempSync(path.join(opts.baseDir ?? tmpdir(), `keryx-freshness-scale-${size}-`));
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "fixture@keryx.test"]);
  runGit(root, ["config", "user.name", "keryx freshness fixture"]);
  // A fixture repo with a locally-modified global excludes/hooks path must not leak in.
  runGit(root, ["config", "commit.gpgsign", "false"]);

  const rand = mulberry32(seed);
  const files: string[] = [];
  const initialContent = new Map<string, string>();
  for (let i = 0; i < size; i++) {
    const rel = `src-gen/mod-${String(i).padStart(6, "0")}.ts`;
    const content = `export const value = ${i};\n// generation: v0\n`;
    files.push(rel);
    initialContent.set(rel, content);
    writeGenFile(root, rel, content);
  }
  let commitIndex = 0;
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "root: generated corpus v0"], commitEnv(commitIndex++));
  const rootCommit = runGit(root, ["rev-parse", "HEAD"]);

  const buckets = Math.max(1, Math.min(20, Math.round(Math.sqrt(size))));
  const checkpoints: string[] = [];
  for (let b = 0; b < buckets; b += 1) {
    writeGenFile(root, `.checkpoints/marker-${b}.txt`, `checkpoint ${b}\n`);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", `checkpoint ${b}`], commitEnv(commitIndex++));
    checkpoints.push(runGit(root, ["rev-parse", "HEAD"]));
  }

  const shares = manifest.categoryShares;
  const thresholds = {
    gitLog: shares.gitLogReachable,
    unreachable: shares.gitLogReachable + shares.gitLogUnreachable,
    scopeHash: shares.gitLogReachable + shares.gitLogUnreachable + shares.scopeHashOnly,
  };

  const pages: FreshnessFixturePage[] = [];
  const toMutate: string[] = [];

  for (let i = 0; i < size; i += 1) {
    const describePath = files[i] as string;
    const categoryDraw = rand();
    const changedDraw = rand();
    const bucketDraw = rand();

    let category: FixturePageCategory;
    if (categoryDraw < thresholds.gitLog) category = "git-log";
    else if (categoryDraw < thresholds.unreachable) category = "git-log-unreachable";
    else if (categoryDraw < thresholds.scopeHash) category = "scope-hash";
    else category = "undecidable";

    const isGitLike = category === "git-log" || category === "git-log-unreachable";
    const changedShare = isGitLike ? manifest.changedShareWithinGitLike : manifest.changedShareWithinScopeHashOnly;
    const changed = category === "undecidable" ? false : changedDraw < changedShare;

    let verifiedAt: string | null = null;
    let verifiedScope: string | null = null;

    if (category === "git-log") {
      const bucket = Math.floor(bucketDraw * buckets) % buckets;
      verifiedAt = checkpoints[bucket] as string;
    } else if (category === "git-log-unreachable") {
      verifiedAt = fakeSha(seed, i);
      verifiedScope = expectedVerifiedScope([{ path: describePath, content: initialContent.get(describePath) ?? null }]);
    } else if (category === "scope-hash") {
      verifiedScope = expectedVerifiedScope([{ path: describePath, content: initialContent.get(describePath) ?? null }]);
    }
    // "undecidable": both stay null.

    if (changed) toMutate.push(describePath);

    const oracle: OracleVerdict =
      category === "undecidable" ? { kind: "undecidable" } : changed ? { kind: "changed" } : { kind: "unchanged" };
    const oracleUnderGitFailure: OracleVerdict = verifiedAt !== null ? { kind: "git-failure" } : oracle;

    pages.push({
      page: `generated/page-${String(i).padStart(6, "0")}.md`,
      category,
      describePath,
      verifiedAt,
      verifiedScope,
      changed,
      oracle,
      oracleUnderGitFailure,
    });
  }

  if (toMutate.length > 0) {
    for (const rel of toMutate) {
      writeGenFile(root, rel, `export const value = "mutated";\n// generation: v1\n`);
    }
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", `mutate ${toMutate.length} files`], commitEnv(commitIndex));
  }
  const headCommit = runGit(root, ["rev-parse", "HEAD"]);

  const graph: GraphData = {
    nodes: files.map((f) => ({ id: f, kind: "file" as const, path: f, language: "typescript" as const })),
    edges: [],
  };

  return {
    size,
    seed,
    root,
    pages,
    graph,
    rootCommit,
    headCommit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
