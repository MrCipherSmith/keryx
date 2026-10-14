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

test("a quote that is not at the reviewed SHA refuses the ingest, names the finding and the SHA, and writes nothing", async () => {
  await writeFile(path.join(dir, "src", "greet.ts"), SOURCE.replace("hello", "howdy"));
  const error = await ingest({ findings: [finding({ quote: "  return `howdy ${trimmed}`;" })] }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("F-001");
  expect((error as Error).message).toContain(head.slice(0, 7));
  expect((error as Error).message).toContain("src/greet.ts");
  await expect(readFile(path.join(dir, ".metaproject", "reviews"), "utf8")).rejects.toThrow();
});

test("a file that is not in the tree at the SHA refuses too, and says that", async () => {
  const error = await ingest({ findings: [finding({ file: "src/gone.ts", quote: "anything" })] }).catch((e: Error) => e);
  expect((error as Error).message).toContain("no such file");
});

test("a finding the round dismissed is recorded rather than refused", async () => {
  const result = await ingest({
    findings: [],
    refuted: [finding({ quote: "  return `howdy ${trimmed}`;", disposition: { state: "dismissed-incorrect", evidence: "the reviewer misread the file" } })],
  });
  const [kept] = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept.disposition.state).toBe("dismissed-incorrect");
});

test("a dismissed finding and an external comment are not asked to resolve, even among the reported findings", async () => {
  const stale = "  return `howdy ${trimmed}`;";
  const result = await ingest({
    findings: [
      finding({ id: "F-001", quote: stale, disposition: { state: "dismissed-incorrect", evidence: "the reviewer misread the file" } }),
      finding({ id: "F-002", quote: stale, source: "external", external_ref: { id: "review-comment:12", author: "someone", url: "https://github.com/acme/app/pull/7#discussion_r12", submitted_at: "2026-10-14T00:00:00Z" } }),
    ],
  });
  const kept = JSON.parse(await readFile(path.join(dir, result.path, "findings.json"), "utf8"));
  expect(kept).toHaveLength(2);
});

test("the refusal names the possible causes and the way out", async () => {
  const error = await ingest({ findings: [finding({ quote: "  return `howdy ${trimmed}`;" })] }).catch((e: Error) => e);
  const message = (error as Error).message;
  expect(message).toContain("appears in it more than once");
  expect(message).toContain(`git cat-file -e ${head.slice(0, 12)}`);
  expect(message).toContain("ingest without --head");
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
