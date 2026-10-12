import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVIDENCE_DIR, MUTANTS_SPEC, parseMutantSpec, pendingMutants, renderMutationTable, runMutation, writeMutationEvidence } from "./mutate";

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
