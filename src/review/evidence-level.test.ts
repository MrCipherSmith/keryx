import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { parseEvidenceLevel } from "./evidence-level";
import { completeManagedReview, createManagedReviewPackage } from "./managed";

const ready = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };
const STATIC = "Evidence level: static only — did not run: tests, typecheck";
const RAN = "Evidence level: ran — bun test src/a.test.ts, bun run typecheck";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-evidence-level-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ingest(reportText: string): Promise<{ pkg: string; ref: string }> {
  const result = await createManagedReviewPackage({ cwd: dir, mode: "ingest", reportText, reviewId: "evidence-level", target: { kind: "report", ref: "review.md" } });
  const pkg = path.resolve(dir, result.path);
  await writeFile(path.join(pkg, "research.json"), JSON.stringify(ready));
  return { pkg, ref: result.path };
}

test("static only needs the list of what did not run; ran needs the list of what ran", () => {
  expect(parseEvidenceLevel(`# R\n\n${STATIC}\n`)).toEqual({ ok: true, level: "static-only", items: ["tests", "typecheck"] });
  expect(parseEvidenceLevel(`# R\n\n${RAN}\n`)).toEqual({ ok: true, level: "ran", items: ["bun test src/a.test.ts", "bun run typecheck"] });
  expect(parseEvidenceLevel("Evidence level: static only")).toMatchObject({ ok: false });
  expect(parseEvidenceLevel("Evidence level: ran")).toMatchObject({ ok: false });
  expect(parseEvidenceLevel("Evidence level: it was fine")).toMatchObject({ ok: false });
  expect(parseEvidenceLevel("# R\n\nNothing about it.\n")).toMatchObject({ ok: false });
});

test("the field is found as a list item or in bold, and only as a line of its own", () => {
  expect(parseEvidenceLevel("- **Evidence level:** static only — did not run: tests").ok).toBe(true);
  expect(parseEvidenceLevel("The Evidence level: static only — did not run: tests, is a phrase in prose").ok).toBe(false);
});

test("complete refuses a new package whose report has no evidence level, and accepts it once the line is there", async () => {
  const { pkg, ref } = await ingest("# Review\nNo findings.\n");
  const manifest = JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8"));
  expect(manifest.report_fields).toEqual(["evidence-level"]);
  await expect(completeManagedReview(dir, ref)).rejects.toThrow("evidence level");
  expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).not.toBe("closed");

  await writeFile(path.join(pkg, "report.md"), `# Review\n${STATIC}\nNo findings.\n`);
  const done = await completeManagedReview(dir, ref);
  expect(done.manifest.status).toBe("closed");
  expect(done.warnings).toEqual([]);
});

test("a package ingested before the field existed completes with a warning, not a refusal", async () => {
  const { pkg, ref } = await ingest("# Review\nNo findings.\n");
  const manifestPath = path.join(pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.report_fields;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const done = await completeManagedReview(dir, ref);
  expect(done.manifest.status).toBe("closed");
  expect(done.warnings.join(" ")).toContain("evidence level");
});

test("a legacy package that does carry the line completes without a warning", async () => {
  const { pkg, ref } = await ingest(`# Review\n${RAN}\n`);
  const manifestPath = path.join(pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.report_fields;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  expect((await completeManagedReview(dir, ref)).warnings).toEqual([]);
});
