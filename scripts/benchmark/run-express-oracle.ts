// Producer for the metastore ORACLE slice on expressjs/express. This is the thin,
// I/O-doing, NETWORK-DEPENDENT half of the pipeline (mirrors generate-express-gold.ts):
// it clones express at the pinned commit, builds the gdgraph code graph, runs
// `gdgraph affected <target>` for the three pinned targets, parses the affected output
// into system-output ID sets, writes them to fixtures/benchmark/express/gdgraph-affected.json,
// then scores them against the committed git-history gold via the PURE scorer in
// src/metrics/oracle-runner.ts and prints the paired-3-5-v2 manifest + validation result.
//
// Regenerate with:
//   bun scripts/benchmark/run-express-oracle.ts
//   bun scripts/benchmark/run-express-oracle.ts --repo /path/to/existing/express/clone
//   bun scripts/benchmark/run-express-oracle.ts --keryx /path/to/keryx   # custom CLI entry
//
// Without --repo it performs a full clone into a temp dir (removed afterwards) and checks
// out the pinned SHA. This requires network access AND a working `keryx gdgraph build`; if
// either fails the committed fixture is left untouched and the script exits non-zero. The
// scorer itself is fully unit-tested offline (src/metrics/oracle-runner.test.ts), so a
// failure here never blocks the metastore slice — it only means the real gdgraph-affected
// fixture was not refreshed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import {
  buildOracleManifestsByGold,
  GOLD_KIND_LABELS,
  type GoldKind,
  type MultiGoldScoreInput,
} from "../../src/metrics/oracle-runner";

const EXPRESS_REPO_URL = "https://github.com/expressjs/express.git";
// Same pinned SHA as generate-express-gold.ts, so the system output and the gold labels
// describe the exact same tree (specification.md AC-2 reproducibility).
const PINNED_SHA = "a3714473feb3d2908add734d340e7755fd85e0a3";
const TARGET_FILES = ["lib/application.js", "lib/express.js", "lib/utils.js"] as const;

const fixtureRoot = new URL("../../fixtures/benchmark/express/", import.meta.url);
const coChangeGoldUrl = new URL("gold-affected-set.json", fixtureRoot);
const dependencyGoldUrl = new URL("gold-dependency-set.json", fixtureRoot);
const systemFixtureUrl = new URL("gdgraph-affected.json", fixtureRoot);

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

type AffectedJson = { dependencies?: string[]; dependents?: string[] };

/**
 * Parse `keryx gdgraph affected <target> --json` into the system-output affected ID set:
 * the union of the target's dependencies and dependents (deduped, sorted). This is the
 * real "what the tool says is affected" set scored against the git-history gold.
 */
function parseAffected(json: string): string[] {
  const parsed = JSON.parse(json) as AffectedJson;
  const ids = new Set<string>([...(parsed.dependencies ?? []), ...(parsed.dependents ?? [])]);
  return [...ids].sort();
}

function keryxCli(): string[] {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--keryx");
  if (flag >= 0 && args[flag + 1]) return [args[flag + 1] as string];
  return ["keryx"];
}

async function loadGold(url: URL): Promise<Map<string, string[]>> {
  const raw = JSON.parse(await Bun.file(url).text()) as {
    targets: Array<{ target: string; affected: string[] }>;
  };
  return new Map(raw.targets.map((t) => [t.target, t.affected]));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoFlag = args.indexOf("--repo");
  const repoDir = repoFlag >= 0 ? args[repoFlag + 1] : undefined;
  const cli = keryxCli();

  let workDir = repoDir;
  let cleanup: (() => void) | undefined;
  if (workDir === undefined) {
    workDir = mkdtempSync(join(tmpdir(), "keryx-express-oracle-"));
    cleanup = () => rmSync(workDir as string, { recursive: true, force: true });
    cloneAtCommit(workDir);
  } else {
    const head = run(["git", "rev-parse", "HEAD"], workDir);
    if (!head.ok || head.stdout.trim() !== PINNED_SHA) {
      throw new Error(`--repo ${workDir} is not checked out at the pinned commit ${PINNED_SHA}`);
    }
  }

  try {
    const build = run([...cli, "gdgraph", "build"], workDir);
    if (!build.ok) throw new Error(`keryx gdgraph build failed: ${build.stderr || build.stdout}`);

    const system = new Map<string, string[]>();
    for (const target of TARGET_FILES) {
      const affected = run([...cli, "gdgraph", "affected", target, "--json"], workDir);
      if (!affected.ok) throw new Error(`keryx gdgraph affected ${target} failed: ${affected.stderr}`);
      system.set(target, parseAffected(affected.stdout));
    }

    // Write the real system-output fixture (same shape the CLI's `--system` loader reads).
    const systemFixture = {
      pinned_commit: PINNED_SHA,
      generated_by: "bun scripts/benchmark/run-express-oracle.ts",
      targets: TARGET_FILES.map((target) => ({ target, affected: system.get(target) ?? [] })),
    };
    await Bun.write(systemFixtureUrl, `${JSON.stringify(systemFixture, null, 2)}\n`);

    // Two-gold scoring (decision (a)+(b)): score the ONE gdgraph affected-set against BOTH
    // the git co-change gold AND the independent transitive import-closure gold, reported
    // separately and never averaged. See src/metrics/oracle-runner.ts.
    const [coChangeGold, dependencyGold] = await Promise.all([
      loadGold(coChangeGoldUrl),
      loadGold(dependencyGoldUrl),
    ]);
    const inputs: MultiGoldScoreInput[] = TARGET_FILES.map((target) => ({
      target,
      system: system.get(target) ?? [],
      golds: [
        { kind: "co-change" as const, gold: coChangeGold.get(target) ?? [] },
        { kind: "dependency" as const, gold: dependencyGold.get(target) ?? [] },
      ],
    }));

    const manifests = buildOracleManifestsByGold(inputs, { ladder: "metastore" });
    let allValid = true;
    for (const kind of ["co-change", "dependency"] as const) {
      const manifest = manifests[kind];
      if (!manifest) {
        console.error(`# gold: ${kind} — no scored targets`);
        allValid = false;
        continue;
      }
      console.log(`# gold: ${kind} (${GOLD_KIND_LABELS[kind as GoldKind]})`);
      console.log(JSON.stringify(manifest, null, 2));
      console.error(`# oracle IR result — gold=${kind} (${GOLD_KIND_LABELS[kind as GoldKind]})`);
      for (const run of manifest.runs) {
        const o = run.oracle;
        console.error(
          `${run.task_id}: precision=${o?.precision?.value} recall=${o?.recall?.value} f1=${o?.f1?.value}`,
        );
      }
      const result = validatePairedBenchmark(manifest);
      console.error(`# gold=${kind} manifest valid: ${result.valid ? "yes" : "no"}`);
      for (const err of result.errors) console.error(`- ${err}`);
      if (!result.valid) allValid = false;
    }
    if (!allValid) process.exit(1);
    console.error(`wrote fixtures/benchmark/express/gdgraph-affected.json`);
  } finally {
    cleanup?.();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-express-oracle failed (offline/gdgraph unavailable is expected in CI): ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/oracle-runner.test.ts");
    process.exit(1);
  });
}
