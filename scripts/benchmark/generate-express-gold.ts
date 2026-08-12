// Producer script for fixtures/benchmark/express/*. This is the "thin, I/O-doing" half
// of the gold-label pipeline described in src/metrics/gold.ts: it shells out to git to
// gather the raw co-change history for a PINNED express commit, then hands the parsed
// history to the pure `goldAffectedSet` derivation in src/metrics/gold.ts and writes the
// result as a committed, reproducible fixture.
//
// Regenerate with:
//   bun scripts/benchmark/generate-express-gold.ts
//   bun scripts/benchmark/generate-express-gold.ts --repo /path/to/existing/express/clone
//   bun scripts/benchmark/generate-express-gold.ts --check   # verify committed fixture is up to date
//
// Without --repo, the script performs a full clone of expressjs/express into a fresh
// temp directory (removed afterwards) and checks out the pinned commit. This requires
// network access; if the clone fails, the fixture is left untouched (see
// fixtures/benchmark/express/README.md for the network-unavailable fallback).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldAffectedSet, parseGitLogNameOnly, type CoChangeCommit } from "../../src/metrics/gold";

export const EXPRESS_REPO_URL = "https://github.com/expressjs/express.git";
// Pinned commit: expressjs/express@master, captured 2026-08-12. Recorded explicitly (not
// "current HEAD") so the fixture is reproducible: re-running this script against the same
// SHA must reproduce the same gold numbers, per specification.md AC-2.
export const PINNED_SHA = "a3714473feb3d2908add734d340e7755fd85e0a3";
export const TARGET_FILES = ["lib/application.js", "lib/express.js", "lib/utils.js"] as const;
// How many of the highest-coChanges near-miss/gold files to keep per target in the
// committed fixture, so it stays small while still documenting the near-threshold
// candidates an auditor would want to see (not just the files that cleared the bar).
const TOP_N_SUPPORT = 20;

const fixtureRoot = new URL("../../fixtures/benchmark/express/", import.meta.url);

type GitResult = { stdout: string; ok: boolean; stderr: string };

function git(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ok: result.exitCode === 0,
  };
}

/** Clone `repoUrl` at `sha` into `dir` (must not already exist). Throws on any git failure. */
function cloneAtCommit(repoUrl: string, sha: string, dir: string): void {
  const clone = Bun.spawnSync(["git", "clone", "--quiet", repoUrl, dir], { stdout: "pipe", stderr: "pipe" });
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed: ${clone.stderr.toString("utf8")}`);
  }
  const checkout = git(["checkout", "--quiet", sha], dir);
  if (!checkout.ok) throw new Error(`git checkout ${sha} failed: ${checkout.stderr}`);
}

/** Gather first-parent co-change history up to `sha` from an already-checked-out clone. */
function collectHistory(dir: string, sha: string): { history: CoChangeCommit[]; commitCount: number } {
  const log = git(["log", "--first-parent", "--pretty=format:commit %H", "--name-only", sha], dir);
  if (!log.ok) throw new Error(`git log failed: ${log.stderr}`);
  const history = parseGitLogNameOnly(log.stdout);

  const count = git(["rev-list", "--first-parent", "--count", sha], dir);
  if (!count.ok) throw new Error(`git rev-list failed: ${count.stderr}`);
  const commitCount = Number.parseInt(count.stdout.trim(), 10);

  return { history, commitCount };
}

type TargetGold = {
  target: string;
  commitsWithTarget: number;
  affected: string[];
  totalCoChangingFiles: number;
  topCoChanges: Array<{ file: string; coChanges: number; support: number }>;
};

function deriveGoldForTargets(history: CoChangeCommit[], targets: readonly string[]): TargetGold[] {
  return targets.map((target) => {
    const result = goldAffectedSet(history, target);
    const ranked = Object.entries(result.support)
      .map(([file, stats]) => ({ file, ...stats }))
      .sort((a, b) => b.coChanges - a.coChanges || a.file.localeCompare(b.file));
    return {
      target,
      commitsWithTarget: result.commitsWithTarget,
      affected: result.affected,
      totalCoChangingFiles: ranked.length,
      topCoChanges: ranked.slice(0, TOP_N_SUPPORT),
    };
  });
}

async function generate(repoDir?: string): Promise<Readonly<Record<string, string>>> {
  let workDir = repoDir;
  let cleanup: (() => void) | undefined;

  if (workDir === undefined) {
    workDir = mkdtempSync(join(tmpdir(), "keryx-express-gold-"));
    cleanup = () => rmSync(workDir as string, { recursive: true, force: true });
    cloneAtCommit(EXPRESS_REPO_URL, PINNED_SHA, workDir);
  } else {
    const head = git(["rev-parse", "HEAD"], workDir);
    if (!head.ok || head.stdout.trim() !== PINNED_SHA) {
      throw new Error(`--repo ${workDir} is not checked out at the pinned commit ${PINNED_SHA}`);
    }
  }

  try {
    const { history, commitCount } = collectHistory(workDir, PINNED_SHA);
    const goldByTarget = deriveGoldForTargets(history, TARGET_FILES);

    const manifest = {
      repo: EXPRESS_REPO_URL,
      pinned_commit: PINNED_SHA,
      pinned_branch: "master",
      target_files: [...TARGET_FILES],
      derivation: {
        method: "goldAffectedSet (src/metrics/gold.ts)",
        rule:
          "A file f is gold-affected for target iff, among commits (first-parent history " +
          "up to the pinned commit) that touched target, f co-occurs in at least " +
          "minCoChanges commits AND co-occurs in at least minSupport of them " +
          "(coChanges(f) / commitsWithTarget). Both defaults below. See goldAffectedSet's " +
          "doc comment in src/metrics/gold.ts for the full rule.",
        minCoChanges: 2,
        minSupport: 0.34,
        history_window: "git log --first-parent (linear ancestry of the pinned commit, full repo history)",
        first_parent_commit_count: commitCount,
        parsed_commit_count: history.length,
      },
      regenerate_command: "bun scripts/benchmark/generate-express-gold.ts",
      generated_at: "2026-08-12",
    };

    const goldAffectedSetFixture = { pinned_commit: PINNED_SHA, targets: goldByTarget };

    return {
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "gold-affected-set.json": `${JSON.stringify(goldAffectedSetFixture, null, 2)}\n`,
    };
  } finally {
    cleanup?.();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoFlagIndex = args.indexOf("--repo");
  const repoDir = repoFlagIndex >= 0 ? args[repoFlagIndex + 1] : undefined;
  const check = args.includes("--check");

  const generated = await generate(repoDir);

  if (check) {
    let stale = false;
    for (const [relative, expected] of Object.entries(generated)) {
      const file = Bun.file(new URL(relative, fixtureRoot));
      const actual = (await file.exists()) ? await file.text() : null;
      if (actual !== expected) {
        stale = true;
        console.error(`stale or missing generated fixture: ${relative}`);
      }
    }
    if (stale) process.exit(1);
    console.log("fixtures/benchmark/express is up to date");
  } else {
    for (const [relative, content] of Object.entries(generated)) {
      await Bun.write(new URL(relative, fixtureRoot), content);
    }
    console.log("wrote", Object.keys(generated).join(", "));
  }
}
