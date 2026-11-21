import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryService } from "../memory/service";
import { createWorktree } from "./create";
import { FORBIDDEN_GIT_SUBCOMMANDS, gitSubcommand } from "./git";
import { prepareWorktree } from "./prepare";
import { createProjectFixture, everyPortFree, type ProjectFixture } from "./project-fixture";
import { promoteWorktree } from "./promote";
import { removeWorktree } from "./remove";
import { worktreeStatus } from "./status";

// AC10: no command of the package runs `git stash`, `git add`, `git commit` or `git push`.
// The proof is a `git` placed first on PATH that records every invocation (from any
// call site, runGit or otherwise) and then runs the real one.

let project: ProjectFixture;
let originalPath: string | undefined;
let logFile: string;

beforeEach(async () => {
  project = await createProjectFixture();
  const shimDir = path.join(project.base, "shim");
  mkdirSync(shimDir);
  logFile = path.join(project.base, "git-calls.log");
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is required for this test");
  const shim = path.join(shimDir, "git");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\037' "$@" >> "${logFile}"\nprintf '\\n' >> "${logFile}"\nexec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(logFile, "");
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  project.cleanup();
});

function loggedSubcommands(): string[] {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => gitSubcommand(line.split("\u001f").slice(0, -1)) ?? "");
}

test("create, prepare, status, promote and remove never run stash, add, commit or push (AC10)", async () => {
  const env = { KERYX_HOME: project.userHome };
  const created = await createWorktree({
    cwd: project.main,
    name: "wt-git",
    base: "main",
    path: path.join(project.base, "wt-git"),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
  await prepareWorktree({ cwd: created.path, runInstall: project.runInstall, isPortFree: everyPortFree });
  await worktreeStatus(created.path, { env });
  await createMemoryService().create({ cwd: created.path, type: "lesson", slug: "git-check", title: "Git check" });
  await promoteWorktree({ cwd: created.path, dryRun: true, interactive: false, env });
  await promoteWorktree({ cwd: created.path, stores: ["memory"], interactive: true, env });
  await removeWorktree({ cwd: project.main, name: "wt-git", force: true, env });

  const subcommands = loggedSubcommands();
  // The shim saw the work: the guard below is not vacuously true.
  expect(subcommands).toContain("worktree");
  expect(subcommands).toContain("status");
  expect(subcommands).toContain("branch");
  for (const forbidden of FORBIDDEN_GIT_SUBCOMMANDS) {
    expect(subcommands).not.toContain(forbidden);
  }
});
