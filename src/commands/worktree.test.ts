import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createWorktree, type CreateResult } from "../worktree/create";
import { createProjectFixture, everyPortFree, type ProjectFixture } from "../worktree/project-fixture";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

let project: ProjectFixture;
let wt: CreateResult;

beforeEach(async () => {
  project = await createProjectFixture();
  wt = await createWorktree({
    cwd: project.main,
    name: "wt-cli",
    base: "main",
    path: path.join(project.base, "wt-cli"),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
});
afterEach(() => project.cleanup());

function runCli(cwd: string, ...argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["bun", path.join(REPO_ROOT, "src/cli.ts"), ...argv], {
    cwd,
    env: { ...process.env, HOME: project.userHome, KERYX_HOME: project.userHome, XDG_CONFIG_HOME: project.userHome, XDG_DATA_HOME: project.userHome },
  });
  return { exitCode: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe("keryx worktree (CLI)", () => {
  test("status --json reports the label and ports as JSON, names only", () => {
    const run = runCli(wt.path, "worktree", "status", "--json");
    expect(run.exitCode).toBe(0);
    const status = JSON.parse(run.stdout);
    expect(status.main).toBe(false);
    expect(status.checkout.checkoutId).toBe(wt.prepare.checkoutId);
    expect(status.envFiles).toEqual([".env"]);
    expect(run.stdout).not.toContain("top-secret-value");
  });

  test("exec -- printenv PORT prints the allocated port, and env prints export lines (AC4)", () => {
    const port = String(wt.prepare.ports?.web);
    const exec = runCli(wt.path, "worktree", "exec", "--", "printenv", "PORT");
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim()).toBe(port);
    expect(runCli(wt.path, "worktree", "env").stdout).toBe(`export PORT=${port}\n`);
  });

  test("exec propagates the command's exit code", () => {
    expect(runCli(wt.path, "worktree", "exec", "--", "sh", "-c", "exit 7").exitCode).toBe(7);
  });

  test("prepare refuses the main checkout with a clear one-line message", () => {
    const run = runCli(project.main, "worktree", "prepare");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("main checkout");
  });

  test("an unknown flag is refused by name", () => {
    const run = runCli(wt.path, "worktree", "status", "--bogus");
    expect(run.exitCode).toBe(1);
    expect(run.stderr.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
    expect(run.stderr).toContain("--bogus");
  });

  test("promote without a terminal only lists with --dry-run", () => {
    const dry = runCli(wt.path, "worktree", "promote", "--dry-run");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("nothing to promote");
    const real = runCli(wt.path, "worktree", "promote");
    expect(real.exitCode).toBe(1);
    expect(real.stderr).toContain("interactive terminal");
  });

  test("--help prints usage without running anything", () => {
    const run = runCli(wt.path, "worktree", "remove", "--help");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("keryx worktree remove");
  });
});
