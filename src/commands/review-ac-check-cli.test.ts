// Flow 328, AC6: `keryx review ingest` for a flow with the opt-in attaches
// the latest CACHED check-ac result to the review package. A dedicated file
// (not `review.test.ts`, which flow 326 already owns) exercising just this
// hook end-to-end on a fixture package.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps } from "../flow/types";
import { acCheckCacheKey, acCheckCachePath, writeAcCheckCache } from "../flow/check-ac";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
const realLog = console.log;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-ac-check-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function deps(): FlowServiceDeps {
  return { tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-09-25T00:00:00Z") };
}

/** A local `git` invocation — same shape as `flow-check-ac.test.ts`'s own helper, needed now that the AC6 hook computes a real diff to verify freshness against. */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function frozenFlow(title: string): Promise<{ dir: string; acChecksum: string }> {
  const service = createFlowService(deps());
  const created = await service.init({ cwd: ROOT, title });
  const dir = path.basename(created.dir);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the fixture criterion holds\n",
    "utf8",
  );
  const frozen = await service.freeze({ cwd: ROOT, id: dir });
  return { dir, acChecksum: frozen.acChecksum ?? "" };
}

/** The package path `createManagedReviewPackage` prints on `path: ...` — nested under the flow's own directory when `--flow` was given, top-level otherwise. */
function packagePathFromLogs(): string {
  const line = logs.find((entry) => entry.startsWith("path: "));
  if (line === undefined) throw new Error("no `path: ...` line was printed by `review ingest`");
  return path.join(ROOT, line.slice("path: ".length));
}

/** `ref` defaults to the historical placeholder ("report.md") every pre-existing test in this file relies on — none of those reach git at all (opt-in off / no cache / no --flow all short-circuit before the AC6 hook ever computes a diff). Only the freshness tests below pass a REAL git ref. */
async function ingest(reviewId: string, extra: string[] = [], ref = "report.md"): Promise<string> {
  await writeFile(path.join(ROOT, "report.md"), "# Round\n\n```json keryx:findings\n[]\n```\n", "utf8");
  await reviewCommand(["ingest", "--report", "report.md", "--ref", ref, "--review-id", reviewId, ...extra]);
  return packagePathFromLogs();
}

// Review finding, fixed by this test's own rewrite: the ORIGINAL version of
// this test planted a cache keyed to a FABRICATED checksum ("sha256:whatever")
// and a fabricated diff hash ("deadbeef") — neither matching anything real —
// and still asserted attachment, because the pre-fix hook attached whatever
// was cached unconditionally. Now it sets up a REAL git repo and a genuinely
// matching key (empty diff, `--ref` and the resolved `--head` on the same
// commit) so this test proves the FRESH path, not the absence of a check.
test("opt-in on, the cache matches this round's own diff: ac-check.md is attached and announced", async () => {
  await git(ROOT, ["init", "-q", "-b", "main"]);
  await git(ROOT, ["config", "user.email", "fixture@example.invalid"]);
  await git(ROOT, ["config", "user.name", "fixture"]);

  const { dir: flowDir, acChecksum } = await frozenFlow("AC6 fixture");
  const flowId = flowDir.slice(0, 3);
  await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));

  // Commit everything so `--ref` and the resolved `--head` (the working
  // tree's own current commit, since no `--head` is passed) land on the SAME
  // commit — merge-base(head, ref) = head = ref, so the diff between them is
  // empty, with a deterministic, known hash.
  await git(ROOT, ["add", "-A"]);
  await git(ROOT, ["commit", "-q", "-m", "fixture base"]);
  const head = await gitOutput(ROOT, ["rev-parse", "HEAD"]);

  await writeAcCheckCache(acCheckCachePath(ROOT, flowDir), {
    key: acCheckCacheKey(acChecksum, ""),
    at: "2026-09-25T01:00:00.000Z",
    jevAsked: true,
    usage: { jevCalls: 1, costUsd: 0.001 },
    verdicts: [
      { id: "AC1", text: "the fixture criterion holds", status: "likely-met", probability: 0.9, factLines: [], evidencePaths: [] },
    ],
  });

  const pkg = await ingest("2026-09-25-ac-check-attach", ["--flow", flowId], head);
  const acCheckPath = path.join(pkg, "ac-check.md");
  const markdown = await readFile(acCheckPath, "utf8");
  expect(markdown).toContain("flow " + flowId);
  expect(markdown).toContain("AC1");
  expect(markdown).toContain("likely met");
  // Item 1's other ask: the report shows when it was checked, and the key
  // it was checked against.
  expect(markdown).toContain("checked: 2026-09-25T01:00:00.000Z");
  expect(markdown).toContain(`criteria checksum: ${acChecksum}`);
  expect(logs.join("\n")).toContain("ac-check: attached");
});

// The other half of the review finding: a cache whose CRITERIA checksum is
// unchanged but whose DIFF is not this round's own — must read as stale, not
// as current, and must say so rather than silently attaching nothing.
test("opt-in on, checksum unchanged but the diff changed since the cache was written: a STALE note, not the cached report", async () => {
  await git(ROOT, ["init", "-q", "-b", "main"]);
  await git(ROOT, ["config", "user.email", "fixture@example.invalid"]);
  await git(ROOT, ["config", "user.name", "fixture"]);

  const { dir: flowDir, acChecksum } = await frozenFlow("AC6 stale-diff fixture");
  const flowId = flowDir.slice(0, 3);
  await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));

  await git(ROOT, ["add", "-A"]);
  await git(ROOT, ["commit", "-q", "-m", "fixture base"]);
  const baseHead = await gitOutput(ROOT, ["rev-parse", "HEAD"]);

  // The cache was computed against the diff AT `baseHead` (empty — checked
  // against itself).
  await writeAcCheckCache(acCheckCachePath(ROOT, flowDir), {
    key: acCheckCacheKey(acChecksum, ""),
    at: "2026-09-25T01:00:00.000Z",
    jevAsked: true,
    verdicts: [
      { id: "AC1", text: "the fixture criterion holds", status: "likely-met", probability: 0.9, factLines: [], evidencePaths: [] },
    ],
  });

  // The criteria never change (same checksum) — but the round's own diff
  // does: an unrelated commit lands AFTER the check ran, and `--head` (left
  // unset, so it resolves to the CURRENT checkout) now names that newer
  // commit while `--ref` still names the original base.
  await writeFile(path.join(ROOT, "changed-after-the-check.txt"), "unrelated change\n", "utf8");
  await git(ROOT, ["add", "-A"]);
  await git(ROOT, ["commit", "-q", "-m", "unrelated change after the check ran"]);

  const pkg = await ingest("2026-09-25-ac-check-stale-diff", ["--flow", flowId], baseHead);
  const acCheckPath = path.join(pkg, "ac-check.md");
  const markdown = await readFile(acCheckPath, "utf8");
  expect(markdown).toContain("STALE");
  expect(markdown).toContain("2026-09-25T01:00:00.000Z");
  expect(logs.join("\n")).toContain("ac-check: stale");
  expect(logs.join("\n")).not.toContain("ac-check: attached");
});

test("opt-in off: no ac-check.md, no attachment line", async () => {
  const { dir: flowDir } = await frozenFlow("No opt-in fixture");
  const flowId = flowDir.slice(0, 3);
  await writeAcCheckCache(acCheckCachePath(ROOT, flowDir), {
    key: "sha256:whatever:deadbeef",
    at: "2026-09-25T01:00:00.000Z",
    jevAsked: false,
    verdicts: [],
  });

  const pkg = await ingest("2026-09-25-ac-check-no-optin", ["--flow", flowId]);
  await expect(readFile(path.join(pkg, "ac-check.md"), "utf8")).rejects.toThrow();
  expect(logs.join("\n")).not.toContain("ac-check: attached");
});

test("opt-in on but no cache yet: no ac-check.md, never fails ingest", async () => {
  const { dir: flowDir } = await frozenFlow("No cache fixture");
  const flowId = flowDir.slice(0, 3);
  await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));

  const pkg = await ingest("2026-09-25-ac-check-no-cache", ["--flow", flowId]);
  await expect(readFile(path.join(pkg, "ac-check.md"), "utf8")).rejects.toThrow();
  expect(process.exitCode).toBe(0);
});

test("no --flow given: no attachment attempted", async () => {
  const pkg = await ingest("2026-09-25-ac-check-no-flow");
  await expect(readFile(path.join(pkg, "ac-check.md"), "utf8")).rejects.toThrow();
  expect(logs.join("\n")).not.toContain("ac-check: attached");
});
