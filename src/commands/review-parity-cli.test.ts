import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HELD_FINDING, followUpObligation, writeMutationLeftovers } from "../review/parity.test-helpers";
import { readyResearchFixture } from "../review/research.test-helpers";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;
let ROOT = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-parity-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  await rm(ROOT, { recursive: true, force: true });
});

const FINDING = {
  id: "F-001",
  reviewer: "review-logic",
  severity: "minor",
  problem: "the new Last seen row reads a field the page never sets",
  impact: "the row is blank for older accounts",
  suggested_fix: "default the value",
  evidence: "read src/admin/ExamplePage.tsx",
  confidence: "high",
};

async function ingest(reviewId: string, reportExtra = ""): Promise<string> {
  await writeFile(path.join(ROOT, "research.json"), JSON.stringify(readyResearchFixture([FINDING.reviewer], [FINDING.id])), "utf8");
  await writeFile(
    path.join(ROOT, "report.md"),
    `# Round\n\nEvidence level: static only — did not run: tests\n${reportExtra}\n\`\`\`json keryx:findings\n${JSON.stringify([FINDING], null, 2)}\n\`\`\`\n`,
    "utf8",
  );
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", reviewId, "--research", "research.json"]);
  return path.join(ROOT, ".metaproject", "reviews", reviewId);
}

/** Leaves the three kinds of leftover in the package: a cap, a held note and a follow-up closed as narrowed (so the round can still close). */
async function leaveThingsBehind(pkg: string): Promise<void> {
  await writeMutationLeftovers(pkg);
  const findings = JSON.parse(await readFile(path.join(pkg, "findings.json"), "utf8")) as Array<Record<string, unknown>>;
  await writeFile(path.join(pkg, "findings.json"), JSON.stringify([{ ...findings[0], severity_audit: HELD_FINDING.severity_audit }]), "utf8");
  const research = JSON.parse(await readFile(path.join(pkg, "research.json"), "utf8")) as { obligations: unknown[] };
  await writeFile(path.join(pkg, "research.json"), JSON.stringify({ ...research, obligations: [...research.obligations, followUpObligation("narrowed")] }), "utf8");
}

describe("keryx review status", () => {
  test("prints Not run, the held note and the follow-up under the coverage line", async () => {
    const pkg = await ingest("parity-status");
    await leaveThingsBehind(pkg);
    logs = [];
    await reviewCommand(["status", "parity-status"]);
    const out = logs.join("\n");
    expect(out).toContain("Not run: 2 candidates (cap 1): m2, m3");
    expect(out).toContain("held: F-001 stays minor (mutant m1)");
    expect(out).toContain("follow-up narrowed: review-testing-practices:fu1");
    expect(out.indexOf("coverage:")).toBeLessThan(out.indexOf("Not run:"));
  });

  test("prints nothing extra for a round with no leftovers", async () => {
    await ingest("parity-clean");
    logs = [];
    await reviewCommand(["status", "parity-clean"]);
    expect(logs.join("\n")).not.toContain("Not run:");
    expect(logs.join("\n")).not.toContain("held:");
    expect(logs.join("\n")).not.toContain("follow-up");
  });
});

describe("keryx review report-parity", () => {
  test("prints the Markdown to paste into report.md", async () => {
    const pkg = await ingest("parity-report");
    await leaveThingsBehind(pkg);
    logs = [];
    await reviewCommand(["report-parity", "parity-report"]);
    expect(process.exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("## Review parity");
    expect(out).toContain("Not run: 2 candidates (cap 1): m2, m3");
    expect(out).toContain("**Held severity:** F-001 stays minor.");
    expect(out).toContain("**Not verified:** the sign-in audit log writer was not read");
  });

  test("says there is nothing to carry for a clean round, and needs a review", async () => {
    await ingest("parity-nothing");
    logs = [];
    await reviewCommand(["report-parity", "parity-nothing"]);
    expect(logs.join("\n")).toContain("Nothing to carry into the report");
    errors = [];
    await reviewCommand(["report-parity"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Usage: keryx review report-parity");
  });
});

describe("keryx review complete", () => {
  test("warns, and still closes, when the report names none of the leftovers", async () => {
    const pkg = await ingest("parity-warn");
    await leaveThingsBehind(pkg);
    // The unrun candidates would refuse the close; the operator's waiver is the existing way past that gate.
    const research = JSON.parse(await readFile(path.join(pkg, "research.json"), "utf8")) as { dispatch: Record<string, unknown> };
    research.dispatch.mutationWaiver = { operatorQuote: "skip the mutation pass", reason: "synthetic fixture" };
    await writeFile(path.join(pkg, "research.json"), JSON.stringify(research), "utf8");
    errors = [];
    await reviewCommand(["complete", pkg]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).toBe("closed");
    const warnings = errors.filter((line) => line.startsWith("warning:")).join("\n");
    expect(warnings).toContain("2 mutation candidate(s) were Not run");
    expect(warnings).toContain("1 severity note(s) were held");
    expect(warnings).toContain("1 follow-up(s) are not verified");
  });

  test("is quiet when the report carries the pasted block", async () => {
    const pkg = await ingest("parity-named", "\nNot run: 2 candidates (cap 1)\nHeld severity: F-001 stays minor (m1 held)\nNot verified: the sign-in audit log writer (review-testing-practices:fu1)\n");
    await leaveThingsBehind(pkg);
    const research = JSON.parse(await readFile(path.join(pkg, "research.json"), "utf8")) as { dispatch: Record<string, unknown> };
    research.dispatch.mutationWaiver = { operatorQuote: "skip the mutation pass", reason: "synthetic fixture" };
    await writeFile(path.join(pkg, "research.json"), JSON.stringify(research), "utf8");
    errors = [];
    await reviewCommand(["complete", pkg]);
    expect(process.exitCode).toBe(0);
    expect(errors.filter((line) => line.includes("Not run") || line.includes("severity note") || line.includes("follow-up"))).toEqual([]);
  });
});
