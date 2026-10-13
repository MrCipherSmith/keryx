// Flow 441 F-045: a revision typed after --ref, --base, --diff or --since reaches git as a revision, never as an option. Run through the
// real CLI in a scratch repository: before the fix `--ref=--output=<file>` made `git diff` write that file.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGitRevision, assertNoWritingDiffOption, revisionOperand } from "../lib/git-revision";
import { diffSince } from "../sync/diff";
import { resolveDiffAgainstBase, resolveIngestDiff } from "./flow-check-ac";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const SRC = path.join(import.meta.dir, "..");
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
mkdirSync(path.join(repo, ".metaproject"), { recursive: true });
writeFileSync(
  path.join(repo, ".metaproject", "tasks.config.json"),
  JSON.stringify({ review: { jev: { rules: true, risk: true, scenarios: true, contract: true, docs: true, select: true } } }),
);

function run(...args: string[]): { exitCode: number; output: string } {
  const child = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENROUTER_API_KEY: "sk-or-test-not-a-real-key" },
  });
  return { exitCode: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

// One output path per row, removed between rows, so a file written by one row cannot be read as the next row's proof.
let outside = "";
let row = 0;
beforeEach(() => {
  row += 1;
  outside = path.join(repo, `outside-file-${row}`);
  rmSync(outside, { force: true });
});

const HOSTILE: ReadonlyArray<(out: string) => string[]> = [
  (out) => ["review", "slice", `--ref=--output=${out}`],
  (out) => ["review", "slice", `--base=--output=${out}`],
  (out) => ["review", "scope", `--ref=--output=${out}`],
  (out) => ["review", "blast-radius", `--base=--output=${out}`],
  (out) => ["review", "floor", `--ref=--output=${out}`],
  (out) => ["review", "jev-select", `--ref=--output=${out}`],
  (out) => ["review", "jev-risk", `--diff=--output=${out}`],
  (out) => ["review", "jev-rules", `--diff=--output=${out}`],
  (out) => ["review", "jev-scenarios", `--diff=--output=${out}`],
  (out) => ["review", "jev-docs", `--diff=--output=${out}`],
  (out) => ["review", "jev-contract", `--diff=--output=${out}`],
  (out) => ["flow", "init", "x", `--base=--output=${out}`],
  (out) => ["test", "run", "--changed", `--since=--output=${out}`],
  (out) => ["health", "run", "--changed", `--since=--output=${out}`],
];

for (const build of HOSTILE) {
  const label = build("<file>").join(" ");
  test(`F-045: ${label} cannot make git write a file`, () => {
    const result = run(...build(outside));
    expect(existsSync(outside)).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Refusing the");
  }, 60_000);
}

test("F-045: wiki freshness reads a dash-leading --since as no changes and writes no file", () => {
  const result = run("wiki", "freshness", `--since=--output=${outside}`);
  expect(existsSync(outside)).toBe(false);
  expect(result.exitCode).toBe(0);
}, 60_000);

test("F-045: diffSince answers null for a dash-leading base and runs git for a real one", async () => {
  expect(await diffSince(repo, `--output=${outside}`)).toBeNull();
  expect(existsSync(outside)).toBe(false);
  const real = await diffSince(repo, "HEAD");
  expect(real?.modified).toEqual(["a.ts"]);
});

test("F-045: flow check-ac diffs through --end-of-options and refuses a dash-leading revision before git runs", async () => {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push([...argv]);
    return { stdout: "abc123\n", stderr: "", exitCode: 0 };
  };
  await resolveDiffAgainstBase(spawn, "origin/main");
  expect(calls[0]).toEqual(["git", "merge-base", "HEAD", "--end-of-options", "origin/main"]);
  expect(calls[1]).toEqual(["git", "diff", "--no-color", "-U20", "--end-of-options", "abc123"]);
  calls.length = 0;
  await resolveIngestDiff(spawn, "origin/main", "deadbeef");
  expect(calls[0]).toEqual(["git", "merge-base", "--end-of-options", "deadbeef", "origin/main"]);
  expect(calls[1]).toEqual(["git", "diff", "--no-color", "-U20", "--end-of-options", "abc123", "deadbeef"]);
  calls.length = 0;
  await expect(resolveDiffAgainstBase(spawn, `--output=${outside}`)).rejects.toThrow("Refusing the revision");
  await expect(resolveIngestDiff(spawn, `--output=${outside}`, "HEAD")).rejects.toThrow("Refusing the revision");
  await expect(resolveIngestDiff(spawn, "origin/main", `--output=${outside}`)).rejects.toThrow("Refusing the revision");
  expect(calls).toEqual([]);
});

test("F-045: ctx diff refuses a git option that writes a file", () => {
  const result = run("ctx", "diff", `--output=${outside}`);
  expect(existsSync(outside)).toBe(false);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Refusing the git diff option");
}, 60_000);

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
  expect(assertGitRevision("a-b")).toBe("a-b");
  expect(() => assertGitRevision("--output=/tmp/x")).toThrow('Refusing the revision "--output=/tmp/x"');
  expect(() => assertGitRevision("-")).toThrow('Refusing the revision "-"');
  expect(() => assertGitRevision("-U0")).toThrow();
});

test("revisionOperand puts --end-of-options before a validated revision", () => {
  expect(revisionOperand("origin/main")).toEqual(["--end-of-options", "origin/main"]);
  expect(() => revisionOperand("--output=x")).toThrow("Refusing the revision");
});

test("assertNoWritingDiffOption refuses the options that write a file or run a program, and nothing else", () => {
  expect(() => assertNoWritingDiffOption(["--output=/tmp/x"])).toThrow('Refusing the git diff option "--output=/tmp/x"');
  expect(() => assertNoWritingDiffOption(["--output"])).toThrow('Refusing the git diff option "--output"');
  expect(() => assertNoWritingDiffOption(["--ext-diff"])).toThrow('Refusing the git diff option "--ext-diff"');
  expect(() => assertNoWritingDiffOption(["--stat", "HEAD", "--", "a.ts"])).not.toThrow();
  expect(() => assertNoWritingDiffOption(["--output-indicator-new=+"])).not.toThrow();
  expect(() => assertNoWritingDiffOption([])).not.toThrow();
});

// Every non-test source file that builds a git argv from a value it did not write must either route that value through
// `revisionOperand` / `--end-of-options` or be listed here with the reason its operand cannot be a typed option.
const VERBS = ["diff", "merge-base", "log", "show", "rev-list", "diff-tree", "name-rev", "rev-parse", "cat-file", "ls-tree", "blame"];

const ALLOWED: Readonly<Record<string, string>> = {
  "metrics/provenance.ts": "answerCommit is a recorded sha followed by ^{commit}, not typed",
  "commands/trigger-dispatch.ts": "operand is refs/heads/<branch>, never dash-leading",
  "harness/external/write-land.ts": "operand is refs/heads/<branch>, never dash-leading",
  "commands/review-jev-comments.ts": "ref defaults to HEAD; no caller passes a typed value",
  "commands/ctx.ts": "ctx diff runs assertNoWritingDiffOption first; base comes from defaultDiffBase",
  "commands/agent.ts": "a word list, not git",
  "gdgraph/treesitter/extract.ts": "a word list, not git",
  "commands/review-jev-edit-guard.ts": "HEAD followed by --, or --no-index with fixed paths",
  "wiki/freshness/page-freshness.ts": "verifiedAt is probed by cat-file -e (which fails on a dash-leading value) before log and diff run",
  "wiki/freshness/run.ts": "fromRev is refused when dash-leading at the top of collectChanges before showFile",
  "health/metrics/churn.ts": "--since=<days> ago, a number",
  "lib/git-head.ts": "operands are HEAD:<path> or follow --",
  "lib/git-worktrees.ts": "mainBranch comes from git itself",
  "flow/review-gate.ts": "operands are shas read from the ledger",
  "flow/remote-flows.ts": "ref is built from a remote name git listed",
  "flow/folder-committed.ts": "HEAD, paths follow --",
  "flow/service.ts": "operands are recorded commits and origin/main",
  "harness/external/write-run.ts": "baseCommit is a sha the harness recorded",
  "review/managed.ts": "operand is <sha>:<path> of a recorded commit",
  "review/conform-pr-port.ts": "gh, not git; the PR number is numeric",
  "review/bot/run.ts": "baseSha is the PR's base sha from the API",
  "review/ci-triage.ts": "operand is <sha>:<path> of a CI-reported commit",
  "rewind/snapshot.ts": "operands are tree-ish ids the snapshot recorded",
  "rewind/restore.ts": "operands are tree ids the snapshot recorded",
  "gdgraph/staleness.ts": "operands are commits recorded in the graph provenance",
  "tui/jev-contract-command.ts": "no revision operand",
  "tui/jev-docs-command.ts": "no revision operand",
  "tui/jev-rules-command.ts": "no revision operand",
  "tui/jev-risk-command.ts": "no revision operand",
};

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function enclosingArray(text: string, from: number): string {
  let depth = 0;
  let begin = from;
  for (let i = from; i >= 0; i--) {
    if (text[i] === "]") depth++;
    else if (text[i] === "[") {
      if (depth === 0) {
        begin = i;
        break;
      }
      depth--;
    }
  }
  let open = 0;
  let end = begin;
  for (let i = begin; i < text.length; i++) {
    if (text[i] === "[") open++;
    else if (text[i] === "]") {
      open--;
      if (open === 0) {
        end = i;
        break;
      }
    }
  }
  return text.slice(begin, end + 1);
}

function hasUnguardedArgv(text: string): boolean {
  const verbRe = new RegExp(`(?:\\[|,)\\s*"(${VERBS.join("|")})"\\s*,`, "g");
  return [...text.matchAll(verbRe)].some((match) => {
    const argv = enclosingArray(text, match.index ?? 0);
    if (argv.includes("--end-of-options") || argv.includes("revisionOperand")) return false;
    return /[A-Za-z_`]/.test(argv.replace(/"(?:[^"\\$]|\\.)*"/g, '""').replace(/[[\],\s"]/g, ""));
  });
}

/** Files holding a git argv with a value that is not a string literal and carries no revisionOperand / --end-of-options. */
function unguardedGitArgvFiles(): string[] {
  return sourceFiles(SRC, [])
    .filter((file) => hasUnguardedArgv(readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
    .sort();
}

test("no git argv takes a non-literal operand without revisionOperand or an entry in ALLOWED", () => {
  const found = unguardedGitArgvFiles();
  expect(found.filter((file) => !(file in ALLOWED))).toEqual([]);
  expect(Object.keys(ALLOWED).filter((file) => !found.includes(file))).toEqual([]);
});

test("the guard scan notices an unguarded argv and passes a guarded one", () => {
  expect(hasUnguardedArgv('run(["git", "diff", "--no-color", ref]);')).toBe(true);
  expect(hasUnguardedArgv('run(["git", "diff", "--no-color", `${ref}..HEAD`]);')).toBe(true);
  expect(hasUnguardedArgv('run(["git", "diff", "--no-color", ...revisionOperand(ref)]);')).toBe(false);
  expect(hasUnguardedArgv('run(["git", "diff", "--no-color", "--end-of-options", ref]);')).toBe(false);
  expect(hasUnguardedArgv('run(["git", "diff", "--no-color", "HEAD"]);')).toBe(false);
});
