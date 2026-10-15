// Flow 452 AC1, AC2, AC3, AC5: a review starts with clean context. The instruction is in the orchestrator skill (both copies)
// and in every reviewer skill, `review start` records the stage in the manifest, and the schema accepts that record.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { createManagedReviewPackage, validateManagedReviewManifest } from "./managed";

const REPO = path.resolve(import.meta.dir, "..", "..");
const BUNDLED = path.join(REPO, "src", "gdskills", "bundled", "skills", "review");
const LOCAL = path.join(REPO, ".metaproject", "skills", "gdskills", "review");
const SCHEMA = path.join(REPO, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");
const ORCHESTRATOR = "review-orchestrator";
const SKILL_CEILING = 1615;

const read = (root: string, skill: string, file = "SKILL.md"): string => readFileSync(path.join(root, skill, file), "utf8");
const lineCount = (text: string): number => text.split("\n").length - 1;
const reviewers = (): string[] =>
  readdirSync(BUNDLED)
    .filter((name) => name.startsWith("review-") && name !== ORCHESTRATOR)
    .sort();

const section = (text: string): string => {
  const start = text.search(/^## Clean context/m);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("AC1: the orchestrator skill has a Clean context section", () => {
  for (const [label, root] of [["bundled", BUNDLED], ["project copy", LOCAL]] as const) {
    for (const file of ["SKILL.md", "SKILL.detail.md"]) {
      test(`${label} ${file} states where context may come from and what is not an input`, () => {
        const body = section(read(root, ORCHESTRATOR, file));
        expect(body).toMatch(/context stages|memory stage/i);
        expect(body).toContain("session memory");
        expect(body).toContain("`MEMORY.md`");
        expect(body).toContain("earlier conversation");
        expect(body).toMatch(/are not inputs|is not an input|not inputs/);
      });

      test(`${label} ${file} names the three accepted exceptions and no others`, () => {
        const body = section(read(root, ORCHESTRATOR, file));
        expect(body).toContain("`prior_findings`");
        expect(body).toMatch(/review-notes/i);
        expect(body).toContain("`memory_search`");
        expect(body).toMatch(/only three|three accepted/i);
      });

      test(`${label} ${file} names the blocking item and the operator-only waiver`, () => {
        const body = section(read(root, ORCHESTRATOR, file));
        expect(body).toContain("memory-outside-stage");
        expect(body).toContain('--waive memory-outside-stage "<operator quote>"');
        expect(body).toContain("orchestrator.jsonl");
        expect(body).toContain("--memory-query");
      });

      test(`${label} ${file} writes the named limit`, () => {
        const body = section(read(root, ORCHESTRATOR, file));
        expect(body).toMatch(/cannot (stop|be prevented)/);
        expect(body).toContain("instruction plus detection, not isolation");
        expect(body).toMatch(/personal memory outside `keryx memory` (are|is) not visible to the log/);
      });
    }

    test(`${label} SKILL.md stays within the length ceiling`, () => {
      expect(lineCount(read(root, ORCHESTRATOR))).toBeLessThanOrEqual(SKILL_CEILING);
    });
  }

  test("the bundled and project copies are byte-identical", () => {
    for (const file of ["SKILL.md", "SKILL.detail.md"]) {
      expect(read(LOCAL, ORCHESTRATOR, file) === read(BUNDLED, ORCHESTRATOR, file)).toBe(true);
    }
  });
});

describe("AC5: one general open-question rule", () => {
  for (const [label, root] of [["bundled", BUNDLED], ["project copy", LOCAL]] as const) {
    for (const file of ["SKILL.md", "SKILL.detail.md"]) {
      test(`${label} ${file} sends an open question to the instructions, then the user, never memory or a guess`, () => {
        const body = section(read(root, ORCHESTRATOR, file));
        expect(body).toMatch(/Open questions?\.?\*\*/);
        expect(body).toContain("AskUserQuestion");
        expect(body).toMatch(/unattended/i);
        expect(body).toMatch(/[Nn]ever answer from memory or a guess|A guess and a recollection are both wrong answers/);
      });
    }
  }

  test("the unattended case is exactly one STATUS line in the shape the skill status contract accepts", () => {
    const text = section(read(BUNDLED, ORCHESTRATOR));
    const status = /`(STATUS: BLOCKED question — <the question>)`/.exec(text)?.[1];
    expect(status).toBeDefined();
    const concrete = status!.replace("<the question>", "which base branch is the release line?");
    expect(concrete).toMatch(/^STATUS: BLOCKED [a-z_]+ — \S.*$/);
    expect(concrete.split("\n")).toHaveLength(1);
    expect(read(BUNDLED, ORCHESTRATOR)).toContain("`STATUS: BLOCKED nested_dispatch_unavailable");
  });
});

describe("AC2: every reviewer skill says its inputs are the reviewer payload only", () => {
  test("there are reviewer skills to check", () => {
    expect(reviewers().length).toBeGreaterThan(10);
  });

  for (const [label, root] of [["bundled", BUNDLED], ["project copy", LOCAL]] as const) {
    test(`${label}: no review-*/SKILL.md lacks the sentence`, () => {
      const missing = reviewers().filter((skill) => !/inputs are the reviewer payload only/.test(read(root, skill)));
      expect(missing).toEqual([]);
    });
  }

  test("the project copies match the bundled skills byte for byte", () => {
    const differing = reviewers().filter((skill) => read(LOCAL, skill) !== read(BUNDLED, skill));
    expect(differing).toEqual([]);
  });
});

describe("AC3: review start records the clean-context stage", () => {
  let root = "";
  const originalCwd = process.cwd();

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "keryx-clean-context-"));
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(path.join(schemas, "managed-review-package.schema.json"), readFileSync(SCHEMA, "utf8"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  const at = new Date("2026-10-15T10:00:00.000Z");

  test("a review-flow package carries the start time and the stage query, and the schema accepts it", async () => {
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "review-flow",
      reviewId: "r-clean",
      target: { kind: "branch", ref: "feat/x" },
      coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
      memoryQuery: "auth middleware session tokens",
      now: at,
    });
    expect(created.manifest.cleanContext).toEqual({ startedAt: at.toISOString(), memoryQuery: "auth middleware session tokens" });
    expect(JSON.parse(readFileSync(path.join(root, created.path, "manifest.json"), "utf8")).cleanContext).toEqual(created.manifest.cleanContext);
    expect((await validateManagedReviewManifest(root, created.manifest)).valid).toBe(true);
  });

  test("without a stage query the block holds the start time alone", async () => {
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "review-flow",
      reviewId: "r-clean-2",
      target: { kind: "branch", ref: "feat/x" },
      coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
      now: at,
    });
    expect(created.manifest.cleanContext).toEqual({ startedAt: at.toISOString() });
    expect((await validateManagedReviewManifest(root, created.manifest)).valid).toBe(true);
  });

  test("the schema refuses a block without a start time or with an empty query", async () => {
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "review-flow",
      reviewId: "r-clean-3",
      target: { kind: "branch", ref: "feat/x" },
      coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
      now: at,
    });
    const noStart = { ...created.manifest, cleanContext: { memoryQuery: "q" } } as unknown as typeof created.manifest;
    const emptyQuery = { ...created.manifest, cleanContext: { startedAt: at.toISOString(), memoryQuery: "" } } as typeof created.manifest;
    expect((await validateManagedReviewManifest(root, noStart)).valid).toBe(false);
    expect((await validateManagedReviewManifest(root, emptyQuery)).valid).toBe(false);
  });

  test("keryx review start --memory-query writes the block into the manifest on disk", async () => {
    process.chdir(root);
    const logged: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void logged.push(parts.join(" "));
    try {
      await reviewCommand(["start", "--target", "branch", "--ref", "feat/x", "--review-id", "r-cli", "--memory-query", "  billing retries  "], { isTerminal: () => false });
    } finally {
      console.log = original;
    }
    const pathLine = logged.join("\n").match(/^path: (.+)$/m)?.[1];
    expect(pathLine).toBeDefined();
    const manifest = JSON.parse(readFileSync(path.join(root, pathLine!, "manifest.json"), "utf8"));
    expect(manifest.cleanContext.memoryQuery).toBe("billing retries");
    expect(Number.isNaN(Date.parse(manifest.cleanContext.startedAt))).toBe(false);
  });
});
