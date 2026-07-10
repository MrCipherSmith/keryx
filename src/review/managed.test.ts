import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../flow/types";
import {
  completeManagedReview,
  createManagedReviewPackage,
  findRelatedFlow,
  validateManagedReviewManifest,
} from "./managed";
import type { ManagedReviewManifest } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: (input) => {
      const match = input.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
      return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : null;
    },
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-09T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    `{"type":"object"}`,
    "utf8",
  );
}

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function writeAc(dir: string): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Review evidence exists\n",
    "utf8",
  );
}

async function createStartedFlow(title = "Managed Review Flow"): Promise<string> {
  const service = createFlowService(makeDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title });
  await writeAc(path.basename(dir));
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  return flow.id;
}

test("matches related flow by explicit id, PR URL, issue URL, and branch", async () => {
  await fresh();
  const service = createFlowService(makeDeps());

  const issue = await service.init({ cwd: ROOT, issue: "https://github.com/acme/app/issues/42" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "issue", ref: "https://github.com/acme/app/issues/42" } }))?.id).toBe(issue.flow.id);
  expect((await findRelatedFlow({ cwd: ROOT, flowId: issue.flow.id, target: { kind: "path", ref: "src" } }))?.reason).toBe("explicit-flow-id");

  await writeAc(path.basename(issue.dir));
  await service.freeze({ cwd: ROOT, id: issue.flow.id });
  await service.start({ cwd: ROOT, id: issue.flow.id });
  await service.implemented({ cwd: ROOT, id: issue.flow.id, prUrl: "https://github.com/acme/app/pull/43" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "pr", ref: "https://github.com/acme/app/pull/43" } }))?.reason).toBe("pr-url");
  const attachedByPr = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "attach-review",
    reviewId: "2026-07-09-pr-43",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/43" },
    now: new Date("2026-07-09T11:00:00Z"),
  });
  expect(attachedByPr.manifest.flow?.id).toBe(issue.flow.id);

  const branch = await service.init({ cwd: ROOT, title: "Feature Branch Match" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "branch", ref: "feature-branch-match" } }))?.id).toBe(branch.flow.id);
});

test("attach-review creates required artifacts and does not mutate flow.json", async () => {
  await fresh();
  const flowId = await createStartedFlow();
  const flowDir = "001-2026-07-09-managed-review-flow";
  const flowJson = path.join(ROOT, ".metaproject", "flows", flowDir, "flow.json");
  const before = await readFile(flowJson, "utf8");

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "attach-review",
    flowId,
    reviewId: "2026-07-09-pr-1",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/1" },
    reviewers: ["review-logic", "review-testing-practices"],
    now: new Date("2026-07-09T11:00:00Z"),
  });

  expect(result.path).toBe(".metaproject/flows/001-2026-07-09-managed-review-flow/reviews/2026-07-09-pr-1");
  for (const file of ["manifest.json", "scope.md", "coverage.md", "report.md", "findings.json", "learning.md", "decisions.md"]) {
    expect((await stat(path.join(ROOT, result.path, file))).isFile()).toBe(true);
  }
  expect((await readFile(flowJson, "utf8"))).toBe(before);
  expect((await validateManagedReviewManifest(ROOT, result.manifest)).valid).toBe(true);
});

test("review-flow creates standalone package under .metaproject/reviews", async () => {
  await fresh();
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "review-flow",
    reviewId: "2026-07-09-branch-managed-review",
    target: { kind: "branch", ref: "feature/managed-review" },
    coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for focused runtime test" }],
    now: new Date("2026-07-09T11:00:00Z"),
  });

  expect(result.path).toBe(".metaproject/reviews/2026-07-09-branch-managed-review");
  expect(result.manifest.flow).toBeUndefined();
  const coverage = await readFile(path.join(ROOT, result.path, "coverage.md"), "utf8");
  expect(coverage).toContain("status: skipped");
});

test("ingest writes classified findings and skill learning decision", async () => {
  await fresh();
  const reportPath = path.join(ROOT, "review.md");
  await writeFile(reportPath, "## Major Issues\n\n- [F-001] major: Missing managed review coverage.\n", "utf8");

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-07-09-report-review",
    target: { kind: "report", ref: "review.md" },
    reportPath: "review.md",
    now: new Date("2026-07-09T11:00:00Z"),
  });

  const findings = await readFile(path.join(ROOT, result.path, "findings.json"), "utf8");
  expect(findings).toContain('"id": "F-001"');
  expect(findings).toContain('"classification": "valid_followup"');
  const learning = await readFile(path.join(ROOT, result.path, "learning.md"), "utf8");
  expect(learning).toContain("## Skill Learning");
});

test("manifest validation rejects invalid modes and missing artifact paths", async () => {
  await fresh();
  const manifest = {
    schemaVersion: 1,
    reviewId: "bad",
    mode: "lightweight",
    status: "draft",
    target: { kind: "pr", ref: "x" },
    artifacts: {
      scope: "",
      coverage: "coverage.md",
      report: "report.md",
      findings: "findings.json",
      learning: "learning.md",
      decisions: "decisions.md",
    },
    coverage: [{ reviewer: "review-logic", status: "run", reason: "selected" }],
  } as unknown as ManagedReviewManifest;

  const result = await validateManagedReviewManifest(ROOT, manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.path === "$.mode")).toBe(true);
  expect(result.errors.some((error) => error.path === "$.artifacts.scope")).toBe(true);
});

test("complete requires every managed review artifact", async () => {
  await fresh();
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "review-flow",
    reviewId: "2026-07-09-complete-review",
    target: { kind: "path", ref: "src/review" },
    now: new Date("2026-07-09T11:00:00Z"),
  });

  const completed = await completeManagedReview(ROOT, result.path);
  expect(completed.status).toBe("closed");
});

test("lightweight CLI mode creates no managed review artifacts", async () => {
  await fresh();
  process.chdir(ROOT);
  await reviewCommand(["lightweight"]);

  await expect(stat(path.join(ROOT, ".metaproject", "reviews"))).rejects.toThrow();
});
