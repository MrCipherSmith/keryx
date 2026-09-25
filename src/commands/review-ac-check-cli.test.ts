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
import { acCheckCachePath, writeAcCheckCache } from "../flow/check-ac";

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

async function frozenFlow(title: string): Promise<string> {
  const service = createFlowService(deps());
  const created = await service.init({ cwd: ROOT, title });
  const dir = path.basename(created.dir);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the fixture criterion holds\n",
    "utf8",
  );
  await service.freeze({ cwd: ROOT, id: dir });
  return dir;
}

/** The package path `createManagedReviewPackage` prints on `path: ...` — nested under the flow's own directory when `--flow` was given, top-level otherwise. */
function packagePathFromLogs(): string {
  const line = logs.find((entry) => entry.startsWith("path: "));
  if (line === undefined) throw new Error("no `path: ...` line was printed by `review ingest`");
  return path.join(ROOT, line.slice("path: ".length));
}

async function ingest(reviewId: string, extra: string[] = []): Promise<string> {
  await writeFile(path.join(ROOT, "report.md"), "# Round\n\n```json keryx:findings\n[]\n```\n", "utf8");
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", reviewId, ...extra]);
  return packagePathFromLogs();
}

test("opt-in on, a cache exists: ac-check.md is attached and announced", async () => {
  const flowDir = await frozenFlow("AC6 fixture");
  const flowId = flowDir.slice(0, 3);
  await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));
  await writeAcCheckCache(acCheckCachePath(ROOT, flowDir), {
    key: "sha256:whatever:deadbeef",
    at: "2026-09-25T01:00:00.000Z",
    jevAsked: true,
    usage: { jevCalls: 1, costUsd: 0.001 },
    verdicts: [
      { id: "AC1", text: "the fixture criterion holds", status: "likely-met", probability: 0.9, factLines: [], evidencePaths: [] },
    ],
  });

  const pkg = await ingest("2026-09-25-ac-check-attach", ["--flow", flowId]);
  const acCheckPath = path.join(pkg, "ac-check.md");
  const markdown = await readFile(acCheckPath, "utf8");
  expect(markdown).toContain("flow " + flowId);
  expect(markdown).toContain("AC1");
  expect(markdown).toContain("likely met");
  expect(logs.join("\n")).toContain("ac-check: attached");
});

test("opt-in off: no ac-check.md, no attachment line", async () => {
  const flowDir = await frozenFlow("No opt-in fixture");
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
  const flowDir = await frozenFlow("No cache fixture");
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
