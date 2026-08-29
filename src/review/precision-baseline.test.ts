// `scripts/review-precision-baseline.ts`, driven end to end over a synthetic
// corpus (flow 202, AC1/AC2/AC14).
//
// Black-box on purpose: the script's contract is "a command in the repository
// recomputes the figure from the same inputs and returns the same number"
// (AC2), so what has to be pinned is what the command PRINTS and what it exits
// with, not its internals. It is also the only reader of `global_id`, and a
// join key with one writer and one reader is exactly where the two drift.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "review-precision-baseline.ts");
let ROOT = "";

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-baseline-"));
});

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

type Finding = Record<string, unknown>;

async function writePackage(reviewId: string, findings: Finding[]): Promise<void> {
  const dir = path.join(ROOT, ".metaproject", "reviews", reviewId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      reviewId,
      mode: "ingest",
      status: "closed",
      target: { kind: "report", ref: "report.md" },
      createdAt: "2026-08-29T11:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(path.join(dir, "findings.json"), JSON.stringify(findings), "utf8");
  await writeFile(path.join(dir, "report.md"), "# Round\n\nno disposition markers here\n", "utf8");
}

async function writeLedger(rows: unknown[]): Promise<string> {
  const file = path.join(ROOT, "ledger.json");
  await writeFile(file, JSON.stringify({ rows }), "utf8");
  return file;
}

type Run = { exitCode: number; stdout: string; json: Record<string, any> | null };

async function run(args: string[] = []): Promise<Run> {
  const ledger = path.join(ROOT, "ledger.json");
  const proc = Bun.spawn(["bun", SCRIPT, "--root", ROOT, "--ledger", ledger, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return {
    exitCode,
    stdout,
    json: args.includes("--json") ? (JSON.parse(stdout) as Record<string, any>) : null,
  };
}

const FINDING: Finding = {
  id: "F-001",
  reviewer: "review-logic",
  severity: "major",
  problem: "p",
  impact: "i",
  suggested_fix: "s",
  evidence: "e",
  confidence: "high",
};

test("a finding carried into a later round is joined by the key it was minted under", async () => {
  // The exact case `global_id` exists to serve. `assignGlobalIds` mints only
  // when the key is absent, so a round-2 record keeps `rev-round1#F-001` — and
  // a measurement that recomputes `${reviewId}#${id}` looks for
  // `rev-round2#F-001`, finds no ledger row, and reports the finding as
  // `unknown` while ALSO reporting the ledger as stale. Both halves are wrong
  // for one reason.
  await writePackage("rev-round2", [{ ...FINDING, global_id: "rev-round1#F-001" }]);
  await writeLedger([
    {
      reviewId: "rev-round1",
      findingId: "F-001",
      category: "acted-on",
      evidence: "flow 202 journal: closed in round 2",
    },
  ]);

  const result = await run(["--json"]);
  expect(result.json?.summary.problems).toEqual([]);
  expect(result.exitCode).toBe(0);
  expect(result.json?.rows[0].category).toBe("acted-on");
  expect(result.json?.rows[0].source).toBe("ledger");
});

test("the classification totals and the source totals count the same rows", async () => {
  // `record` was added to the type and to the producer and not to the report
  // loop, so a run with one recorded disposition printed a classification
  // totalling 3 against a source table totalling 1. A report whose two halves
  // disagree cannot be used to check anything.
  await writePackage("rev-recorded", [
    { ...FINDING, disposition: { state: "acted-on", evidence: "closed by 380bf3b0" } },
    { ...FINDING, id: "F-002", disposition: { state: "dismissed-incorrect", evidence: "measured 0700" } },
    { ...FINDING, id: "F-003" },
  ]);
  await writeLedger([]);

  const result = await run();
  expect(result.exitCode).toBe(0);
  const sourceSection = result.stdout.split("## By evidence source")[1] ?? "";
  expect(sourceSection).toContain("record");

  const total = (section: string): number =>
    [...section.matchAll(/^\S+\s+(\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  const classification = result.stdout.split("## Classification")[1]?.split("## By evidence source")[0] ?? "";
  expect(total(sourceSection.split("## Figure")[0] ?? "")).toBe(total(classification));
});

test("the `NOT A BASELINE` note does not state things this pipeline has since made false", async () => {
  // `review-finding.schema.json` HAS a disposition property and `decisions.md`
  // no longer says the same sentence for every finding — both were changed on
  // this branch. A refusal that argues from facts that stopped being true reads
  // as an unmaintained artifact, and the refusal itself is what AC1 is
  // satisfied by.
  await writePackage("rev-unmeasurable", [{ ...FINDING, disposition: { state: "acted-on", evidence: "a commit" } }]);
  await writeLedger([]);

  const result = await run();
  expect(result.stdout).toContain("NOT A BASELINE");
  expect(result.stdout).not.toContain("has no disposition property");
  expect(result.stdout).not.toContain("template that says the same sentence for every finding");
});

test("a ledger row naming a finding on disk under its own key still matches", async () => {
  // Non-regression for the ordinary case: most findings carry a `global_id`
  // minted under their own package, and that must keep joining.
  await writePackage("rev-plain", [{ ...FINDING, global_id: "rev-plain#F-001" }]);
  await writeLedger([
    { reviewId: "rev-plain", findingId: "F-001", category: "dismissed-out-of-scope", evidence: "flow 133" },
  ]);

  const result = await run(["--json"]);
  expect(result.json?.summary.problems).toEqual([]);
  expect(result.json?.rows[0].category).toBe("dismissed-out-of-scope");
});

test("a pre-contract finding with no key is still keyed by its package", async () => {
  // All 83 records on disk have no `global_id`. Falling back to
  // `<reviewId>#<id>` is what keeps them readable.
  await writePackage("rev-legacy", [FINDING]);
  await writeLedger([
    { reviewId: "rev-legacy", findingId: "F-001", category: "acted-on", evidence: "closed by 380bf3b0" },
  ]);

  const result = await run(["--json"]);
  expect(result.json?.summary.problems).toEqual([]);
  expect(result.json?.rows[0].category).toBe("acted-on");
});
