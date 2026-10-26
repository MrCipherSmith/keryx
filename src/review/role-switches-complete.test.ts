// Flow 478 G4: `review complete` puts the optional roles that did not run into report.md, once, and leaves the line out
// when the round asked for them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { completeManagedReview, createManagedReviewPackage } from "./managed";
import { ROLE_LINE_PREFIX, ROUND_ROLES_FILE } from "./role-switches";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-roles-complete-")));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of ["review-orchestrator", "review-verifier", "review-logic", "review-architecture", "review-clean-code", "review-style"]) {
    const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function packageWithReport(id: string): Promise<string> {
  const result = await createManagedReviewPackage({
    cwd: root,
    mode: "review-flow",
    reviewId: id,
    target: { kind: "path", ref: "src/review" },
    research: { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH },
    now: new Date("2026-10-25T11:00:00Z"),
  });
  await appendFile(path.join(root, result.path, "report.md"), "\nEvidence level: static only — did not run: tests\n", "utf8");
  return result.path;
}

const reportOf = (pkg: string): Promise<string> => readFile(path.join(root, pkg, "report.md"), "utf8");

test("without the flag the report names the roles that did not run, once, however often complete runs", async () => {
  const pkg = await packageWithReport("2026-10-25-roles-off");
  const done = await completeManagedReview(root, pkg);
  expect(done.rolesNotRun).toEqual(["review-clean-code", "review-style"]);
  const report = await reportOf(pkg);
  expect(report).toContain(`${ROLE_LINE_PREFIX} review-clean-code, review-style`);
  expect(report).toContain("Evidence level: static only");
  await completeManagedReview(root, pkg);
  expect((await reportOf(pkg)).split(ROLE_LINE_PREFIX)).toHaveLength(2);
});

test("a round that asked for the roles has no such line", async () => {
  const pkg = await packageWithReport("2026-10-25-roles-on");
  await writeFile(path.join(root, pkg, ROUND_ROLES_FILE), JSON.stringify({ enabled: ["review-clean-code", "review-style"] }), "utf8");
  const done = await completeManagedReview(root, pkg);
  expect(done.rolesNotRun).toBeUndefined();
  expect(await reportOf(pkg)).not.toContain(ROLE_LINE_PREFIX);
});

test("one role asked for and the other not: only the other is named", async () => {
  const pkg = await packageWithReport("2026-10-25-roles-one");
  await writeFile(path.join(root, pkg, ROUND_ROLES_FILE), JSON.stringify({ enabled: ["review-style"] }), "utf8");
  expect((await completeManagedReview(root, pkg)).rolesNotRun).toEqual(["review-clean-code"]);
  expect(await reportOf(pkg)).toContain(`${ROLE_LINE_PREFIX} review-clean-code`);
  expect(await reportOf(pkg)).not.toContain("review-style");
});
