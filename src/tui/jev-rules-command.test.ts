// flow 330 (AC7/AC8): render tests for `/jevrules` — English UI, grouped by
// rule. Hermetic: `runJevRulesForShell` takes an injectable `gitDiff`, and
// every scenario here either refuses before any network call or produces an
// empty diff (zero hunks -> zero Jev calls), so nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupFindingsByRule, isJevRulesCommand, JEV_RULES_COMMAND, renderJevRulesForShell, runJevRulesForShell } from "./jev-rules-command";
import type { JevRulesComputedResult } from "../commands/review-jev-rules";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jevrules-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { rules: enabled } } }), "utf8");
  return dir;
}

function finding(overrides: Partial<JevRulesComputedResult["findings"][number]> = {}): JevRulesComputedResult["findings"][number] {
  return {
    id: "jev-rules-1",
    severity: "minor",
    file: "src/a.ts",
    line: 10,
    quote: "const x = 1;",
    problem: "likely violates rule X",
    impact: "erodes the convention",
    suggested_fix: "bring it in line",
    evidence: "hunk src/a.ts:10-12; p=0.9",
    confidence: "high",
    reviewer: "review-jev-rules",
    dedupe_key: "rules/core/x.mdc::x-1::src/a.ts",
    ...overrides,
  };
}

describe("isJevRulesCommand", () => {
  test("matches only the exact token", () => {
    expect(isJevRulesCommand(JEV_RULES_COMMAND)).toBe(true);
    expect(isJevRulesCommand("/jevrules")).toBe(true);
    expect(isJevRulesCommand("/jevrulesx")).toBe(false);
    expect(isJevRulesCommand("jevrules")).toBe(false);
  });
});

describe("groupFindingsByRule", () => {
  test("groups by the ruleId encoded in dedupe_key", () => {
    const findings = [
      finding({ dedupe_key: "rules/a.mdc::a-1::src/a.ts" }),
      finding({ id: "2", dedupe_key: "rules/b.mdc::b-1::src/b.ts", file: "src/b.ts" }),
      finding({ id: "3", dedupe_key: "rules/a.mdc::a-2::src/c.ts", file: "src/c.ts" }),
    ];
    const groups = groupFindingsByRule(findings);
    expect([...groups.keys()].sort()).toEqual(["rules/a.mdc", "rules/b.mdc"]);
    expect(groups.get("rules/a.mdc")).toHaveLength(2);
    expect(groups.get("rules/b.mdc")).toHaveLength(1);
  });

  test("a missing dedupe_key groups under an explicit placeholder rather than crashing", () => {
    const withoutKey: Record<string, unknown> = { ...finding() };
    delete withoutKey.dedupe_key;
    const groups = groupFindingsByRule([withoutKey as unknown as Parameters<typeof groupFindingsByRule>[0][number]]);
    expect([...groups.keys()]).toEqual(["(unknown rule)"]);
  });
});

describe("renderJevRulesForShell", () => {
  test("English, grouped by rule, sorted, with severity/location/problem/fix per finding", () => {
    const result: JevRulesComputedResult = {
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-rules",
      summary: "Checked 2 (hunk, rule-clause) pair(s) against working diff; 2 finding(s) at/above threshold 0.5. 0 pair(s) dropped by --max-calls 150.",
      findings: [
        finding({ dedupe_key: "rules/b.mdc::b-1::src/b.ts", file: "src/b.ts", severity: "major" }),
        finding({ dedupe_key: "rules/a.mdc::a-1::src/a.ts", file: "src/a.ts" }),
      ],
      stats: { blocker: 0, major: 1, minor: 1, info: 0 },
      tokens: { jevCalls: 1, taggingCalls: 0, violationCalls: 1 },
      selection: { maxCalls: 150, selectedPairs: 2, droppedPairs: 0, notApplicable: 0, droppedClauses: 0 },
      ruleSources: [{ path: "rules/a.mdc", kind: "project-rule" }, { path: "rules/b.mdc", kind: "project-rule" }],
      excludedSources: [],
      droppedClauses: [],
    };
    const text = renderJevRulesForShell(result);
    expect(text).toContain("review-jev-rules: DONE_WITH_CONCERNS");
    // Grouped by rule, rules sorted, so "rules/a.mdc" renders before "rules/b.mdc".
    expect(text.indexOf("Rule: rules/a.mdc")).toBeLessThan(text.indexOf("Rule: rules/b.mdc"));
    expect(text).toContain("[minor] src/a.ts:10 — likely violates rule X");
    expect(text).toContain("[major] src/b.ts:10 — likely violates rule X");
    expect(text).toContain("fix: bring it in line");
    // English only.
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no findings: a plain, unambiguous English sentence", () => {
    const result: JevRulesComputedResult = {
      status: "DONE",
      reviewer: "review-jev-rules",
      summary: "Checked 0 (hunk, rule-clause) pair(s) against working diff; 0 finding(s) at/above threshold 0.5. 0 pair(s) dropped by --max-calls 150.",
      findings: [],
      stats: { blocker: 0, major: 0, minor: 0, info: 0 },
      tokens: { jevCalls: 0, taggingCalls: 0, violationCalls: 0 },
      selection: { maxCalls: 150, selectedPairs: 0, droppedPairs: 0, notApplicable: 0, droppedClauses: 0 },
      ruleSources: [],
      excludedSources: [],
      droppedClauses: [],
    };
    expect(renderJevRulesForShell(result)).toContain("No findings at or above threshold.");
  });
});

describe("runJevRulesForShell — gate refusal (no network, no git diff)", () => {
  test("review.jev.rules absent: the refusal message, and git diff is never called", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gitDiffCalled = false;
    const text = await runJevRulesForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text.toLowerCase()).toContain("review.jev.rules");
    expect(text.toLowerCase()).toContain("not enabled");
    expect(gitDiffCalled).toBe(false);
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY, git diff never called", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    let gitDiffCalled = false;
    const text = await runJevRulesForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(gitDiffCalled).toBe(false);
  });
});

describe("runJevRulesForShell — an empty working diff makes zero Jev calls", () => {
  test("opted in, credentialed, nothing changed: DONE, no findings, no network call needed", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevRulesForShell(ROOT, async () => "");
    expect(text).toContain("review-jev-rules: DONE");
    expect(text).toContain("No findings at or above threshold.");
  });
});
