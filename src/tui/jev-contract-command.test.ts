// flow 335: render tests for `/contract` — English UI, claim list plus
// findings. Hermetic: `runJevContractForShell` takes an injectable `gitDiff`,
// and every scenario here either refuses before any network call or produces
// an empty diff with no PR description (zero claims -> zero Jev calls), so
// nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJevContractCommand, JEV_CONTRACT_COMMAND, renderJevContractForShell, runJevContractForShell } from "./jev-contract-command";
import type { JevContractComputedResult } from "../commands/review-jev-contract";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jevcontract-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { contract: enabled } } }), "utf8");
  return dir;
}

describe("isJevContractCommand", () => {
  test("matches only the exact token", () => {
    expect(isJevContractCommand(JEV_CONTRACT_COMMAND)).toBe(true);
    expect(isJevContractCommand("/contract")).toBe(true);
    expect(isJevContractCommand("/contractx")).toBe(false);
    expect(isJevContractCommand("contract")).toBe(false);
  });
});

function baseResult(overrides: Partial<JevContractComputedResult> = {}): JevContractComputedResult {
  return {
    status: "DONE",
    reviewer: "review-jev-contract",
    summary: "Extracted 0 claim(s) from the description; checked 0 against working diff. 0 finding(s) at/above threshold 0.5 or contradicted by facts. 0 claim(s) skipped by --max-calls 30.",
    findings: [],
    stats: { blocker: 0, major: 0, minor: 0, info: 0 },
    claims: [],
    budget: { maxCalls: 30, claimsScored: 0, claimsSkipped: 0 },
    tokens: { jevCalls: 0 },
    ...overrides,
  };
}

describe("renderJevContractForShell", () => {
  test("English, claim list, findings", () => {
    const result = baseResult({
      status: "DONE_WITH_CONCERNS",
      claims: [{ id: "CLAIM1", text: "Does not change the public API.", source: "bullet", intent: "no-change", probability: 0.9 }],
      findings: [
        {
          id: "jev-contract-1",
          severity: "major",
          claim: "Does not change the public API.",
          class_scope: { sites: ["src/widget.ts:1-3"], enumeration_method: "matched regions" },
          file: "src/widget.ts",
          line: 1,
          problem: "contradicted by exported symbols",
          impact: "misleads a reader",
          suggested_fix: "update the description",
          evidence: "exported symbols touched: widget",
          confidence: "high",
          reviewer: "review-jev-contract",
          dedupe_key: "jev-contract::CLAIM1",
        },
      ],
      stats: { blocker: 0, major: 1, minor: 0, info: 0 },
    });
    const text = renderJevContractForShell(result);
    expect(text).toContain("review-jev-contract");
    expect(text).toContain("DONE_WITH_CONCERNS");
    expect(text).toContain("Does not change the public API.");
    expect(text).toContain("major");
    // English only.
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no claims extracted: a plain, unambiguous English sentence", () => {
    expect(renderJevContractForShell(baseResult())).toContain("_no claims extracted from the PR description_");
  });
});

describe("runJevContractForShell — gate refusal (no network, no git diff)", () => {
  test("review.jev.contract absent: the refusal message, and git diff is never called", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gitDiffCalled = false;
    const text = await runJevContractForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text.toLowerCase()).toContain("review.jev.contract");
    expect(text.toLowerCase()).toContain("not enabled");
    expect(gitDiffCalled).toBe(false);
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY, git diff never called", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    let gitDiffCalled = false;
    const text = await runJevContractForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(gitDiffCalled).toBe(false);
  });
});

describe("runJevContractForShell — a working diff has no PR description, so zero claims and zero Jev calls", () => {
  test("opted in, credentialed, nothing to check: DONE, no findings, no network call needed", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevContractForShell(ROOT, async () => "");
    expect(text).toContain("review-jev-contract");
    expect(text).toContain("DONE");
    expect(text).toContain("_no claims extracted from the PR description_");
  });
});
