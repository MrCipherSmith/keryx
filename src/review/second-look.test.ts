// Flow 458 "cheap second look" and its neighbours: code unchanged since the previous round gets one more pass by logic and
// security-code (kind second-look), or full round-1 treatment when the previous round was weak; an empty range is refused
// loudly; a first-round slice leaves committed review packages out. Throwaway git repositories, no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { renumberSlices, secondLookSource } from "../commands/review-slice";
import { emptyRangeWarning, findPreviousRound, resolveBase, subtractHunks, defaultGitRunner, weakReasons, type PriorRoundDeps, type RoundCandidate } from "./prior-round";
import { previousRoundFacts, type RoundRecord } from "./round-record";
import { estimateRound } from "./estimate";
import { fixSliceRoles, secondLookClaimBacked, splitCounts, tagSecondLookSlices } from "./round-split";
import { narrowedSlices } from "./routing-check";
import type { SliceEntry, SliceManifest } from "./slice";

const PR = "https://github.com/acme/app/pull/7";
const TARGET = { kind: "pr", ref: PR };
const offline: PriorRoundDeps["github"] = async () => ({ status: "not-consulted", detail: "offline (test)" });

describe("subtractHunks", () => {
  test("cuts the covered lines out of a hunk, per file", () => {
    const from = [{ file: "a.ts", startLine: 5, endLine: 20 }, { file: "b.ts", startLine: 1, endLine: 3 }];
    const remove = [{ file: "a.ts", startLine: 8, endLine: 10 }, { file: "a.ts", startLine: 18, endLine: 30 }, { file: "c.ts", startLine: 1, endLine: 99 }];
    expect(subtractHunks(from, remove)).toEqual([
      { file: "a.ts", startLine: 5, endLine: 7 },
      { file: "a.ts", startLine: 11, endLine: 17 },
      { file: "b.ts", startLine: 1, endLine: 3 },
    ]);
    expect(subtractHunks([{ file: "a.ts", startLine: 5, endLine: 6 }], [{ file: "a.ts", startLine: 1, endLine: 10 }])).toEqual([]);
  });
});

describe("previousRoundFacts", () => {
  test("only a ledger that ran and proved coverage is not weak; an empty ingest ledger proves nothing", () => {
    expect(previousRoundFacts({ version: 1, scopeReviewed: false, obligations: [] }, undefined).weak[0]).toContain("no ledger dispatch block");
    expect(previousRoundFacts({ scopeReviewed: true, dispatch: { runs: [] } }, undefined).weak).toEqual([]);
    expect(previousRoundFacts({ dispatch: { runs: [] } }, undefined).weak[0]).toContain("unproven");
    expect(previousRoundFacts({ scopeReviewed: false, dispatch: { runs: [] } }, undefined).weak[0]).toContain("coverage incomplete");
    expect(previousRoundFacts({ scopeReviewed: true, dispatch: { skipped: [{ reviewer: "review-security-code", reason: "x" }] } }, undefined).weak[0]).toContain("review-security-code");
    expect(previousRoundFacts({ scopeReviewed: true, dispatch: { notRun: ["Not run: mutation (light round)"] } }, undefined).weak).toEqual([]);
    expect(previousRoundFacts({ scopeReviewed: true, dispatch: { notRun: ["Not run: review-logic — timeout"] } }, undefined).weak[0]).toContain("Not run");
    expect(previousRoundFacts(undefined, { mergeBase: "abc1234" }).mergeBase).toBe("abc1234");
  });
});

describe("a delta round's second look, on a throwaway repository", () => {
  let root: string;
  const originalCwd = process.cwd();
  let base = "";
  let reviewed = "";
  let head = "";

  const git = (...args: string[]): string => {
    const email = "200531777+MrCipherSmith@users.noreply.github.com";
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    git("add", "--", ...Object.keys(files));
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const lines = (n: number, tag = "l"): string => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join("\n") + "\n";
  const replaceLine = (text: string, line: number, value: string): string => text.split("\n").map((entry, i) => (i + 1 === line ? value : entry)).join("\n");
  const writePackage = (id: string, extra: Record<string, unknown> = {}): void => {
    write(`.metaproject/reviews/${id}/manifest.json`, JSON.stringify({ schemaVersion: 1, reviewId: id, mode: "review-flow", status: "closed", target: { kind: "pr", ref: PR, head: reviewed }, createdAt: "2026-10-01T00:00:00.000Z" }));
    write(`.metaproject/reviews/${id}/findings.json`, "[]");
    for (const [file, content] of Object.entries(extra)) write(`.metaproject/reviews/${id}/${file}`, JSON.stringify(content));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "keryx-second-look-"));
    git("init", "-q", "-b", "main");
    base = commit("base", { "src/a/a.ts": lines(200), "README.md": "x\n" });
    git("checkout", "-q", "-b", "feature");
    // Round 1 reviewed this commit: it changes a.ts line 10 and adds c.ts.
    reviewed = commit("feature", { "src/a/a.ts": replaceLine(lines(200), 10, "export const l10 = 100; // round 1"), "src/c/c.ts": lines(6, "c") });
    // The fix after round 1 touches only line 190 (far enough from line 10 that the two never share a region).
    head = commit("fix", { "src/a/a.ts": replaceLine(replaceLine(lines(200), 10, "export const l10 = 100; // round 1"), 190, "export const l190 = 500; // the fix") });
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  const GOOD_LEDGER = { "research.json": { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: { runs: [] } }, "round.json": { v: 1, round: 1, mergeBase: undefined } };

  test("a previous round with no ledger dispatch block, or an unproven scopeReviewed, or a null merge-base, is weak", async () => {
    writePackage("r1", {});
    const none = await findPreviousRound(TARGET, head, { cwd: root, github: offline, registry: [] });
    expect(none.round.weakPrevious).toContain("no ledger dispatch block");
    expect(none.round.secondLookHunks).toBeUndefined();
    const git2 = defaultGitRunner(root);
    const resolved = (await resolveBase(git2, TARGET, head))!;
    const candidate = { source: "local-package", reviewId: "r1", reviewedHead: reviewed, round: 1, at: 0, findings: [], completed: { ok: true, why: "x" }, weak: [], prevMergeBase: null } as RoundCandidate;
    expect((await weakReasons(git2, candidate, resolved))[0]).toContain("no merge-base");
  });

  test("unchanged code of merge-base..head becomes second-look hunks; the delta stays new", async () => {
    writePackage("r1", GOOD_LEDGER);
    const { round } = await findPreviousRound(TARGET, head, { cwd: root, github: offline, registry: [] });
    expect(round).toMatchObject({ mode: "delta", range: { base: reviewed, head }, mergeBase: base });
    expect(round.newHunks.map((h) => [h.file, h.startLine, h.endLine])).toEqual([["src/a/a.ts", 190, 190]]);
    const second = round.secondLookHunks ?? [];
    expect(second.map((h) => h.file).sort()).toEqual(["src/a/a.ts", "src/c/c.ts"]);
    expect(second.find((h) => h.file === "src/a/a.ts")).toMatchObject({ startLine: 10, endLine: 10 });
    expect(round.weakPrevious).toBeUndefined();
  });

  test("a weak previous round (uncovered slices in its ledger): the unchanged code is new, and round.json says why", async () => {
    writePackage("r1", { "research.json": { version: 1, scopeReviewed: false, rawReconciled: true, obligations: [], dispatch: { runs: [] } } });
    const { round } = await findPreviousRound(TARGET, head, { cwd: root, github: offline, registry: [] });
    expect(round.mode).toBe("delta");
    expect(round.secondLookHunks).toBeUndefined();
    expect(round.weakPrevious).toContain("previous round weak: coverage incomplete");
    expect(round.modeReason).toContain("previous round weak");
    expect(round.newHunks.map((h) => h.file).sort()).toEqual(["src/a/a.ts", "src/a/a.ts", "src/c/c.ts"]);
  });

  test("a previous round that reviewed a narrower scope (its merge-base is not this one or older) is weak", async () => {
    const candidate = { source: "local-package", reviewId: "r1", reviewedHead: reviewed, round: 1, at: 0, findings: [], completed: { ok: true, why: "x" }, weak: [], prevMergeBase: head } as RoundCandidate;
    const git2 = defaultGitRunner(root);
    const resolved = (await resolveBase(git2, TARGET, head))!;
    // head is a descendant of the current merge-base, so it is not "this one or older".
    expect((await weakReasons(git2, candidate, resolved))[0]).toContain("scope narrower");
    expect(await weakReasons(git2, { ...candidate, prevMergeBase: base }, resolved)).toEqual([]);
    expect((await weakReasons(git2, { ...candidate, prevMergeBase: undefined, completed: { ok: false, why: "no completion evidence" } }, resolved))[0]).toContain("not completed");
  });

  test("review slice cuts second-look slices apart from the delta: kind, roster, one sequence of ids", async () => {
    writePackage("r1", GOOD_LEDGER);
    const { round, priorFindings } = await findPreviousRound(TARGET, head, { cwd: root, github: offline, registry: [] });
    const record: RoundRecord = round;
    const pkg = path.join(root, ".metaproject/reviews/r2");
    write(".metaproject/reviews/r2/manifest.json", JSON.stringify({ schemaVersion: 1, reviewId: "r2", target: { kind: "pr", ref: PR, head } }));
    write(".metaproject/reviews/r2/round.json", `${JSON.stringify(record)}\n`);
    write(".metaproject/reviews/r2/prior_findings.json", `${JSON.stringify(priorFindings)}\n`);
    process.chdir(root);
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await reviewCommand(["slice", "--package", pkg, "--head", head, "--max-bytes", "100000"]);
    } finally {
      console.log = log;
      console.error = err;
    }
    const manifest = JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8")) as SliceManifest;
    const kinds = manifest.slices.map((slice) => slice.kind);
    expect(kinds).toContain("new");
    expect(kinds).toContain("second-look");
    const secondLook = manifest.slices.filter((slice) => slice.kind === "second-look");
    for (const slice of secondLook) expect(slice.roles).toEqual(["review-logic", "review-security-code"]);
    expect(manifest.slices.map((slice) => slice.id)).toEqual(manifest.slices.map((_, i) => `slice-${String(i + 1).padStart(2, "0")}`));
    expect(manifest.totals.slices).toBe(manifest.slices.length);
    // The delta slice holds the fix at line 50 only; the second-look slices hold lines 10 and c.ts.
    const newSlice = manifest.slices.find((slice) => slice.kind === "new")!;
    expect(readFileSync(path.join(pkg, "slices", newSlice.path), "utf8")).toContain("the fix");
    expect(readFileSync(path.join(pkg, "slices", secondLook[0]!.path), "utf8")).not.toContain("the fix");
    // The routing check backs the claim from the round, so the narrower roster is not "narrowed".
    const readText = (entry: SliceEntry): string | undefined => readFileSync(path.join(pkg, "slices", entry.path), "utf8");
    expect(narrowedSlices(manifest, readText, { round: record, prior: priorFindings }).narrowed).toEqual([]);
    // Unbacked (a round with no second-look hunks): judged as a new slice, so the narrow roster is refused.
    expect(narrowedSlices(manifest, readText, { round: { ...record, secondLookHunks: [] }, prior: priorFindings }).narrowed.length).toBeGreaterThan(0);
    expect(fixSliceRoles(manifest)).toEqual(expect.arrayContaining(["review-logic", "review-security-code"]));
  });

  test("secondLookSource keeps only the regions overlapping the second-look hunks", async () => {
    process.chdir(root);
    const source = await secondLookSource({ range: { base: reviewed, head }, mergeBase: base, secondLookHunks: [{ file: "src/c/c.ts", startLine: 1, endLine: 6 }] }, 3, undefined);
    expect(source?.regions.map((region) => region.path)).toEqual(["src/c/c.ts"]);
    expect(await secondLookSource({ range: { base: reviewed, head }, mergeBase: base }, 3, undefined)).toBeUndefined();
  });

  test("a weak previous round is sliced over merge-base..head: unchanged code reads as new", async () => {
    const { deltaSliceDiff } = await import("../commands/review-slice");
    const cut = await deltaSliceDiff({ range: { base: reviewed, head }, mergeBase: base, weakPrevious: "previous round weak: x" }, 3, async (from) => `from ${from}`);
    expect(cut.diff).toBe(`from ${base}`);
    expect(cut.note).toContain("previous round weak");
  });

  describe("a merged pull request", () => {
    test("the merge-base from origin/main is the head: the recorded base wins, and with none the range is flagged empty", async () => {
      git("checkout", "-q", "main");
      git("merge", "-q", "--ff-only", "feature");
      const git2 = defaultGitRunner(root);
      // main now holds the head: merge-base(main, head) == head.
      const none = await resolveBase(git2, TARGET, head);
      expect(none?.sha).toBe(head);
      expect(emptyRangeWarning(none, head)).toContain("empty review range");
      expect(emptyRangeWarning(none, head)).toContain(head.slice(0, 12));
      const { round } = await findPreviousRound(TARGET, head, { cwd: root, github: offline, registry: [] });
      expect(round.warnings?.[0]).toContain("empty review range");
      const recorded = await resolveBase(git2, { ...TARGET, base }, head);
      expect(recorded).toEqual({ ref: base, sha: base });
      const planned = await findPreviousRound({ ...TARGET, base }, head, { cwd: root, github: offline, registry: [] });
      expect(planned.round.warnings).toBeUndefined();
      expect(planned.round.range.base).toBe(base);
      expect(planned.round.newHunks.length).toBeGreaterThan(0);
    });

    test("review slice refuses an empty range instead of planning zero slices", async () => {
      git("checkout", "-q", "main");
      git("merge", "-q", "--ff-only", "feature");
      process.chdir(root);
      const err = console.error;
      const log = console.log;
      console.error = () => {};
      console.log = () => {};
      const errors: string[] = [];
      console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
      try {
        await reviewCommand(["slice", "--ref", head, "--head", head]).catch((error: unknown) => void errors.push(String(error)));
      } finally {
        console.error = err;
        console.log = log;
      }
      expect(errors.join("\n")).toMatch(/empty review range/);
      process.exitCode = 0;
    });
  });

  test("a first-round slice leaves committed review and flow packages out of the diff", async () => {
    commit("packages", { ".metaproject/reviews/old/report.md": `${"finding text\n".repeat(400)}`, ".metaproject/flows/9-x/reviews/o/findings.json": `[${'"x",'.repeat(2000)}"y"]` });
    process.chdir(root);
    const out = path.join(root, "out-slices");
    const log = console.log;
    console.log = () => {};
    try {
      await reviewCommand(["slice", "--ref", base, "--out", out, "--head", git("rev-parse", "HEAD"), "--max-bytes", "100000"]);
    } finally {
      console.log = log;
    }
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8")) as SliceManifest;
    const files = manifest.slices.flatMap((slice) => slice.files);
    expect(files.some((file) => file.startsWith(".metaproject/"))).toBe(false);
    expect(manifest.omissions.some((omission) => omission.path.startsWith(".metaproject/"))).toBe(false);
    expect(files).toContain("src/a/a.ts");
  });
});

describe("second-look slices in the plan arithmetic", () => {
  const entry = (id: string, kind: SliceEntry["kind"], roles: string[]): SliceEntry => ({ id, path: `${id}.diff`, bytes: 1000, files: [`${id}.ts`], domain: "d", split: "domain", roles, depth: "deep", ...(kind === undefined ? {} : { kind }) });
  const manifest = (): SliceManifest => ({
    schemaVersion: 1,
    maxBytes: 10_000,
    waveBytes: 10_000,
    source: "diff",
    slices: [entry("slice-01", "fix", ["review-logic", "review-regression"]), entry("slice-02", "new", ["review-logic", "review-security-code"]), ...[3, 4, 5].map((n) => entry(`slice-0${n}`, "second-look", ["review-logic", "review-security-code"]))],
    omissions: [],
    totals: { slices: 5, bytes: 5000, files: 5, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
  });

  test("splitCounts and the estimate count second-look slices and dispatches apart", () => {
    expect(splitCounts(manifest())).toEqual({ fix: 1, new: 1, secondLook: 3 });
    const estimate = estimateRound(["review-logic", "review-security-code", "review-regression"], manifest());
    expect(estimate.split?.secondLook).toEqual({ slices: 3, dispatches: 2 });
    expect(estimate.split?.fix.slices).toBe(1);
    expect(estimate.split?.new.slices).toBe(1);
    // review-regression owns only the fix slice: second-look slices are not owed to it.
    expect(estimate.perRole.find((role) => role.role === "review-regression")?.slices).toBe(1);
    expect(estimate.perRole.find((role) => role.role === "review-security-code")?.slices).toBe(4);
    // A round with no second-look slice has no such entry.
    const without = { ...manifest(), slices: manifest().slices.slice(0, 2) };
    expect(estimateRound(["review-logic"], without).split).not.toHaveProperty("secondLook");
  });

  test("tagSecondLookSlices and secondLookClaimBacked", () => {
    const tagged = tagSecondLookSlices([{ ...entry("slice-01", undefined, ["review-logic", "review-architecture"]), audit: true, text: "t" }], 1);
    expect(tagged[0]).toMatchObject({ kind: "second-look", roles: ["review-logic", "review-security-code"], depth: "deep" });
    expect(tagged[0]?.audit).toBeUndefined();
    expect(tagged[0]?.risk?.why.join(" ")).toContain("second look: unchanged since round 1");
    expect(secondLookClaimBacked({ kind: "second-look", files: ["a.ts"] }, undefined, "")).toBe(false);
  });

  test("renumberSlices keeps one slice-NN sequence", () => {
    expect(renumberSlices([{ id: "slice-01", path: "slice-01.diff" }, { id: "slice-01", path: "slice-01.diff" }])).toEqual([{ id: "slice-01", path: "slice-01.diff" }, { id: "slice-02", path: "slice-02.diff" }]);
  });
});

describe("review plan summary names the second look", () => {
  test("renderPlanSummary prints second-look slices and dispatches", async () => {
    const { renderPlanSummary, slicesByKind } = await import("../commands/review-plan");
    const slices = slicesByKind({ slices: [{ id: "s1", path: "s1.diff", bytes: 1, files: ["a.ts"], domain: "d", split: "domain", kind: "second-look", roles: ["review-logic"] }] });
    expect(slices.secondLook).toHaveLength(1);
    const text = renderPlanSummary({
      v: 1,
      package: "/p",
      target: { kind: "pr", ref: PR, base: null, head: null },
      round: { number: 2, mode: "delta", source: "local-package", previous: "r1", range: { base: null, head: null }, fixHunks: 0, newHunks: 0, priorFindings: 0, carried: 0, line: "round 2" },
      slices: { fix: [], new: [], secondLook: slices.secondLook ?? [] },
      roster: ["review-logic"],
      dispatches: 1,
      minutes: { min: 2, max: 5 },
      split: { fix: { slices: 0, dispatches: 0 }, new: { slices: 0, dispatches: 0 }, secondLook: { slices: 1, dispatches: 1 } },
      overThreshold: false,
      overReasons: [],
      planKey: "k",
      warnings: [],
      next: "dispatch",
    });
    expect(text).toContain("second-look: 1 slices / 1 dispatches");
  });
});
