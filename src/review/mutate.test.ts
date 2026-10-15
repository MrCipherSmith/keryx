import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaselineError, EVIDENCE_DIR, MUTANTS_SPEC, type MutantResult, type MutationRecord, parseMutantSpec, pendingMutants, renderMutationTable, runMutation, SCRATCH_DIR, writeMutationEvidence } from "./mutate";

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
