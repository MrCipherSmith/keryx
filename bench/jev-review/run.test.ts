// Flow 331, AC2/AC5/AC6/AC7 — the runner, end-to-end, offline only (a real
// subprocess, since `run.ts` is a `bun` entry point with `import.meta.main`
// — the same boundary `src/commands/review-conform-cli.test.ts` draws
// around the CLI, just one process further out because this is itself a
// script rather than a `keryx` subcommand).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const RUN_SCRIPT = path.join(import.meta.dir, "run.ts");

describe("run.ts: offline (AC5 hermetic, AC2 wiring, AC4 honesty)", () => {
  test("writes results-<date>.json and .md with every registered component present", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-bench-run-"));
    try {
      const result = spawnSync(process.execPath, [RUN_SCRIPT, "--out", outDir], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, OPENROUTER_API_KEY: "not-a-real-key" },
      });
      expect(result.status).toBe(0);

      // Derive the date from the script's own "wrote results-<date>.json"
      // stdout line, not by recomputing `new Date()` here — the two can
      // legitimately disagree by a day if this test happens to run across a
      // UTC midnight boundary between the subprocess's write and this check.
      const written = result.stdout.match(/results-(\d{4}-\d{2}-\d{2})\.json/);
      if (!written) throw new Error(`run.ts did not report the date it wrote in stdout: ${result.stdout}`);
      const date = written[1];
      const jsonRaw = await readFile(path.join(outDir, `results-${date}.json`), "utf8");
      const mdRaw = await readFile(path.join(outDir, `results-${date}.md`), "utf8");

      const parsed = JSON.parse(jsonRaw) as {
        meta: { mode: string };
        components: Array<{ component: string; arm: string; available: boolean }>;
      };
      expect(parsed.meta.mode).toBe("offline");
      const ids = new Set(parsed.components.map((c) => c.component));
      expect(ids).toEqual(new Set(["ci-triage", "review-conform", "flow-check-ac", "review-jev-rules", "severity-calibration"]));
      expect(parsed.components).toHaveLength(10); // 5 components x 2 arms

      expect(mdRaw).toContain("# Jev review benchmark");
      expect(mdRaw).toContain("not available");
      expect(mdRaw).toContain("95% CI");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("--max-cost below what offline replay would cost live is irrelevant offline — offline never calls assertEstimateWithinCap's live-only gate", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-bench-run-cap-"));
    try {
      const result = spawnSync(process.execPath, [RUN_SCRIPT, "--out", outDir, "--max-cost", "0"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, OPENROUTER_API_KEY: "not-a-real-key" },
      });
      // Offline mode ignores --max-cost (it costs nothing) — this must still succeed.
      expect(result.status).toBe(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
