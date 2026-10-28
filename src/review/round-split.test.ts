// Flow 458 AC3 (routing) and AC4: a delta round splits into fix and new slices; coverage, the routing check, the
// estimate and the ledger count both kinds, each against its own roster.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { deltaSliceDiff } from "../commands/review-slice";
import { computeCoverage } from "./coverage-complete";
import { estimateRound } from "./estimate";
import { buildLedger, type LedgerInputs, type RawFile } from "./ledger";
import { type PriorFinding, type RoundRecord } from "./round-record";
import { classifyDeltaSlices, expectedFixRoles, fixClaimBacked, fixContentRoles, fixRosterRoles, fixSliceCoverage, fixSliceRoles, fixSliceRoster, isDeltaRound, manifestRosterRoles, isSecurityFinding, partitionRegionsByFix, priorDispositionsOf, splitCounts } from "./round-split";
import { narrowedSlices } from "./routing-check";
import type { ScopedRegion } from "./scope";
import { buildSlices, parseScopedDiff, type SliceEntry, type SliceManifest } from "./slice";
import { routeSliceRegions, routeSlices } from "./slice-routing";
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

  test("a security finding brings the code-level security reviewer, whoever authored it", () => {
    const traversal: PriorFinding = { ...prior("L1", "review-logic"), problem: "a user path escapes the root (path traversal)" };
    const secId: PriorFinding = { ...prior("review-style-w1:SEC-002", "review-style"), problem: "p" };
    const plain: PriorFinding = { ...prior("L2", "review-logic"), problem: "off by one in the loop" };
    expect(isSecurityFinding(traversal)).toBe(true);
    expect(isSecurityFinding(secId)).toBe(true);
    expect(isSecurityFinding(plain)).toBe(false);
    expect(fixRosterRoles(["L1"], [traversal])).toEqual(["review-logic", "review-regression", "review-security-code"]);
    expect(fixRosterRoles(["review-style-w1:SEC-002"], [secId])).toEqual(["review-logic", "review-regression", "review-security-code", "review-style"]);
    expect(fixRosterRoles(["L2"], [plain])).toEqual(["review-logic", "review-regression"]);
  });

  test("security classes a non-security reviewer names in other words still count; a literal next to its own stem is gone (SEC-002)", () => {
    for (const problem of ["builds a shell string from the ref", "spawns git with a user-controlled argv", "a symlink lets the write escape the package", "TOCTOU between stat and open", "a ReDoS on a crafted ref", "prototype pollution through the merged JSON", "unsanitized input reaches the SQL", "the secret leaks into the log", "deserialization of untrusted YAML"]) {
      expect(isSecurityFinding({ id: "L9", reviewer: "review-logic", problem })).toBe(true);
    }
    for (const problem of ["off by one in the loop", "the execution id is not unique", "a memory leak in the cache", "keryx shell prints the wrong path"]) {
      expect(isSecurityFinding({ id: "L9", reviewer: "review-logic", problem })).toBe(false);
    }
  });
});

describe("fix slice content roles (flow 458 M3, restored in 460 round 2)", () => {
  test("a fix whose own lines spawn a process or build a git argv brings review-security-code; plain fix lines bring nothing", () => {
    expect(fixContentRoles(region("src/a/a.ts", 10, 10, "+  return Bun.spawn(cmd);"))).toContain("review-security-code");
    expect(fixContentRoles(region("src/a/a.ts", 10, 10, "+  await runGit(cwd, [\"diff\", ref]);"))).toContain("review-security-code");
    expect(fixContentRoles(region("src/a/a.ts", 10, 10, "+  return total + 1;"))).toEqual([]);
    // Content roles only, not the deep roster of the file: no backend, frontend or style reviewer.
    const roles = fixContentRoles(region("src/a/a.ts", 10, 10, "+  return Bun.spawn(cmd);"));
    expect(roles.some((role) => ["review-backend", "review-frontend", "review-style"].includes(role))).toBe(false);
  });
});

describe("fix slice routes the degradation reviewer only on a shared symbol (flow 479 AC6)", () => {
  test("a fix that changes an exported symbol brings review-degradation; a fix inside a function body does not", () => {
    expect(fixContentRoles(region("src/a/a.ts", 10, 10, "+export const LABEL = 'n/a';"))).toContain("review-degradation");
    expect(fixContentRoles(region("src/a/a.ts", 10, 10, "+  return total + 1;"))).not.toContain("review-degradation");
  });

  test("the roster of a fix slice is the finding roster united with it, and the base roster never carries it", () => {
    expect(fixRosterRoles(["F2"], PRIOR)).not.toContain("review-degradation");
    expect(fixSliceRoster(["F2"], PRIOR, region("src/a/a.ts", 10, 10, "+  return total + 1;"))).toEqual(["review-architecture", "review-logic", "review-regression"]);
    expect(fixSliceRoster(["F2"], PRIOR, region("src/a/a.ts", 10, 10, "+export const LABEL = 'n/a';"))).toEqual(["review-architecture", "review-degradation", "review-logic", "review-regression"]);
  });
});

describe("partitionRegionsByFix (flow 460 L6)", () => {
  const scoped = (file: string, startLine: number, body: string): ScopedRegion => {
    const lines = body.split("\n");
    return { path: file, startLine, endLine: startLine + lines.filter((line) => !line.startsWith("-")).length - 1, changedLines: lines.filter((line) => /^[+-]/.test(line)).length, contextTruncated: false, text: body };
  };
  const hunks = [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F1"] }];

  test("a region holding a fix change and an unrelated new change is cut between them; context is shared", () => {
    // Lines 8..16: the fix replaces line 10, a new line is added at 14.
    const body = [" l8", " l9", "-old10", "+fix10", " l11", " l12", " l13", "+new14", " l15", " l16"].join("\n");
    const { fix, other } = partitionRegionsByFix([scoped("src/a/a.ts", 8, body)], hunks);
    expect(fix).toHaveLength(1);
    expect(other).toHaveLength(1);
    expect(fix[0]).toMatchObject({ path: "src/a/a.ts", startLine: 8, changedLines: 2 });
    expect(fix[0]!.text).toContain("+fix10");
    expect(fix[0]!.text).not.toContain("+new14");
    expect(other[0]!.text).toContain("+new14");
    expect(other[0]!.text).not.toContain("fix10");
    // The two pieces cover the region's lines exactly once, in order.
    expect(`${fix[0]!.text}\n${other[0]!.text}`).toBe(body);
    expect(other[0]!.startLine).toBe(fix[0]!.endLine + 1);
    expect(other[0]!.endLine).toBe(16);
  });

  test("each piece of a cut region says its context is truncated: the neighbour kept part of the window (LG-002)", () => {
    const body = [" l8", " l9", "-old10", "+fix10", " l11", " l12", " l13", "+new14", " l15", " l16"].join("\n");
    const { fix, other } = partitionRegionsByFix([scoped("src/a/a.ts", 8, body)], hunks);
    expect(fix[0]!.contextTruncated).toBe(true);
    expect(other[0]!.contextTruncated).toBe(true);
    expect(partitionRegionsByFix([scoped("src/a/a.ts", 9, " l9\n+fix10\n l11")], hunks).fix[0]!.contextTruncated).toBe(false);
  });

  test("a large mixed region is labelled in linear time and every line lands in exactly one piece", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => (i % 2 === 0 ? `+n${i}` : ` c${i}`));
    const body = [" l9", "+fix10", ...many].join("\n");
    const { fix, other } = partitionRegionsByFix([scoped("src/a/a.ts", 9, body)], hunks);
    expect([...fix, ...other].map((piece) => piece.text).join("\n")).toBe(body);
    expect(fix).toHaveLength(1);
  });

  test("a region of only fix lines, or only new lines, is kept whole; another file's change is new", () => {
    const onlyFix = scoped("src/a/a.ts", 9, " l9\n+fix10\n l11");
    const onlyNew = scoped("src/a/a.ts", 20, " l20\n+new21");
    const elsewhere = scoped("src/b/b.ts", 9, " l9\n+x10");
    expect(partitionRegionsByFix([onlyFix, onlyNew, elsewhere], hunks)).toEqual({ fix: [onlyFix], other: [onlyNew, elsewhere] });
  });

  test("a pure deletion right after a fix hunk's line counts as in it (git records it at the line before)", () => {
    const deletion = scoped("src/a/a.ts", 10, " l10\n-gone");
    expect(partitionRegionsByFix([deletion], hunks).fix).toEqual([deletion]);
  });

  test("a deletion one line past the hunk, or before its start, is new (TP-006): the tolerance is one line, on one side", () => {
    const past = scoped("src/a/a.ts", 11, " l11\n-gone");
    expect(partitionRegionsByFix([past], hunks)).toEqual({ fix: [], other: [past] });
    const before = scoped("src/a/a.ts", 8, " l8\n-gone\n l9");
    expect(partitionRegionsByFix([before], hunks)).toEqual({ fix: [], other: [before] });
  });
});

describe("delta round", () => {
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

  test("a fix slice whose own line spawns a process gets review-security-code although no finding it answers is a security one (458 M3)", () => {
    const [fix] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 10, 10, "+  return Bun.spawn(cmd);"))], round({ fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F2"] }] }), PRIOR);
    expect(fix).toMatchObject({ kind: "fix", findingIds: ["F2"] });
    expect(fix!.roles).toEqual(expect.arrayContaining(["review-architecture", "review-logic", "review-regression", "review-security-code"]));
    expect(fix!.roles).not.toContain("review-style");
  });

  test("a slice whose changed lines all lie in fix hunks is fix with exactly the fix roster; every other slice is new and keeps its routing", () => {
    const slices = [
      entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 10, 10)),
      entry("slice-02", ["src/c/c.ts"], region("src/c/c.ts", 1, 3)),
    ];
    const [fix, fresh] = classifyDeltaSlices(slices, round(), PRIOR);
    // Flow 460 L6: no union with the slice's round-1 routing — style and performance do not ride along on a fix slice.
    expect(fix).toMatchObject({ kind: "fix", findingIds: ["F1"], roles: ["review-logic", "review-regression", "review-security-code"], depth: "deep" });
    expect(fresh).toMatchObject({ kind: "new", roles: ["review-logic", "review-style", "review-performance"], depth: "light" });
    expect(fresh?.findingIds).toBeUndefined();
  });

  test("a region whose changed lines miss the fix hunk leaves the slice new, even when its context spans it; the audit mark of a fix slice is dropped", () => {
    const [outside] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 40, 45))], round(), PRIOR);
    expect(outside?.kind).toBe("new");
    const [spanning] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 7, 13, "+const x = 1;\n a\n b\n c\n d"))], round(), PRIOR);
    expect(spanning?.kind).toBe("new");
    const [audited] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 10, 10), { audit: true, escalated: { by: "x", finding: "y" } })], round(), PRIOR);
    expect(audited?.kind).toBe("fix");
    expect(audited?.audit).toBeUndefined();
    expect(audited?.escalated).toBeUndefined();
  });

  test("a slice mixing a fix line with a new line is new: its new line is owed round-1 routing", () => {
    const [mixed] = classifyDeltaSlices([entry("slice-01", ["src/a/a.ts"], region("src/a/a.ts", 9, 11, " a\n+const fix = 1;\n+const fresh = 2;"))], round(), PRIOR);
    expect(mixed).toMatchObject({ kind: "new", roles: ["review-logic", "review-style", "review-performance"], depth: "light" });
  });

  test("a retry piece is left as it is", () => {
    const [piece] = classifyDeltaSlices([entry("r1-x-01", ["src/a/a.ts"], region("src/a/a.ts", 10, 10), { retryOf: ["slice-01"] })], round(), PRIOR);
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

  test("a slice routed to the security reviewer adds it to the roster in a light round too; another routed role does not (SEC-R3-001)", () => {
    // A light round's required set is path-only: a new slice that spawns a process is routed to review-security-code by
    // its content, and the roster (drivers, plan.json, ledger) must dispatch it.
    const light = manifest([{ ...plain(newSlice), roles: ["review-logic", "review-security-code", "review-backend"] }]);
    expect(manifestRosterRoles(light)).toEqual(["review-security-code"]);
    expect(estimateRound(["review-logic", ...manifestRosterRoles(light)], light).perRole.find((r) => r.role === "review-security-code")?.waves).toBe(1);
    // A retry piece adds nothing of its own; the fix roster is still part of it.
    expect(manifestRosterRoles(manifest([{ ...plain(newSlice), id: "r1", roles: ["review-security-code"], retryOf: ["slice-02"] }]))).toEqual([]);
    expect(manifestRosterRoles(m)).toEqual(fixSliceRoles(m));
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

describe("a #1045-shaped fix delta (flow 460 L6)", () => {
  // Round 2 of a TypeScript CLI pull request: 33 fix hunks over 12 source files answering findings of 10 round-1 authors,
  // each fix line code the round-1 router would send to many roles (fs, spawn, exports, loops).
  const AUTHORS = ["review-architecture", "review-clean-code", "review-core-boundaries", "review-highload", "review-logic", "review-performance", "review-regression", "review-security-code", "review-style", "review-testing-practices"];
  const files = Array.from({ length: 12 }, (_, i) => `src/review/mod${i}.ts`);
  const fixHunks = files.flatMap((file, f) => [0, 1, 2].map((h) => ({ file, startLine: 20 + h * 40, endLine: 21 + h * 40, findingIds: [`${AUTHORS[(f * 3 + h) % AUTHORS.length]}-w1:F-${f}-${h}`] }))).slice(0, 33);
  const prior33: PriorFinding[] = fixHunks.map((hunk) => ({ ...prior(hunk.findingIds[0]!, hunk.findingIds[0]!.split("-w1:")[0]!, hunk.file), line: hunk.startLine, problem: "p" }));
  const regions: ScopedRegion[] = fixHunks.map((hunk) => ({
    path: hunk.file,
    startLine: hunk.startLine - 3,
    endLine: hunk.endLine + 3,
    changedLines: 4,
    contextTruncated: false,
    text: [" a", " b", " c", "-  old();", "-  old2();", `+  export async function f${hunk.startLine}(dir: string) { const out = readFileSync(path.join(dir, name)); while (true) { await Promise.all([spawn(cmd)]); } }`, "+  return out.sort();", " d", " e", " f"].join("\n"),
  }));
  const ROUND1_ROSTER = AUTHORS;

  test("its fix slices carry exactly the fix roster, no backend or frontend reviewer joins, and the plan stays under 40 dispatches", () => {
    const deltaRound = round({ fixHunks });
    const parts = partitionRegionsByFix(regions, fixHunks);
    expect(parts.other).toEqual([]);
    const built = buildSlices({ source: "scoped-diff", regions: parts.fix, drops: [] }, { maxBytes: 150_000, waveBytes: 150_000 });
    const classified = classifyDeltaSlices(routeSlices(built.slices, { head: "h" }), deltaRound, prior33);
    expect(classified.every((s) => s.kind === "fix")).toBe(true);
    // The fix roster united with the fix lines' own content roles (458 M3): never the deep round-1 roster.
    for (const s of classified) expect(s.roles).toEqual([...new Set([...fixRosterRoles(s.findingIds ?? [], prior33), ...fixContentRoles(s.text)])].sort());
    // What round-1 routing would have given the same slices (the old union): wider than the fix roster.
    const contentRoles = new Set(routeSlices(built.slices, { head: "h" }).flatMap((s) => s.roles ?? []));
    expect(contentRoles.has("review-backend") || contentRoles.has("review-frontend")).toBe(true);
    const manifest: SliceManifest = { ...built.manifest, slices: classified.map(({ text: _text, ...entry }) => entry) };
    const roster = [...new Set([...ROUND1_ROSTER, ...fixSliceRoles(manifest)])].sort();
    expect(roster).not.toContain("review-backend");
    expect(roster).not.toContain("review-frontend");
    const estimate = estimateRound(roster, manifest);
    expect(estimate.split?.fix.slices).toBe(classified.length);
    expect(estimate.split?.new).toEqual({ slices: 0, dispatches: 0 });
    expect(estimate.dispatches).toBeLessThanOrEqual(40);
    expect(estimate.overThreshold).toBe(false);
  });
});

describe("routing check accepts fix rosters", () => {
  // The fix hunk covers lines 10-11 and names F1 (security-code) and F2 (architecture).
  const text = region("src/a/a.ts", 10, 11, "+eval(userInput);\n+child_process.exec(cmd);");
  const slice = (extra: Partial<SliceEntry>): SliceEntry => ({ id: "slice-01", path: "slice-01.diff", bytes: 100, files: ["src/a/a.ts"], domain: "src/a", split: "domain", kind: "fix", findingIds: ["F1", "F2"], ...extra });
  const context = { round: round({ fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 11, findingIds: ["F1", "F2"] }] }), prior: PRIOR };
  const read = () => text;

  const contentRoles = routeSliceRegions("slice-01", parseScopedDiff(text), { changedFiles: ["src/a/a.ts"] }).roles;
  const FIX_ROSTER = ["review-architecture", "review-logic", "review-regression", "review-security-code"];

  test("a backed fix slice is held to the fix roster plus its content roles (flow 460 L6, 458 M3): the deep round-1 roster is not owed", () => {
    expect(expectedFixRoles({ findingIds: ["F1", "F2"] }, context, text)).toEqual(FIX_ROSTER);
    // The content would route more roles as a round-1 slice; a fix slice needs none of them.
    expect(contentRoles.some((role) => !FIX_ROSTER.includes(role))).toBe(true);
    const fixOnly = slice({ roles: FIX_ROSTER, depth: "deep" });
    expect(narrowedSlices({ slices: [fixOnly] }, read, context).narrowed).toEqual([]);
    // A fix slice is read deep.
    expect(narrowedSlices({ slices: [{ ...fixOnly, depth: "light" }] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: [], depth: { recorded: "light", needed: "deep" } }]);
  });

  test("a fix slice whose content routes review-security-code is narrowed without it, although its findings are not security ones", () => {
    const spawnText = region("src/a/a.ts", 10, 10, "+  return Bun.spawn(cmd);");
    const ctx = { round: round({ fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F2"] }] }), prior: PRIOR };
    const entryOf = (roles: string[]): SliceEntry => ({ id: "slice-01", path: "slice-01.diff", bytes: 100, files: ["src/a/a.ts"], domain: "src/a", split: "domain", kind: "fix", findingIds: ["F2"], roles, depth: "deep" });
    expect(expectedFixRoles({ findingIds: ["F2"] }, ctx, spawnText)).toContain("review-security-code");
    expect(narrowedSlices({ slices: [entryOf(["review-architecture", "review-logic", "review-regression"])] }, () => spawnText, ctx).narrowed).toEqual([{ id: "slice-01", missingRoles: ["review-security-code"] }]);
    expect(narrowedSlices({ slices: [entryOf(expectedFixRoles({ findingIds: ["F2"] }, ctx, spawnText))] }, () => spawnText, ctx).narrowed).toEqual([]);
  });

  test("a fix slice missing an author of its finding is narrowed, also when the manifest dropped that finding's id", () => {
    const fix = slice({ roles: FIX_ROSTER.filter((role) => role !== "review-security-code"), depth: "deep" });
    expect(narrowedSlices({ slices: [fix] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: ["review-security-code"] }]);
    // F2 dropped from the manifest: the text still touches F2's hunk, so its author is still owed.
    const dropped = slice({ findingIds: ["F1"], roles: ["review-logic", "review-regression", "review-security-code"], depth: "deep" });
    expect(narrowedSlices({ slices: [dropped] }, read, context).narrowed).toEqual([{ id: "slice-01", missingRoles: ["review-architecture"] }]);
  });

  test("tagging a slice fix does not narrow it: the round must back the claim, line by line", () => {
    expect(fixClaimBacked(slice({}), context, text)).toBe(true);
    expect(fixClaimBacked(slice({ findingIds: ["F7"] }), context, text)).toBe(false);
    expect(fixClaimBacked(slice({ files: ["src/z/z.ts"] }), context, text)).toBe(false);
    expect(fixClaimBacked(slice({ findingIds: [] }), context, text)).toBe(false);
    expect(fixClaimBacked(slice({}), { round: round({ mode: "first" }), prior: PRIOR }, text)).toBe(false);
    expect(fixClaimBacked(slice({}), undefined, text)).toBe(false);
    const forged = slice({ findingIds: ["F7"], roles: ["review-logic", "review-regression"], depth: "deep" });
    expect(narrowedSlices({ slices: [forged] }, read, context).narrowed.length).toBe(1);
  });

  test("a slice tagged fix that carries a new line is judged as a new slice: the fix roster alone is narrowed", () => {
    const withNew = region("src/a/a.ts", 10, 12, "+eval(userInput);\n+child_process.exec(cmd);\n+export function fresh() { return spawn(cmd); }");
    expect(fixClaimBacked(slice({}), context, withNew)).toBe(false);
    const needed = routeSliceRegions("slice-01", parseScopedDiff(withNew), { changedFiles: ["src/a/a.ts"] }).roles;
    const narrowed = narrowedSlices({ slices: [slice({ roles: FIX_ROSTER, depth: "deep" })] }, () => withNew, context).narrowed;
    expect(narrowed).toEqual([{ id: "slice-01", missingRoles: needed.filter((role) => !FIX_ROSTER.includes(role)).sort() }]);
    expect(narrowed[0]!.missingRoles.length).toBeGreaterThan(0);
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

  test("a fix hunk and an unrelated new hunk of the same file: one fix slice with the fix roster, one new slice with round-1 roles (flow 460 L6)", async () => {
    const a = (await readFile(path.join(repo, "src/a/a.ts"), "utf8")).split("\n");
    a[13] = "export function fresh(cmd: string[]) { return Bun.spawn(cmd); }";
    await writeFile(path.join(repo, "src/a/a.ts"), a.join("\n"));
    git("add", "-A");
    git("commit", "-q", "-m", "a new function next to the fix");
    const head2 = git("rev-parse", "HEAD");
    const pkg = await writeRound({ range: { base, head: head2 }, fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F2"] }], newHunks: [{ file: "src/a/a.ts", startLine: 14, endLine: 14 }, { file: "src/c/c.ts", startLine: 4, endLine: 8 }] });
    await reviewCommand(["slice", "--package", pkg, "--max-bytes", "100000", "--head", head2]);
    expect(process.exitCode).toBe(0);
    const { slices } = await manifestOf(pkg);
    const fixes = slices.filter((s) => s.kind === "fix");
    expect(fixes).toHaveLength(1);
    // The fix roster: logic, regression, F2's author; the fix line's own content (an export) routes architecture, F2's
    // author already, and the degradation reviewer (a shared symbol changed; flow 479 AC6). The deep round-1 roster of the file does not ride along.
    expect(fixes[0]).toMatchObject({ files: ["src/a/a.ts"], findingIds: ["F2"], depth: "deep", roles: ["review-architecture", "review-degradation", "review-logic", "review-regression"] });
    const fixText = await readFile(path.join(pkg, "slices", fixes[0]!.path), "utf8");
    expect(fixText).toContain("a9 = 99");
    expect(fixText).not.toContain("Bun.spawn");
    // The new function in the same file is in a new slice, routed as in round 1: the spawn brings security-code.
    const freshA = slices.find((s) => s.kind === "new" && s.files.includes("src/a/a.ts"));
    expect(freshA).toBeDefined();
    const freshText = await readFile(path.join(pkg, "slices", freshA!.path), "utf8");
    expect(freshText).toContain("Bun.spawn");
    expect(freshText).not.toContain("+export const a9 = 99");
    expect(freshA!.roles).toEqual(routeSliceRegions(freshA!.id, parseScopedDiff(freshText), { changedFiles: ["src/a/a.ts", "src/c/c.ts"] }).roles);
    expect(freshA!.roles).toEqual(expect.arrayContaining(["review-logic", "review-security-code"]));
    // The routing check accepts the manifest as written.
    expect(narrowedSlices({ slices }, (entry) => readFileSync(path.join(pkg, "slices", entry.path), "utf8"), { round: JSON.parse(await readFile(path.join(pkg, "round.json"), "utf8")) as RoundRecord, prior: PRIOR }).narrowed).toEqual([]);
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
    // Bytes of the diff lines read, without section headers: the fix/new cut (flow 460 L6) may split one window into two
    // sections, which repeats a header but never a line of the diff. A header is a `--- path` line directly followed by
    // its `@@ a,b @@` line (the scoped format's section structure), so a removed `-- comment` line still counts.
    const bodyBytes = async (dir: string, m: SliceManifest): Promise<number> => {
      let bytes = 0;
      for (const s of m.slices) {
        const lines = (await readFile(path.join(dir, s.path), "utf8")).split("\n");
        lines.forEach((line, index) => {
          const header = /^@@ \d+,\d+ @@$/.test(line) || (line.startsWith("--- ") && /^@@ \d+,\d+ @@$/.test(lines[index + 1] ?? ""));
          if (line !== "" && !header) bytes += Buffer.byteLength(line) + 1;
        });
      }
      return bytes;
    };
    expect(await bodyBytes(path.join(pkg, "slices"), delta)).toBeLessThanOrEqual(await bodyBytes(fullDir, full));
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
