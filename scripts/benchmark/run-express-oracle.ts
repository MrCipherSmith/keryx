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
import { validatePairedBenchmark, type PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
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
  const result = Bun.spawnSync(cmd, { ...(cwd !== undefined ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
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

const GOLD_KINDS = ["co-change", "dependency"] as const;

/** Injectable side effects for {@link finalizeExpressOracleRun} — real I/O in `main`, spies in tests. */
export type ExpressOracleEmissionIO = {
  readonly writeSystemFixture: (contents: string) => Promise<void>;
  readonly printManifest: (kind: GoldKind, contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Decide what to emit for the express-oracle run, GATED on validation (same defect shape
 * fixed across every scripts/benchmark/run-*-oracle.ts producer: previously the captured
 * gdgraph-affected system fixture was written to disk and each gold-kind's manifest
 * printed to stdout FIRST, and only afterward validated — an invalid manifest reached both
 * the file and the terminal before the process exited non-zero).
 *
 * The ONE system-output fixture (gdgraph-affected.json) is shared by BOTH gold-kind
 * manifests it feeds, so it is written only when EVERY present gold kind validates —
 * a fixture cannot be "half published" for one gold kind and not the other. Each
 * gold-kind's manifest is then printed independently, gated on ITS OWN validity (mirrors
 * run-containment.ts's per-case-class independence: the two golds are never conflated).
 * Choice recorded (same as run-ablation.ts's finalizeAblationRun): on an invalid run, a
 * previously-written GOOD fixture file is left ON DISK, UNTOUCHED.
 */
export async function finalizeExpressOracleRun(
  systemFixture: unknown,
  manifestsByKind: Partial<Record<GoldKind, PairedBenchmarkManifestV2>>,
  validationByKind: Partial<Record<GoldKind, { readonly valid: boolean; readonly errors: readonly string[] }>>,
  io: ExpressOracleEmissionIO,
): Promise<number> {
  let allValid = true;
  for (const kind of GOLD_KINDS) {
    const manifest = manifestsByKind[kind];
    const validation = validationByKind[kind];
    if (!manifest || !validation) {
      io.logLine(`# gold: ${kind} — no scored targets`);
      allValid = false;
      continue;
    }
    io.logLine(`# gold=${kind} manifest valid: ${validation.valid ? "yes" : "no"}`);
    for (const err of validation.errors) io.logLine(`- ${err}`);
    if (validation.valid) {
      io.printManifest(kind, JSON.stringify(manifest, null, 2));
    } else {
      allValid = false;
    }
  }

  if (allValid) {
    await io.writeSystemFixture(`${JSON.stringify(systemFixture, null, 2)}\n`);
    io.logLine("wrote fixtures/benchmark/express/gdgraph-affected.json");
    return 0;
  }
  io.logLine(
    "invalid manifest(s) — nothing written to disk and nothing printed to stdout for an invalid gold kind; " +
      "fixtures/benchmark/express/gdgraph-affected.json left unchanged " +
      "(a previously-written valid fixture, if any, is preserved as-is)",
  );
  return 1;
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

    // Build the real system-output fixture (same shape the CLI's `--system` loader reads) —
    // held in memory, not yet written; {@link finalizeExpressOracleRun} decides whether it
    // reaches disk, based on both gold kinds' own validation below.
    const systemFixture = {
      pinned_commit: PINNED_SHA,
      generated_by: "bun scripts/benchmark/run-express-oracle.ts",
      targets: TARGET_FILES.map((target) => ({ target, affected: system.get(target) ?? [] })),
    };

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
    const validations: Partial<Record<GoldKind, { valid: boolean; errors: string[] }>> = {};
    for (const kind of GOLD_KINDS) {
      const manifest = manifests[kind];
      if (!manifest) continue;
      console.error(`# oracle IR result — gold=${kind} (${GOLD_KIND_LABELS[kind]})`);
      for (const run of manifest.runs) {
        const o = run.oracle;
        console.error(
          `${run.task_id}: precision=${o?.precision?.value} recall=${o?.recall?.value} f1=${o?.f1?.value}`,
        );
      }
      validations[kind] = validatePairedBenchmark(manifest);
    }

    const code = await finalizeExpressOracleRun(systemFixture, manifests, validations, {
      writeSystemFixture: async (contents) => {
        await Bun.write(systemFixtureUrl, contents);
      },
      printManifest: (kind, contents) => {
        console.log(`# gold: ${kind} (${GOLD_KIND_LABELS[kind]})`);
        console.log(contents);
      },
      logLine: (line) => console.error(line),
    });
    if (code !== 0) process.exit(code);
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
