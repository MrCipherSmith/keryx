import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "../lib/test-tmp";
import { flagStatus, skillPackageNames } from "./project-reviewers";

// The inventory-level behaviour (`keryx review reviewers`, the import's flag
// warnings) is driven through `src/review/reviewers.test.ts` and
// `./import-skills.test.ts`. This file holds what only the directory scan shows.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function reviewersRoot(): Promise<string> {
  const root = uniqueTestRoot(path.join(tmpdir(), "keryx-project-reviewers"), "scan");
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return dir;
}

describe("skillPackageNames", () => {
  test("a symlink to a skill directory is not a package; only real directories are (V01)", async () => {
    const root = await reviewersRoot();
    const real = await writeSkill(root, "review-real");
    await symlink(real, path.join(root, "review-link"), "dir");
    // A symlink to a directory outside the tree is not a package either.
    const outside = await writeSkill(await reviewersRoot(), "review-elsewhere");
    await symlink(outside, path.join(root, "review-outside"), "dir");
    expect(await skillPackageNames(root)).toEqual(["review-real"]);
  });

  test("a directory without a SKILL.md and a plain file are skipped", async () => {
    const root = await reviewersRoot();
    await writeSkill(root, "review-b");
    await writeSkill(root, "review-a");
    await mkdir(path.join(root, "half-written"));
    await writeFile(path.join(root, "notes.md"), "not a package\n");
    expect(await skillPackageNames(root)).toEqual(["review-a", "review-b"]);
  });
});

test("flagStatus: nobody, one, or several carriers", () => {
  expect([0, 1, 2, 3].map(flagStatus)).toEqual(["none", "own", "family", "family"]);
});
