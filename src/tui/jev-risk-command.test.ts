// flow 332 (AC6/AC8): render tests for `/risk` — English UI, ranked risk map
// plus routing hints plus findings. Hermetic: `runJevRiskForShell` takes an
// injectable `gitDiff`, and every scenario here either refuses before any
// network call or produces an empty diff (zero hunks -> zero Jev calls), so
// nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJevRiskCommand, JEV_RISK_COMMAND, renderJevRiskForShell, runJevRiskForShell } from "./jev-risk-command";
import type { JevRiskComputedResult } from "../commands/review-jev-risk";

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
let ROOT = "";

afterEach(async () => {
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

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jevrisk-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { risk: enabled } } }), "utf8");
  return dir;
}

describe("isJevRiskCommand", () => {
  test("matches only the exact token", () => {
    expect(isJevRiskCommand(JEV_RISK_COMMAND)).toBe(true);
    expect(isJevRiskCommand("/risk")).toBe(true);
    expect(isJevRiskCommand("/riskx")).toBe(false);
    expect(isJevRiskCommand("risk")).toBe(false);
  });
});

function baseResult(overrides: Partial<JevRiskComputedResult> = {}): JevRiskComputedResult {
  return {
    status: "DONE",
    reviewer: "review-jev-risk",
    summary:
      "Scored 0 hunk(s) against working diff; 0 finding(s) at/above threshold 0.7. 0 hunk(s) skipped by --max-calls 150 (0 pair(s)); 0 hunk(s) skipped as not a code hunk (docs/.md/.txt).",
    findings: [],
    stats: { blocker: 0, major: 0, minor: 0, info: 0 },
    ranked: [],
    routingHints: [],
    tokens: { jevCalls: 0 },
    selection: { maxCalls: 150, hunksScored: 0, hunksSkipped: 0, hunksNotCode: 0 },
    ...overrides,
  };
}

describe("renderJevRiskForShell", () => {
  test("English, ranked map, routing hints, findings", () => {
    const result = baseResult({
      status: "DONE_WITH_CONCERNS",
      ranked: [
        { file: "src/auth/session.ts", startLine: 1, endLine: 3, combinedRisk: 0.95, topDimension: "security" },
        { file: "src/util/fmt.ts", startLine: 5, endLine: 8, combinedRisk: 0.2, topDimension: "error-handling" },
      ],
      routingHints: [{ file: "src/auth/session.ts", startLine: 1, endLine: 3, dimension: "security", probability: 0.95, suggestedReviewer: "review-security-code" }],
      findings: [
        {
          id: "jev-risk-1",
          severity: "minor",
          file: "src/auth/session.ts",
          line: 1,
          quote: "export function login() {}",
          problem: "high risk, no nearby test",
          impact: "regress silently",
          suggested_fix: "add a test",
          evidence: "security=0.95",
          confidence: "high",
          reviewer: "review-jev-risk",
          dedupe_key: "jev-risk::src/auth/session.ts:1-3",
        },
      ],
      stats: { blocker: 0, major: 0, minor: 1, info: 0 },
    });
    const text = renderJevRiskForShell(result);
    expect(text).toContain("review-jev-risk: DONE_WITH_CONCERNS");
    expect(text).toContain("src/auth/session.ts:1-3 — combined risk 0.95");
    expect(text.indexOf("session.ts")).toBeLessThan(text.indexOf("fmt.ts"));
    expect(text).toContain("review-security-code");
    expect(text).toContain("[minor] src/auth/session.ts:1 — high risk, no nearby test");
    // English only.
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no hunks scored: a plain, unambiguous English sentence", () => {
    expect(renderJevRiskForShell(baseResult())).toContain("No hunks scored.");
  });
});

describe("runJevRiskForShell — gate refusal (no network, no git diff)", () => {
  test("review.jev.risk absent: the refusal message, and git diff is never called", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gitDiffCalled = false;
    const text = await runJevRiskForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text.toLowerCase()).toContain("review.jev.risk");
    expect(text.toLowerCase()).toContain("not enabled");
    expect(gitDiffCalled).toBe(false);
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY, git diff never called", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    let gitDiffCalled = false;
    const text = await runJevRiskForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(gitDiffCalled).toBe(false);
  });
});

describe("runJevRiskForShell — an empty working diff makes zero Jev calls", () => {
  test("opted in, credentialed, nothing changed: DONE, no findings, no network call needed", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevRiskForShell(ROOT, async () => "");
    expect(text).toContain("review-jev-risk: DONE");
    expect(text).toContain("No hunks scored.");
  });
});
