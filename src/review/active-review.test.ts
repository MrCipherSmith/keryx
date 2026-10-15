// Flow 454 AC2: `review start` and `review attach` write the pointer to the package being recorded, closing the
// package removes it, a pointer to a missing or closed package records nothing, and with no pointer the recorder
// creates no file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { createFlowService } from "../flow/service";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { ACTIVE_REVIEW_DIR, clearActiveReview, resolveActiveReview, writeActiveReview } from "./active-review";
import { completeManagedReview, createManagedReviewPackage } from "./managed";
import { orchestratorLogPath, recordActiveCall, startOrchestratorLog } from "./orchestrator-log";

const REPO = path.resolve(import.meta.dir, "..", "..");
const SCHEMA = path.join(REPO, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");
const READY = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };
const POINTER = path.join(ACTIVE_REVIEW_DIR, "active-review.json");
const call = { source: "mcp", caller: "orchestrator", tool: "memory_search", input: { query: "q" } } as const;

let root = "";
const originalCwd = process.cwd();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-active-review-"));
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
  mkdirSync(schemas, { recursive: true });
  writeFileSync(path.join(schemas, "managed-review-package.schema.json"), readFileSync(SCHEMA, "utf8"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

async function createFlow(): Promise<{ id: string }> {
  const service = createFlowService({
    tracker: {
      id: "fake",
      detect: async () => true,
      parseRef: () => null,
      fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
      prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
      comment: async () => true,
    },
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-15T10:00:00Z"),
  });
  const { flow } = await service.init({ cwd: root, title: "Active review flow" });
  return flow;
}

async function run(args: string[]): Promise<string> {
  process.chdir(root);
  const logged: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => void logged.push(parts.join(" "));
  try {
    await reviewCommand(args, { isTerminal: () => false });
  } finally {
    console.log = original;
  }
  return logged.join("\n");
}

const pointer = (): { id: string; dir: string } => JSON.parse(readFileSync(path.join(root, POINTER), "utf8"));

describe("AC2: the active-review pointer", () => {
  for (const command of ["start", "attach"] as const) {
    test(`review ${command} writes the pointer and the first line of the log`, async () => {
      const extra = command === "attach" ? ["--flow", (await createFlow()).id] : [];
      const output = await run([command, "--target", "branch", "--ref", "feat/x", "--review-id", `r-${command}`, ...extra]);
      const relative = output.match(/^path: (.+)$/m)?.[1];
      expect(relative).toBeDefined();
      const written = pointer();
      expect(written.id).toBe(`r-${command}`);
      expect(written.dir).toBe(path.resolve(root, relative!));
      expect(readFileSync(orchestratorLogPath(written.dir), "utf8")).toContain('"event":"log-start"');
      expect((await resolveActiveReview(root))?.dir).toBe(written.dir);
    });
  }

  test("review ingest does not point at the package it imports", async () => {
    writeFileSync(path.join(root, "review.md"), "# Review\nEvidence level: static only — did not run: tests\nNo findings.\n");
    const output = await run(["ingest", "--target", "report", "--ref", "review.md", "--review-id", "r-ingest", "--report", "review.md"]);
    expect(output).toContain("# managed review: r-ingest");
    expect(existsSync(path.join(root, POINTER))).toBe(false);
  });

  test("closing the package removes the pointer", async () => {
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "ingest",
      reportText: "# Review\nEvidence level: static only — did not run: tests\nNo findings.\n",
      reviewId: "r-close",
      target: { kind: "report", ref: "review.md" },
    });
    writeFileSync(path.join(root, created.path, "research.json"), JSON.stringify(READY));
    expect(await startOrchestratorLog(root, created.reviewId, created.path)).toBe(true);
    expect(existsSync(path.join(root, POINTER))).toBe(true);
    await completeManagedReview(root, created.path);
    expect(existsSync(path.join(root, POINTER))).toBe(false);
  });

  test("closing another package leaves a pointer that names a different review", async () => {
    await writeActiveReview(root, { id: "other", dir: path.join(".metaproject", "reviews", "other") });
    await clearActiveReview(root, "r-close");
    expect(existsSync(path.join(root, POINTER))).toBe(true);
    await clearActiveReview(root, "other");
    expect(existsSync(path.join(root, POINTER))).toBe(false);
  });

  test("a pointer to a missing package is ignored and records nothing", async () => {
    const dir = path.join(root, ".metaproject", "reviews", "gone");
    await writeActiveReview(root, { id: "gone", dir });
    expect(await resolveActiveReview(root)).toBeUndefined();
    expect(await recordActiveCall(root, call)).toBe(false);
    expect(existsSync(orchestratorLogPath(dir))).toBe(false);
  });

  test("a pointer to a closed package is ignored and records nothing", async () => {
    const dir = path.join(root, ".metaproject", "reviews", "closed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: "closed", status: "closed" }));
    await writeActiveReview(root, { id: "closed", dir });
    expect(await resolveActiveReview(root)).toBeUndefined();
    expect(await recordActiveCall(root, call)).toBe(false);
    expect(existsSync(orchestratorLogPath(dir))).toBe(false);
  });

  test("a pointer that leaves the project is ignored", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-active-outside-"));
    try {
      writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ status: "open" }));
      await writeActiveReview(root, { id: "out", dir: outside });
      expect(await resolveActiveReview(root)).toBeUndefined();
      expect(await recordActiveCall(root, call)).toBe(false);
      expect(existsSync(orchestratorLogPath(outside))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("with no pointer the recorder creates no file", async () => {
    expect(await recordActiveCall(root, call)).toBe(false);
    expect(existsSync(path.join(root, ".metaproject", "reviews"))).toBe(false);
    expect(existsSync(path.join(root, POINTER))).toBe(false);
  });

  test("an open package the pointer names is recorded into", async () => {
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "review-flow",
      reviewId: "r-open",
      target: { kind: "branch", ref: "feat/x" },
      coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
    });
    await startOrchestratorLog(root, created.reviewId, created.path);
    expect(await recordActiveCall(root, call)).toBe(true);
    const lines = readFileSync(orchestratorLogPath(path.resolve(root, created.path)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).tool).toBe("memory_search");
  });
});
