// Flow 313 (W4 portability), re-plan lane C1: coverage for the shared
// symlink-containment check. Previously this had no test of its own — only
// indirect coverage through `markdown-block.test.ts` and friends — even
// though `contained-write.ts` now also depends on it directly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { refuseEscapingSymlink } from "./symlink-safety";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-symsafe-")));
  root = path.join(base, "project");
  outsideDir = path.join(base, "elsewhere");
  await mkdir(root, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  if (root.length > 0) await rm(path.dirname(root), { recursive: true, force: true });
});

describe("refuseEscapingSymlink", () => {
  test("allows a plain, non-existent relative path", async () => {
    expect(await refuseEscapingSymlink(root, "a/b/new-file.txt")).toBeUndefined();
  });

  test("allows a symlink that resolves inside root (CLAUDE.md -> AGENTS.md shape)", async () => {
    await writeFile(path.join(root, "AGENTS.md"), "# agents\n", "utf8");
    await symlink(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
    expect(await refuseEscapingSymlink(root, "CLAUDE.md")).toBeUndefined();
  });

  test("allows a relative-target symlink that resolves inside root", async () => {
    await mkdir(path.join(root, ".github"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# agents\n", "utf8");
    await symlink(path.join("..", "AGENTS.md"), path.join(root, ".github", "copilot-instructions.md"));
    expect(await refuseEscapingSymlink(root, ".github/copilot-instructions.md")).toBeUndefined();
  });

  test("refuses a symlink whose resolved real path leaves root", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "TOP SECRET\n", "utf8");
    await symlink(outsideFile, path.join(root, "escape.txt"));
    const refusal = await refuseEscapingSymlink(root, "escape.txt");
    expect(refusal).toContain("escape.txt");
    expect(refusal).toContain("outside the project root");
  });

  test("refuses via an intermediate directory symlink that escapes", async () => {
    const outsideSubdir = path.join(outsideDir, "sub");
    await mkdir(outsideSubdir, { recursive: true });
    await writeFile(path.join(outsideSubdir, "target.txt"), "x\n", "utf8");
    await symlink(outsideSubdir, path.join(root, "linked"));
    const refusal = await refuseEscapingSymlink(root, "linked/target.txt");
    expect(refusal).toBeDefined();
  });

  test("refuses a dangling symlink with a distinct message", async () => {
    await symlink(path.join(outsideDir, "does-not-exist"), path.join(root, "broken.txt"));
    const refusal = await refuseEscapingSymlink(root, "broken.txt");
    expect(refusal).toContain("broken symlink");
  });

  test("R3-F13: refuses a symlink that resolves into the project's own .git directory", async () => {
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\n", "utf8");
    await symlink(path.join(root, ".git", "hooks", "pre-commit"), path.join(root, "CLAUDE.md"));
    const refusal = await refuseEscapingSymlink(root, "CLAUDE.md");
    expect(refusal).toBeDefined();
    expect(refusal).toContain(".git");
  });

  test("never follows a symlink to decide whether a later segment exists", async () => {
    // `linked` -> outside dir that does not itself exist yet: lstat on
    // `linked` still finds the symlink and refuses it before the "does the
    // target exist" question is ever asked.
    await symlink(path.join(outsideDir, "not-there-yet"), path.join(root, "linked"));
    const refusal = await refuseEscapingSymlink(root, "linked/child.txt");
    expect(refusal).toBeDefined();
  });
});
