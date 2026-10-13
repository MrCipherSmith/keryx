// Flow 441 F-045: a revision typed after --ref, --base or --diff reaches git as a revision, never as an option. Run through the
// real CLI in a scratch repository: before the fix `--ref=--output=<file>` made `git diff` write that file.

import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGitRevision } from "../lib/git-revision";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-revision-operand-")));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
git("add", "a.ts");
git("commit", "-qm", "one");
writeFileSync(path.join(repo, "a.ts"), "export const a = 2;\n");

function run(...args: string[]): { exitCode: number; output: string } {
  const child = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { exitCode: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

const outside = path.join(repo, "outside-file");
const HOSTILE: ReadonlyArray<readonly string[]> = [
  ["review", "slice", `--ref=--output=${outside}`],
  ["review", "slice", `--base=--output=${outside}`],
  ["review", "scope", `--ref=--output=${outside}`],
  ["review", "blast-radius", `--base=--output=${outside}`],
  ["review", "floor", `--ref=--output=${outside}`],
];
// These return early when Jev is not enabled (the CI default), so their exit code proves nothing there; the source pin below covers their call sites.
const JEV_HOSTILE: ReadonlyArray<readonly string[]> = [
  ["review", "jev-select", `--ref=--output=${outside}`],
  ["review", "jev-risk", `--diff=--output=${outside}`],
  ["review", "jev-rules", `--diff=--output=${outside}`],
  ["review", "jev-scenarios", `--diff=--output=${outside}`],
  ["review", "jev-docs", `--diff=--output=${outside}`],
  ["review", "jev-contract", `--diff=--output=${outside}`],
];

test("F-045: no review command lets a --flag=--output=<file> revision make git write a file", () => {
  for (const args of HOSTILE) {
    const result = run(...args);
    expect(existsSync(outside), args.join(" ")).toBe(false);
    expect(result.exitCode, args.join(" ")).not.toBe(0);
  }
}, 120_000);

test("F-045: no jev command lets a --flag=--output=<file> revision make git write a file", () => {
  for (const args of JEV_HOSTILE) {
    run(...args);
    expect(existsSync(outside), args.join(" ")).toBe(false);
  }
}, 120_000);

test("F-045: a revision that starts with - is refused by name, before git runs", () => {
  const result = run("review", "slice", "--ref=-U0");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain('Refusing the revision "-U0"');
});

test("F-045: a real revision still slices the diff", () => {
  const result = run("review", "slice", "--ref=HEAD", "--json");
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("a.ts");
});

test("assertGitRevision returns a plain revision and refuses one that starts with -", () => {
  expect(assertGitRevision("origin/main")).toBe("origin/main");
  expect(assertGitRevision("HEAD~1")).toBe("HEAD~1");
  expect(() => assertGitRevision("--output=/tmp/x")).toThrow('Refusing the revision "--output=/tmp/x"');
  expect(() => assertGitRevision("-")).toThrow();
});

test("every git call that takes a typed revision puts --end-of-options before it", () => {
  const sites: ReadonlyArray<readonly [string, string, number]> = [
    ["review.ts", '"--end-of-options", assertGitRevision(ref)', 2],
    ["review.ts", '"merge-base", "--end-of-options", "HEAD", assertGitRevision(ref)', 1],
    ["review-jev-select.ts", '"--end-of-options", assertGitRevision(ref)', 1],
    ["review-jev-risk.ts", '"--end-of-options", assertGitRevision(ref)', 1],
    ["review-jev-contract.ts", '"--end-of-options", assertGitRevision(ref)', 1],
    ["review-jev-docs.ts", '"--end-of-options", assertGitRevision(ref)', 1],
    ["review-jev-scenarios.ts", '"--end-of-options", assertGitRevision(ref)', 1],
    ["review-jev-rules.ts", '"--end-of-options", assertGitRevision(ref)', 1],
  ];
  for (const [file, needle, times] of sites) {
    const text = readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(text.split(needle).length - 1, `${file}: ${needle}`).toBe(times);
  }
});
