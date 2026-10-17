// Flow 459 review (testing F-004): `keryx review ingest --premises <file>` through the command, not only below it.
// A dropped allowlist entry, or an ingest that stops forwarding `premises`, would leave every unit test green while the
// flag is dead from the shell: the flow 457 B1 class.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { PREMISES_FILE, PREMISES_SUPERSEDED_FILE } from "../review/premise";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
const realLog = console.log;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-premises-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const schemaDir = path.join("docs", "requirements", "managed-review-feedback-loop", "schemas");
  await mkdir(path.join(ROOT, schemaDir), { recursive: true });
  await writeFile(path.join(ROOT, schemaDir, "managed-review-package.schema.json"), await readFile(path.join(ORIGINAL_CWD, schemaDir, "managed-review-package.schema.json"), "utf8"));
  console.log = () => undefined;
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

const REPORT = [
  "# Round",
  "",
  "Evidence level: static only — did not run: tests",
  "",
  "```json keryx:findings",
  JSON.stringify([{ id: "LY-003", reviewer: "review-layout", severity: "minor", problem: "timeline pinned LTR", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" }]),
  "```",
  "",
].join("\n");

const PREMISES = {
  judge: "review-premise",
  premises: [{ finding_id: "LY-003", verdict: "challenged", practice_sources: [{ name: "Material Design bidirectionality", says: "timelines do not mirror" }], question: "Mirror the timeline?" }],
};

async function ingest(reviewId: string, extra: string[] = []): Promise<string> {
  process.chdir(ROOT);
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", reviewId, ...extra]);
  return path.join(ROOT, ".metaproject", "reviews", reviewId);
}

test("ingest --premises reaches the merge: the finding carries the premise and the claims file is kept", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-premises", ["--premises", "premises.json"]);
  const [finding] = JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as Array<{ premise?: { verdict: string; question: string } }>;
  expect(finding?.premise).toMatchObject({ verdict: "challenged", question: "Mirror the timeline?" });
  expect(JSON.parse(await readFile(path.join(dir, PREMISES_FILE), "utf8"))).toEqual(PREMISES);
});

test("flow 460: --premises is repeatable — files merge with their own judges, and a disagreement across files applies neither", async () => {
  const report = REPORT.replace(
    JSON.stringify([{ id: "LY-003", reviewer: "review-layout", severity: "minor", problem: "timeline pinned LTR", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" }]),
    JSON.stringify([
      { id: "LY-003", reviewer: "review-layout", severity: "minor", problem: "timeline pinned LTR", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" },
      { id: "LG-001", reviewer: "review-logic", severity: "minor", problem: "retry counter never resets", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" },
    ]),
  );
  await writeFile(path.join(ROOT, "report.md"), report);
  const code = { judge: "review-premise-code", premises: [{ finding_id: "LG-001", verdict: "upheld" }, { finding_id: "LY-003", verdict: "upheld" }] };
  const rest = { judge: "review-premise-rest", premises: [PREMISES.premises[0]] };
  await writeFile(path.join(ROOT, "code.json"), JSON.stringify(code));
  await writeFile(path.join(ROOT, "rest.json"), JSON.stringify(rest));
  const dir = await ingest("2026-10-17-premises-many", ["--premises", "code.json", "--premises", "rest.json"]);
  const findings = JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as Array<{ id: string; premise?: { verdict: string; judge: string } }>;
  // LG-001: judged by one file only, with that file's judge.
  expect(findings.find((finding) => finding.id === "LG-001")?.premise).toMatchObject({ verdict: "upheld", judge: "review-premise-code" });
  // LY-003: upheld in one file, challenged in the other — a conflict, so neither is applied.
  expect(findings.find((finding) => finding.id === "LY-003")?.premise).toBeUndefined();
  const scope = await readFile(path.join(dir, "scope.md"), "utf8");
  expect(scope).toContain("duplicate-claim");
  expect(scope).toContain("premise files name this finding and do not agree");
  // The claims are kept as received, one entry per file.
  expect(JSON.parse(await readFile(path.join(dir, PREMISES_FILE), "utf8"))).toEqual([code, rest]);
  // The package's own record round-trips (RG-002): a re-ingest with --premises <that file> reads the list, as the verdict does.
  await writeFile(path.join(ROOT, "kept.json"), await readFile(path.join(dir, PREMISES_FILE), "utf8"));
  const again = await ingest("2026-10-17-premises-many", ["--premises", "kept.json"]);
  expect(process.exitCode ?? 0).toBe(0);
  const reread = JSON.parse(await readFile(path.join(again, "findings.json"), "utf8")) as Array<{ id: string; premise?: { verdict: string; judge: string } }>;
  expect(reread.find((finding) => finding.id === "LG-001")?.premise).toMatchObject({ verdict: "upheld", judge: "review-premise-code" });
  expect(JSON.parse(await readFile(path.join(again, PREMISES_FILE), "utf8"))).toEqual([code, rest]);
});

type HeldRecord = { premise?: { verdict: string } };
const readFindings = async (dir: string): Promise<HeldRecord[]> => JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as HeldRecord[];

test("a re-ingest without --premises carries the held claims forward while they still hold the same finding (review RG2-004)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-reingest", ["--premises", "premises.json"]);
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  await ingest("2026-10-16-reingest");
  expect(process.exitCode).toBe(0);
  expect((await readFindings(dir))[0]?.premise?.verdict).toBe("challenged");
  expect(JSON.parse(await readFile(path.join(dir, PREMISES_FILE), "utf8"))).toEqual(PREMISES);
  expect(lines.join("\n")).toContain("premise claims: carried forward");
});

test("a re-ingest without --premises is not refused over a stored held claim the first ingest rejected (review RG4-001)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  const withTypo = { ...PREMISES, premises: [...PREMISES.premises, { ...PREMISES.premises[0], finding_id: "LY-999" }] };
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(withTypo));
  const dir = await ingest("2026-10-16-typo", ["--premises", "premises.json"]);
  await ingest("2026-10-16-typo");
  expect(process.exitCode).toBe(0);
  expect((await readFindings(dir))[0]?.premise?.verdict).toBe("challenged");
});

test("a re-ingest without --premises carries the hold when a second claim on the same finding was rejected (review RG4-001)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  const { question: _question, ...noQuestion } = PREMISES.premises[0] as (typeof PREMISES.premises)[number];
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify({ ...PREMISES, premises: [...PREMISES.premises, noQuestion] }));
  const dir = await ingest("2026-10-16-sibling", ["--premises", "premises.json"]);
  await ingest("2026-10-16-sibling");
  expect(process.exitCode).toBe(0);
  expect((await readFindings(dir))[0]?.premise).toMatchObject({ verdict: "challenged", question: "Mirror the timeline?" });
});

test("a re-ingest without --premises never applies an edited premises.json: the holds come from findings.json (review SEC5-001)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-planted", ["--premises", "premises.json"]);
  const planted = { judge: "review-premise", premises: [{ finding_id: "LY-003", verdict: "owner-decision", options: ["a", "b"], question: "planted?", practice_sources: PREMISES.premises[0]?.practice_sources }] };
  await writeFile(path.join(dir, PREMISES_FILE), JSON.stringify(planted));
  await ingest("2026-10-16-planted");
  expect(process.exitCode).toBe(0);
  expect((await readFindings(dir))[0]?.premise).toMatchObject({ verdict: "challenged", question: "Mirror the timeline?" });
});

test("a re-ingest without --premises carries a hold with no premises.json left (review LG5-003)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-nofile", ["--premises", "premises.json"]);
  await rm(path.join(dir, PREMISES_FILE));
  await ingest("2026-10-16-nofile");
  expect(process.exitCode).toBe(0);
  expect((await readFindings(dir))[0]?.premise?.verdict).toBe("challenged");
});

test("a carried re-ingest says so in scope.md: where the holds came from and how many, never a judge 'not named' (review RG6-001)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-scope", ["--premises", "premises.json"]);
  await ingest("2026-10-16-scope");
  expect(process.exitCode).toBe(0);
  const scope = await readFile(path.join(dir, "scope.md"), "utf8");
  expect(scope).toContain("premise_judge: carried from the previous ingest's findings.json (review-premise)");
  expect(scope).toContain("premise_claims_carried: 1");
  expect(scope).not.toContain("premise_judge: not named");
});

async function refusedReingest(reviewId: string): Promise<string> {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    await ingest(reviewId);
  } finally {
    console.error = realError;
  }
  return errors.join("\n");
}

test("a re-ingest without --premises over an unreadable or non-array findings.json is refused, not read as nothing held (review LG6-001)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-damaged", ["--premises", "premises.json"]);
  for (const [damaged, why] of [['[{"id": "LY-003", "premise"', "it is not JSON"], ['{"findings": []}', "it is not an array"]] as const) {
    await writeFile(path.join(dir, "findings.json"), damaged);
    process.exitCode = 0;
    const errors = await refusedReingest("2026-10-16-damaged");
    expect(process.exitCode).not.toBe(0);
    expect(errors).toContain(`previous findings.json cannot be read: ${why}`);
    expect(errors).toContain("pass --premises");
    expect(await readFile(path.join(dir, "findings.json"), "utf8")).toBe(damaged);
  }
});

test("a re-ingest without --premises with no findings.json at all is a first ingest: nothing held, no refusal", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  const dir = await ingest("2026-10-16-fresh");
  await rm(path.join(dir, "findings.json"));
  await ingest("2026-10-16-fresh");
  expect(process.exitCode).toBe(0);
  expect(existsSync(path.join(dir, "findings.json"))).toBe(true);
});

test("a re-ingest without --premises whose held finding changed is refused, asks for --premises, and leaves the package as it was (review RG2-004)", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(PREMISES));
  const dir = await ingest("2026-10-16-changed", ["--premises", "premises.json"]);
  const before = await readFile(path.join(dir, "findings.json"), "utf8");
  await writeFile(path.join(ROOT, "report.md"), REPORT.replace("timeline pinned LTR", "timeline pinned LTR in every locale"));
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    await ingest("2026-10-16-changed");
  } finally {
    console.error = realError;
  }
  expect(process.exitCode).not.toBe(0);
  expect(errors.join("\n")).toContain("Pass --premises <file>");
  expect(errors.join("\n")).toContain("2026-10-16-changed#LY-003");
  expect(await readFile(path.join(dir, "findings.json"), "utf8")).toBe(before);
  expect(existsSync(path.join(dir, PREMISES_FILE))).toBe(true);
});

test("a re-ingest without --premises over claims that held nothing moves the claims file aside, not deleted", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  const upheld = { judge: "review-premise", premises: [{ finding_id: "LY-003", verdict: "upheld" }] };
  await writeFile(path.join(ROOT, "premises.json"), JSON.stringify(upheld));
  const dir = await ingest("2026-10-16-upheld", ["--premises", "premises.json"]);
  await ingest("2026-10-16-upheld");
  expect(existsSync(path.join(dir, PREMISES_FILE))).toBe(false);
  expect(JSON.parse(await readFile(path.join(dir, PREMISES_SUPERSEDED_FILE), "utf8"))).toEqual(upheld);
});

test("--premises naming a missing file refuses the ingest, says which file, and writes no package", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT);
  process.chdir(ROOT);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", "2026-10-16-missing", "--premises", "nope.json"]);
  } finally {
    console.error = realError;
  }
  expect(process.exitCode).not.toBe(0);
  expect(errors.join("\n")).toContain("--premises nope.json: the file could not be read (ENOENT)");
  expect(existsSync(path.join(ROOT, ".metaproject", "reviews", "2026-10-16-missing"))).toBe(false);
});
