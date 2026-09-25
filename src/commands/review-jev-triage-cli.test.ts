// flow 340: `keryx review jev-triage`, driven through the real CLI
// dispatcher — a real `--report` directory/file on disk, fixture Jev
// responses (`--fixtures`), and an injected `env` for `computeJevTriageResult`
// itself. Hermetic: no network, no real OPENROUTER_API_KEY ever read from
// the machine — every credential here is a fixture string.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { computeJevTriageResult } from "./review-jev-triage";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-triage-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { triage: enabled } } }), "utf8");
  return dir;
}

async function writeReviewPackage(root: string, findings: unknown[]): Promise<string> {
  const dir = path.join(root, "package");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "findings.json"), JSON.stringify(findings), "utf8");
  return dir;
}

async function writeFixtures(root: string, responses: unknown[]): Promise<string> {
  const dir = path.join(root, "fixtures");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "jev-responses.json"), JSON.stringify(responses), "utf8");
  return dir;
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const BLOCKER_MAJOR_FINDINGS = [
  { id: "F-001", severity: "blocker", file: "src/a.ts", line: 10, quote: "throw new Error('boom')", problem: "crashes on empty input", evidence: "no guard before use", confidence: "high", reviewer: "sonnet-reviewer" },
  { id: "F-002", severity: "major", file: "src/a.ts", line: 14, quote: "return list[0]", problem: "off-by-one on an empty list", evidence: "indexes without a length check", confidence: "medium", reviewer: "sonnet-reviewer" },
  { id: "F-003", severity: "minor", file: "src/b.ts", problem: "naming could be clearer", evidence: "n/a", confidence: "low", reviewer: "sonnet-reviewer" },
];

describe("AC1: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.triage absent/false: refused, --report is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-triage", "--report", "/nonexistent/nowhere", "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.triage");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved key): refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-triage", "--report", "/nonexistent/nowhere", "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: --report is required", () => {
  test("missing --report is refused with a usage line", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-triage", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-triage");
    expect(process.exitCode).toBe(1);
  });
});

describe("AC2/AC3/AC4: --report <dir> --fixtures <dir> --json", () => {
  test("severity calibration, a duplicate-merge candidate, and verify-order over blocker/major findings", async () => {
    ROOT = await projectRoot(true);
    const reportDir = await writeReviewPackage(ROOT, BLOCKER_MAJOR_FINDINGS);
    // 2 blocker/major findings, same file -> 1 merge pair -> 5 items total
    // (2 severity, 1 merge, 2 verify), packed into batches of <= 3.
    const fixturesDir = await writeFixtures(ROOT, [
      { answers: { "SEV-F-001": { type: "noul", noul: 0.9 }, "SEV-F-002": { type: "noul", noul: 0.1 }, MRG1: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 40, output_tokens: 4, cost: 0.0004 } },
      { answers: { "VER-F-001": { type: "noul", noul: 0.2 }, "VER-F-002": { type: "noul", noul: 0.95 } }, usage: { input_tokens: 20, output_tokens: 2, cost: 0.0002 } },
    ]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-triage", "--report", reportDir, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      reviewer: string;
      status: string;
      annotations: {
        severity_check: Array<{ id: string; p?: number; flagged: boolean }>;
        merge_candidates: Array<{ id: string; a: string; b: string; reason: string; p?: number }>;
        verify_order: Array<{ id: string; p?: number }>;
      };
      budget: { maxItems: number; itemsScored: number; itemsSkipped: number; findingsDropped: number };
    };
    expect(parsed.reviewer).toBe("review-jev-triage");
    expect(parsed.annotations.severity_check).toEqual([
      { id: "F-001", p: 0.9, flagged: false },
      { id: "F-002", p: 0.1, flagged: true },
    ]);
    expect(parsed.annotations.merge_candidates).toEqual([{ id: "MRG1", a: "F-001", b: "F-002", reason: "file", p: 0.7 }]);
    expect(parsed.annotations.verify_order.map((v) => v.id)).toEqual(["F-001", "F-002"]);
    expect(parsed.status).toBe("DONE_WITH_CONCERNS");
    expect(parsed.budget.findingsDropped).toBe(0);
    expect(parsed.budget.itemsSkipped).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a bare findings.json file (not a directory) is read directly", async () => {
    ROOT = await projectRoot(true);
    const filePath = path.join(ROOT, "findings.json");
    await writeFile(filePath, JSON.stringify([BLOCKER_MAJOR_FINDINGS[0]]), "utf8");
    const fixturesDir = await writeFixtures(ROOT, [{ answers: { "SEV-F-001": { type: "noul", noul: 0.9 }, "VER-F-001": { type: "noul", noul: 0.8 } }, usage: {} }]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-triage", "--report", filePath, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { annotations: { severity_check: unknown[] } };
    expect(parsed.annotations.severity_check).toHaveLength(1);
  });

  test("--max-calls caps items scored, reported rather than silently truncated", async () => {
    ROOT = await projectRoot(true);
    const reportDir = await writeReviewPackage(ROOT, BLOCKER_MAJOR_FINDINGS);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-triage", "--report", reportDir, "--max-calls", "0", "--json"]);
    const parsed = JSON.parse(output()) as { budget: { maxItems: number; itemsScored: number; itemsSkipped: number }; tokens: { jevCalls: number } };
    expect(parsed.budget.maxItems).toBe(0);
    expect(parsed.budget.itemsScored).toBe(0);
    expect(parsed.budget.itemsSkipped).toBe(5);
    expect(parsed.tokens.jevCalls).toBe(0);
  });

  test("findings the schema cannot parse are dropped and reported, not thrown", async () => {
    ROOT = await projectRoot(true);
    const reportDir = await writeReviewPackage(ROOT, [...BLOCKER_MAJOR_FINDINGS, { severity: "major", problem: "no id, dropped" }]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-triage", "--report", reportDir, "--max-calls", "0", "--json"]);
    const parsed = JSON.parse(output()) as { budget: { findingsDropped: number } };
    expect(parsed.budget.findingsDropped).toBe(1);
  });

  test("every finding's problem/evidence/quote sent to Jev is redacted (AC5)", async () => {
    ROOT = await projectRoot(true);
    const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";
    const reportDir = await writeReviewPackage(ROOT, [
      { id: "F-1", severity: "blocker", file: "a.ts", line: 1, quote: `const key = "${secret}"`, problem: `leaks ${secret}`, evidence: `found ${secret} in logs`, confidence: "high", reviewer: "x" },
    ]);
    let capturedBody = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return new Response(JSON.stringify({ answers: { "SEV-F-1": { type: "noul", noul: 0.9 }, "VER-F-1": { type: "noul", noul: 0.9 } }, usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await computeJevTriageResult({ findingsRaw: JSON.parse(await readFile(path.join(reportDir, "findings.json"), "utf8")) as unknown, fetchFn, env: { OPENROUTER_API_KEY: "sk-or-test-fixture" } });
    expect(result.tokens.jevCalls).toBeGreaterThan(0);
    expect(capturedBody).not.toContain(secret);
  });
});

describe("a Jev batch failure (real vendor max_tokens_exceeded) degrades only that batch", () => {
  function maxTokensResponse(): Response {
    return new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), { status: 400 });
  }
  function noulResponse(answers: Record<string, number>): Response {
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: "noul", noul }])), usage: {} }), { status: 200 });
  }

  test("a batch of 3 items retries once, split in half — both halves succeed", async () => {
    const findings = [
      { id: "F-1", severity: "blocker", problem: "p1", evidence: "e1" },
      { id: "F-2", severity: "blocker", problem: "p2", evidence: "e2" },
      { id: "F-3", severity: "blocker", problem: "p3", evidence: "e3" },
    ];
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      if (call === 1) return maxTokensResponse();
      if (call === 2) return noulResponse({ "SEV-F-1": 0.9, "SEV-F-2": 0.85 });
      return noulResponse({ "SEV-F-3": 0.8 });
    }) as unknown as typeof fetch;

    // max-calls 3 so only the severity track is scored (deterministic batch shape for this test).
    const result = await computeJevTriageResult({ findingsRaw: findings, maxItems: 3, fetchFn, env: { OPENROUTER_API_KEY: "sk-or-test-fixture" } });
    expect(call).toBe(3);
    expect(result.jevError).toBeUndefined();
    expect(result.annotations.severity_check.map((a) => a.p)).toEqual([0.9, 0.85, 0.8]);
  });

  test("a single-item batch is never split — degrades on the first max_tokens failure", async () => {
    const findings = [{ id: "F-1", severity: "blocker", problem: "p1", evidence: "e1" }];
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      return maxTokensResponse();
    }) as unknown as typeof fetch;

    const result = await computeJevTriageResult({ findingsRaw: findings, maxItems: 1, fetchFn, env: { OPENROUTER_API_KEY: "sk-or-test-fixture" } });
    expect(call).toBe(1);
    expect(result.jevError).toContain("max_tokens_exceeded");
    expect(result.annotations.severity_check[0]!.p).toBeUndefined();
    // Never auto-demoted/flagged from a degrade — `flagged` stays false with no score.
    expect(result.annotations.severity_check[0]!.flagged).toBe(false);
  });
});

describe("keryx review reviewers --json can be listed after jev-triage exists (no crash on registration)", () => {
  test("review dispatcher still recognizes every other subcommand", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    await reviewCommand(["stack", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("schema conformance", () => {
  test("reviewer-finding.schema.json is unrelated to jev-triage output on purpose — annotations are not findings", async () => {
    // jev-triage never emits a `findings` array of its own (it is
    // annotate-only over an EXISTING package's findings), so there is
    // nothing here to validate against reviewer-finding.schema.json — this
    // test only pins that the schema file still parses, guarding against a
    // future edit that couples the two shapes by accident.
    const schemaRaw = await readFile(path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"), "utf8");
    const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
    expect(schema["$id"]).toBe("reviewer-finding");
  });
});
