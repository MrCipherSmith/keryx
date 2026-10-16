import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordOperatorDecision } from "../review/operator-decisions";
import { coverageErrors, isAttendedRun, operatorDecisionSubject, requiredReviewers } from "../review/coverage";
import type { RawFile } from "../review/ledger";
import { pendingMutants } from "../review/mutate";
import { runCoverage } from "./review-chunks";
import { assignRawDispatch, definitionCandidates, isReviewerReply, loadRaws, parseSkips, readDrivers, runLedger } from "./review-ledger";
import { computeVerdict, renderVerdict } from "../review/verdict";

describe("driver files and raw replies (flow 430 AC3, AC4)", () => {
  test("a rule file is found under definition, skill_path, or either key inside payload", () => {
    expect(definitionCandidates({ definition: "a.md" })).toEqual(["a.md"]);
    expect(definitionCandidates({ skill_path: "b.md" })).toEqual(["b.md"]);
    expect(definitionCandidates({ payload: { skill_path: "c.md", definition: "d.md" } })).toEqual(["d.md", "c.md"]);
    expect(definitionCandidates({ definition: "", payload: {} })).toEqual([]);
  });

  test("readDrivers resolves a payload skill_path and still names a missing definition as no rule", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f430-"));
    try {
      await mkdir(path.join(root, "in", "drivers"), { recursive: true });
      await mkdir(path.join(root, "rules"), { recursive: true });
      await writeFile(path.join(root, "rules", "logic.md"), "# logic\n");
      const put = (name: string, body: object) => writeFile(path.join(root, "in", "drivers", name), JSON.stringify(body));
      await put("review-logic.json", { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt", payload: { skill_path: "rules/logic.md" } });
      await put("review-style.json", { reviewer: "review-style", slices: [{ id: "S2", status: "DONE" }], result: "raw/review-style.txt", definition: "rules/missing.md" });
      const drivers = await readDrivers(path.join(root, "in"), root);
      expect(drivers.ruleFiles).toEqual({ "review-logic": path.join("rules", "logic.md") });
      expect(drivers.payloadSlices).toEqual({ "review-logic": ["S1"], "review-style": ["S2"] });
      expect([...drivers.replies.files].sort()).toEqual(["review-logic.txt", "review-style.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const replies = { files: new Set(["review-logic.txt"]), reviewers: ["review-logic"] };

  test("a verification payload filed in raw/ is not a reviewer reply", () => {
    expect(isReviewerReply("verification.txt", '{"claims": []}', replies)).toBe(false);
  });

  test("a file holding REVIEW_RESULT, named by a driver, or named after a reviewer still is one", () => {
    expect(isReviewerReply("verification.txt", "REVIEW_RESULT: {}", replies)).toBe(true);
    expect(isReviewerReply("review-logic.txt", "no block here", replies)).toBe(true);
    expect(isReviewerReply("review-logic-retry.txt", "no block here", replies)).toBe(true);
    expect(isReviewerReply("review-logic.2.txt", "no block here", replies)).toBe(true);
  });
});

for (const [label, reviewer, slices, expected] of [
  ["ambiguous raw does not cover union", "reviewer", [["A"], ["B"]], []],
  ["unique dispatch assigns only its slices", "reviewer", [["B"]], ["B"]],
  ["other reviewer cannot assign reply", "other", [["A"]], undefined],
] as const) {
  test(label, () => {
    const raw: RawFile = { name: "raw/reviewer.txt", hash: "hash", mtimeMs: 1, empty: false,
      result: { reviewer: "reviewer", status: "DONE" } };
    const assignments = new Map<string, string[][]>([[`${reviewer}\0raw/reviewer.txt`, slices.map((s) => [...s])]]);
    assignRawDispatch([raw], assignments);
    expect(raw.assignedSlices).toEqual(expected === undefined ? undefined : [...expected]);
  });
}

describe("the close rule for a mutation pass (flow 428 AC5)", () => {
  const dispatch = { mode: "all", override: { operatorQuote: "fixture", reason: "fixture" } };
  const base = { root: "/nonexistent" };

  test("an attended review with proposed mutants nobody ran is refused", async () => {
    const errors = await coverageErrors(dispatch, { ...base, pendingMutants: 3, attended: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("3 proposed mutant(s)");
    expect(errors[0]).toContain("keryx review mutate");
  });

  test("a waiver carrying the operator's words lets it close", async () => {
    const waived = { ...dispatch, mutationWaiver: { operatorQuote: "не гоняй мутации, тесты не запускаются", reason: "suite needs a database" } };
    expect(await coverageErrors(waived, { ...base, pendingMutants: 3, attended: true })).toEqual([]);
    expect(await coverageErrors({ ...dispatch, mutationWaiver: { reason: "no quote" } }, { ...base, pendingMutants: 3, attended: true })).toHaveLength(1);
  });

  test("the unattended rule is unchanged: pending mutants do not block an autonomous run", async () => {
    expect(await coverageErrors(dispatch, { ...base, pendingMutants: 3, attended: false })).toEqual([]);
  });

  test("no pending mutants means nothing to refuse", async () => {
    expect(await coverageErrors(dispatch, { ...base, pendingMutants: 0, attended: true })).toEqual([]);
  });

  test("the autonomous runner's child shell is the only unattended process", () => {
    expect(isAttendedRun({})).toBe(true);
    expect(isAttendedRun({ KERYX_AUTONOMOUS_ANSWERS_FILE: "/tmp/answers.json" })).toBe(false);
  });

  test("pendingMutants counts only mutants no recorded pass ran, and a spec marked not runnable has none", async () => {
    const pkg = await mkdtemp(path.join(tmpdir(), "keryx-ac5-"));
    try {
      await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
      const spec = (extra: object) => writeFile(path.join(pkg, "research-evidence", "mutants.json"), JSON.stringify({ ...extra, mutants: [{ id: "A", file: "f.ts", anchor: "x", replacement: "y" }] }));
      await spec({});
      expect(await pendingMutants(pkg)).toHaveLength(1);
      await spec({ runnable: false });
      expect(await pendingMutants(pkg)).toEqual([]);
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });
});

describe("raw/ files through loadRaws and runLedger (flow 430 AC3, AC4)", () => {
  type Out = { ready: boolean; gaps: Array<{ reviewer?: string; detail: string }>; ignored: string[]; ledger: Record<string, unknown> & { setAside?: string[] } };

  async function fixture(raws: Record<string, string>, drivers: Record<string, object> = {}): Promise<{ pkg: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f430-ledger-"));
    const pkg = path.join(root, ".metaproject", "reviews", "pkg");
    await mkdir(path.join(pkg, "raw"), { recursive: true });
    await mkdir(path.join(pkg, "drivers"), { recursive: true });
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
    for (const [name, body] of Object.entries(raws)) await writeFile(path.join(pkg, "raw", name), body);
    for (const [name, body] of Object.entries(drivers)) await writeFile(path.join(pkg, "drivers", name), JSON.stringify(body));
    return { pkg, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  async function build(pkg: string): Promise<Out> {
    const lines: string[] = [];
    const log = console.log;
    const exitCode = process.exitCode;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await runLedger(["build", pkg, "--mode", "all", "--json"], { rejectUnknownFlags: () => undefined });
    } finally {
      console.log = log;
      process.exitCode = exitCode;
    }
    return JSON.parse(lines.join("\n")) as Out;
  }

  const noBlock = (out: Out, file: string) => out.gaps.filter((gap) => gap.detail.includes(`raw/${file}`) && gap.detail.includes("no parseable REVIEW_RESULT block"));

  test("a verification payload filed in raw/ is set aside, listed, kept on disk, and does not block the ledger", async () => {
    const { pkg, cleanup } = await fixture({ "verification.txt": '{"claims": []}' });
    try {
      const out = await build(pkg);
      expect(out.ignored).toHaveLength(1);
      expect(out.ignored[0]).toContain("raw/verification.txt (set aside:");
      expect(noBlock(out, "verification.txt")).toEqual([]);
      expect(out.ledger.rawReconciled).toBe(true);
      expect(out.ledger.setAside).toEqual(["raw/verification.txt"]);
      expect(JSON.parse(await readFile(path.join(pkg, "research.json"), "utf8")).setAside).toEqual(["raw/verification.txt"]);
      expect(existsSync(path.join(pkg, "raw", "verification.txt"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("a file that holds REVIEW_RESULT but no parseable block is a gap that blocks, never set aside", async () => {
    const { pkg, cleanup } = await fixture({ "notes.txt": "REVIEW_RESULT: this is where the block should be, but it is cut off" });
    try {
      const out = await build(pkg);
      expect(noBlock(out, "notes.txt")).toHaveLength(1);
      expect(out.ledger.rawReconciled).toBe(false);
      expect(out.ledger.setAside).toBeUndefined();
      expect(out.ready).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("a file a driver names as its result, with no parseable block, is a gap that blocks", async () => {
    const { pkg, cleanup } = await fixture(
      { "custom-output.txt": "the reviewer wrote prose and never emitted a result" },
      { "review-logic.json": { reviewer: "review-logic", slices: ["S1"], result: "raw/custom-output.txt" } },
    );
    try {
      const out = await build(pkg);
      expect(noBlock(out, "custom-output.txt")).toHaveLength(1);
      expect(out.ledger.rawReconciled).toBe(false);
      expect(out.ledger.setAside).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a file named after a required reviewer is protected even when no driver names it", async () => {
    const probe = await fixture({});
    let reviewer: string;
    try {
      reviewer = (await requiredReviewers(path.resolve(probe.pkg, "..", "..", ".."), "all", ["src/a.ts"])).required[0]!;
    } finally {
      await probe.cleanup();
    }
    expect(reviewer).toBeDefined();
    const { pkg, cleanup } = await fixture({ [`${reviewer}.txt`]: "prose, no block" });
    try {
      const out = await build(pkg);
      expect(noBlock(out, `${reviewer}.txt`)).toHaveLength(1);
      expect(out.ignored).toEqual([]);
      expect(out.ledger.rawReconciled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("loadRaws names the set-aside files and keeps them out of raws", async () => {
    const { pkg, cleanup } = await fixture({ "verification.txt": '{"claims": []}', "empty.txt": "" });
    try {
      const loaded = await loadRaws(pkg, { files: new Set(), reviewers: [] });
      expect(loaded.setAside).toEqual(["raw/verification.txt"]);
      expect(loaded.raws.map((raw) => raw.name)).toEqual(["raw/empty.txt"]);
    } finally {
      await cleanup();
    }
  });

  test("a ```REVIEW_RESULT fence with a status only (or a null reviewer) is ignored by name, not turned into a raw or a gap (flow 441 AC13)", async () => {
    const { pkg, cleanup } = await fixture({
      "review-a.txt": '```REVIEW_RESULT\n{"status":"DONE"}\n```',
      "review-b.txt": '```REVIEW_RESULT\n{"status":"DONE","reviewer":null}\n```',
      "review-c.txt": '```REVIEW_RESULT\n{"status":"DONE","reviewer":"review-c"}\n```',
    });
    try {
      const loaded = await loadRaws(pkg, { files: new Set(), reviewers: [] });
      expect(loaded.ignored).toEqual(["raw/review-a.txt", "raw/review-b.txt"]);
      expect(loaded.raws.map((raw) => raw.name)).toEqual(["raw/review-c.txt"]);
    } finally {
      await cleanup();
    }
  });

  test("a bare status-only reply saved under a reviewer's name makes the ledger NOT READY with a named gap (flow 441 AC13)", async () => {
    const { pkg, cleanup } = await fixture(
      { "review-logic.txt": '{"status":"DONE"}' },
      { "review-logic.json": { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt" } },
    );
    try {
      const loaded = await loadRaws(pkg, { files: new Set(["review-logic.txt"]), reviewers: [] });
      expect(loaded.raws.map((raw) => [raw.name, raw.result])).toEqual([["raw/review-logic.txt", undefined]]);
      const out = await build(pkg);
      expect(out.ready).toBe(false);
      // The gap names what the reply lacks (flow 458 AC12), not only that it failed.
      expect(out.gaps.map((gap) => gap.detail)).toContain("raw/review-logic.txt: no parseable REVIEW_RESULT block (the closest JSON object in the reply cannot be read as a reviewer result: missing reviewer, slices, findings)");
    } finally {
      await cleanup();
    }
  });

  test("a driver with an entry that has no usable id is reported by count and hands over none of its slices", async () => {
    const { pkg, cleanup } = await fixture({}, { "review-logic.json": { reviewer: "review-logic", slices: ["S1", { coverage: "no id" }, ""], result: "raw/review-logic.txt" } });
    try {
      const out = await build(pkg);
      const gap = out.gaps.find((g) => g.detail.includes("drivers/review-logic.json"));
      expect(gap?.reviewer).toBe("review-logic");
      expect(gap?.detail).toContain("2 slice entries without a usable id");
    } finally {
      await cleanup();
    }
  });

  test("a rebuild never invents dispatch.roles: an in-flight package with pr-context.md stays grandfathered, and research.json has no roles key", async () => {
    const { pkg, cleanup } = await fixture({}, { "review-logic.json": { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt" } });
    try {
      await writeFile(path.join(pkg, "pr-context.md"), "# pr context\n");
      const out = await build(pkg);
      expect("roles" in (out.ledger.dispatch as object)).toBe(false);
      expect("roles" in JSON.parse(await readFile(path.join(pkg, "research.json"), "utf8")).dispatch).toBe(false);
      const again = await build(pkg);
      expect("roles" in (again.ledger.dispatch as object)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("dispatch.roles is stamped when a driver shows the role was dispatched, and a rebuild keeps an existing stamp", async () => {
    const { pkg, cleanup } = await fixture({}, { "review-pr-contract.json": { reviewer: "review-pr-contract", slices: ["S1"], result: "raw/review-pr-contract.txt" } });
    try {
      await writeFile(path.join(pkg, "pr-context.md"), "# pr context\n");
      expect((await build(pkg)).ledger.dispatch).toMatchObject({ roles: ["review-pr-contract"] });
      await rm(path.join(pkg, "drivers"), { recursive: true, force: true });
      expect((await build(pkg)).ledger.dispatch).toMatchObject({ roles: ["review-pr-contract"] });
    } finally {
      await cleanup();
    }
  });

  test("readDrivers reads an object entry's status as an assignment, not as coverage", async () => {
    const { pkg, cleanup } = await fixture({}, { "review-logic.json": { reviewer: "review-logic", slices: [{ id: "S1", status: "NOT_READ" }, "S2"], result: "raw/review-logic.txt" } });
    try {
      const drivers = await readDrivers(pkg, pkg);
      expect(drivers.payloadSlices).toEqual({ "review-logic": ["S1", "S2"] });
      expect(drivers.dropped).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("coverage from the slice manifest of a separate input directory (flow 431 AC9, AC10)", () => {
  test("ledger build leaves a copy of the manifest in the package, and `review coverage` counts from it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f431-ledger-"));
    const original = process.cwd();
    const pkg = path.join(root, ".metaproject", "reviews", "pkg");
    const input = path.join(root, ".metaproject", "reviews", "input");
    try {
      await mkdir(path.join(input, "raw"), { recursive: true });
      await mkdir(path.join(input, "slices"), { recursive: true });
      await mkdir(pkg, { recursive: true });
      await mkdir(path.join(root, ".git"), { recursive: true });
      await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts", "src/b.ts", "pnpm-lock.yaml"] }));
      await writeFile(path.join(input, "slices", "s1.txt"), "src/a.ts\n");
      await writeFile(
        path.join(input, "slices", "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          maxBytes: 1000,
          waveBytes: 1000,
          source: "diff",
          slices: [{ id: "s1", path: "s1.txt", bytes: 9, files: ["src/a.ts"], domain: "d", split: "file" }],
          omissions: [{ path: "pnpm-lock.yaml", reason: "lockfile", detail: "generated", bytes: 5 }],
          totals: { slices: 1, bytes: 9, files: 1, omittedFiles: 1, omittedBytes: 5, droppedBlocks: 0 },
        }),
      );
      const log = console.log;
      const exitCode = process.exitCode;
      console.log = () => undefined;
      try {
        await runLedger(["build", input, "--package", pkg, "--mode", "all"], { rejectUnknownFlags: () => undefined });
      } finally {
        console.log = log;
        process.exitCode = exitCode;
      }
      expect(existsSync(path.join(pkg, "slice-manifest.json"))).toBe(true);

      process.chdir(root);
      const lines: string[] = [];
      console.log = (...args: unknown[]) => void lines.push(args.join(" "));
      try {
        await runCoverage(["--package", pkg], { rejectUnknownFlags: () => undefined });
      } finally {
        console.log = log;
      }
      expect(lines.join("\n")).toBe("coverage: in scope 3, covered 0, omitted 1 (lockfile 1), uncovered 2");
    } finally {
      process.chdir(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ledger build --skip and flow-bound packages (flow 458 AC7)", () => {
  type Out = { ready: boolean; gaps: Array<{ reviewer?: string; detail: string }>; blockers: string[]; ledger: { dispatch: Record<string, unknown> } };

  async function packageAt(segments: readonly string[]): Promise<{ root: string; pkg: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f458-ledger-"));
    const pkg = path.join(root, ".metaproject", ...segments);
    await mkdir(path.join(pkg, "raw"), { recursive: true });
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
    return { root, pkg, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  async function run(args: string[]): Promise<{ text: string }> {
    const lines: string[] = [];
    const log = console.log;
    const exitCode = process.exitCode;
    console.log = (...items: unknown[]) => void lines.push(items.join(" "));
    try {
      await runLedger(["build", ...args], { rejectUnknownFlags: () => undefined });
    } finally {
      console.log = log;
      process.exitCode = exitCode;
    }
    return { text: lines.join("\n") };
  }

  test("a skip of a required reviewer needs the operator's recorded decision (M5); with it the skip leaves the selection as Not run", async () => {
    const { root, pkg, cleanup } = await packageAt(["reviews", "pkg"]);
    try {
      const required = (await requiredReviewers(root, "all", ["src/a.ts"])).required;
      const skipped = required.find((name) => name !== "review-logic")!;
      // The agent's flag alone is refused, and names the card and the terminal command.
      await expect(run([pkg, "--mode", "all", "--json", "--skip", skipped, "--reason", "operator: no style pass on a hotfix"])).rejects.toThrow(/needs the operator's decision.*review_override_reviewers/s);
      const subject = await operatorDecisionSubject(pkg, "reviewer-override", required.filter((name) => name !== skipped));
      expect(subject.items).toEqual([skipped]);
      await recordOperatorDecision(pkg, { kind: "reviewer-override", quote: "yes, skip it", reason: "hotfix", confirmedVia: "terminal", at: new Date().toISOString(), subject });
      const out = JSON.parse((await run([pkg, "--mode", "all", "--json", "--skip", skipped, "--reason", "operator: no style pass on a hotfix"])).text) as Out;
      expect(out.ledger.dispatch.skipped).toEqual([{ reviewer: skipped, reason: "operator: no style pass on a hotfix" }]);
      expect(out.ledger.dispatch.notRun).toContain(`Not run: ${skipped} — operator: no style pass on a hotfix`);
      expect(out.ledger.dispatch.selected).not.toContain(skipped);
      expect(out.gaps.some((gap) => gap.reviewer === skipped)).toBe(false);
      expect(out.blockers.join("\n")).not.toContain(skipped);
      // The gate on the dispatch: the skip counts with the package's recorded decision, never as a dispatch entry alone.
      const dispatch = out.ledger.dispatch;
      expect((await coverageErrors({ mode: "all", selected: dispatch.selected, skipped: dispatch.skipped }, { root, files: ["src/a.ts"], packageDir: pkg })).join("\n")).not.toContain("missing");
      expect((await coverageErrors({ mode: "all", selected: dispatch.selected, skipped: dispatch.skipped }, { root, files: ["src/a.ts"] })).join("\n")).toContain("dispatch.skipped is not accepted");
      expect((await coverageErrors({ mode: "all", selected: dispatch.selected }, { root, files: ["src/a.ts"], packageDir: pkg })).join("\n")).toContain(`missing: ${skipped}`);

      const text = (await run([pkg, "--mode", "all", "--dry-run", "--skip", skipped, "--reason", "operator: no style pass on a hotfix"])).text;
      expect(text).toContain(`- Not run: ${skipped} — operator: no style pass on a hotfix`);
      const verdict = await computeVerdict(pkg);
      expect(verdict.notRun?.[0]).toBe(`Not run: ${skipped} — operator: no style pass on a hotfix`);
      // M6: a reviewer the required set dropped by an overlap group or a supersede is named in the verdict, with why.
      expect(verdict.notRun).toContain("excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines");
      expect(renderVerdict(verdict, "pkg")).toContain(`Not run: ${skipped} — operator: no style pass on a hotfix`);
    } finally {
      await cleanup();
    }
  });

  test("a skip without a reason or a reason without a skip is refused; a skip of a reviewer the round does not require is only recorded", async () => {
    expect(() => parseSkips(["--skip", "review-style"])).toThrow("needs --reason");
    expect(() => parseSkips(["--reason", "why"])).toThrow("must follow");
    expect(() => parseSkips(["--skip", "a", "--skip", "b", "--reason", "x"])).toThrow("has no --reason");
    expect(() => parseSkips(["--skip", "a", "--reason", ""])).toThrow("needs a value");
    expect(parseSkips(["--package", "p", "--skip", "a", "--reason", "x", "--skip", "b", "--reason", "y"])).toEqual([
      { reviewer: "a", reason: "x" },
      { reviewer: "b", reason: "y" },
    ]);
    const { pkg, cleanup } = await packageAt(["reviews", "pkg"]);
    try {
      const out = JSON.parse((await run([pkg, "--json", "--skip", "review-nonexistent", "--reason", "x"])).text) as Out;
      expect(out.ledger.dispatch.notRun).toContain("Not run: review-nonexistent — x (not required this round)");
    } finally {
      await cleanup();
    }
  });

  test("a flow-bound package resolves its project root, so the project's own reviewers are required", async () => {
    const { root, pkg, cleanup } = await packageAt(["flows", "458-2026-10-16-x", "reviews", "2026-10-16-pr-1"]);
    try {
      const overlay = path.join(root, ".metaproject", "project-skills", "review", "acme-review");
      await mkdir(overlay, { recursive: true });
      await writeFile(path.join(overlay, "SKILL.md"), "---\nname: acme-review\ndescription: Use when reviewing acme code.\n---\n");
      const out = JSON.parse((await run([pkg, "--mode", "all", "--json"])).text) as Out;
      expect(out.ledger.dispatch.selected).toContain("acme-review");
    } finally {
      await cleanup();
    }
  });
});

describe("dispositions and the recorded model (flow 458 AC12)", () => {
  type Out = { ready: boolean; gaps: Array<{ reviewer?: string; detail: string }>; ledger: { obligations: Array<Record<string, unknown>>; dispatch: { runs: Array<Record<string, unknown>> } } };
  const REVIEW = { reviewer: "review-logic", status: "DONE", slices: ["S1"], findings: [{ id: "F1", problem: "p" }] };

  async function pkgWith(extra: Record<string, string> = {}, driver: object = { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt" }): Promise<{ pkg: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f458-ledger-"));
    const pkg = path.join(root, ".metaproject", "reviews", "pkg");
    await mkdir(path.join(pkg, "raw"), { recursive: true });
    await mkdir(path.join(pkg, "drivers"), { recursive: true });
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
    await writeFile(path.join(pkg, "raw", "review-logic.txt"), `REVIEW_RESULT: ${JSON.stringify(REVIEW)}\n`);
    await writeFile(path.join(pkg, "drivers", "review-logic.json"), JSON.stringify(driver));
    for (const [name, body] of Object.entries(extra)) await writeFile(path.join(pkg, name), body);
    return { pkg, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  async function run(args: string[]): Promise<{ out?: Out; text: string; error?: string }> {
    const lines: string[] = [];
    const log = console.log;
    const exitCode = process.exitCode;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      await runLedger(["build", ...args], { rejectUnknownFlags: () => undefined });
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : String(error) };
    } finally {
      console.log = log;
      process.exitCode = exitCode;
    }
    const text = lines.join("\n");
    return { text, ...(args.includes("--json") ? { out: JSON.parse(text) as Out } : {}) };
  }

  const ID = "review-logic:F1";

  test("every known wrapper key is normalised to the same dispositions", async () => {
    const row = { id: ID, status: "refuted", evidence: "ran it", reason: "not reproducible" };
    for (const wrapped of [[row], { dispositions: [row] }, { items: [row] }, { results: [row] }, { data: [row] }, { entries: [row] }, { data: { dispositions: [row] } }]) {
      const { pkg, cleanup } = await pkgWith({ "dispositions.json": JSON.stringify(wrapped) });
      try {
        const { out } = await run([pkg, "--mode", "all", "--json", "--dispositions", path.join(pkg, "dispositions.json")]);
        expect(out?.ledger.obligations.find((o) => o.id === ID)).toMatchObject({ status: "refuted", evidence: "ran it" });
      } finally {
        await cleanup();
      }
    }
  });

  test("a narrowed row without remains, an unknown status and a row without id are all refused in one message, nothing written", async () => {
    const rows = [
      { id: ID, status: "narrowed", evidence: "e", reason: "r" },
      { id: "review-logic:F2", status: "maybe", evidence: "e", reason: "r" },
      { status: "refuted", evidence: "e", reason: "r" },
      "not an object",
      { id: "review-logic:F3", status: "narrowed", evidence: "e", reason: "r", remains: "the null case" },
    ];
    const { pkg, cleanup } = await pkgWith({ "dispositions.json": JSON.stringify({ dispositions: rows }) });
    try {
      const { error } = await run([pkg, "--mode", "all", "--json", "--dispositions", path.join(pkg, "dispositions.json")]);
      expect(error).toContain("4 bad row(s)");
      expect(error).toContain(`row 1 (${ID}): narrowed needs "remains"`);
      expect(error).toContain('row 2 (review-logic:F2): status "maybe" is not one of finding, refuted, out-of-scope, narrowed');
      expect(error).toContain('row 3: no "id"');
      expect(error).toContain("row 4: not an object");
      expect(error).not.toContain("row 5");
      expect(error).toContain("One schema per row");
      expect(existsSync(path.join(pkg, "research.json"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("a dispositions input that is not a list, or not JSON, is refused by name", async () => {
    const { pkg, cleanup } = await pkgWith({ "object.json": JSON.stringify({ note: "nothing here" }), "broken.json": "{" });
    try {
      expect((await run([pkg, "--mode", "all", "--dispositions", path.join(pkg, "object.json")])).error).toContain("not a list of dispositions");
      expect((await run([pkg, "--mode", "all", "--dispositions", path.join(pkg, "broken.json")])).error).toContain("missing or not valid JSON");
    } finally {
      await cleanup();
    }
  });

  test("the default input (the obligations of the last build) keeps its still-open rows without being refused", async () => {
    const { pkg, cleanup } = await pkgWith();
    try {
      expect((await run([pkg, "--mode", "all", "--json"])).out?.ledger.obligations.find((o) => o.id === ID)?.status).toBe("unresolved");
      // The second build reads research.json back, `unresolved` obligation included.
      const again = await run([pkg, "--mode", "all", "--json"]);
      expect(again.error).toBeUndefined();
      expect(again.out?.ledger.obligations.find((o) => o.id === ID)?.status).toBe("unresolved");
    } finally {
      await cleanup();
    }
  });

  test("the model a driver records is on the run and in the report; without one the report says model not recorded", async () => {
    const withModel = await pkgWith({}, { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt", model: "claude-sonnet-5-5" });
    try {
      const { out } = await run([withModel.pkg, "--mode", "all", "--json"]);
      expect(out?.ledger.dispatch.runs.find((r) => r.reviewer === "review-logic")?.model).toBe("claude-sonnet-5-5");
      expect((await run([withModel.pkg, "--mode", "all"])).text).toContain("review-logic claude-sonnet-5-5");
    } finally {
      await withModel.cleanup();
    }
    const without = await pkgWith();
    try {
      const { out } = await run([without.pkg, "--mode", "all", "--json"]);
      expect(out?.ledger.dispatch.runs.find((r) => r.reviewer === "review-logic")).not.toHaveProperty("model");
      expect((await run([without.pkg, "--mode", "all"])).text).toContain("review-logic model not recorded");
    } finally {
      await without.cleanup();
    }
  });

  test("a result's own model wins over the driver's", async () => {
    const { pkg, cleanup } = await pkgWith({}, { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt", model: "from-driver" });
    try {
      await writeFile(path.join(pkg, "raw", "review-logic.txt"), `REVIEW_RESULT: ${JSON.stringify({ ...REVIEW, model: "from-result" })}\n`);
      const { out } = await run([pkg, "--mode", "all", "--json"]);
      expect(out?.ledger.dispatch.runs.find((r) => r.reviewer === "review-logic")?.model).toBe("from-result");
    } finally {
      await cleanup();
    }
  });
});
