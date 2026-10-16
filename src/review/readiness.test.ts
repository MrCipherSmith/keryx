// Flow 451: one checklist stands between a review and "completed" or GitHub. The fixture is shaped like the package of the
// review of PR #7932 that was published while incomplete: 25 changed files, 341 candidates of which 301 were cut by the cap,
// a ledger with open obligations, reviewers that never ran, a result missing from raw/, and a coverage.md that listed
// everything as "run".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { CHUNK_REVIEWER, ensureChunkPlan, recordChunk } from "./chunks";
import { CALLER_UNATTRIBUTED, recordLogStart, recordOrchestratorCall } from "./orchestrator-log";
import { computeReadiness, failingItems, memoryLogNote, partialHeader, readinessDepthLines, readinessItemId, readinessLine, readinessRefusal, renderReadiness, waiveReadiness } from "./readiness";

let root: string;
let pkg: string;

const REVIEWERS = ["review-logic", "review-security-code", "review-style", "review-regression", "review-verifier"];
const CHANGED = Array.from({ length: 25 }, (_, index) => `src/changed-${String(index).padStart(2, "0")}.ts`);
const CUT = Array.from({ length: 301 }, (_, index) => `src/cut-${String(index).padStart(3, "0")}.ts`);

const run = (reviewer: string, extra: object = {}) => ({
  reviewer,
  executionId: `run-${reviewer}`,
  status: "complete",
  scopeComplete: true,
  rawEvidence: `raw/${reviewer}.txt#sha256:abc`,
  ruleEvidence: ["rule"],
  executionRequired: false,
  executionReason: "source-only review",
  ...extra,
});
const notRun = (reviewer: string) => ({ reviewer, executionId: `run-${reviewer}`, status: "not-run", notRunReason: "never dispatched" });

const writeJson = (name: string, value: unknown): void => writeFileSync(path.join(pkg, name), JSON.stringify(value, null, 2));
const writeCoverageMd = (statuses: Record<string, string>): void =>
  writeFileSync(path.join(pkg, "coverage.md"), `# Reviewer Coverage\n\n${Object.entries(statuses).map(([reviewer, status]) => `reviewer: ${reviewer}\nstatus: ${status}\nreason: x`).join("\n\n")}\n`);

function writeResearch(kind: "broken" | "repaired"): void {
  const broken = kind === "broken";
  writeJson("research.json", {
    version: 1,
    scopeReviewed: !broken,
    rawReconciled: !broken,
    obligations: broken ? [{ id: "ob-1", source: "raw", question: "is it real?", status: "open" }] : [],
    dispatch: {
      version: 1,
      mode: "all",
      override: { operatorQuote: "synthetic fixture", reason: "readiness fixture" },
      selected: REVIEWERS,
      unresolvedRules: [],
      runs: REVIEWERS.map((name, index) => (broken && index > 0 ? notRun(name) : run(name, { coveredSlices: [] }))),
    },
  });
}

function writeBlastRadius(changed: string[], dropped: string[]): void {
  writeJson("blast-radius.json", {
    schemaVersion: 1,
    scope: "blast-radius",
    depth: 2,
    maxFiles: 40,
    changedFiles: changed,
    files: [],
    dropped: dropped.map((file) => ({ file, hop: 1, fanIn: 1, via: CHANGED[0], source: "graph", reason: "cap", detail: "over the cap" })),
    unresolved: [],
    counts: {},
    graph: { nodes: 1, edges: 0 },
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-readiness-"));
  pkg = path.join(root, ".metaproject", "reviews", "pr7932-r1");
  mkdirSync(path.join(pkg, "raw"), { recursive: true });
  for (const file of CHANGED.concat(CUT)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "x".repeat(40));
  }
  writeJson("manifest.json", {
    schemaVersion: 1,
    reviewId: "pr7932-r1",
    mode: "review-flow",
    status: "draft",
    target: { kind: "pr", ref: "https://github.com/Presight-AI/vantage-frontend/pull/7932" },
    artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md", research: "research.json", reviewerDispatch: "research.json" },
    coverage: [],
  });
  writeJson("scope-files.json", { files: CHANGED });
  writeBlastRadius(CHANGED, CUT);
  writeResearch("broken");
  writeJson("findings.json", [{ id: "f-1", severity: "major", title: "raw finding" }, { id: "f-2", severity: "blocker", title: "another" }, { id: "f-3", severity: "minor", title: "small" }]);
  writeFileSync(path.join(pkg, "report.md"), "# Review\n\nRequest changes.\n");
  writeCoverageMd(Object.fromEntries(REVIEWERS.map((name) => [name, "run"])));
  for (const name of REVIEWERS.slice(1, 4)) writeFileSync(path.join(pkg, "raw", `${name}.txt`), "reply");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ids = (items: ReturnType<typeof failingItems>): string[] => items.map((item) => item.id);

describe("the checklist on a package shaped like pr7932-r1 (AC1, AC2)", () => {
  test("is NOT READY with exactly the failing items, each naming the command that repairs it", async () => {
    const report = await computeReadiness(pkg);
    expect(report.verdict).toBe("NOT READY");
    expect(report.items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ids(failingItems(report))).toEqual(["blast-radius", "reviewers", "verifier", "ledger", "coverage-md"]);
    for (const item of failingItems(report)) {
      expect(item.repair).toBeTruthy();
      expect(item.evidence.length).toBeGreaterThan(10);
    }
    const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
    expect(byId["blast-radius"]?.evidence).toContain("301 of 301");
    expect(byId["blast-radius"]?.repair).toContain("keryx review chunks plan --package");
    expect(byId["reviewers"]?.evidence).toContain("review-security-code");
    expect(byId["reviewers"]?.evidence).toContain("result file missing from raw/: review-logic");
    expect(byId["verifier"]?.repair).toContain("Not verified: 2");
    expect(byId["ledger"]?.evidence).toContain("unresolved research");
    expect(byId["coverage-md"]?.evidence).toContain("review-regression");
    expect(byId["coverage-md"]?.repair).toContain("keryx review ingest");
    expect(byId["files-covered"]?.status).toBe("pass");
    expect(byId["head"]?.status).toBe("pass");
  });

  test("is READY after the repairs, with no item waived", async () => {
    writeResearch("repaired");
    for (const name of REVIEWERS) writeFileSync(path.join(pkg, "raw", `${name}.txt`), "reply");
    writeFileSync(path.join(pkg, "report.md"), "# Review\n\nRequest changes.\n\nNot verified: 2\n");
    writeCoverageMd(Object.fromEntries(REVIEWERS.map((name) => [name, "run"])));
    const plan = await ensureChunkPlan(pkg, root);
    expect(plan?.chunks.length).toBeGreaterThan(0);
    for (const chunk of plan!.chunks) await recordChunk(pkg, chunk.id, { status: "DONE" });
    const report = await computeReadiness(pkg);
    expect(failingItems(report).map((item) => `${item.id}: ${item.evidence}`)).toEqual([]);
    expect(report.verdict).toBe("READY");
    expect(report.items.every((item) => item.status === "pass")).toBe(true);
    expect(CHUNK_REVIEWER).toBeTruthy();
  });

  test("is read-only: computing it twice leaves every file as it was", async () => {
    const before = readFileSync(path.join(pkg, "manifest.json"), "utf8") + readFileSync(path.join(pkg, "report.md"), "utf8");
    await computeReadiness(pkg);
    await computeReadiness(pkg);
    expect(readFileSync(path.join(pkg, "manifest.json"), "utf8") + readFileSync(path.join(pkg, "report.md"), "utf8")).toBe(before);
  });

  test("renders one line per fact: verdict, items, evidence and repair, and a one-line summary for status screens", async () => {
    const report = await computeReadiness(pkg);
    const lines = renderReadiness(report);
    expect(lines[0]).toBe("readiness: NOT READY (pr7932-r1)");
    expect(lines.filter((line) => line.includes("[FAIL  ]"))).toHaveLength(5);
    expect(lines.some((line) => line.includes("repair: keryx review chunks plan"))).toBe(true);
    expect(readinessLine(report)).toBe("readiness: NOT READY — 5 failing: blast-radius, reviewers, verifier, ledger, coverage-md");
    const refusal = readinessRefusal(report, "complete the review");
    expect(refusal).toContain("5 failing item(s)");
    expect(refusal).toContain("--waive");
  });
});

describe("premise-decisions: every held finding has an operator decision (flow 459, AC2)", () => {
  const held = { id: "f-9", global_id: "pr7932-r1#f-9", severity: "major", title: "timeline pinned LTR", premise: { verdict: "challenged", judge: "review-premise", question: "mirror it?" } };
  const item = async () => (await computeReadiness(pkg)).items.find((entry) => entry.id === "premise-decisions");

  test("passes when nothing is held", async () => {
    expect((await item())?.status).toBe("pass");
  });

  test("fails while a held finding has no decision, naming it and the command that records one", async () => {
    writeJson("findings.json", [held]);
    const result = await item();
    expect(result?.status).toBe("fail");
    expect(result?.evidence).toContain("pr7932-r1#f-9");
    expect(result?.repair).toContain("decide-premise");
  });

  test("an owner-decision hold fails the same way, at any severity", async () => {
    writeJson("findings.json", [{ ...held, severity: "minor", premise: { ...held.premise, verdict: "owner-decision", options: ["a", "b"] } }]);
    expect((await item())?.status).toBe("fail");
  });

  test("passes once the package holds a premise-question decision for the finding", async () => {
    writeJson("findings.json", [held]);
    writeJson("operator-decisions.json", { schemaVersion: 1, decisions: [{ kind: "premise-question", finding: "pr7932-r1#f-9", answer: "dismiss", reason: "platforms do not mirror it", at: "2026-10-16T12:00:00Z", actor: "owner" }] });
    expect((await item())?.status).toBe("pass");
  });

  test("a downgraded finding is not held", async () => {
    writeJson("findings.json", [{ ...held, premise: { verdict: "downgraded", judge: "review-premise", severity: "minor", original_severity: "major" } }]);
    expect((await item())?.status).toBe("pass");
  });
});

describe("the other items", () => {
  test("a reviewer that never came back is named when only the head and the files are fine", async () => {
    writeResearch("repaired");
    const research = JSON.parse(readFileSync(path.join(pkg, "research.json"), "utf8"));
    research.dispatch.runs[2] = { ...notRun(REVIEWERS[2]!) };
    writeJson("research.json", research);
    const report = await computeReadiness(pkg);
    const reviewers = report.items.find((item) => item.id === "reviewers");
    expect(reviewers?.status).toBe("fail");
    expect(reviewers?.evidence).toContain("review-style");
  });

  test("a package that predates the research ledger is not held to the dispatch items", async () => {
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    delete manifest.artifacts.research;
    delete manifest.artifacts.reviewerDispatch;
    writeJson("manifest.json", manifest);
    const report = await computeReadiness(pkg);
    expect(report.items.find((item) => item.id === "reviewers")?.status).toBe("pass");
    expect(report.items.find((item) => item.id === "ledger")?.status).toBe("pass");
  });

  test("the head is read only when the tracker is: a moved PR fails item 7, a PR at the reviewed head passes", async () => {
    writeResearch("repaired");
    const lookup = async () => ({ exists: true, state: "OPEN", headSha: "bbbbbbbbbbbb" }) as never;
    const open = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    open.target.head = "aaaaaaaaaaaa";
    writeJson("manifest.json", open);
    const moved = await computeReadiness(pkg, { prLookup: lookup });
    expect(moved.items.find((item) => item.id === "head")?.status).toBe("fail");
    open.target.head = "bbbbbbbbbbbb";
    writeJson("manifest.json", open);
    const same = await computeReadiness(pkg, { prLookup: lookup });
    expect(same.items.find((item) => item.id === "head")?.status).toBe("pass");
  });
});

describe("item 9: a recount against the wrong base (AC7)", () => {
  test("a blast radius computed for more than 3x the scope is flagged with both numbers, and the recorded scope is untouched", async () => {
    const many = Array.from({ length: 1547 }, (_, index) => `src/base-${index}.ts`);
    writeBlastRadius(many, []);
    const scopeBefore = readFileSync(path.join(pkg, "scope-files.json"), "utf8");
    const report = await computeReadiness(pkg);
    const item = report.items.find((entry) => entry.id === "pr-files");
    expect(item?.status).toBe("fail");
    expect(item?.evidence).toContain("1547");
    expect(item?.evidence).toContain("25");
    expect(item?.repair).toContain("keryx review blast-radius --package");
    expect(readFileSync(path.join(pkg, "scope-files.json"), "utf8")).toBe(scopeBefore);
  });

  test("the PR's own file list is compared with the scope when the tracker can give it", async () => {
    const list = [...CHANGED.slice(0, 24), "src/other.ts"];
    const report = await computeReadiness(pkg, { prFiles: async () => list });
    const item = report.items.find((entry) => entry.id === "pr-files");
    expect(item?.status).toBe("fail");
    expect(item?.evidence).toContain("src/other.ts");
    const equal = await computeReadiness(pkg, { prFiles: async () => CHANGED });
    expect(equal.items.find((entry) => entry.id === "pr-files")?.status).toBe("pass");
  });
});

describe("a waiver is the operator's own words (AC3)", () => {
  test("is refused without a quote, with a too-short one, and for an item that already passes", async () => {
    await expect(waiveReadiness(pkg, ["verifier"], "")).rejects.toThrow("operator's own words");
    await expect(waiveReadiness(pkg, ["verifier"], "ok")).rejects.toThrow("at least 8 characters");
    await expect(waiveReadiness(pkg, ["verifier"], "........")).rejects.toThrow("letters or digits");
    await expect(waiveReadiness(pkg, ["files-covered"], "this one is fine anyway")).rejects.toThrow("nothing to waive");
    await expect(waiveReadiness(pkg, ["nonsense"], "waive nonsense please")).rejects.toThrow("not a readiness item");
    expect(JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8")).readiness_waivers).toBeUndefined();
  });

  test("is written into the manifest and into the first lines of report.md, and turns the item into waived", async () => {
    const added = await waiveReadiness(pkg, ["4", "ledger"], "ship it, the ledger is a known gap", { now: new Date("2026-10-15T07:00:00Z") });
    expect(added.map((waiver) => waiver.item)).toEqual(["verifier", "ledger"]);
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    expect(manifest.readiness_waivers).toEqual([
      { item: "verifier", operator_quote: "ship it, the ledger is a known gap", time: "2026-10-15T07:00:00.000Z" },
      { item: "ledger", operator_quote: "ship it, the ledger is a known gap", time: "2026-10-15T07:00:00.000Z" },
    ]);
    const report = readFileSync(path.join(pkg, "report.md"), "utf8").split("\n");
    expect(report[0]).toBe("Partial review: verifier waived by the operator: ship it, the ledger is a known gap");
    expect(report[1]).toBe("Partial review: ledger waived by the operator: ship it, the ledger is a known gap");
    expect(report).toContain("# Review");
    const after = await computeReadiness(pkg);
    expect(after.items.find((item) => item.id === "verifier")?.status).toBe("waived");
    expect(after.items.find((item) => item.id === "verifier")?.waiver?.operatorQuote).toContain("ship it");
    expect(ids(failingItems(after))).toEqual(["blast-radius", "reviewers", "coverage-md"]);
    expect(after.verdict).toBe("NOT READY");
  });

  test("a second waiver replaces the header lines instead of stacking them, and the header helper agrees", async () => {
    await waiveReadiness(pkg, ["verifier"], "first reason for this");
    await waiveReadiness(pkg, ["verifier"], "second reason for this");
    const report = readFileSync(path.join(pkg, "report.md"), "utf8");
    expect(report.match(/^Partial review:/gm)).toHaveLength(1);
    expect(report).toContain("second reason for this");
    expect(partialHeader([{ item: "ledger", operator_quote: "q q q q q", time: "t" }])).toEqual(["Partial review: ledger waived by the operator: q q q q q"]);
  });

  test("waiving every failing item makes the package READY, with the header still on top", async () => {
    await waiveReadiness(pkg, ["blast-radius", "reviewers", "verifier", "ledger", "coverage-md"], "operator accepts a partial review");
    const report = await computeReadiness(pkg);
    expect(report.verdict).toBe("READY");
    expect(report.items.filter((item) => item.status === "waived")).toHaveLength(5);
    expect(readFileSync(path.join(pkg, "report.md"), "utf8").split("\n")[0]).toStartWith("Partial review: blast-radius waived");
  });

  test("items are named by number or by id", () => {
    expect(readinessItemId("5")).toBe("ledger");
    expect(readinessItemId("Ledger")).toBe("ledger");
    expect(readinessItemId("12")).toBeUndefined();
  });
});

describe("keryx review complete goes through the checklist (AC3)", () => {
  const seams = (terminal: boolean) => ({ isTerminal: () => terminal, prLookup: async () => null, prFiles: async () => null });
  let errors: string[];
  let logs: string[];
  const realError = console.error;
  const realLog = console.log;
  const cwd = process.cwd();

  beforeEach(() => {
    errors = [];
    logs = [];
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    for (const name of ["scope.md", "learning.md", "decisions.md"]) writeFileSync(path.join(pkg, name), `# ${name}\n`);
  });
  beforeEach(async () => {
    // The research and coverage gates that predate the checklist run first, so the fixture passes them and fails one
    // checklist item: the verifier left blocker/major findings unchecked and the report does not say so.
    writeResearch("repaired");
    for (const name of REVIEWERS) writeFileSync(path.join(pkg, "raw", `${name}.txt`), "reply");
    writeFileSync(path.join(pkg, "report.md"), "# Review\n\nEvidence level: static only — did not run: tests\n\nRequest changes.\n");
    const plan = await ensureChunkPlan(pkg, root);
    for (const chunk of plan!.chunks) await recordChunk(pkg, chunk.id, { status: "DONE" });
    process.chdir(root);
    process.exitCode = 0;
  });
  afterEach(() => {
    console.error = realError;
    console.log = realLog;
    process.chdir(cwd);
    process.exitCode = 0;
  });

  const status = (): string => JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8")).status;

  test("refuses while an item fails, prints each failing item, and leaves the package open; nothing was published", async () => {
    await reviewCommand(["complete", pkg], seams(true));
    expect(process.exitCode).toBe(1);
    const out = errors.join("\n");
    expect(out).toContain("verifier");
    expect(out).toContain("Not verified: 2");
    expect(out).toContain("--waive");
    expect(out).toContain("--waive");
    expect(status()).toBe("draft");
    expect(() => readFileSync(path.join(pkg, "published.json"))).toThrow();
  });

  test("a waiver without the operator's words is refused, and writes nothing", async () => {
    await reviewCommand(["complete", pkg, "--waive", "verifier"], seams(true));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--waive needs an item and the operator's own words");
    await reviewCommand(["complete", pkg, "--waive", "verifier", "ok"], seams(true));
    expect(errors.join("\n")).toContain("at least 8 characters");
    expect(JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8")).readiness_waivers).toBeUndefined();
    expect(status()).toBe("draft");
  });

  test("a waiver is refused when nobody is at a terminal, so an agent cannot write the operator's words", async () => {
    await reviewCommand(["complete", pkg, "--waive", "verifier", "the operator said ship it"], seams(false));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("needs a terminal");
    expect(errors.join("\n")).toContain("review_waive_readiness");
    expect(JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8")).readiness_waivers).toBeUndefined();
    expect(readFileSync(path.join(pkg, "report.md"), "utf8")).not.toContain("Partial review:");
  });

  test("waiving every failing item at a terminal writes the waivers into the manifest and the top of report.md, and closes", async () => {
    const quote = "the operator accepts a partial review";
    await reviewCommand(["complete", pkg, "--waive", "verifier", quote], seams(true));
    const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8"));
    expect(manifest.readiness_waivers.map((waiver: { item: string }) => waiver.item)).toEqual(["verifier"]);
    expect(manifest.readiness_waivers.every((waiver: { operator_quote: string }) => waiver.operator_quote === quote)).toBe(true);
    const head = readFileSync(path.join(pkg, "report.md"), "utf8").split("\n")[0];
    expect(head).toBe(`Partial review: verifier waived by the operator: ${quote}`);
    expect(errors.join("\n")).not.toContain("readiness checklist");
    expect(status()).toBe("closed");
  });

  test("a READY package closes without any published review, so the report-only path is held to the same checklist", async () => {
    writeFileSync(path.join(pkg, "report.md"), "# Review\n\nEvidence level: static only — did not run: tests\n\nRequest changes.\n\nNot verified: 2\n");
    expect(failingItems(await computeReadiness(pkg))).toEqual([]);
    await reviewCommand(["complete", pkg], seams(true));
    expect(errors.join("\n")).not.toContain("readiness checklist");
    expect(status()).toBe("closed");
    expect(() => readFileSync(path.join(pkg, "published.json"))).toThrow();
  });
});

describe("a recount against the wrong base is refused (flow 451 AC7)", () => {
  test("names both numbers and the PR-files command when the count passes 3x the recorded scope", async () => {
    const { recountRefusal } = await import("./readiness");
    const recorded = Array.from({ length: 25 }, (_, index) => `src/f${index}.ts`);
    const refusal = recountRefusal(1547, recorded, "pr7932-r1");
    expect(refusal).toContain("1547");
    expect(refusal).toContain("25");
    expect(refusal).toContain("keryx review blast-radius --package pr7932-r1 --changed");
    expect(recountRefusal(75, recorded, "pr7932-r1")).toBeUndefined();
    expect(recountRefusal(76, recorded, "pr7932-r1")).toBeDefined();
    expect(recountRefusal(1547, [], "pr7932-r1")).toBeUndefined();
  });
});

// Flow 454 AC7: the log's state, recorded or absent, and the count of calls keryx could not attribute, in the same words
// on the checklist and on the compact status lines.
describe("the orchestrator log note (flow 454 AC7)", () => {
  const memoryLines = (lines: string[]): string[] => lines.filter((line) => line.includes("orchestrator log:"));

  test("with no log file the checklist and the status lines say none", async () => {
    const report = await computeReadiness(pkg);
    expect(memoryLogNote(report)).toBe("orchestrator log: none");
    expect(memoryLines(renderReadiness(report)).map((line) => line.trim())).toEqual(["orchestrator log: none"]);
    expect(readinessDepthLines(report).join("\n")).toContain("memory-outside-stage: orchestrator log: none");
  });

  test("with a log keryx started both say recorded", async () => {
    await recordLogStart(pkg);
    const report = await computeReadiness(pkg);
    expect(memoryLogNote(report)).toBe("orchestrator log: recorded");
    expect(memoryLines(renderReadiness(report)).map((line) => line.trim())).toEqual(["orchestrator log: recorded"]);
    expect(readinessDepthLines(report).join("\n")).toContain("memory-outside-stage: orchestrator log: recorded");
  });

  test("the count of unattributed calls is the same on every projection", async () => {
    await recordLogStart(pkg);
    for (const query of ["a", "b"]) await recordOrchestratorCall(pkg, { source: "mcp", caller: CALLER_UNATTRIBUTED, tool: "memory_search", input: { query } });
    const report = await computeReadiness(pkg);
    expect(memoryLogNote(report)).toBe("orchestrator log: recorded, 2 unattributed");
    expect(memoryLines(renderReadiness(report)).map((line) => line.trim())).toEqual(["orchestrator log: recorded, 2 unattributed"]);
    expect(readinessDepthLines(report).join("\n")).toContain("memory-outside-stage: orchestrator log: recorded, 2 unattributed");
  });
});

describe("item 2 counts only cap drops (flow 457 AC2)", () => {
  const reasoned = (file: string, reason: string) => ({ file, hop: 1, fanIn: 1, via: CHANGED[0], source: "graph", reason, detail: `${reason} fixture` });

  test("graph-related files omitted with a reason neither fail item 2 nor get a chunk plan", async () => {
    writeJson("blast-radius.json", {
      schemaVersion: 1,
      scope: "blast-radius",
      depth: 2,
      maxFiles: 40,
      changedFiles: CHANGED,
      files: [],
      dropped: [
        reasoned(CUT[0] as string, "unrelated-symbol"),
        reasoned(CUT[1] as string, "hub-damped"),
        reasoned(CUT[2] as string, "text-hub"),
        reasoned("src/cut.test.ts", "test-consumer"),
      ],
      unresolved: [],
      counts: {},
      graph: { nodes: 1, edges: 0 },
    });
    expect(await ensureChunkPlan(pkg, root)).toBeNull();
    // A slice manifest makes coverage tracked, so item 2 reads the radius rather than saying there is nothing to track.
    writeJson("slice-manifest.json", { schemaVersion: 1, maxBytes: 1000, waveBytes: 1000, source: "diff", slices: [{ id: "s1", path: "slices/s1", bytes: 10, contentHash: "s1", files: CHANGED, domain: "d", split: "file" }], omissions: [], totals: { slices: 1, bytes: 10, files: CHANGED.length, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } });
    const item = (await computeReadiness(pkg)).items.find((entry) => entry.id === "blast-radius");
    expect(item?.status).toBe("pass");
    expect(item?.evidence).toContain("4 graph-related file(s) omitted with a reason");
  });

  test("a cap drop beside reasoned omissions still fails item 2 until its chunk is read", async () => {
    writeJson("blast-radius.json", {
      schemaVersion: 1,
      scope: "blast-radius",
      depth: 2,
      maxFiles: 40,
      changedFiles: CHANGED,
      files: [],
      dropped: [{ ...reasoned(CUT[0] as string, "cap"), detail: "over the cap" }, reasoned(CUT[1] as string, "unrelated-symbol")],
      unresolved: [],
      counts: {},
      graph: { nodes: 1, edges: 0 },
    });
    const item = (await computeReadiness(pkg)).items.find((entry) => entry.id === "blast-radius");
    expect(item?.status).toBe("fail");
    expect(item?.evidence).toContain("1 of 1 file(s) cut by the cap");
    const plan = await ensureChunkPlan(pkg, root);
    expect(plan?.chunks.flatMap((chunk) => chunk.files)).toEqual([CUT[0] as string]);
  });
});

describe("a delta round's fix slice (flow 458 AC4)", () => {
  const fixOnly = (covered: string[]): void => {
    writeBlastRadius([CHANGED[0]!], []);
    writeJson("scope-files.json", { files: [CHANGED[0]] });
    mkdirSync(path.join(pkg, "slices"), { recursive: true });
    writeJson("slices/manifest.json", {
      schemaVersion: 1,
      maxBytes: 18000,
      source: "diff",
      slices: [{ id: "slice-01", path: "slice-01.diff", bytes: 10, files: [CHANGED[0]], domain: "src", split: "domain", roles: ["review-logic", "review-regression"], depth: "deep", kind: "fix", findingIds: ["F1"] }],
      omissions: [],
      totals: { slices: 1, bytes: 10, files: 1, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
    });
    writeResearch("repaired");
    const research = JSON.parse(readFileSync(path.join(pkg, "research.json"), "utf8"));
    research.dispatch.fixSlicesCovered = covered;
    writeJson("research.json", research);
  };

  test("the file of a fix slice is uncovered until every finding attached to the slice has a disposition", async () => {
    fixOnly([]);
    const open = (await computeReadiness(pkg)).items.find((item) => item.id === "files-covered");
    expect(open?.status).toBe("fail");
    fixOnly(["slice-01"]);
    const covered = (await computeReadiness(pkg)).items.find((item) => item.id === "files-covered");
    expect(covered?.status).toBe("pass");
  });
});
