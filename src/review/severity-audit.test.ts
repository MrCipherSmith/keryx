import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MUTANT_KINDS, type MutantResult, type MutationRecord, parseMutantSpec, renderMutationTable } from "./mutate";
import { auditPackage, auditSeverity, type NamedMutationRecord } from "./severity-audit";

function mutant(over: Partial<MutantResult> = {}): MutantResult {
  return { id: "M1", file: "src/a.ts", anchor: "a", replacement: "b", status: "survived", ms: 1, ...over };
}

function run(...mutants: MutantResult[]): NamedMutationRecord {
  const record: MutationRecord = {
    schemaVersion: 1,
    worktree: "/w",
    command: "bun test",
    baseline: { exitCode: 0, ms: 1 },
    mutants,
    totals: { killed: 0, survived: mutants.length, invalid: 0, timeout: 0 },
  };
  return { name: "mutation-1.json", record };
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "F1", severity: "minor", evidence: "mutant:M1 survived", ...over };
}

describe("mutant kind", () => {
  test("a spec may declare kind; absent stays absent and reads as behavior", () => {
    const [plain, shown] = parseMutantSpec([
      { id: "A", file: "f.ts", anchor: "x", replacement: "y" },
      { id: "B", file: "f.ts", anchor: "x", replacement: "z", kind: "presentation" },
    ]);
    expect("kind" in plain!).toBe(false);
    expect(shown?.kind).toBe("presentation");
    expect(() => parseMutantSpec([{ id: "C", file: "f.ts", anchor: "x", replacement: "y", kind: "cosmetic" }])).toThrow(/kind/);
  });

  test("the mutation table marks a presentation row and leaves other rows as they were", () => {
    const table = renderMutationTable(run(mutant({ id: "P", kind: "presentation" }), mutant({ id: "B" })).record);
    expect(table).toContain("survived [presentation]");
    expect(table.match(/\[presentation\]/g)).toHaveLength(1);
  });
});

describe("auditSeverity and mutant kind", () => {
  test("a behavior survivor raises a minor finding to major", () => {
    const { findings, changes } = auditSeverity([finding()], [run(mutant({ kind: "behavior" }))], { changedFiles: ["src/a.ts"] });
    expect(findings[0]).toMatchObject({ severity: "major", severity_audit: { from: "minor", to: "major", evidence: "mutation-1.json#M1" } });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.held).toBeUndefined();
  });

  test("a record written before the field existed raises exactly as before", () => {
    const { findings } = auditSeverity([finding()], [run(mutant())], { changedFiles: ["src/a.ts"] });
    expect(findings[0]).toMatchObject({ severity: "major", severity_audit: { from: "minor", to: "major" } });
  });

  test("a presentation survivor keeps the severity and records a held note naming the mutant", () => {
    for (const severity of ["minor", "nit", "info", "low"]) {
      const { findings, changes } = auditSeverity([finding({ severity })], [run(mutant({ kind: "presentation" }))], { changedFiles: ["src/a.ts"] });
      expect(findings[0]?.severity).toBe(severity);
      expect(findings[0]?.severity_audit).toEqual({
        held: {
          severity,
          mutant: "M1",
          kind: "presentation",
          evidence: "mutation-1.json#M1",
          reason: "mutant M1 survived but only changes presentation: severity held",
        },
      });
      expect(changes).toEqual([
        { id: "F1", from: severity, to: severity, evidence: "mutation-1.json#M1", held: true, reason: "mutant M1 survived but only changes presentation: severity held" },
      ]);
    }
  });

  test("one behavior survivor among presentation survivors still raises, on the behavior mutant", () => {
    const records = [run(mutant({ id: "M1", kind: "presentation" }), mutant({ id: "M2", kind: "behavior" }))];
    const { findings } = auditSeverity([finding({ evidence: "mutant:M1 and mutant:M2" })], records, { changedFiles: ["src/a.ts"] });
    expect(findings[0]).toMatchObject({ severity: "major", severity_audit: { evidence: "mutation-1.json#M2" } });
  });

  test("a presentation survivor does not touch a finding that would not have been raised", () => {
    const records = [run(mutant({ kind: "presentation" }))];
    expect(auditSeverity([finding({ severity: "major" })], records, { changedFiles: ["src/a.ts"] })).toEqual({ findings: [finding({ severity: "major" })], changes: [] });
    expect(auditSeverity([finding({ severity: "blocker" })], records).changes).toEqual([]);
  });

  test("auditPackage persists the held note into findings.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-sev-audit-"));
    try {
      await mkdir(path.join(dir, "research-evidence"), { recursive: true });
      await writeFile(path.join(dir, "findings.json"), JSON.stringify([finding()]));
      await writeFile(path.join(dir, "research-evidence", "mutation-1.json"), JSON.stringify(run(mutant({ kind: "presentation" })).record));
      const result = await auditPackage(dir);
      expect(result.changes.map((change) => change.held)).toEqual([true]);
      const written = JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as Record<string, unknown>[];
      expect(written[0]?.severity).toBe("minor");
      expect(written[0]?.severity_audit).toMatchObject({ held: { mutant: "M1", kind: "presentation" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the reviewer's documented mutant_candidates shape", () => {
  const REPO = path.resolve(import.meta.dir, "..", "..");
  const COPIES = ["src/gdskills/bundled/skills/review/review-testing-practices/SKILL.md", ".metaproject/skills/gdskills/review/review-testing-practices/SKILL.md"];

  test("names the optional kind with every value the severity hold reads, in both copies", async () => {
    const texts = await Promise.all(COPIES.map((file) => readFile(path.join(REPO, file), "utf8")));
    expect(texts[1]).toBe(texts[0]!);
    const bullet = texts[0]!.slice(texts[0]!.indexOf("`mutant_candidates` in your `REVIEW_RESULT`")).split("\n- ")[0]!;
    expect(bullet).toContain("optional `kind`");
    for (const kind of MUTANT_KINDS) expect(bullet).toContain(`\`${kind}\``);
  });
});
