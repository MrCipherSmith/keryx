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
