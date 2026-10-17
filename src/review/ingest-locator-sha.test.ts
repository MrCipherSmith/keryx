import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManagedReviewPackage, type ManagedReviewIngestInput } from "./managed";
import type { StructuredReviewFinding } from "./types";

const SOURCE = ["export function greet(name: string): string {", "  const trimmed = name.trim();", "  return `hello ${trimmed}`;", "}"].join("\n");
const QUOTE = "  return `hello ${trimmed}`;";
const TEMPLATES = [
  "src/gdskills/bundled/skills/review/review-orchestrator/templates/review-report.md",
  ".metaproject/skills/gdskills/review/review-orchestrator/templates/review-report.md",
];

let dir = "";
let head = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "keryx-locator-sha-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "greet.ts"), SOURCE);
  await $`git init -q`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(dir).quiet();
  head = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const finding = (over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding => ({
  id: "F-001", reviewer: "review-logic", severity: "minor", problem: "drops an empty name", impact: "trailing space",
  suggested_fix: "return a bare hello", evidence: "called it with an empty string", confidence: "high", file: "src/greet.ts", line: 3, quote: QUOTE, ...over,
});

const ingest = (over: Partial<ManagedReviewIngestInput> = {}) =>
  createManagedReviewPackage({ cwd: dir, mode: "ingest", reviewId: "locator-sha", target: { kind: "report", ref: "review.md", head }, reportText: "# R\n", findings: [finding()], ...over });

test("a quote that is at its path at the reviewed SHA is recorded, even when the working tree has moved on", async () => {
  await rm(path.join(dir, "src", "greet.ts"));
  const result = await ingest();
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.locator).toMatchObject({ state: "derived" });
  expect(kept.line).toBe(3);
});

// Flow 460 (supersedes the old refusal): a quote absent from its file at the SHA, or in it more than once, is kept with
// no line, flagged quote_unlocated and listed in scope.md; the round is recorded. Only a quote that could not be checked
// at all (below: a head this checkout does not have) still refuses.
test("a quote that is not at the reviewed SHA is kept unanchored, flagged quote_unlocated: absent, and the round is recorded", async () => {
  await writeFile(path.join(dir, "src", "greet.ts"), SOURCE.replace("hello", "howdy"));
  const result = await ingest({ findings: [finding({ quote: "  return `howdy ${trimmed}`;" }), finding({ id: "F-002" })] });
  const kept = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept).toHaveLength(2);
  expect(kept[0].line).toBeNull();
  expect(kept[0].locator).toMatchObject({ state: "unlocatable", reported_line: 3 });
  expect(kept[0].quote_unlocated).toEqual({ reason: "absent" });
  expect(kept[1].quote_unlocated).toBeUndefined();
  expect(kept[1].line).toBe(3);
  // One check writes both: a finding flagged quote_unlocated always records an unlocatable locator.
  for (const entry of kept) if (entry.quote_unlocated !== undefined) expect(entry.locator.state).toBe("unlocatable");
  const scope = await readFile(path.join(dir, result.path, "scope.md"), "utf8");
  expect(scope).toContain("## Quotes not located at the reviewed head");
  expect(scope).toContain("F-001 (review-logic): src/greet.ts: the quote is absent from the file");
  expect(scope).not.toContain("F-002 (review-logic)");
});

test("an ambiguous quote is kept with its candidate lines, never anchored to the first or the nearest one", async () => {
  await writeFile(path.join(dir, "src", "twice.ts"), ["const a = 1;", "const b = 2;", "const a = 1;"].join("\n"));
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m twice`.cwd(dir).quiet();
  const twiceHead = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim();
  const result = await ingest({ target: { kind: "report", ref: "review.md", head: twiceHead }, findings: [finding({ file: "src/twice.ts", line: 3, quote: "const a = 1;" })] });
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.line).toBeNull();
  expect(kept.quote_unlocated).toEqual({ reason: "ambiguous", candidate_lines: [1, 3] });
  expect(await readFile(path.join(dir, result.path, "scope.md"), "utf8")).toContain("candidate lines 1, 3");
});

test("a quote that could not be checked at all (the head is not in this checkout) still refuses, names the finding and the SHA, and writes nothing", async () => {
  const missing = "f".repeat(40);
  const error = await ingest({ target: { kind: "report", ref: "review.md", head: missing } }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("F-001");
  expect((error as Error).message).toContain(missing.slice(0, 7));
  expect((error as Error).message).toContain("src/greet.ts");
  await expect(readFile(path.join(dir, ".metaproject", "reviews"), "utf8")).rejects.toThrow();
});

// Flow 458 AC12 (supersedes the old refusal): a finding's own file absent at the SHA is kept and flagged path_missing.
// Only a quote that could not be checked at all (the head is not in this checkout, an empty quote, a size bound) refuses
// (above); a quote that was checked and is absent or ambiguous is kept and flagged quote_unlocated.
test("a file that is not in the tree at the SHA is kept, flagged path_missing, not refused", async () => {
  const result = await ingest({ findings: [finding({ file: "src/gone.ts", quote: "anything" })] });
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.path_missing).toBe(true);
  expect(kept.locator).toMatchObject({ state: "unlocatable" });
});

// The two exemptions below are pinned on a quote that still refuses for an open internal finding (a head this checkout
// does not have): an absent quote at a head that exists no longer refuses anyone, so it would pass without them.
const UNCHECKABLE = { kind: "report" as const, ref: "review.md", head: "f".repeat(40) };

test("a finding the round dismissed is recorded rather than refused, even where its quote cannot be checked", async () => {
  const result = await ingest({
    target: UNCHECKABLE,
    findings: [],
    refuted: [finding({ quote: "  return `howdy ${trimmed}`;", disposition: { state: "dismissed-incorrect", evidence: "the reviewer misread the file" } })],
  });
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.disposition.state).toBe("dismissed-incorrect");
});

test("a dismissed finding and an external comment are not asked to resolve, even among the reported findings", async () => {
  const stale = "  return `howdy ${trimmed}`;";
  // The same quote on an open internal finding refuses at this head: the exemptions are what lets these two through.
  expect(await ingest({ target: UNCHECKABLE, findings: [finding({ quote: stale })] }).catch((e: Error) => e)).toBeInstanceOf(Error);
  const result = await ingest({
    target: UNCHECKABLE,
    findings: [
      finding({ id: "F-001", quote: stale, disposition: { state: "dismissed-incorrect", evidence: "the reviewer misread the file" } }),
      finding({ id: "F-002", quote: stale, source: "external", external_ref: { id: "review-comment:12", author: "someone", url: "https://github.com/acme/app/pull/7#discussion_r12", submitted_at: "2026-10-14T00:00:00Z" } }),
    ],
  });
  const kept = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept).toHaveLength(2);
});

test("the refusal names the possible causes and the way out", async () => {
  const missing = "f".repeat(40);
  const error = await ingest({ target: { kind: "report", ref: "review.md", head: missing } }).catch((e: Error) => e);
  const message = (error as Error).message;
  expect(message).toContain("the commit is not in this checkout");
  expect(message).toContain("flagged quote_unlocated");
  expect(message).toContain(`git cat-file -e ${missing.slice(0, 12)}`);
  expect(message).toContain("dismiss the finding with evidence");
  expect(message).not.toContain("without --head");
});

test("with no reviewed SHA the ingest does not refuse, as before", async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), "keryx-locator-nosha-"));
  try {
    const result = await createManagedReviewPackage({ cwd: bare, mode: "ingest", reviewId: "no-sha", target: { kind: "report", ref: "review.md" }, reportText: "# R\n", findings: [finding()] });
    const [kept] = JSON.parse(await readFile(path.join(bare, result.path, "findings.json"), "utf8"));
    expect(kept.locator.state).toBe("unlocatable");
  } finally { await rm(bare, { recursive: true, force: true }); }
});

test("the report template links each finding at the blob of the reviewed SHA, in both copies", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const copies = await Promise.all(TEMPLATES.map((file) => readFile(path.join(root, file), "utf8")));
  for (const text of copies) expect(text).toContain("/blob/<head>/");
  expect(copies[0]).toBe(copies[1]!);
});
