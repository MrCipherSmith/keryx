// Producer script for fixtures/benchmark/express/gold-dependency-set.json. Mirrors
// generate-express-gold.ts's shape (clone pinned commit -> derive gold -> write fixture),
// but for the SECOND, dependency-derived gold described in src/metrics/gold.ts
// (`goldDependencyClosure`): it clones expressjs/express at the SAME pinned commit used by
// the co-change gold, reads every tracked `.js` file, parses and resolves imports with the
// INDEPENDENT parser in ./parse-imports.ts (never gdgraph), builds the direct-import graph,
// and derives the transitive dependency closure for the three pinned targets.
//
// Regenerate with:
//   bun scripts/benchmark/generate-express-deps-gold.ts
//   bun scripts/benchmark/generate-express-deps-gold.ts --repo /path/to/existing/express/clone
//   bun scripts/benchmark/generate-express-deps-gold.ts --check   # verify committed fixture is up to date
//
// Without --repo, the script performs a full clone of expressjs/express into a fresh temp
// directory (removed afterwards) and checks out the pinned commit. This requires network
// access; if the clone fails, the fixture is left untouched — the derivation itself
// (goldDependencyClosure + the parser) is fully unit-tested offline regardless
// (src/metrics/gold.test.ts), so a failure here never blocks that.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldDependencyClosure } from "../../src/metrics/gold";
import { buildImportGraph, type RepoSourceMap } from "./parse-imports";

export const EXPRESS_REPO_URL = "https://github.com/expressjs/express.git";
// Same pinned SHA as generate-express-gold.ts, so the co-change gold and the dependency
// gold describe the exact same tree (specification.md AC-2 reproducibility).
export const PINNED_SHA = "a3714473feb3d2908add734d340e7755fd85e0a3";
export const TARGET_FILES = ["lib/application.js", "lib/express.js", "lib/utils.js"] as const;

const fixtureRoot = new URL("../../fixtures/benchmark/express/", import.meta.url);

type SpawnResult = { stdout: string; stderr: string; ok: boolean };

function run(cmd: string[], cwd?: string): SpawnResult {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ok: result.exitCode === 0,
  };
}

function cloneAtCommit(dir: string): void {
  const clone = run(["git", "clone", "--quiet", EXPRESS_REPO_URL, dir]);
  if (!clone.ok) throw new Error(`git clone failed: ${clone.stderr}`);
  const checkout = run(["git", "checkout", "--quiet", PINNED_SHA], dir);
  if (!checkout.ok) throw new Error(`git checkout ${PINNED_SHA} failed: ${checkout.stderr}`);
}

/** List every git-tracked `.js` file at the current checkout, repo-relative, forward-slash paths. */
function listTrackedJsFiles(dir: string): string[] {
  const lsFiles = run(["git", "ls-files", "--", "*.js"], dir);
  if (!lsFiles.ok) throw new Error(`git ls-files failed: ${lsFiles.stderr}`);
  return lsFiles.stdout.split("\n").filter((line) => line.length > 0);
}

async function readSources(dir: string, files: readonly string[]): Promise<RepoSourceMap> {
  const sources: Record<string, string> = {};
  for (const file of files) {
    sources[file] = await Bun.file(join(dir, file)).text();
  }
  return sources;
}

type TargetDependencyGold = {
  target: string;
  dependencies: string[];
  dependents: string[];
  affected: string[];
};

function deriveGoldForTargets(
  graph: Record<string, string[]>,
  targets: readonly string[],
): TargetDependencyGold[] {
  return targets.map((target) => {
    const result = goldDependencyClosure(graph, target);
    return {
      target,
      dependencies: result.dependencies,
      dependents: result.dependents,
      affected: result.affected,
    };
  });
}

async function generate(repoDir?: string): Promise<Readonly<Record<string, string>>> {
  let workDir = repoDir;
  let cleanup: (() => void) | undefined;

  if (workDir === undefined) {
    workDir = mkdtempSync(join(tmpdir(), "keryx-express-deps-gold-"));
    cleanup = () => rmSync(workDir as string, { recursive: true, force: true });
    cloneAtCommit(workDir);
  } else {
    const head = run(["git", "rev-parse", "HEAD"], workDir);
    if (!head.ok || head.stdout.trim() !== PINNED_SHA) {
      throw new Error(`--repo ${workDir} is not checked out at the pinned commit ${PINNED_SHA}`);
    }
  }

  try {
    const files = listTrackedJsFiles(workDir);
    const sources = await readSources(workDir, files);
    const graph = buildImportGraph(sources);
    const goldByTarget = deriveGoldForTargets(graph, TARGET_FILES);

    const manifest = {
      repo: EXPRESS_REPO_URL,
      pinned_commit: PINNED_SHA,
      pinned_branch: "master",
      target_files: [...TARGET_FILES],
      derivation: {
        method: "goldDependencyClosure (src/metrics/gold.ts) over an import graph built by " +
          "scripts/benchmark/parse-imports.ts — an INDEPENDENT parser/resolver that never " +
          "calls gdgraph, so scoring gdgraph's affected-set against this gold is not circular.",
        rule:
          "dependencies(target) = transitive closure of target's forward import edges " +
          "(target's direct imports, their imports, ...), self and cycles excluded. " +
          "dependents(target) = transitive closure of the reverse edges (every file that " +
          "transitively imports target). affected = dependencies ∪ dependents, sorted. " +
          "See goldDependencyClosure's doc comment in src/metrics/gold.ts for the full rule.",
        parser: "scripts/benchmark/parse-imports.ts: require(...) / import(...) / " +
          "import ... from '...'; relative specifiers (./ ../) resolved against the known " +
          "repo-relative .js file set (exact path, +.js, or /index.js); bare/package " +
          "specifiers are external and excluded.",
        corpus: "every git-tracked *.js file at the pinned commit",
        corpus_file_count: files.length,
      },
      regenerate_command: "bun scripts/benchmark/generate-express-deps-gold.ts",
      generated_at: "2026-08-13",
    };

    const goldDependencySetFixture = { pinned_commit: PINNED_SHA, targets: goldByTarget };

    return {
      "gold-dependency-set.json": `${JSON.stringify({ ...manifest, ...goldDependencySetFixture }, null, 2)}\n`,
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
    console.log("fixtures/benchmark/express/gold-dependency-set.json is up to date");
  } else {
    for (const [relative, content] of Object.entries(generated)) {
      await Bun.write(new URL(relative, fixtureRoot), content);
    }
    console.log("wrote", Object.keys(generated).join(", "));
  }
}
