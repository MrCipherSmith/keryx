import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import { listSourceFiles } from "./util";
import { uniqueTestRoot } from "../lib/test-tmp";

// A phase-2 review reported that the health file walk counts agent worktrees
// under .claude/ the way the testing module's walk did, because .claude is
// absent from IGNORED_DIRS. Measured against the real walk, it does not: the
// walk skips every entry whose name begins with a dot, so .claude never
// entered it and adding it to IGNORED_DIRS changed nothing. The report was
// read off the constant rather than run.
//
// The behaviour is right and was unpinned, so it is pinned here rather than
// left to the next reader to re-derive. Both directions matter: a worktree is
// a whole copy of the checkout and must not be counted again, while an
// ordinary nested package is not a worktree and must still be walked.

test("the source walk skips transient agent worktrees under .claude", async () => {
  const root = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-health-ignored");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".claude", "worktrees", "gone-abc123", "src"), { recursive: true });

  await writeFile(path.join(root, "src", "real.ts"), "export const x = 1;\n");
  await writeFile(
    path.join(root, ".claude", "worktrees", "gone-abc123", "src", "copy.ts"),
    "export const x = 1;\n",
  );

  const files = await listSourceFiles(root, DEFAULT_HEALTH_CONFIG.ignore.paths);
  expect(files).toEqual(["src/real.ts"]);

  await rm(root, { recursive: true, force: true });
});

test("the source walk still descends into an ordinary nested package", async () => {
  const root = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-health-nested");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "packages", "widgets", "src"), { recursive: true });

  await writeFile(
    path.join(root, "packages", "widgets", "package.json"),
    JSON.stringify({ name: "widgets" }),
  );
  await writeFile(path.join(root, "packages", "widgets", "src", "widget.ts"), "export const x = 1;\n");

  const files = await listSourceFiles(root, DEFAULT_HEALTH_CONFIG.ignore.paths);
  expect(files).toEqual(["packages/widgets/src/widget.ts"]);

  await rm(root, { recursive: true, force: true });
});
