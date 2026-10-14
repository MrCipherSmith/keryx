import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { citedPaths, flagMissingCitations } from "./rebuttal-citation";
import { createManagedReviewPackage } from "./managed";
import type { StructuredReviewFinding } from "./types";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "keryx-rebuttal-"));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "style.md"), "# style\n");
  await writeFile(path.join(dir, "src.ts"), "export const a = 1;\n");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const finding = (over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding => ({
  id: "F-001", reviewer: "review-logic", severity: "minor", problem: "p", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high", file: "src.ts", ...over,
});

async function recorded(evidence: string): Promise<StructuredReviewFinding[]> {
  const result = await createManagedReviewPackage({
    cwd: dir, mode: "ingest", reviewId: "citation", target: { kind: "report", ref: "review.md" }, reportText: "# R\n",
    refuted: [finding({ disposition: { state: "dismissed-incorrect", evidence } })],
  });
  return JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
}

test("paths a rebuttal cites are picked out of prose, backticks and links, and URLs are not paths", () => {
  expect(citedPaths("per `docs/style.md` and rules/core/naming.mdc:12, see https://example.com/a/b.md and (docs/x.md#anchor).").sort()).toEqual(["docs/style.md", "docs/x.md", "rules/core/naming.mdc"]);
  expect(citedPaths("the author said it is fine, commit 1a2b3c4")).toEqual([]);
});

test("a cited document that is not in the tree gets a 'citation not found' line; the finding stays", async () => {
  const [kept] = await recorded("author: the project rule docs/missing-rule.md allows this");
  expect(kept).toBeDefined();
  expect(kept!.disposition?.state).toBe("dismissed-incorrect");
  expect(kept!.disposition?.evidence).toContain("author: the project rule docs/missing-rule.md allows this");
  expect(kept!.disposition?.evidence).toContain("citation not found: docs/missing-rule.md");
});

test("a citation that exists adds nothing", async () => {
  const [kept] = await recorded("author: see docs/style.md");
  expect(kept!.disposition?.evidence).toBe("author: see docs/style.md");
});

test("only the missing one of several citations is named, and a rerun does not append twice", async () => {
  const findings = [finding({ disposition: { state: "dismissed-incorrect", evidence: "docs/style.md and docs/gone.md" } })];
  const exists = async (relative: string) => relative === "docs/style.md";
  expect(await flagMissingCitations(findings, exists)).toBe(1);
  expect(findings[0]!.disposition!.evidence).toBe("docs/style.md and docs/gone.md\ncitation not found: docs/gone.md");
  expect(await flagMissingCitations(findings, exists)).toBe(0);
});

test("a citation is looked up at the reviewed commit as well as in the working tree", async () => {
  await $`git init -q`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(dir).quiet();
  const head = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim();
  await rm(path.join(dir, "docs", "style.md"));
  const result = await createManagedReviewPackage({
    cwd: dir, mode: "ingest", reviewId: "citation-head", target: { kind: "report", ref: "review.md", head }, reportText: "# R\n",
    refuted: [finding({ disposition: { state: "dismissed-incorrect", evidence: "docs/style.md" } })],
  });
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.disposition.evidence).toBe("docs/style.md");
});

test("a path that leaves the tree is reported missing without being read", async () => {
  const [kept] = await recorded("see ../../etc/passwd.md");
  expect(kept!.disposition?.evidence).toContain("citation not found: ../../etc/passwd.md");
});
