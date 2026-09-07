import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSourceFiles, listSourceFilesWithReasons } from "./util";
import { uniqueTestRoot } from "../lib/test-tmp";

// Flow 234 T26: `walk()` in this module called `readdir` with no guard, so a
// subdirectory it could not read (e.g. permission denied) threw uncaught and
// crashed the entire health run. Reproduced for real before this fix: `bun
// src/cli.ts health run` over a project tree containing a chmod-000
// subdirectory exited non-zero on an uncaught
// `EACCES: permission denied, scandir '...'` instead of producing a report
// (see the flow 234 T26 task report for the exact transcript). This file
// pins the fix -- the walk must survive AND must carry out which paths it
// could not read, mirroring `listProjectFiles`/`walk` in
// `src/testing/service.ts`, fixed for the identical defect one module over.

test("listSourceFiles survives an unreadable subdirectory instead of throwing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-util-unreadable");
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "src", "locked", "hidden.ts"), "export const y = 1;\n");
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const files = await listSourceFiles(root, []);
    expect(files).toEqual(["src/visible.ts"]);
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("listSourceFilesWithReasons names the unreadable path instead of reading it as clean coverage", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-util-unreadable-reasons");
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "src", "locked", "hidden.ts"), "export const y = 1;\n");
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const { files, incompleteReasons } = await listSourceFilesWithReasons(root, []);
    expect(files).toEqual(["src/visible.ts"]);
    expect(incompleteReasons).toHaveLength(1);
    expect(incompleteReasons[0]).toContain("src/locked");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("a fully readable tree reports no incompleteness", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-util-complete");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "export const x = 1;\n");

  try {
    const { files, incompleteReasons } = await listSourceFilesWithReasons(root, []);
    expect(files).toEqual(["src/visible.ts"]);
    expect(incompleteReasons).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
