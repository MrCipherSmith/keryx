// What `keryx review ingest` prints about the degradation evidence screen (flow 479, AC4): the downgrade is on the
// terminal, not only in scope.md, and nothing a reviewer wrote reaches the terminal as a control sequence.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { readyResearchFixture } from "../review/research.test-helpers";

// eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
const CONTROL = new RegExp("[\\u001b\\u2028\\u2029]");
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;
let ROOT = "";
let logs: string[] = [];

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-degradation-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = () => {};
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  await rm(ROOT, { recursive: true, force: true });
});

function degradationFinding(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reviewer: "review-degradation",
    severity: "major",
    problem: "an Escape key press handled by a nested popup now also closes the parent",
    impact: "the parent dialog disappears while the user is editing in the popup",
    suggested_fix: "stop the event at the popup",
    evidence: "pressed Escape in the popup on head and on base",
    confidence: "high",
    file: "src/popup.ts",
    class_scope: { sites: ["src/popup.ts:10"], enumeration_method: "every handler registered on the popup" },
    degradation_class: "behaviour-delta",
    ...over,
  };
}

async function ingest(reviewId: string, findings: Array<Record<string, unknown>>): Promise<string> {
  await writeFile(
    path.join(ROOT, "research.json"),
    JSON.stringify(readyResearchFixture(["review-degradation"], findings.map((entry) => String(entry.id)))),
    "utf8",
  );
  const report = `# Round\n\nEvidence level: static only — did not run: tests\n\n\`\`\`json keryx:findings\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
  await writeFile(path.join(ROOT, "report.md"), report, "utf8");
  await reviewCommand(
    ["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", reviewId, "--research", "research.json"],
    { prBase: async () => undefined },
  );
  return path.join(ROOT, ".metaproject", "reviews", reviewId);
}

test("AC4: ingest prints the summary line and one line per downgraded finding", async () => {
  await ingest("2026-10-28-degradation-cli", [degradationFinding("D-001"), degradationFinding("D-002", { evidence_kind: "probe" })]);

  expect(logs).toContain("degradation screen: screened=2 downgraded=1");
  expect(logs).toContain("  downgraded D-001 major -> info [degradation-no-evidence]: major without evidence_kind (one of probe, consumer-trace, merge-trace, red-test, base-diff) is unproven; kept as info");
  expect(logs.some((line) => line.includes("downgraded D-002"))).toBe(false);
});

test("an id with terminal control sequences is printed and written as plain text", async () => {
  const dir = await ingest("2026-10-28-degradation-cli-esc", [degradationFinding("D-001\u001b[31m\u2028X")]);

  const printed = logs.filter((line) => line.includes("downgraded")).join("\n");
  expect(printed).toContain("downgraded D-001 X major -> info");
  expect(printed).not.toMatch(CONTROL);
  const scope = await readFile(path.join(dir, "scope.md"), "utf8");
  const row = scope.split("\n").find((line) => line.startsWith("| D-001 X |"));
  expect(row).toBeDefined();
  expect(row).not.toMatch(CONTROL);
});
