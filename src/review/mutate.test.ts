import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { BaselineError, doneMutantIds, EVIDENCE_DIR, MUTANTS_SPEC, type MutantResult, type MutationRecord, parseMutantSpec, pendingMutants, renderMutationTable, runMutation, SCRATCH_DIR, unjudgedMutants, withBail, worktreeProvenance, writeMutationEvidence } from "./mutate";

let base: string;
let tree: string;
let scratch: string;

const CALC = 'exports.add = (a, b) => a + b;\nexports.label = (n) => (n > 0 ? "pos" : "neg");\n';
const CHECK = 'const c = require("./calc");\nif (c.add(2, 3) !== 5 || c.label(1) !== "pos") process.exit(1);\n';

async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else hash.update(`${path.relative(dir, full)}\0`).update(await readFile(full));
    }
  };
  await walk(dir);
  return hash.digest("hex");
}

const command = () => `"${process.execPath}" check.js`;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "keryx-mutate-test-"));
  tree = path.join(base, "worktree");
  scratch = path.join(base, "scratch");
  await mkdir(tree, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(tree, "calc.js"), CALC);
  await writeFile(path.join(tree, "check.js"), CHECK);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("runMutation", () => {
  test("kills the pinned change, lets the unpinned one survive, and leaves the original tree byte-identical", async () => {
    const before = await hashTree(tree);
    const record = await runMutation({
      worktree: tree,
      command: command(),
      scratchRoot: scratch,
      mutants: parseMutantSpec([
        { id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" },
        { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" },
      ]),
    });
    expect(record.mutants.map((m) => [m.id, m.status, m.line])).toEqual([
      ["A", "killed", 1],
      ["B", "survived", 2],
    ]);
    expect(record.totals).toEqual({ killed: 1, survived: 1, invalid: 0, timeout: 0 });
    expect(await hashTree(tree)).toBe(before);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("every row names the test command and the exit code it was judged by, in the record and in the table", async () => {
    const record = await runMutation({
      worktree: tree,
      command: command(),
      scratchRoot: scratch,
      mutants: parseMutantSpec([
        { id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" },
        { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" },
        { id: "C", file: "calc.js", anchor: "no such text", replacement: "x" },
      ]),
    });
    expect(record.mutants.map((m) => [m.id, m.command, m.exitCode])).toEqual([
      ["A", command(), 1],
      ["B", command(), 0],
      ["C", command(), undefined],
    ]);
    const rows = renderMutationTable(record).split("\n").filter((line) => /^\| [ABC] \|/.test(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("killed");
    expect(rows[0]).toContain("| 1 |");
    expect(rows[1]).toContain("survived");
    expect(rows[1]).toContain("| 0 |");
    expect(rows[2]).toContain("anchor not found");
    for (const row of rows) expect(row).toContain("check.js");
  });

  test("an anchor that is missing, ambiguous, outside the tree or behind a link is invalid and never run", async () => {
    await writeFile(path.join(base, "outside.js"), "x\n");
    await symlink(path.join(base, "outside.js"), path.join(tree, "link.js"));
    const record = await runMutation({
      worktree: tree,
      command: command(),
      scratchRoot: scratch,
      mutants: parseMutantSpec([
        { id: "gone", file: "calc.js", anchor: "no such text", replacement: "x" },
        { id: "twice", file: "calc.js", anchor: "exports.", replacement: "module." },
        { id: "escape", file: "../outside.js", anchor: "x", replacement: "y" },
        { id: "link", file: "link.js", anchor: "x", replacement: "y" },
      ]),
    });
    expect(record.mutants.map((m) => [m.id, m.status])).toEqual([
      ["gone", "invalid"],
      ["twice", "invalid"],
      ["escape", "invalid"],
      ["link", "invalid"],
    ]);
    expect(await readFile(path.join(base, "outside.js"), "utf8")).toBe("x\n");
  });

  test("a red baseline stops the run before any mutant, and the scratch copy is still removed", async () => {
    await writeFile(path.join(tree, "check.js"), "process.exit(1);\n");
    await expect(
      runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]) }),
    ).rejects.toThrow("baseline");
    expect(await readdir(scratch)).toEqual([]);
  });

  test("the scratch copy lives inside the repository by default, is not copied into itself, and is removed afterwards", async () => {
    const out = path.join(base, "cwd.txt");
    await writeFile(path.join(tree, "where.js"), `require("fs").writeFileSync(${JSON.stringify(out)}, process.cwd()); require("./check.js");\n`);
    const spec = parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]);
    const record = await runMutation({ worktree: tree, command: `"${process.execPath}" where.js`, mutants: spec });
    const cwd = await readFile(out, "utf8");
    const root = await realpath(tree);
    expect(cwd.startsWith(`${root}${path.sep}.metaproject${path.sep}data${path.sep}review${path.sep}mutate-scratch${path.sep}`)).toBe(true);
    expect(record.mutants[0]?.status).toBe("killed");
    expect(await readdir(path.join(tree, SCRATCH_DIR))).toEqual([]);

    // A second run starts from a tree that now holds the (empty) scratch directory; it must not copy it in.
    await runMutation({ worktree: tree, command: `"${process.execPath}" where.js`, mutants: spec });
    expect(await readdir(path.join(tree, SCRATCH_DIR))).toEqual([]);
  });

  test("--scratch tmp keeps the old location in the OS temp dir", async () => {
    const out = path.join(base, "cwd.txt");
    await writeFile(path.join(tree, "where.js"), `require("fs").writeFileSync(${JSON.stringify(out)}, process.cwd()); require("./check.js");\n`);
    await runMutation({ worktree: tree, command: `"${process.execPath}" where.js`, scratch: "tmp", mutants: parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]) });
    expect((await readFile(out, "utf8")).startsWith(await realpath(tmpdir()))).toBe(true);
    expect(existsSync(path.join(tree, SCRATCH_DIR))).toBe(false);
  });

  test("a failing baseline reports its command, cwd and the last 60 output lines, and the same tail goes into the evidence", async () => {
    await writeFile(path.join(tree, "check.js"), 'for (let i = 1; i <= 100; i++) console.log("out line " + i);\nconsole.error("boom on stderr");\nprocess.exit(3);\n');
    const error = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaselineError);
    const message = (error as BaselineError).message;
    expect(message).toContain("exited 3");
    expect(message).toContain(`baseline command: ${command()}`);
    expect(message).toContain("baseline cwd: ");
    expect(message).toContain("boom on stderr");
    expect(message).toContain("out line 100");
    expect(message).toContain("out line 42");
    expect(message).not.toContain("out line 41\n");
    expect(await readdir(scratch)).toEqual([]);

    const record = (error as BaselineError).record;
    expect(record.baseline.tail).toContain("boom on stderr");
    const written = await writeMutationEvidence(path.join(base, "pkg"), record);
    expect(path.basename(written.json)).toBe("mutation-baseline-1.json");
    expect(path.basename((await writeMutationEvidence(path.join(base, "pkg"), record)).json)).toBe("mutation-baseline-2.json");
    expect((await readdir(path.join(base, "pkg", EVIDENCE_DIR))).some((n) => /^mutation-\d+\./.test(n))).toBe(false);
    expect(await readFile(written.md, "utf8")).toContain("out line 100");
    expect(JSON.parse(await readFile(written.json, "utf8")).baseline.tail).toContain("boom on stderr");
  });

  test("git run by the tests does not resolve to the real repository above the scratch copy", async () => {
    const init = Bun.spawn(["git", "init", "-q", tree], { stdout: "ignore", stderr: "ignore" });
    expect(await init.exited).toBe(0);
    const out = path.join(base, "toplevel.txt");
    await writeFile(path.join(tree, "where.js"), `const r = require("child_process").spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });\nrequire("fs").writeFileSync(${JSON.stringify(out)}, r.status + ":" + r.stdout);\nrequire("./check.js");\n`);
    const spec = parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]);
    // A GIT_DIR from a git hook must not reach the test run and point git back at the real repository.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tree, ".git");
    try {
      await runMutation({ worktree: tree, command: `"${process.execPath}" where.js`, mutants: spec });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    const seen = await readFile(out, "utf8");
    expect(seen.startsWith("0:")).toBe(false);
    expect(seen).not.toContain(await realpath(tree));
  });

  test("a SIGTERM during a run removes the scratch copy", async () => {
    const hold = path.join(base, "started");
    const pidFile = path.join(base, "pid");
    await writeFile(path.join(tree, "hang.js"), `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require("fs").writeFileSync(${JSON.stringify(hold)}, "x"); setTimeout(() => {}, 60000);\n`);
    const driver = path.join(base, "driver.ts");
    await writeFile(driver, `import { runMutation, parseMutantSpec } from ${JSON.stringify(path.resolve(import.meta.dir, "mutate.ts"))};\nawait runMutation({ worktree: ${JSON.stringify(tree)}, command: ${JSON.stringify(`"${process.execPath}" hang.js`)}, scratchRoot: ${JSON.stringify(scratch)}, mutants: parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]) });\n`);
    const child = Bun.spawn([process.execPath, driver], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 200 && !existsSync(hold); i++) await Bun.sleep(50);
    expect(existsSync(hold)).toBe(true);
    expect((await readdir(scratch)).length).toBe(1);
    child.kill("SIGTERM");
    await child.exited;
    expect(await readdir(scratch)).toEqual([]);
    // The test suite the run spawned dies with it; it is not left running as an orphan.
    const testPid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(testPid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);

  test("a mutant that hangs is a timeout, not a survivor", async () => {
    await writeFile(path.join(tree, "check.js"), 'const c = require("./calc");\nif (c.add(2, 3) !== 5) while (true) {}\n');
    const record = await runMutation({
      worktree: tree,
      command: command(),
      scratchRoot: scratch,
      timeoutMs: 3000,
      mutants: parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]),
    });
    expect(record.mutants[0]!.status).toBe("timeout");
  });
});

describe("parseMutantSpec", () => {
  test("refuses an empty spec, a duplicate id and a no-op replacement", () => {
    expect(() => parseMutantSpec([])).toThrow("non-empty");
    expect(() => parseMutantSpec([{ id: "A", file: "f", anchor: "x", replacement: "y" }, { id: "A", file: "f", anchor: "x", replacement: "z" }])).toThrow("twice");
    expect(() => parseMutantSpec([{ id: "A", file: "f", anchor: "x", replacement: "x" }])).toThrow("nothing changes");
  });
});

describe("renderMutationTable", () => {
  const mutant = (over: Partial<MutantResult>): MutantResult => ({ id: "A", file: "f.ts", anchor: "x", replacement: "y", status: "killed", command: "bun test f.test.ts", exitCode: 1, ms: 1, ...over });
  const record = (mutants: MutantResult[]): MutationRecord => ({
    schemaVersion: 1,
    worktree: "/w",
    command: "bun test f.test.ts",
    baseline: { exitCode: 0, ms: 1 },
    mutants,
    totals: { killed: 0, survived: 0, invalid: 0, timeout: 0 },
  });

  test("the header names the Test command and Exit columns", () => {
    const lines = renderMutationTable(record([mutant({})])).split("\n");
    expect(lines).toContain("| Mutant | Where | Change | Result | Test command | Exit |");
    expect(lines).toContain("|---|---|---|---|---|---|");
  });

  test("a row that never ran shows - as its exit code, and a row that ran shows the code", () => {
    const rows = renderMutationTable(record([mutant({ id: "A", exitCode: 3 }), mutant({ id: "B", status: "invalid", reason: "anchor not found", exitCode: undefined })]))
      .split("\n")
      .filter((line) => /^\| [AB] \|/.test(line));
    expect(rows[0]!.endsWith("| 3 |")).toBe(true);
    expect(rows[1]!.endsWith("| - |")).toBe(true);
  });

  test("a pipe in the command cell is escaped so the row keeps six cells", () => {
    const row = renderMutationTable(record([mutant({ command: "bun test a || bun test b" })])).split("\n").find((line) => line.startsWith("| A |"))!;
    expect(row).toContain("`bun test a \\|\\| bun test b`");
    expect(row.replace(/\\\|/g, "").split("|").length).toBe(8);
  });

  test("a backtick or a carriage return in a cell cannot end the code span or the row", () => {
    const row = renderMutationTable(record([mutant({ command: "echo `id`\rbun test", anchor: "a`b" })])).split("\n").find((line) => line.startsWith("| A |"))!;
    expect(row).toContain("`echo 'id' bun test`");
    expect(row).toContain("`a'b`");
    expect(row).not.toContain("\r");
    expect(row.split("`").length - 1).toBe(6);
  });

  test("a record written before rows carried a command falls back to the record's command", () => {
    const old = mutant({});
    delete old.command;
    const row = renderMutationTable(record([old])).split("\n").find((line) => line.startsWith("| A |"))!;
    expect(row).toContain("`bun test f.test.ts`");
  });

  test("the header of a new record states the bail, the copy and mutant time, the load, and what was judged", () => {
    const text = renderMutationTable({
      ...record([mutant({})]),
      bail: true,
      copyMs: 1234,
      mutantsMs: 56789,
      loadavg: [3.14, 2.8, 2.5],
      startedAt: "2026-10-24T05:00:00.000Z",
      head: "0123456789abcdef0123",
      treeHash: "fedcba9876543210fedcba",
    });
    const lines = text.split("\n");
    expect(lines).toContain("Bail: applied (mutants ran with --bail; baseline in full).");
    expect(lines).toContain("Cost: copy 1234 ms, mutants 56789 ms, load 3.1/2.8/2.5.");
    expect(lines).toContain("started 2026-10-24T05:00:00.000Z, head 0123456789ab, treeHash fedcba987654.");
    expect(text).not.toContain("undefined");
  });

  test("a new record without a bail has no Bail line", () => {
    const text = renderMutationTable({ ...record([mutant({})]), copyMs: 1, mutantsMs: 2, loadavg: [0, 0, 0] });
    expect(text).not.toContain("Bail:");
    expect(text).toContain("Cost: copy 1 ms, mutants 2 ms, load 0.0/0.0/0.0.");
  });
});

describe("withBail", () => {
  test("puts --bail right after bun test, behind env and NAME=value prefixes too", () => {
    expect(withBail("bun test src/a.test.ts src/b.test.ts")).toBe("bun test --bail src/a.test.ts src/b.test.ts");
    expect(withBail("bun test")).toBe("bun test --bail");
    expect(withBail("bun test --timeout 20000 src/a.test.ts")).toBe("bun test --bail --timeout 20000 src/a.test.ts");
    expect(withBail("bun   test  -t name@v1.2,x src/a.test.ts")).toBe("bun test --bail -t name@v1.2,x src/a.test.ts");
    expect(withBail("FOO=1 BAR=a/b:c,d bun test src/a.test.ts")).toBe("FOO=1 BAR=a/b:c,d bun test --bail src/a.test.ts");
    expect(withBail("env CI=true bun test src/a.test.ts")).toBe("env CI=true bun test --bail src/a.test.ts");
    expect(withBail("env bun test x")).toBe("env bun test --bail x");
  });

  test("returns undefined for any other tool, for a command with a shell metacharacter, and when --bail is already there", () => {
    const rejected = [
      "",
      "   ",
      "sh run.sh",
      "bunx vitest",
      "bun x test",
      "npm test",
      "bun run test",
      "bun",
      "node bun test",
      "bun testx a.test.ts",
      "env -i bun test a",
      "bun test --bail a.test.ts",
      "bun test a.test.ts --bail",
      "bun test --bail=2 a.test.ts",
      'bun test "a b.test.ts"',
      "bun test 'a.test.ts'",
      "bun test $FILE",
      "bun test `ls`",
      "bun test $(ls)",
      "bun test a; echo hi",
      "bun test a && bun test b",
      "bun test a & ",
      "bun test a | tee out",
      "bun test a > out",
      "bun test < in",
      "bun test src/*.test.ts",
      "bun test src/?.test.ts",
      "bun test src/[ab].test.ts",
      "bun test a\\ b",
      "bun test a\nbun test b",
      "bun test a\tb",
      "bun test (a)",
      "bun test {a,b}",
      "bun test ~/a",
      "bun test !a",
      "bun test a #c",
      "FOO=$X bun test a",
      'FOO="a b" bun test a',
      "cd x && bun test a",
    ];
    for (const command of rejected) expect([command, withBail(command)]).toEqual([command, undefined]);
  });
});

describe("bun fixture", () => {
  const TEST_CMD = "bun test";
  let proj: string;

  beforeEach(async () => {
    proj = path.join(base, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "calc.ts"), 'export const add = (a: number, b: number) => a + b;\nexport const label = (n: number) => (n > 0 ? "pos" : "neg");\nexport const spin = (n: number) => n;\n');
    await writeFile(path.join(proj, "a.test.ts"), 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\ntest("add", () => expect(add(2, 3)).toBe(5));\n');
    await writeFile(path.join(proj, "b.test.ts"), 'import { expect, test } from "bun:test";\nimport { add, label } from "./calc";\ntest("label", () => expect(label(1)).toBe("pos"));\ntest("add again", () => expect(add(1, 1)).toBe(2));\n');
    await writeFile(path.join(proj, "c.test.ts"), 'import { test } from "bun:test";\nimport { spin } from "./calc";\ntest("spin", () => {\n  if (spin(1) !== 1) while (true) {}\n});\n');
  });

  const specs = () =>
    parseMutantSpec([
      { id: "kill", file: "calc.ts", anchor: "a + b", replacement: "a - b" },
      { id: "both", file: "calc.ts", anchor: "a + b", replacement: "0" },
      { id: "live", file: "calc.ts", anchor: "n > 0", replacement: "n >= 0" },
      { id: "hang", file: "calc.ts", anchor: "spin = (n: number) => n;", replacement: "spin = (n: number) => n + 1;" },
      { id: "bad", file: "calc.ts", anchor: "no such text", replacement: "x" },
    ]);
  const statuses = (record: MutationRecord) => record.mutants.map((m) => [m.id, m.status]);
  const run = (extra: { bail?: boolean; command?: string; worktree?: string } = {}) => runMutation({ worktree: proj, command: TEST_CMD, scratchRoot: scratch, timeoutMs: 8000, mutants: specs(), ...extra });

  describe("bail applied", () => {
    test("the mutants run with --bail, the baseline and the record keep the command as given, and the record says so", async () => {
      const record = await run();
      expect(record.bail).toBe(true);
      expect(record.command).toBe(TEST_CMD);
      expect(record.mutants.length).toBe(5);
      for (const m of record.mutants) expect(m.command).toBe("bun test --bail");
    }, 90_000);

    test("a command withBail rejects runs unchanged and leaves bail unset", async () => {
      await writeFile(path.join(proj, "run.sh"), `${process.execPath} test\n`);
      const record = await run({ command: "sh run.sh" });
      expect(record.bail).toBeUndefined();
      expect("bail" in record).toBe(false);
      expect(record.command).toBe("sh run.sh");
      for (const m of record.mutants) expect(m.command).toBe("sh run.sh");
      expect(statuses(record)).toEqual([["kill", "killed"], ["both", "killed"], ["live", "survived"], ["hang", "timeout"], ["bad", "invalid"]]);
    }, 90_000);
  });

  describe("bail status parity", () => {
    test("killed, survived, timeout and invalid keep their status with and without --bail on a project with several test files", async () => {
      const bailed = await run();
      const full = await run({ bail: false });
      expect(statuses(bailed)).toEqual([["kill", "killed"], ["both", "killed"], ["live", "survived"], ["hang", "timeout"], ["bad", "invalid"]]);
      expect(statuses(full)).toEqual(statuses(bailed));
      expect(bailed.totals).toEqual({ killed: 2, survived: 1, invalid: 1, timeout: 1 });
    }, 90_000);
  });

  describe("no-bail", () => {
    test("runMutation({ bail: false }) runs the original command and writes no bail field", async () => {
      const record = await run({ bail: false });
      expect("bail" in record).toBe(false);
      for (const m of record.mutants) expect(m.command).toBe(TEST_CMD);
    }, 90_000);

    test("--no-bail is accepted by the mutate flag allowlist, switches the bail off, and an unknown flag is still refused", async () => {
      const pkg = path.join(base, "pkg");
      await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
      await writeFile(path.join(pkg, EVIDENCE_DIR, MUTANTS_SPEC), JSON.stringify({ mutants: [{ id: "kill", file: "calc.ts", anchor: "a + b", replacement: "a - b" }] }));
      const flags = ["--test", TEST_CMD, "--package", pkg, "--worktree", proj, "--json"];
      const output = async (extra: string[]): Promise<{ bail?: boolean; mutants: { command: string }[] }> => {
        const saved = console.log;
        let printed = "";
        console.log = (...parts: unknown[]) => void (printed += parts.join(" "));
        try {
          await reviewCommand(["mutate", ...flags, ...extra]);
        } finally {
          console.log = saved;
        }
        return JSON.parse(printed);
      };
      const off = await output(["--no-bail"]);
      expect("bail" in off).toBe(false);
      expect(off.mutants[0]!.command).toBe(TEST_CMD);
      const on = await output([]);
      expect(on.bail).toBe(true);
      expect(on.mutants[0]!.command).toBe("bun test --bail");
      const logError = console.error;
      const errors: string[] = [];
      console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
      try {
        process.exitCode = 0;
        await reviewCommand(["mutate", ...flags, "--no-bial"]);
        expect(process.exitCode).toBe(1);
      } finally {
        console.error = logError;
        process.exitCode = 0;
      }
      expect(errors.join("\n")).toContain("Unknown option for `keryx review mutate`: --no-bial");
    }, 90_000);
  });
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return out.trim();
}

async function gitCommit(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
}

describe("provenance", () => {
  const specs = () => parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }, { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" }]);

  test("a record from a git checkout carries the time, load, copy and mutant time, the commit and the tree hash", async () => {
    await gitCommit(tree);
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: specs() });
    expect(new Date(record.startedAt!).toISOString()).toBe(record.startedAt!);
    expect(record.loadavg).toHaveLength(3);
    for (const n of record.loadavg!) expect(typeof n).toBe("number");
    expect(record.copyMs).toBeGreaterThanOrEqual(0);
    expect(record.mutantsMs).toBe(record.mutants.reduce((sum, m) => sum + m.ms, 0));
    expect(record.head).toBe(await git(tree, "rev-parse", "HEAD"));
    expect(record.treeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.schemaVersion).toBe(1);
  });

  test("outside git head and treeHash are absent and the pass still succeeds", async () => {
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: specs() });
    expect(record.mutants.map((m) => m.status)).toEqual(["killed", "survived"]);
    expect("head" in record).toBe(false);
    expect("treeHash" in record).toBe(false);
    expect(record.startedAt).toBeDefined();
    expect(record.copyMs).toBeDefined();
    expect(await worktreeProvenance(tree)).toEqual({});
  });

  test("a repository with no commit has no head and no treeHash", async () => {
    await git(tree, "init", "-q");
    expect(await worktreeProvenance(tree)).toEqual({});
  });
});

describe("treeHash", () => {
  beforeEach(async () => {
    await writeFile(path.join(tree, ".gitignore"), "ignored.txt\n");
    await gitCommit(tree);
  });

  const hashOf = async () => (await worktreeProvenance(tree)).treeHash;

  test("is identical for an unchanged worktree, also across two real passes with the default scratch directory", async () => {
    const first = await hashOf();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOf()).toBe(first);
    const spec = parseMutantSpec([{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" }]);
    const one = await runMutation({ worktree: tree, command: command(), mutants: spec });
    const two = await runMutation({ worktree: tree, command: command(), mutants: spec });
    expect(one.treeHash).toBe(first!);
    expect(two.treeHash).toBe(first!);
  });

  test("differs after a tracked file changes and after an untracked non-ignored file appears", async () => {
    const clean = await hashOf();
    await writeFile(path.join(tree, "calc.js"), `${CALC}// edit\n`);
    const edited = await hashOf();
    expect(edited).not.toBe(clean);
    await writeFile(path.join(tree, "new.txt"), "one");
    const untracked = await hashOf();
    expect(untracked).not.toBe(edited);
    await writeFile(path.join(tree, "new.txt"), "two");
    expect(await hashOf()).not.toBe(untracked);
  });

  test("ignores a gitignored file", async () => {
    const clean = await hashOf();
    await writeFile(path.join(tree, "ignored.txt"), "noise");
    expect(await hashOf()).toBe(clean);
  });
});

describe("legacy record", () => {
  test("is still read by doneMutantIds, unjudgedMutants and pendingMutants, and rendered with no bail, cost or provenance line", async () => {
    const pkg = path.join(base, "pkg");
    await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
    const specs = [
      { id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" },
      { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" },
    ];
    await writeFile(path.join(pkg, EVIDENCE_DIR, MUTANTS_SPEC), JSON.stringify({ mutants: specs }));
    const legacy: MutationRecord = {
      schemaVersion: 1,
      worktree: "/w",
      command: "bun test f.test.ts",
      baseline: { exitCode: 0, ms: 7 },
      mutants: [{ id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b", status: "killed", exitCode: 1, ms: 5 }],
      totals: { killed: 1, survived: 0, invalid: 0, timeout: 0 },
    };
    await writeFile(path.join(pkg, EVIDENCE_DIR, "mutation-1.json"), JSON.stringify(legacy));
    expect([...(await doneMutantIds(pkg))]).toEqual(["A"]);
    expect((await unjudgedMutants(pkg, parseMutantSpec(specs))).map((m) => m.id)).toEqual(["B"]);
    expect((await pendingMutants(pkg)).map((m) => m.id)).toEqual(["B"]);

    const text = renderMutationTable(legacy);
    expect(text).not.toMatch(/Bail|Cost|started|treeHash|head |undefined/);
    expect(text).not.toContain("\n\n\n");
    expect(text.split("\n").slice(0, 5)).toEqual([
      "# Mutation pass",
      "",
      "Command: `bun test f.test.ts` (baseline exit 0, 7 ms). Run in a scratch copy; the worktree was not written.",
      "",
      "Killed 1, survived 0, timeout 0, invalid 0.",
    ]);
  });
});

describe("evidence", () => {
  test("the table and the record land in research-evidence, and run mutants stop being pending", async () => {
    const pkg = path.join(base, "pkg");
    await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
    const specs = [
      { id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" },
      { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" },
      { id: "C", file: "calc.js", anchor: 'n > 0 ? "pos"', replacement: 'n > 0 ? "neg"' },
    ];
    await writeFile(path.join(pkg, EVIDENCE_DIR, MUTANTS_SPEC), JSON.stringify({ mutants: specs }));
    expect((await pendingMutants(pkg)).map((m) => m.id)).toEqual(["A", "B", "C"]);

    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: parseMutantSpec(specs.slice(0, 2)) });
    const written = await writeMutationEvidence(pkg, record);
    expect(path.basename(written.json)).toBe("mutation-1.json");
    expect(await readFile(written.md, "utf8")).toContain("| B | calc.js:2 |");
    expect(renderMutationTable(record)).toContain("survived 1");
    expect((await pendingMutants(pkg)).map((m) => m.id)).toEqual(["C"]);
    expect(path.basename((await writeMutationEvidence(pkg, record)).json)).toBe("mutation-2.json");
  });
});
