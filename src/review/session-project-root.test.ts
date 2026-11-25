import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionProjectRoot } from "./session-attempt";

// A session's review round is listed by the session's project root. An agent often reviews a pull request in a linked
// worktree beside the project; a round started there must still be registered under the project.

let base: string;
let project: string;
let worktree: string;
let stranger: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "keryx-session-root-"));
  project = path.join(base, "project");
  worktree = path.join(base, "project-pr");
  stranger = path.join(base, "stranger");
  for (const dir of [project, stranger]) {
    mkdirSync(dir);
    git(dir, "init", "-q");
    git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  git(project, "worktree", "add", "-q", "--detach", worktree);
  mkdirSync(path.join(worktree, "src"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const session = () => ({ KERYX_REVIEW_SESSION_ID: "5d0c2c1e-3f0a-4d53-9a53-7a1d6d1b2c3e", KERYX_REVIEW_SESSION_PROJECT_ROOT: project });

test("the session's own project root is its project", async () => {
  expect(await sessionProjectRoot(project, session())).toBe(project);
});

test("a linked worktree of the project, and a folder inside it, belong to the session's project", async () => {
  expect(await sessionProjectRoot(worktree, session())).toBe(project);
  expect(await sessionProjectRoot(path.join(worktree, "src"), session())).toBe(project);
});

test("another repository, or a folder that is no repository, does not", async () => {
  expect(await sessionProjectRoot(stranger, session())).toBeUndefined();
  expect(await sessionProjectRoot(base, session())).toBeUndefined();
});

test("outside a session there is no session project", async () => {
  expect(await sessionProjectRoot(worktree, {})).toBeUndefined();
  expect(await sessionProjectRoot(worktree, { KERYX_REVIEW_SESSION_PROJECT_ROOT: project })).toBeUndefined();
});
