// Acceptance layer W0, AC3 — written before any parser code.
//
// The verification-kind marker is a trailing `[verify: ...]` inside the
// existing `- ACn: <criterion>` line. The claim this file proves is BACKWARD
// COMPATIBILITY: every acceptance-criteria file this repository already holds
// parses without a single error, and every criterion that carries no marker
// reads as `unclassified` — never as `none`, never as a failure.
//
// Corpus resolution: the repo's own `.metaproject/flows/`, and — when this
// checkout is a git worktree — the main checkout's `.metaproject/flows/` too
// (flow directories are untracked on main, so a worktree would otherwise see
// fewer of them). Where neither exists (CI on a bare clone) the checked-in
// fixture set under `src/flow/fixtures/ac-kinds/` is parsed instead, so this
// file never passes on zero input.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseAcKinds } from "./ac-kinds";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "ac-kinds");

/** The main checkout when `REPO_ROOT` is a linked worktree; `undefined` otherwise. */
function mainCheckoutRoot(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const commonDir = result.stdout.trim();
  if (commonDir.length === 0) return undefined;
  const root = path.dirname(commonDir);
  return path.resolve(root) === path.resolve(REPO_ROOT) ? undefined : root;
}

function criteriaFilesIn(flowsDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(flowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(flowsDir, entry.name, "acceptance-criteria.md");
    if (existsSync(file)) files.push(file);
  }
  return files;
}

interface Corpus {
  readonly source: "flows" | "fixtures";
  readonly files: readonly string[];
}

function resolveCorpus(): Corpus {
  const roots = [REPO_ROOT, mainCheckoutRoot()].filter((root): root is string => root !== undefined);
  const files = new Set<string>();
  let sawFlowsDir = false;
  for (const root of roots) {
    const flowsDir = path.join(root, ".metaproject", "flows");
    if (!existsSync(flowsDir)) continue;
    sawFlowsDir = true;
    for (const file of criteriaFilesIn(flowsDir)) files.add(file);
  }
  if (sawFlowsDir) {
    // A flows directory that holds no criteria files is a broken corpus, not an empty pass.
    if (files.size === 0) {
      throw new Error("`.metaproject/flows/` exists but holds no acceptance-criteria.md files — refusing to pass on zero input");
    }
    return { source: "flows", files: [...files].sort() };
  }
  return {
    source: "fixtures",
    files: readdirSync(FIXTURES_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(FIXTURES_DIR, name))
      .sort(),
  };
}

/** An oracle independent of the parser: a criterion is marked when its text carries `[verify:` at all. */
function carriesMarker(text: string): boolean {
  return text.includes("[verify:");
}

function assertBackwardCompatible(files: readonly string[]): { criteria: number; marked: number } {
  const failures: string[] = [];
  let criteria = 0;
  let marked = 0;
  for (const file of files) {
    const parsed = parseAcKinds(readFileSync(file, "utf8"));
    for (const error of parsed.errors) failures.push(`${file}: ${error.id}: ${error.message}`);
    for (const criterion of parsed.criteria) {
      criteria += 1;
      if (carriesMarker(criterion.text) || carriesMarker(criterion.rawText)) {
        marked += 1;
        if (criterion.record.kind === "unclassified") failures.push(`${file}: ${criterion.id}: carries a marker but parsed as unclassified`);
      } else if (criterion.record.kind !== "unclassified") {
        failures.push(`${file}: ${criterion.id}: no marker, but parsed as ${criterion.record.kind}`);
      }
    }
  }
  expect(failures).toEqual([]);
  return { criteria, marked };
}

describe("acceptance-kind parser over the real corpus (AC3)", () => {
  const corpus = resolveCorpus();

  test("the corpus is non-empty — a run that saw no criteria files fails loudly", () => {
    expect(corpus.files.length).toBeGreaterThan(0);
    if (corpus.source === "flows") {
      // The repo holds hundreds of flows; a handful would mean the resolution broke.
      expect(corpus.files.length).toBeGreaterThan(50);
    }
  });

  test("every criteria file parses with zero errors; unmarked criteria are unclassified, marked ones parse", () => {
    const { criteria } = assertBackwardCompatible(corpus.files);
    expect(criteria).toBeGreaterThan(0);
  });
});

describe("acceptance-kind parser over the checked-in fixtures (runs everywhere, CI included)", () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(FIXTURES_DIR, name))
    .sort();

  test("the fixture set exists", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(2);
  });

  test("real-corpus sample: backticks, brackets and the word verify: in prose all stay unclassified", () => {
    const file = path.join(FIXTURES_DIR, "corpus-sample.md");
    const parsed = parseAcKinds(readFileSync(file, "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.criteria.length).toBeGreaterThanOrEqual(10);
    for (const criterion of parsed.criteria) {
      expect(criterion.record).toEqual({ kind: "unclassified" });
    }
  });

  test("marked sample: each marker parses to the kind it declares, the unmarked line is unclassified", () => {
    const file = path.join(FIXTURES_DIR, "marked-sample.md");
    const parsed = parseAcKinds(readFileSync(file, "utf8"));
    expect(parsed.errors).toEqual([]);
    const byId = Object.fromEntries(parsed.criteria.map((criterion) => [criterion.id, criterion.record]));
    expect(byId["AC1"]).toEqual({ kind: "exec", check: "bun test src/flow/ac-kinds.test.ts" });
    expect(byId["AC2"]).toEqual({ kind: "exec", check: "bun test src/flow/ac-kinds-errors.test.ts" });
    expect(byId["AC3"]).toEqual({ kind: "invariant", check: "bun test src/flow/ac-kinds-never-gates.test.ts" });
    expect(byId["AC4"]).toEqual({ kind: "judged" });
    expect(byId["AC5"]?.kind).toBe("none");
    expect(byId["AC6"]).toEqual({ kind: "unclassified" });
    expect(byId["AC7"]).toEqual({ kind: "exec", check: "grep -q '[a-z]' docs/requirements/keryx-acceptance-layer/prd.md" });
  });

  test("the whole fixture set passes the same backward-compatibility check as the corpus", () => {
    const { criteria, marked } = assertBackwardCompatible(fixtureFiles);
    expect(criteria).toBeGreaterThan(marked);
    expect(marked).toBeGreaterThan(0);
  });
});
