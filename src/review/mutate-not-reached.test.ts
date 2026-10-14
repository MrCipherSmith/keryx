import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVIDENCE_DIR, MUTANTS_SPEC, parseMutantSpec, pendingMutants, renderMutationTable, runMutation, unjudgedMutants, writeMutationEvidence } from "./mutate";
import { coverageErrors } from "./coverage";

let base: string;
let tree: string;
let scratch: string;

const CALC = 'exports.add = (a, b) => a + b;\nexports.label = (n) => (n > 0 ? "pos" : "neg");\nexports.neg = (a) => -a;\n';
const CHECK = 'const c = require("./calc");\nif (c.add(2, 3) !== 5 || c.label(1) !== "pos" || c.neg(2) !== -2) process.exit(1);\n';
const command = () => `"${process.execPath}" check.js`;
const SPECS = [
  { id: "A", file: "calc.js", anchor: "a + b", replacement: "a - b" },
  { id: "B", file: "calc.js", anchor: "n > 0", replacement: "n >= 0" },
  { id: "C", file: "calc.js", anchor: "-a", replacement: "a" },
];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "keryx-mutate-cap-"));
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

describe("a capped mutation pass", () => {
  test("records the cap and how many candidates it never reached, and runs only the first ones", async () => {
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 2, mutants: parseMutantSpec(SPECS) });
    expect(record.mutants.map((m) => m.id)).toEqual(["A", "B"]);
    expect(record.cap).toBe(2);
    expect(record.not_reached).toBe(1);
  });

  test("the table and the report path print `Not run: N candidates` only when some were not reached", async () => {
    const capped = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 1, mutants: parseMutantSpec(SPECS) });
    expect(renderMutationTable(capped)).toContain("Not run: 2 candidates");
    const written = await writeMutationEvidence(path.join(base, "pkg"), capped);
    expect(await Bun.file(written.md).text()).toContain("Not run: 2 candidates");

    const full = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 3, mutants: parseMutantSpec(SPECS) });
    expect(full.not_reached).toBe(0);
    expect(renderMutationTable(full)).not.toContain("Not run");
  });

  test("a candidate the cap left out is still pending, and a pending candidate still blocks the coverage gate", async () => {
    const pkg = path.join(base, "pkg");
    await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
    await writeFile(path.join(pkg, EVIDENCE_DIR, MUTANTS_SPEC), JSON.stringify({ mutants: SPECS }));
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 2, mutants: parseMutantSpec(SPECS) });
    await writeMutationEvidence(pkg, record);
    const pending = await pendingMutants(pkg);
    expect(pending.map((m) => m.id)).toEqual(["C"]);
    const errors = await coverageErrors({ reviewers: [] } as never, { root: base, files: [], pendingMutants: pending.length });
    expect(errors.join("\n")).toMatch(/mutan/i);
  });

  test("without a cap the record and the table are what they were: no cap, no not_reached, no Not run line", async () => {
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, mutants: parseMutantSpec(SPECS) });
    expect("cap" in record).toBe(false);
    expect("not_reached" in record).toBe(false);
    expect(record.mutants).toHaveLength(3);
    expect(renderMutationTable(record)).not.toContain("Not run");
  });

  test("a cap of zero runs nothing and reports every candidate as not reached", async () => {
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 0, mutants: parseMutantSpec(SPECS) });
    expect(record.mutants).toEqual([]);
    expect(record.not_reached).toBe(3);
  });

  test("a second capped pass takes the next pending candidates instead of re-running the first ones", async () => {
    const pkg = path.join(base, "pkg");
    await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
    const specs = parseMutantSpec([...SPECS, { id: "D", file: "calc.js", anchor: "exports.neg", replacement: "exports.neg2" }, { id: "E", file: "calc.js", anchor: "\"neg\"", replacement: "\"nope\"" }, { id: "F", file: "calc.js", anchor: "\"pos\"", replacement: "\"nop\"" }]);
    const first = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 3, mutants: await unjudgedMutants(pkg, specs) });
    await writeMutationEvidence(pkg, first);
    expect(first.mutants.map((m) => m.id)).toEqual(["A", "B", "C"]);
    const second = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 3, mutants: await unjudgedMutants(pkg, specs) });
    expect(second.mutants.map((m) => m.id)).toEqual(["D", "E", "F"]);
    expect(second.not_reached).toBe(0);
  });

  test("an invalid candidate does not use up the cap and counts as not reached, as the gate counts it pending", async () => {
    const pkg = path.join(base, "pkg");
    await mkdir(path.join(pkg, EVIDENCE_DIR), { recursive: true });
    const specs = parseMutantSpec([{ id: "X", file: "calc.js", anchor: "no such text", replacement: "y" }, ...SPECS]);
    await writeFile(path.join(pkg, EVIDENCE_DIR, MUTANTS_SPEC), JSON.stringify({ mutants: specs }));
    const record = await runMutation({ worktree: tree, command: command(), scratchRoot: scratch, cap: 2, mutants: specs });
    expect(record.mutants.map((m) => `${m.id}:${m.status}`)).toEqual(["X:invalid", "A:killed", "B:survived"]);
    expect(record.not_reached).toBe(2);
    await writeMutationEvidence(pkg, record);
    expect((await pendingMutants(pkg)).length).toBe(record.not_reached);
  });
});
