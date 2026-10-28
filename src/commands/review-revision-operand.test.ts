// Flow 441 F-045: a revision typed after --ref, --base, --diff or --since reaches git as a revision, never as an option. Run through the
// real CLI in a scratch repository: before the fix `--ref=--output=<file>` made `git diff` write that file.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGitRevision, assertNoWritingDiffOption, revisionOperand } from "../lib/git-revision";
import { checkGraphStaleness } from "../gdgraph/staleness";
import { diffSince } from "../sync/diff";
import { readProvenance } from "../sync/provenance";
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

test("F-068: wiki freshness refuses a dash-leading --since by name and writes no file", () => {
  const result = run("wiki", "freshness", `--since=--output=${outside}`);
  expect(existsSync(outside)).toBe(false);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Refusing the revision");
}, 60_000);

test("F-069: wiki collect --changed with a dash-leading --since writes no file", () => {
  const result = run("wiki", "collect", "--changed", `--since=--output=${outside}`);
  expect(existsSync(outside)).toBe(false);
  expect(result.output).not.toContain("Refusing the git diff option");
}, 60_000);

test("F-067: a provenance file whose commit reads as an option is treated as absent and writes no file", async () => {
  const provenance = path.join(repo, ".metaproject", "data", "gdgraph", ".provenance.json");
  const nodes = path.join(repo, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  mkdirSync(path.dirname(nodes), { recursive: true });
  writeFileSync(nodes, "");
  writeFileSync(provenance, JSON.stringify({ commit: `--output=${outside}`, branch: "main", builtAt: "2026-01-01T00:00:00Z" }));
  try {
    expect(await readProvenance(repo, "gdgraph")).toBeNull();
    const check = await checkGraphStaleness(repo);
    expect(check.status).not.toBe("fresh");
    expect(existsSync(outside)).toBe(false);
    writeFileSync(provenance, JSON.stringify({ commit: "0123abcd", branch: "main", builtAt: "2026-01-01T00:00:00Z" }));
    expect((await readProvenance(repo, "gdgraph"))?.commit).toBe("0123abcd");
  } finally {
    rmSync(path.join(repo, ".metaproject", "data"), { recursive: true, force: true });
  }
});

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
}, 60_000);

test("F-045: a real revision still slices the diff", () => {
  const result = run("review", "slice", "--ref=HEAD", "--json");
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("a.ts");
}, 60_000);

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

// Every git argv built in a non-test source file from a value the file did not write must route that value through
// `revisionOperand` / `--end-of-options`, or its file is listed here with the number of such call sites and the reason their
// operands cannot be a typed option. The count is per call site: a new unguarded argv in a listed file fails the scan.
const VERBS = [
  "diff", "merge-base", "log", "show", "rev-list", "diff-tree", "name-rev", "rev-parse", "cat-file", "ls-tree", "blame",
  "worktree", "checkout", "switch", "fetch", "reset", "merge", "rebase", "cherry-pick", "describe", "format-patch", "archive",
  "for-each-ref", "ls-remote", "show-ref", "restore", "branch", "tag",
];

const ALLOWED: Readonly<Record<string, readonly [sites: number, reason: string]>> = {
  "commands/agent.ts": [1, "a word list, not git"],
  "commands/ctx.ts": [1, "ctx diff runs assertNoWritingDiffOption first; base comes from defaultDiffBase"],
  "commands/research-sync.ts": [1, "git archive writes keryx's own temp file; the revision is the literal HEAD"],
  "commands/review-jev-comments.ts": [1, "ref defaults to HEAD; no caller passes a typed value"],
  "commands/review-jev-edit-guard.ts": [2, "HEAD followed by --, or --no-index with fixed paths"],
  "commands/trigger-dispatch.ts": [5, "operand is refs/heads/<branch>, never dash-leading"],
  "decisions/blind.ts": [2, "a word list of blocked git subcommands, not git"],
  "flow/folder-committed.ts": [1, "HEAD, paths follow --"],
  "flow/remote-flows.ts": [1, "ref is built from a remote name git listed"],
  "flow/review-gate.ts": [2, "operands are shas read from the ledger"],
  "flow/service.ts": [3, "operands are recorded commits and origin/main"],
  "gdgraph/treesitter/extract.ts": [1, "a word list, not git"],
  "harness/child/git-worktree-port.ts": [2, "ref is the base commit the harness recorded, or HEAD; the path is a harness-made directory"],
  "harness/external/write-land.ts": [4, "operand is refs/heads/<branch>, never dash-leading"],
  "harness/external/write-run.ts": [3, "baseCommit is a sha the harness recorded"],
  "health/metrics/churn.ts": [1, "--since=<days> ago, a number"],
  "hub/connector.ts": [1, "rev-parse --git-path takes a state-file name from a constant list"],
  "lib/git-head.ts": [7, "operands are HEAD:<path> or follow --"],
  "lib/git-worktrees.ts": [1, "the remaining call reads the git common dir; no operand came from a person"],
  "lib/shell-permissions.ts": [1, "a word list of network commands, not git"],
  "metrics/provenance.ts": [1, "answerCommit is a recorded sha followed by ^{commit}, not typed"],
  "review/bot/run.ts": [1, "baseSha is the PR's base sha from the API"],
  "review/ci-triage.ts": [1, "operand is <sha>:<path> of a CI-reported commit"],
  "review/conform-pr-port.ts": [1, "gh, not git; the PR number is numeric"],
  "review/managed.ts": [1, "operand is <sha>:<path> of a recorded commit"],
  "rewind/restore.ts": [2, "operands are tree ids the snapshot recorded; the native preview's is 40-hex checked first and again by safeShadowArguments"],
  "rewind/snapshot.ts": [1, "operands are tree-ish ids the snapshot recorded"],
  "session/commands/analysis-read-ports.ts": [1, "a gh argv pattern table, not git; the operand is the /^[1-9]\\d{0,19}$/ identifier predicate"],
  "tui/jev-contract-command.ts": [1, "no revision operand"],
  "tui/jev-docs-command.ts": [1, "no revision operand"],
  "tui/jev-risk-command.ts": [1, "no revision operand"],
  "tui/jev-rules-command.ts": [1, "no revision operand"],
  "wiki/freshness/page-freshness.ts": [3, "verifiedAt is probed by cat-file -e (which fails on a dash-leading value) before log and diff run"],
  "wiki/freshness/run.ts": [2, "operands are <rev>:<path> after collectChanges passed rev through revisionOperand, or HEAD:<path>"],
};

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function enclosingArray(text: string, from: number): { begin: number; text: string } {
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
  return { begin, text: text.slice(begin, end + 1) };
}

/** Number of git argv arrays in `text` that carry a non-literal operand and no revisionOperand / --end-of-options. */
function unguardedArgvSites(text: string): number {
  const verbRe = new RegExp(`(?:\\[|,)\\s*"(${VERBS.join("|")})"\\s*,`, "g");
  const sites = new Set<number>();
  for (const match of text.matchAll(verbRe)) {
    const argv = enclosingArray(text, match.index ?? 0);
    if (argv.text.includes("--end-of-options") || argv.text.includes("revisionOperand")) continue;
    if (/[A-Za-z_`]/.test(argv.text.replace(/"(?:[^"\\$]|\\.)*"/g, '""').replace(/[[\],\s"]/g, ""))) sites.add(argv.begin);
  }
  return sites.size;
}

function unguardedGitArgvSites(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC, []).sort()) {
    const sites = unguardedArgvSites(readFileSync(file, "utf8"));
    if (sites > 0) found[path.relative(SRC, file).split(path.sep).join("/")] = sites;
  }
  return found;
}

test("no git argv takes a non-literal operand without revisionOperand or an entry in ALLOWED, site for site", () => {
  const found = unguardedGitArgvSites();
  const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, [sites]]) => [file, sites]));
  expect(found).toEqual(allowed);
});

test("the guard scan notices an unguarded argv and passes a guarded one", () => {
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", ref]);')).toBe(1);
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", `${ref}..HEAD`]);')).toBe(1);
  expect(unguardedArgvSites('run(["git", "worktree", "add", dir, ref]);')).toBe(1);
  expect(unguardedArgvSites('run(["git", "checkout", ref]);')).toBe(1);
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", ...revisionOperand(ref)]);')).toBe(0);
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", "--end-of-options", ref]);')).toBe(0);
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", "HEAD"]);')).toBe(0);
  expect(unguardedArgvSites('run(["git", "diff", a]); run(["git", "log", b]);')).toBe(2);
  expect(unguardedArgvSites('run(["git", "diff", "--no-color", ref]); run(["git", "log", "--end-of-options", b]);')).toBe(1);
});
