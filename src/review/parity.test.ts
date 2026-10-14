import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditSeverity } from "./severity-audit";
import { parityIsEmpty, parityLines, paritySummary, parityWarnings, readReviewParity, renderParityReport } from "./parity";
import { FOLLOW_UP_TEXT, HELD_FINDING, MUTATION_RECORD, followUpObligation, writeMutationLeftovers } from "./parity.test-helpers";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function pkg(options: { held?: boolean; followUp?: "unresolved" | "narrowed" | "refuted"; mutants?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-parity-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "findings.json"), JSON.stringify(options.held === true ? [HELD_FINDING] : []), "utf8");
  await writeFile(path.join(dir, "research.json"), JSON.stringify({ version: 1, obligations: options.followUp === undefined ? [] : [followUpObligation(options.followUp)] }), "utf8");
  if (options.mutants === true) await writeMutationLeftovers(dir);
  return dir;
}

describe("readReviewParity", () => {
  test("a package with nothing left over reads as empty", async () => {
    const view = await readReviewParity(await pkg());
    expect(parityIsEmpty(view)).toBe(true);
    expect(parityLines(view)).toEqual([]);
    expect(paritySummary(view)).toBe("");
    expect(renderParityReport(view)).toBe("");
  });

  test("counts the candidates no pass ran and names the cap of the latest pass", async () => {
    const view = await readReviewParity(await pkg({ mutants: true }));
    expect(view.notRun).toBe(2);
    expect(view.cap).toBe(MUTATION_RECORD.cap);
    expect(view.notRunIds).toEqual(["m2", "m3"]);
    expect(parityLines(view)[0]).toBe("Not run: 2 candidates (cap 1): m2, m3");
  });

  test("reads held notes off findings.json", async () => {
    const view = await readReviewParity(await pkg({ held: true }));
    expect(view.held).toEqual([{ finding: "F-010", severity: "minor", mutant: "m1", reason: "mutant m1 survived but only changes presentation: severity held" }]);
    expect(parityLines(view)).toEqual(["held: F-010 stays minor (mutant m1): mutant m1 survived but only changes presentation: severity held"]);
  });

  test("an unresolved follow-up is open, a narrowed one keeps what remains, a closed one is gone", async () => {
    const open = await readReviewParity(await pkg({ followUp: "unresolved" }));
    expect(open.followUps).toEqual([{ id: "review-testing-practices:fu1", text: FOLLOW_UP_TEXT, state: "open" }]);
    const narrowed = await readReviewParity(await pkg({ followUp: "narrowed" }));
    expect(narrowed.followUps[0]).toMatchObject({ state: "narrowed", remains: "accounts created before 2024 are still unchecked" });
    expect((await readReviewParity(await pkg({ followUp: "refuted" }))).followUps).toEqual([]);
  });

  test("the audit's own held note is what the view reads back", async () => {
    const record = { ...MUTATION_RECORD, mutants: [{ ...MUTATION_RECORD.mutants[0]!, id: "m1" }] };
    const audited = auditSeverity([{ id: "F-010", severity: "minor", evidence: "mutant:m1 survived" }], [{ name: "mutation-1.json", record: record as never }]);
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify(audited.findings), "utf8");
    expect((await readReviewParity(dir)).held.map((h) => h.mutant)).toEqual(["m1"]);
  });
});

describe("renderParityReport", () => {
  test("names the Not run line, each held note and each not-verified follow-up", async () => {
    const markdown = renderParityReport(await readReviewParity(await pkg({ mutants: true, held: true, followUp: "unresolved" })));
    expect(markdown).toContain("## Review parity");
    expect(markdown).toContain("Not run: 2 candidates (cap 1): m2, m3");
    expect(markdown).toContain("**Held severity:** F-010 stays minor. Mutant m1 survived but only changes presentation.");
    expect(markdown).toContain(`**Not verified:** ${FOLLOW_UP_TEXT} (review-testing-practices:fu1, open)`);
  });
});

describe("parityWarnings", () => {
  test("warns for every kind of leftover the report does not name", async () => {
    const view = await readReviewParity(await pkg({ mutants: true, held: true, followUp: "unresolved" }));
    const warnings = parityWarnings(view, "# Round\n\nNo problems found.\n");
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("2 mutation candidate(s) were Not run");
    expect(warnings.join("\n")).toContain("1 severity note(s) were held");
    expect(warnings.join("\n")).toContain("1 follow-up(s) are not verified");
    expect(warnings.every((w) => w.includes("keryx review report-parity"))).toBe(true);
  });

  test("stays quiet once the report carries the pasted block, and when there is nothing to name", async () => {
    const view = await readReviewParity(await pkg({ mutants: true, held: true, followUp: "unresolved" }));
    expect(parityWarnings(view, `# Round\n\n${renderParityReport(view)}`)).toEqual([]);
    expect(parityWarnings(await readReviewParity(await pkg()), "# Round\n")).toEqual([]);
  });

  test("a report that names one kind is still warned about the others", async () => {
    const view = await readReviewParity(await pkg({ mutants: true, held: true }));
    const warnings = parityWarnings(view, "Not run: 2 candidates (cap 1)\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("severity note(s)");
  });
});
