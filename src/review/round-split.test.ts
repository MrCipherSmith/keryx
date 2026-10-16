// Flow 458 AC3 (routing) and AC4: a delta round splits into fix and new slices; coverage, the routing check, the
// estimate and the ledger count both kinds, each against its own roster.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { deltaSliceDiff } from "../commands/review-slice";
import { computeCoverage } from "./coverage-complete";
import { estimateRound } from "./estimate";
import { buildLedger, type LedgerInputs, type RawFile } from "./ledger";
import { type PriorFinding, type RoundRecord } from "./round-record";
import { classifyDeltaSlices, expectedFixRoles, fixClaimBacked, fixRosterRoles, fixSliceCoverage, fixSliceRoles, isDeltaRound, priorDispositionsOf, splitCounts } from "./round-split";
import { narrowedSlices } from "./routing-check";
import { parseScopedDiff, type SliceEntry, type SliceManifest } from "./slice";
import { routeSliceRegions } from "./slice-routing";
import { requiredSlices } from "./waves";

const prior = (id: string, reviewer: string, file = "src/a/a.ts"): PriorFinding => ({ id, reviewer, severity: "major", file, line: 10, problem: "p", status: "open", source: "local-package" });
const PRIOR: PriorFinding[] = [prior("F1", "review-security-code"), prior("F2", "review-architecture"), prior("F3", "my-project-reviewer", "src/b/b.ts")];

const round = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  v: 1,
  round: 2,
  source: "local-package",
  sourcesTried: [],
  previous: { reviewId: "r1", reviewedHead: "a".repeat(40) },
  mode: "delta",
  range: { base: "a".repeat(40), head: "b".repeat(40) },
  fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F1"] }],
  newHunks: [{ file: "src/c/c.ts", startLine: 1, endLine: 3 }],
  carried: [{ findingId: "F9", disposition: "closed" }],
  ...over,
});

const region = (file: string, start: number, end: number, body = "+const x = 1;"): string => `--- ${file}\n@@ ${start},${end} @@\n${body}\n`;

describe("fix roster", () => {
  test("logic, regression and the authors of the attached findings, nothing else; a missing id adds no one", () => {
    expect(fixRosterRoles(["F1", "F2"], PRIOR)).toEqual(["review-architecture", "review-logic", "review-regression", "review-security-code"]);
    expect(fixRosterRoles(["F1", "NOPE"], PRIOR)).toEqual(["review-logic", "review-regression", "review-security-code"]);
    expect(fixRosterRoles([], PRIOR)).toEqual(["review-logic", "review-regression"]);
  });

  test("a project reviewer that authored a finding is on the roster only when it is a review- role", () => {
    expect(fixRosterRoles(["F3"], PRIOR)).toEqual(["review-logic", "review-regression"]);
  });

  test("only a delta round with both ends of its range splits", () => {
    expect(isDeltaRound(round())).toBe(true);
    expect(isDeltaRound(round({ mode: "first" }))).toBe(false);
    expect(isDeltaRound(round({ mode: "fallback-first" }))).toBe(false);
    expect(isDeltaRound(round({ range: { base: null, head: "b".repeat(40) } }))).toBe(false);
    expect(isDeltaRound(undefined)).toBe(false);
  });
});

describe("classifyDeltaSlices", () => {
  const entry = (id: string, files: string[], text: string, extra: Partial<SliceEntry> = {}): SliceEntry & { text: string } => ({
    id,
    path: `${id}.diff`,
    bytes: 100,
    files,
    domain: "src",
    split: "domain",
    roles: ["review-logic", "review-style", "review-performance"],
    depth: "light",
    risk: { score: 0.1, why: [] },
    text,
    ...extra,
  });

  test("a slice holding a fix hunk region is fix with its findings and the fix roster; every other slice is new and keeps its routing", () => {
    const slices = [
      entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 7, 13)),
      entry("slice-02", ["src/c/c.ts"], region("src/c/c.ts", 1, 3)),
    ];
    const [fix, fresh] = classifyDeltaSlices(slices, round(), PRIOR);
    // The fix roster joined by the slice's own round-1 routing (M2/M3): nothing its content needs is dropped.
    expect(fix).toMatchObject({ kind: "fix", findingIds: ["F1"], roles: ["review-logic", "review-performance", "review-regression", "review-security-code", "review-style"], depth: "deep" });
    expect(fresh).toMatchObject({ kind: "new", roles: ["review-logic", "review-style", "review-performance"], depth: "light" });
    expect(fresh?.findingIds).toBeUndefined();
  });

  test("a region that does not reach the fix hunk's lines leaves the slice new; the audit mark of a fix slice is dropped", () => {
    const [outside] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 40, 45))], round(), PRIOR);
    expect(outside?.kind).toBe("new");
    const [audited] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 8, 12), { audit: true, escalated: { by: "x", finding: "y" } })], round(), PRIOR);
    expect(audited?.kind).toBe("fix");
    expect(audited?.audit).toBeUndefined();
    expect(audited?.escalated).toBeUndefined();
  });

  test("a retry piece is left as it is", () => {
    const [piece] = classifyDeltaSlices([entry("r1-x-01", ["src/a/a.ts"], region("src/a/a.ts", 8, 12), { retryOf: ["slice-01"] })], round(), PRIOR);
    expect(piece?.kind).toBeUndefined();
  });
});

describe("fix slices in the manifest", () => {
  const manifest = (slices: SliceEntry[]): SliceManifest => ({ schemaVersion: 1, maxBytes: 18000, waveBytes: 1000, source: "diff", slices, omissions: [], totals: { slices: slices.length, bytes: 0, files: 0, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } });
  const fixSlice: SliceEntry = { id: "slice-01", path: "slice-01.diff", bytes: 100, files: ["src/a/a.ts"], domain: "src/a", split: "domain", roles: ["review-logic", "review-regression", "review-security-code", "my-project-reviewer"], depth: "deep", kind: "fix", findingIds: ["F1"] };
  const newSlice: SliceEntry = { id: "slice-02", path: "slice-02.diff", bytes: 100, files: ["src/c/c.ts"], domain: "src/c", split: "domain", roles: ["review-logic", "review-style"], depth: "light", kind: "new" };
  const m = manifest([fixSlice, newSlice]);
  const plain = (entry: SliceEntry): SliceEntry => {
    const { kind: _kind, findingIds: _ids, ...rest } = entry;
    return rest;
  };

  test("a fix slice belongs to exactly its roster, whether or not a role is routable", () => {
    // A project reviewer with no path gate reads every new slice, and a fix slice only when it is on its roster.
    expect(requiredSlices(m, "my-project-reviewer")).toEqual(["slice-01", "slice-02"]);
    expect(requiredSlices(m, "other-project-reviewer")).toEqual(["slice-02"]);
    expect(requiredSlices(m, "review-security-code")).toEqual(["slice-01"]);
    expect(requiredSlices(m, "review-style")).toEqual(["slice-02"]);
    expect(requiredSlices(m, "review-logic")).toEqual(["slice-01", "slice-02"]);
    expect(requiredSlices(m, "review-architecture")).toEqual([]);
  });

  test("fix-slice roles join the round, and the counts split the two kinds", () => {
    expect(fixSliceRoles(m)).toEqual(["my-project-reviewer", "review-logic", "review-regression", "review-security-code"]);
    expect(splitCounts(m)).toEqual({ fix: 1, new: 1 });
    expect(splitCounts(manifest([plain(newSlice)]))).toBeUndefined();
  });

  test("estimate counts both kinds: a dispatch carries one kind, and the split is reported", () => {
    const estimate = estimateRound(["review-logic", "review-regression", "review-security-code", "review-style"], m);
    expect(estimate.split).toEqual({ fix: { slices: 1, dispatches: 3 }, new: { slices: 1, dispatches: 2 } });
    // logic reads both kinds (two dispatches); regression and security the fix slice; style the new one.
    expect(estimate.perRole.find((r) => r.role === "review-logic")?.waves).toBe(2);
    expect(estimate.dispatches).toBe(5);
    expect(estimate.slices).toBe(2);
  });

  test("a round without kinds estimates as before and reports no split", () => {
    const estimate = estimateRound(["review-logic"], manifest([plain(newSlice)]));
    expect(estimate.split).toBeUndefined();
    expect(estimate.dispatches).toBe(1);
  });
});

describe("routing check accepts fix rosters", () => {
  const text = region("src/a/a.ts", 8, 12, "+eval(userInput);\n+child_process.exec(cmd);");
  const slice = (extra: Partial<SliceEntry>): SliceEntry => ({ id: "slice-01", path: "slice-01.diff", bytes: 100, files: ["src/a/a.ts"], domain: "src/a", split: "domain", kind: "fix", findingIds: ["F1"], ...extra });
  const context = { round: round(), prior: PRIOR };
  const read = () => text;

  const contentRoles = routeSliceRegions("slice-01", parseScopedDiff(text), { changedFiles: ["src/a/a.ts"] }).roles;

  test("a fix slice is held to the fix roster AND its content's round-1 routing (M3): the fix roster alone is narrowed", () => {
    const fixOnly = slice({ roles: expectedFixRoles({ findingIds: ["F1"] }, context), depth: "deep" });
    const missing = contentRoles.filter((role) => !fixOnly.roles!.includes(role));
    expect(missing.length).toBeGreaterThan(0);
    expect(narrowedSlices({ slices: [fixOnly] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: missing.sort() }]);
    const union = slice({ roles: [...new Set([...contentRoles, ...expectedFixRoles({ findingIds: ["F1"] }, context)])], depth: "deep" });
    expect(narrowedSlices({ slices: [union] }, read, context).narrowed).toEqual([]);
    // A fix slice is read deep.
    expect(narrowedSlices({ slices: [{ ...union, depth: "light" }] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: [], depth: { recorded: "light", needed: "deep" } }]);
  });

  test("a fix slice missing an author of its finding is narrowed", () => {
    const fix = slice({ roles: [...new Set([...contentRoles, "review-logic", "review-regression"])].filter((role) => role !== "review-security-code"), depth: "deep" });
    expect(narrowedSlices({ slices: [fix] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: ["review-security-code"] }]);
  });

  test("tagging a slice fix does not narrow it: the round must back the claim", () => {
    expect(fixClaimBacked(slice({}), context)).toBe(true);
    expect(fixClaimBacked(slice({ findingIds: ["F7"] }), context)).toBe(false);
    expect(fixClaimBacked(slice({ files: ["src/z/z.ts"] }), context)).toBe(false);
    expect(fixClaimBacked(slice({ findingIds: [] }), context)).toBe(false);
    expect(fixClaimBacked(slice({}), { round: round({ mode: "first" }), prior: PRIOR })).toBe(false);
    expect(fixClaimBacked(slice({}), undefined)).toBe(false);
    const forged = slice({ findingIds: ["F7"], roles: ["review-logic", "review-regression"], depth: "deep" });
    expect(narrowedSlices({ slices: [forged] }, read, context).narrowed.length).toBe(1);
  });

  test("a new slice is still held to round-1 routing", () => {
    const fresh = slice({ kind: "new", roles: ["review-logic"], depth: "light" });
    expect(narrowedSlices({ slices: [fresh] }, read, context).narrowed.length).toBe(1);
  });
});

describe("ledger: a split round", () => {
  const files = (list: string[]): string[] => list;
  const fix: SliceEntry = { id: "slice-01", path: "slice-01.diff", bytes: 100, contentHash: "h1", files: files(["src/a/a.ts"]), domain: "src/a", split: "domain", roles: ["review-logic", "review-regression"], depth: "deep", kind: "fix", findingIds: ["F1", "F2"] };
  const fresh: SliceEntry = { id: "slice-02", path: "slice-02.diff", bytes: 100, contentHash: "h2", files: files(["src/c/c.ts"]), domain: "src/c", split: "domain", roles: ["review-logic", "review-style"], depth: "light", kind: "new" };
  const manifest = { schemaVersion: 1, maxBytes: 18000, waveBytes: 1000, source: "diff", slices: [fix, fresh], omissions: [], totals: { slices: 2, bytes: 200, files: 2, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } } as SliceManifest;

  let clock = 0;
  const raw = (reviewer: string, extra: Record<string, unknown> = {}): RawFile => {
    clock += 1;
    return { name: `raw/${reviewer}.txt`, hash: `h${clock}`, mtimeMs: clock, empty: false, result: { reviewer, status: "DONE", summary: "s", findings: [], needs_context: [], ...extra } };
  };
  const build = (raws: RawFile[], over: Partial<LedgerInputs> = {}) =>
    buildLedger({
      mode: "all",
      selected: ["review-logic", "review-regression", "review-style"],
      manifest,
      payloadSlices: {},
      ruleFiles: Object.fromEntries(["review-logic", "review-regression", "review-style"].map((r) => [r, `.metaproject/skills/gdskills/review/${r}/SKILL.md`])),
      raws,
      retry: { schemaVersion: 1, reviewers: {} },
      canonical: [],
      dispositions: [],
      manifestPath: "slices/manifest.json",
      ...over,
    });
  const claims = (reviewer: string, slices: string[], extra: Record<string, unknown> = {}): RawFile => ({ ...raw(reviewer, { slices, ...extra }), assignedSlices: slices });

  const answered = { prior_dispositions: [{ id: "F1", disposition: "closed" }, { id: "F2", disposition: "partial" }] };

  test("each kind is checked against its own roster: the style reviewer owes the new slice only, regression the fix slice only", () => {
    const { ledger, gaps } = build([claims("review-logic", ["slice-01", "slice-02"]), claims("review-regression", ["slice-01"], answered), claims("review-style", ["slice-02"])]);
    expect(gaps).toEqual([]);
    expect(ledger.scopeReviewed).toBe(true);
    const runs = (ledger.dispatch.runs as Array<{ reviewer: string; scopeComplete: boolean }>).map((r) => [r.reviewer, r.scopeComplete]);
    expect(runs).toEqual([["review-logic", true], ["review-regression", true], ["review-style", true]]);
  });

  test("a reviewer that skips a slice of its own kind still leaves it open", () => {
    const { ledger, gaps } = build([claims("review-logic", ["slice-01", "slice-02"]), claims("review-regression", []), claims("review-style", ["slice-02"])]);
    expect(ledger.scopeReviewed).toBe(false);
    expect(gaps.some((g) => g.reviewer === "review-regression" && g.detail.includes("slice-01"))).toBe(true);
  });

  test("a fix slice is covered when every roster reviewer read it and its findings have dispositions from that roster (M4)", () => {
    const { ledger, gaps } = build([claims("review-logic", ["slice-01", "slice-02"], answered), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"])]);
    expect(gaps).toEqual([]);
    expect(ledger.scopeReviewed).toBe(true);
    expect(ledger.dispatch.fixSlicesCovered).toEqual(["slice-01"]);
    expect(ledger.dispatch.priorDispositions).toEqual({ F1: "closed", F2: "partial" });
  });

  test("dispositions alone do not cover a fix slice nobody on its roster read", () => {
    const { ledger, gaps } = build([claims("review-logic", ["slice-02"], answered), claims("review-regression", []), claims("review-style", ["slice-02"])]);
    expect(ledger.scopeReviewed).toBe(false);
    expect(ledger.dispatch.fixSlicesCovered).toBeUndefined();
    expect(gaps.some((g) => g.detail.startsWith("fix slice slice-01: not read by review-logic, review-regression"))).toBe(true);
  });

  test("a disposition from a reviewer off the roster, or a carried record, covers nothing", () => {
    const off = build([claims("review-logic", ["slice-01", "slice-02"]), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"], answered)]);
    expect(off.ledger.scopeReviewed).toBe(false);
    expect(off.gaps.some((g) => g.detail.includes("no disposition from its roster for F1, F2"))).toBe(true);
    const carried = build([claims("review-logic", ["slice-01", "slice-02"], { prior_dispositions: [{ id: "F1", disposition: "withdrawn" }] }), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"])], { carried: [{ findingId: "F2", disposition: "closed" }] });
    expect(carried.ledger.dispatch.fixSlicesCovered).toBeUndefined();
    expect(carried.ledger.scopeReviewed).toBe(false);
  });

  test("a disposition counts only from a finished result of this scope", () => {
    const unfinished = build([claims("review-logic", ["slice-01", "slice-02"]), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"]), claims("review-regression", ["slice-01"], { ...answered, status: "NEEDS_CONTEXT" })]);
    expect(unfinished.gaps.some((g) => g.detail.includes("no disposition from its roster"))).toBe(true);
    const stale = build([claims("review-logic", ["slice-01", "slice-02"], { ...answered, scopeFingerprint: "another-scope" }), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"])]);
    expect(stale.ledger.scopeReviewed).toBe(false);
    expect(stale.gaps.some((g) => g.detail.includes("no disposition from its roster for F1, F2"))).toBe(true);
  });

  test("one finding without a disposition leaves the fix slice uncovered; an unknown disposition word counts for nothing", () => {
    const { ledger, gaps } = build([claims("review-logic", ["slice-01", "slice-02"], { prior_dispositions: [{ id: "F1", disposition: "closed" }, { id: "F2", disposition: "fixed-ish" }] }), claims("review-regression", ["slice-01"]), claims("review-style", ["slice-02"])]);
    expect(ledger.scopeReviewed).toBe(false);
    expect(ledger.dispatch.fixSlicesCovered).toBeUndefined();
    expect(gaps.some((g) => g.detail.includes("no disposition from its roster for F2"))).toBe(true);
  });

  test("the vocabulary is the prior-disposition one: closed, open, partial, regressed, withdrawn", () => {
    const parsed = priorDispositionsOf({ prior_dispositions: ["x", { id: "A", disposition: "open" }, { finding: "B", status: "regressed" }, { id: "C", disposition: "fixed" }, { disposition: "closed" }] });
    expect([...parsed]).toEqual([["A", "open"], ["B", "regressed"]]);
    const read = new Map([["review-logic", new Set(["slice-01"])], ["review-regression", new Set(["slice-01"])]]);
    const given = new Map([["review-logic", new Map([["F1", "closed"], ["F2", "open"]])]]);
    expect(fixSliceCoverage({ slices: [fix] }, read, given).covered).toEqual(["slice-01"]);
    expect(fixSliceCoverage({ slices: [{ ...fix, findingIds: [] }] }, read, given).covered).toEqual([]);
    // A reviewer the operator confirmed skipping does not hold the slice open.
    expect(fixSliceCoverage({ slices: [fix] }, new Map([["review-logic", new Set(["slice-01"])]]), given, new Set(["review-regression"])).covered).toEqual(["slice-01"]);
  });
});

describe("coverage of files by a fix slice covered through dispositions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-split-cov-"));
    await mkdir(path.join(dir, "slices"), { recursive: true });
    await writeFile(path.join(dir, "scope-files.json"), `${JSON.stringify({ version: 1, files: ["src/a/a.ts"] })}\n`);
    const entry = { id: "slice-01", path: "slice-01.diff", bytes: 10, files: ["src/a/a.ts"], domain: "src/a", split: "domain", roles: ["review-logic"], kind: "fix", findingIds: ["F1"] };
    await writeFile(path.join(dir, "slices", "manifest.json"), `${JSON.stringify({ schemaVersion: 1, maxBytes: 100, source: "diff", slices: [entry], omissions: [], totals: {} })}\n`);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the file is covered once the ledger records the fix slice as covered, uncovered before", async () => {
    const before = await computeCoverage(dir, { research: { dispatch: { runs: [] } } });
    expect(before.counts.uncovered).toBe(1);
    const after = await computeCoverage(dir, { research: { dispatch: { runs: [], fixSlicesCovered: ["slice-01"] } } });
    expect(after.counts).toMatchObject({ covered: 1, uncovered: 0 });
  });
});

describe("review slice in a delta round", () => {
  const ORIGINAL_CWD = process.cwd();
  const realLog = console.log;
  const realError = console.error;
  let repo: string;
  let base = "";
  let head = "";

  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "200531777+MrCipherSmith@users.noreply.github.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "200531777+MrCipherSmith@users.noreply.github.com" } });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  const lines = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "keryx-split-slice-"));
    await mkdir(path.join(repo, ".metaproject", "reviews", "r2"), { recursive: true });
    await mkdir(path.join(repo, "src", "a"), { recursive: true });
    await mkdir(path.join(repo, "src", "c"), { recursive: true });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "src/a/a.ts"), lines("a", 30));
    await writeFile(path.join(repo, "src/c/c.ts"), lines("c", 3));
    git("add", "-A");
    git("commit", "-q", "-m", "round 1");
    base = git("rev-parse", "HEAD");
    const a = (await readFile(path.join(repo, "src/a/a.ts"), "utf8")).split("\n");
    a[9] = "export const a9 = 99; // the fix";
    await writeFile(path.join(repo, "src/a/a.ts"), a.join("\n"));
    await writeFile(path.join(repo, "src/c/c.ts"), `${lines("c", 3)}${lines("n", 5)}`);
    git("add", "-A");
    git("commit", "-q", "-m", "fix F1 and add c");
    head = git("rev-parse", "HEAD");
    process.chdir(repo);
    console.log = () => {};
    console.error = () => {};
    process.exitCode = 0;
  });
  afterEach(async () => {
    console.log = realLog;
    console.error = realError;
    process.exitCode = 0;
    process.chdir(ORIGINAL_CWD);
    await rm(repo, { recursive: true, force: true });
  });

  const writeRound = async (over: Partial<RoundRecord>): Promise<string> => {
    const pkg = path.join(repo, ".metaproject", "reviews", "r2");
    await writeFile(path.join(pkg, "round.json"), `${JSON.stringify(round({ range: { base, head }, previous: { reviewId: "r1", reviewedHead: base }, ...over }))}\n`);
    await writeFile(path.join(pkg, "prior_findings.json"), `${JSON.stringify(PRIOR)}\n`);
    return pkg;
  };
  const manifestOf = async (pkg: string): Promise<{ slices: SliceEntry[] }> => JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8"));

  test("only the round's range is sliced; the slice with the fix hunk is fix with the fix roster, the rest is new", async () => {
    const pkg = await writeRound({ fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F1"] }], newHunks: [{ file: "src/c/c.ts", startLine: 4, endLine: 8 }] });
    await reviewCommand(["slice", "--package", pkg, "--max-bytes", "500", "--head", head]);
    expect(process.exitCode).toBe(0);
    const { slices } = await manifestOf(pkg);
    const fix = slices.find((s) => s.files.includes("src/a/a.ts"));
    const fresh = slices.find((s) => s.files.includes("src/c/c.ts"));
    expect(fix).toMatchObject({ kind: "fix", findingIds: ["F1"], depth: "deep" });
    expect(fix?.roles).toEqual(expect.arrayContaining(["review-logic", "review-regression", "review-security-code"]));
    expect(fresh?.kind).toBe("new");
    expect(fresh?.findingIds).toBeUndefined();
    expect(fresh?.roles).toContain("review-logic");
    // Unchanged code of the round is not in any slice: only the delta's files are.
    expect([...new Set(slices.flatMap((s) => s.files))].sort()).toEqual(["src/a/a.ts", "src/c/c.ts"]);
  });

  test("a delta slice never exceeds the round-1 slice of the same head under the same exclusions", async () => {
    // Round 1 reviewed `prev`, which added a large block the fix then removed: prev..head carries every removed line,
    // merge-base..head does not. The delta is cut from merge-base..head then, still split fix/new.
    await writeFile(path.join(repo, "src/c/c.ts"), `${lines("c", 3)}${lines("n", 5)}${lines("big", 300)}`);
    git("add", "-A");
    git("commit", "-q", "-m", "round-1 head with a big block");
    const prev = git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/c/c.ts"), `${lines("c", 3)}${lines("n", 5)}export const fixed = 1;\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "fix: drop the block");
    const fixed = git("rev-parse", "HEAD");
    const pkg = await writeRound({ previous: { reviewId: "r1", reviewedHead: prev }, range: { base: prev, head: fixed }, mergeBase: base, fixHunks: [{ file: "src/c/c.ts", startLine: 9, endLine: 9, findingIds: ["F1"] }], newHunks: [] });
    await reviewCommand(["slice", "--package", pkg, "--max-bytes", "100000", "--head", fixed]);
    const delta = JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8")) as SliceManifest;
    const fullDir = path.join(repo, "full-slices");
    await reviewCommand(["slice", "--out", fullDir, "--ref", base, "--max-bytes", "100000", "--head", fixed]);
    const full = JSON.parse(await readFile(path.join(fullDir, "manifest.json"), "utf8")) as SliceManifest;
    expect(delta.totals.bytes).toBeLessThanOrEqual(full.totals.bytes);
    expect(delta.slices.some((slice) => slice.kind === "fix")).toBe(true);

    // The ordinary case: a small fix on top of round 1 is cut from prev..head, smaller than the whole branch.
    const pkg2 = await writeRound({ previous: { reviewId: "r1", reviewedHead: base }, range: { base, head }, mergeBase: base, fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F1"] }], newHunks: [] });
    const cut = await deltaSliceDiff({ range: { base: prev, head: fixed }, mergeBase: base }, 3, async (from) => (from === prev ? "x".repeat(10) : "y".repeat(100)));
    expect(cut).toEqual({ diff: "x".repeat(10) });
    const larger = await deltaSliceDiff({ range: { base: prev, head: fixed }, mergeBase: base }, 3, async (from) => (from === prev ? "x".repeat(100) : "y".repeat(10)));
    expect(larger.diff).toBe("y".repeat(10));
    expect(larger.note).toContain("larger than the round-1 diff");
    expect(pkg2).toBe(pkg);
  });

  test("a round record edited after review start is refused by slice", async () => {
    const pkg = await writeRound({});
    await writeFile(path.join(pkg, "manifest.json"), `${JSON.stringify({ reviewId: "r2", roundRecord: { roundSha256: "0".repeat(64), priorFindingsSha256: "0".repeat(64) } })}\n`);
    const errors: string[] = [];
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    await reviewCommand(["slice", "--package", pkg, "--head", head]).catch((error: unknown) => void errors.push(String(error)));
    expect(errors.join("\n")).toMatch(/changed after `keryx review start`/);
    expect(existsSync(path.join(pkg, "slices", "manifest.json"))).toBe(false);
    process.exitCode = 0;
  });

  test("a first round and a fallback-first round are sliced as before: no kinds", async () => {
    for (const mode of ["first", "fallback-first"] as const) {
      const pkg = await writeRound({ mode, range: { base, head } });
      await reviewCommand(["slice", "--package", pkg, "--ref", base, "--head", head]);
      const { slices } = await manifestOf(pkg);
      expect(slices.length).toBeGreaterThan(0);
      expect(slices.every((s) => s.kind === undefined && s.findingIds === undefined)).toBe(true);
    }
  });
});
