import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChunks } from "../commands/review-chunks";
import {
  chunkPassReviewer,
  injectablePassFindings,
  missingWarning,
  passFindingToRound,
  passFindingsNotInRound,
  renderMissingSection,
  sameSite,
  upsertMissingSection,
} from "./chunk-findings";
import { type ChunkFinding, type ChunkPass, ensureChunkPlan, recordChunk } from "./chunks";

const finding = (over: ChunkFinding = {}): ChunkFinding => ({
  id: "R-001",
  file: "src/workspace/store/workspace-routing-store.ts",
  line: 218,
  severity: "high",
  confidence: "high",
  title: "stale route",
  problem: "the store returns the cached route after a rename",
  impact: "the panel opens the old workspace",
  suggested_fix: "drop the entry on rename",
  evidence: "workspace-routing-store.ts:218",
  chunks: ["chunk-001"],
  ...over,
});

const passOf = (findings: ChunkFinding[]): ChunkPass =>
  ({ schemaVersion: 1, reviewer: "review-regression", tier: "middle", totals: { chunks: 1, files: 1, done: 1, failed: 0, pending: 0 }, chunks: [], uncoveredFiles: [], findings }) as unknown as ChunkPass;

describe("sameSite", () => {
  test("the same file and line is the same site, another line is not", () => {
    expect(sameSite({ file: "a.ts", line: 3 }, { file: "a.ts", line: 3 })).toBe(true);
    expect(sameSite({ file: "a.ts", line: 3 }, { file: "a.ts", line: 4 })).toBe(false);
    expect(sameSite({ file: "a.ts", line: 3 }, { file: "b.ts", line: 3 })).toBe(false);
  });

  test("without a line on either side, the same file and the same words", () => {
    expect(sameSite({ file: "a.ts", problem: "x" }, { file: "a.ts", title: "x" })).toBe(true);
    expect(sameSite({ file: "a.ts", problem: "x" }, { file: "a.ts", problem: "y" })).toBe(false);
    expect(sameSite({ file: "a.ts", line: 3 }, { file: "a.ts", problem: "x" })).toBe(false);
    expect(sameSite({ file: "a.ts" }, { file: "a.ts" })).toBe(false);
  });
});

describe("what the round holds", () => {
  test("a pass finding is missing until some round entry sits at its file and line", () => {
    const pass = passOf([finding()]);
    expect(passFindingsNotInRound(pass, undefined)).toHaveLength(1);
    expect(passFindingsNotInRound(pass, [])).toHaveLength(1);
    expect(passFindingsNotInRound(pass, [{ file: "src/workspace/store/workspace-routing-store.ts", line: 218 }])).toHaveLength(0);
    expect(passFindingsNotInRound(null, undefined)).toEqual([]);
  });
});

describe("a pass finding as a round finding", () => {
  test("is recorded under review-regression/<chunk>, with the chunk in the id and no '#'", () => {
    const record = passFindingToRound(finding({ id: "a#b" }), "review-regression");
    expect(record.reviewer).toBe(chunkPassReviewer("review-regression", "chunk-001"));
    expect(record.id).toBe("chunk-001-a_b");
  });

  test("maps the severity words of the pass and defaults the confidence to low", () => {
    const severities = ["critical", "high", "medium", "low", "nonsense"].map((severity) => passFindingToRound(finding({ severity, confidence: undefined }), "r").severity);
    expect(severities).toEqual(["blocker", "major", "minor", "info", "info"]);
    expect(passFindingToRound(finding({ confidence: undefined }), "r").confidence).toBe("low");
  });

  test("a major or blocker without a class_scope gets the placeholder that says it was not enumerated", () => {
    const record = passFindingToRound(finding(), "review-regression");
    expect(record.class_scope?.sites).toEqual(["src/workspace/store/workspace-routing-store.ts:218"]);
    expect(record.class_scope?.enumeration_method).toStartWith("NOT ENUMERATED");
    expect(record.class_scope_present).toBe(true);
  });

  test("a minor gets no class_scope, and the pass's own valid class_scope wins over the placeholder", () => {
    expect(passFindingToRound(finding({ severity: "medium" }), "r").class_scope).toBeUndefined();
    const own = { sites: ["a.ts:1", "b.ts:2"], enumeration_method: "grep" };
    expect(passFindingToRound(finding({ class_scope: own }), "r").class_scope).toEqual(own);
    expect(passFindingToRound(finding({ class_scope: { sites: [], enumeration_method: "grep" } }), "r").class_scope?.enumeration_method).toStartWith("NOT ENUMERATED");
  });

  test("text fields the pass left out say so instead of being invented", () => {
    const record = passFindingToRound({ id: "R-9", file: "a.ts", line: 1, severity: "low", chunks: ["chunk-002"] }, "r");
    expect(record.impact).toBe("(not stated by the chunk pass)");
    expect(record.evidence).toBe("(not stated by the chunk pass)");
  });

  test("a finding the report already holds at the same site is not injected", () => {
    const pass = passOf([finding(), finding({ id: "R-002", line: 300 })]);
    const result = injectablePassFindings(pass, [{ file: "src/workspace/store/workspace-routing-store.ts", line: 218 }]);
    expect(result.findings.map((record) => record.line)).toEqual([300]);
    expect(result.alreadyReported).toHaveLength(1);
    expect(injectablePassFindings(null, []).findings).toEqual([]);
  });
});

describe("the report.md section", () => {
  const report = "# Round\n\nbody\n\n## Verdict\n\nfine\n";

  test("is added once, replaced rather than repeated, and removed when nothing is missing", () => {
    const missing = [finding()];
    const once = upsertMissingSection(report, missing);
    expect(once).toContain("## Chunk pass findings not in the round");
    expect(upsertMissingSection(once, missing)).toBe(once);
    const fewer = upsertMissingSection(once, [finding({ id: "R-002", line: 7 })]);
    expect(fewer.match(/## Chunk pass findings not in the round/g)).toHaveLength(1);
    expect(fewer).toContain(":7 ");
    expect(fewer).not.toContain(":218 ");
    expect(upsertMissingSection(once, [])).toBe(report);
    expect(upsertMissingSection(report, [])).toBe(report);
  });

  test("leaves the sections around it alone", () => {
    const withSection = `${report}\n${renderMissingSection([finding()])}\n## Appendix\n\ntail\n`;
    const cleaned = upsertMissingSection(withSection, []);
    expect(cleaned).toContain("## Verdict");
    expect(cleaned).toContain("## Appendix");
    expect(cleaned).not.toContain("Chunk pass findings");
  });

  test("the warning names the count, the ids and the command, and does not say refused", () => {
    const warning = missingWarning([finding()]);
    expect(warning).toContain("1 chunk-pass finding(s) are not in findings.json");
    expect(warning).toContain("R-001 high src/workspace/store/workspace-routing-store.ts:218 [chunk-001]");
    expect(warning).toContain("keryx review ingest");
  });
});

describe("chunks merge prints what the pass found", () => {
  let root: string;
  let packageDir: string;
  let lines: string[];
  const log = console.log;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-chunk-findings-"));
    packageDir = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(packageDir, { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/dep.ts"), "x".repeat(10));
    await writeFile(
      path.join(packageDir, "blast-radius.json"),
      JSON.stringify({ schemaVersion: 1, scope: "blast-radius", depth: 2, maxFiles: 40, changedFiles: ["src/a.ts"], files: [], dropped: [{ file: "src/dep.ts", hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" }], unresolved: [], counts: {}, graph: { nodes: 1, edges: 0 } }),
    );
    await ensureChunkPlan(packageDir, root);
    lines = [];
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  });
  afterEach(async () => {
    console.log = log;
    await rm(root, { recursive: true, force: true });
  });

  const merge = async (...extra: string[]): Promise<string> => {
    lines = [];
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await runChunks(["merge", "--package", packageDir, ...extra], { rejectUnknownFlags: () => undefined });
    } finally {
      process.chdir(cwd);
    }
    return lines.join("\n");
  };

  test("a pass without findings prints the one summary line it always printed, and no notInRound in JSON", async () => {
    await recordChunk(packageDir, "chunk-001", { status: "DONE", findings: [] });
    expect(await merge()).toBe("chunk-pass.json: 1/1 chunk(s) done, 0 failed, 0 pending; 0 file(s) uncovered; 0 finding(s)");
    expect(JSON.parse(await merge("--json"))).not.toHaveProperty("notInRound");
  });

  test("a pass with a finding prints it and the count not in the round; --json carries findings and notInRound", async () => {
    await recordChunk(packageDir, "chunk-001", { status: "DONE", findings: [finding({ file: "src/dep.ts", line: 218 })] });
    const text = await merge();
    expect(text).toContain("1 finding(s)");
    expect(text).toContain("R-001 high src/dep.ts:218 [chunk-001]");
    expect(text).toContain("1 chunk-pass findings not in round");
    const json = JSON.parse(await merge("--json"));
    expect(json.findings).toHaveLength(1);
    expect(json.notInRound).toHaveLength(1);
  });

  test("a finding findings.json already holds is marked and not counted", async () => {
    await recordChunk(packageDir, "chunk-001", { status: "DONE", findings: [finding({ file: "src/dep.ts", line: 218 })] });
    await writeFile(path.join(packageDir, "findings.json"), JSON.stringify([{ id: "F-1", file: "src/dep.ts", line: 218 }]));
    const text = await merge();
    expect(text).toContain("(in round)");
    expect(text).not.toContain("not in round");
    expect(JSON.parse(await merge("--json")).notInRound).toEqual([]);
  });
});
