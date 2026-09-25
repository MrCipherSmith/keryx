// flow 335 (AC3/AC5/AC6): pure-function tests for `jev-contract.ts` — claim
// extraction, fact gathering, budget selection, batching and finding
// synthesis. Hermetic: no I/O, no network, no client import (this module is
// core).

import { describe, expect, test } from "bun:test";
import {
  batchContractClaimItems,
  classifyClaimIntent,
  computeClaimFacts,
  computeContractClaimItems,
  contractFindingStats,
  DEFAULT_JEV_CONTRACT_THRESHOLD,
  DEFAULT_MAX_JEV_CONTRACT_CALLS,
  extractClaims,
  renderContractMarkdown,
  selectContractClaims,
  selectMatchedRegionsForClaim,
  synthesizeContractFindings,
  type ScoredClaim,
} from "./jev-contract";
import type { ScopedRegion } from "./scope";

function region(overrides: Partial<ScopedRegion> = {}): ScopedRegion {
  return {
    path: "src/widget.ts",
    startLine: 10,
    endLine: 20,
    changedLines: 3,
    contextTruncated: false,
    text: "+export function widget() {}\n+  return 1;\n",
    ...overrides,
  };
}

describe("extractClaims — AC3", () => {
  test("every bullet line is a claim regardless of verb cue", () => {
    const claims = extractClaims("- adds a new flag\n- something with no verb cue at all\n* fixes the bug");
    expect(claims.map((c) => c.text)).toEqual(["adds a new flag", "something with no verb cue at all", "fixes the bug"]);
    expect(claims.every((c) => c.source === "bullet")).toBe(true);
  });

  test("numbered list items are claims too", () => {
    const claims = extractClaims("1. adds a flag\n2) removes the old path");
    expect(claims.map((c) => c.text)).toEqual(["adds a flag", "removes the old path"]);
  });

  test("checkbox bullets have their [ ]/[x] prefix stripped", () => {
    const claims = extractClaims("- [ ] adds a flag\n- [x] fixes a bug");
    expect(claims.map((c) => c.text)).toEqual(["adds a flag", "fixes a bug"]);
  });

  test("prose sentences with a verb cue are claims; sentences without one are not", () => {
    const claims = extractClaims("This PR adds a new endpoint. It has nothing to do with anything. It does not change the public API.");
    expect(claims.map((c) => c.text)).toEqual(["This PR adds a new endpoint.", "It does not change the public API."]);
    expect(claims.every((c) => c.source === "sentence")).toBe(true);
  });

  test("a description with no bullets and no verb cue produces zero claims", () => {
    expect(extractClaims("Just some notes about context, nothing actionable here at all.")).toEqual([]);
  });

  test("a multi-claim description mixing bullets and prose", () => {
    const claims = extractClaims("Summary: this change adds retries.\n\n- fixes the flaky test\n- removes the dead code path\n\nSee the linked issue for background.");
    expect(claims.map((c) => c.text)).toEqual(["Summary: this change adds retries.", "fixes the flaky test", "removes the dead code path"]);
  });

  test("code-fenced content is never a claim", () => {
    const claims = extractClaims("```\n- adds a flag inside a fence\n```\n- adds a flag outside a fence");
    expect(claims.map((c) => c.text)).toEqual(["adds a flag outside a fence"]);
  });

  test("duplicate claim text is deduplicated", () => {
    const claims = extractClaims("- adds a flag\n- adds a flag");
    expect(claims).toHaveLength(1);
  });
});

describe("classifyClaimIntent", () => {
  test("no-change phrasing", () => {
    expect(classifyClaimIntent("This does not change the public API.")).toBe("no-change");
    expect(classifyClaimIntent("No API change here.")).toBe("no-change");
  });

  test("tests-added phrasing", () => {
    expect(classifyClaimIntent("Adds new tests for the parser.")).toBe("tests-added");
  });

  test("everything else is other", () => {
    expect(classifyClaimIntent("Fixes a bug in the parser.")).toBe("other");
  });
});

describe("computeClaimFacts — AC5", () => {
  test("named token present in the diff", () => {
    const facts = computeClaimFacts({ text: "Adds `widget()` to the API.", source: "sentence" }, "+export function widget() {}", ["src/widget.ts"], [region()]);
    expect(facts.tokensPresent).toContain("widget()");
    expect(facts.tokensAbsent).toEqual([]);
  });

  test("named token absent from the diff", () => {
    const facts = computeClaimFacts({ text: "Adds `gizmo()` to the API.", source: "sentence" }, "+export function widget() {}", ["src/widget.ts"], [region()]);
    expect(facts.tokensAbsent).toContain("gizmo()");
  });

  test("tests-added claim: test files touched are reported as evidence", () => {
    const facts = computeClaimFacts({ text: "Adds tests for the widget.", source: "sentence" }, "+test", ["src/widget.test.ts"], []);
    expect(facts.intent).toBe("tests-added");
    expect(facts.testFilesInDiff).toEqual(["src/widget.test.ts"]);
  });

  test("tests-added claim: no test file touched, evidence is empty", () => {
    const facts = computeClaimFacts({ text: "Adds tests for the widget.", source: "sentence" }, "+code", ["src/widget.ts"], []);
    expect(facts.testFilesInDiff).toEqual([]);
  });

  test("no-change + API-shaped claim, no exported symbol touched: not contradicted", () => {
    const facts = computeClaimFacts({ text: "Does not change the public API.", source: "sentence" }, "+  return 1;", ["src/widget.ts"], [region({ text: "+  return 1;" })]);
    expect(facts.contradicted).toBe(false);
    expect(facts.exportedSymbolsChanged).toEqual([]);
  });

  test("no-change + API-shaped claim, an exported symbol IS touched: contradicted", () => {
    const facts = computeClaimFacts(
      { text: "Does not change the public API.", source: "sentence" },
      "+export function widget() {}",
      ["src/widget.ts"],
      [region({ text: "+export function widget() {}" })],
    );
    expect(facts.contradicted).toBe(true);
    expect(facts.exportedSymbolsChanged).toEqual(["widget"]);
  });

  test("no-change claim that is NOT API-shaped never checks exported symbols", () => {
    const facts = computeClaimFacts(
      { text: "This does not change behavior for existing callers of the CLI.", source: "sentence" },
      "+export function widget() {}",
      ["src/widget.ts"],
      [region({ text: "+export function widget() {}" })],
    );
    // "callers" / "CLI" are not API-shaped by the narrow marker regex, so no contradiction check runs.
    expect(facts.exportedSymbolsChanged).toEqual([]);
    expect(facts.contradicted).toBe(false);
  });
});

describe("selectMatchedRegionsForClaim", () => {
  test("no tokens: no regions matched", () => {
    expect(selectMatchedRegionsForClaim([], [region()])).toEqual([]);
  });

  test("matches by token appearing in region text or path", () => {
    const r = region({ text: "+export function widget() {}" });
    expect(selectMatchedRegionsForClaim(["widget"], [r])).toEqual([r]);
  });
});

describe("selectContractClaims — budget", () => {
  test("default cap keeps every claim under it", () => {
    const claims = Array.from({ length: 5 }, (_, i) => ({ text: `claim ${i}`, source: "bullet" as const }));
    const selection = selectContractClaims(claims);
    expect(selection.selected).toHaveLength(5);
    expect(selection.skipped).toHaveLength(0);
    expect(selection.maxCalls).toBe(DEFAULT_MAX_JEV_CONTRACT_CALLS);
  });

  test("a smaller --max-calls skips the remainder, reported rather than silently dropped", () => {
    const claims = Array.from({ length: 5 }, (_, i) => ({ text: `claim ${i}`, source: "bullet" as const }));
    const selection = selectContractClaims(claims, 2);
    expect(selection.selected).toHaveLength(2);
    expect(selection.skipped).toHaveLength(3);
  });
});

describe("computeContractClaimItems / batchContractClaimItems", () => {
  test("every claim gets a stable CLAIMn id and its own noul question", () => {
    const claims = [
      { text: "adds a flag", source: "bullet" as const },
      { text: "fixes a bug", source: "bullet" as const },
    ];
    const items = computeContractClaimItems(claims, "+diff", ["src/x.ts"], []);
    expect(items.map((i) => i.id)).toEqual(["CLAIM1", "CLAIM2"]);
    const batches = batchContractClaimItems(items);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["CLAIM1", "CLAIM2"]);
    expect(batches[0]!.questions.CLAIM1?.type).toBe("noul");
  });
});

describe("synthesizeContractFindings — AC6", () => {
  function item(text: string, contradicted: boolean, matchedRegions: readonly ScopedRegion[] = []) {
    const facts = computeClaimFacts({ text, source: "bullet" as const }, "", [], contradicted ? [region({ text: "+export function widget() {}" })] : []);
    return { id: "CLAIM1", claim: { text, source: "bullet" as const }, facts, matchedRegions, changedFiles: [] };
  }

  test("a contradicted no-change claim is major, with a valid class_scope object, regardless of the noul score", () => {
    const claimItem = item("Does not change the public API.", true, [region()]);
    const scored: ScoredClaim[] = [{ item: claimItem, probability: 0.99 }];
    const findings = synthesizeContractFindings(scored);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.class_scope?.sites.length).toBeGreaterThan(0);
    expect(findings[0]!.class_scope?.enumeration_method.length).toBeGreaterThan(0);
  });

  test("an unsupported claim (below threshold, not contradicted) is minor", () => {
    const claimItem = item("Adds a brand-new retry mechanism.", false);
    const scored: ScoredClaim[] = [{ item: claimItem, probability: 0.1 }];
    const findings = synthesizeContractFindings(scored, DEFAULT_JEV_CONTRACT_THRESHOLD);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("minor");
    expect(findings[0]!.class_scope).toBeUndefined();
  });

  test("a well-evidenced claim (at/above threshold, not contradicted) produces no finding", () => {
    const claimItem = item("Adds a brand-new retry mechanism.", false);
    const scored: ScoredClaim[] = [{ item: claimItem, probability: 0.9 }];
    expect(synthesizeContractFindings(scored, DEFAULT_JEV_CONTRACT_THRESHOLD)).toEqual([]);
  });

  test("stats count major/minor correctly", () => {
    const scored: ScoredClaim[] = [
      { item: item("Does not change the public API.", true, [region()]), probability: 0.9 },
      { item: item("Adds a brand-new retry mechanism.", false), probability: 0.1 },
    ];
    const findings = synthesizeContractFindings(scored);
    expect(contractFindingStats(findings)).toEqual({ blocker: 0, major: 1, minor: 1, info: 0 });
  });
});

describe("renderContractMarkdown", () => {
  test("renders with no findings", () => {
    const md = renderContractMarkdown({
      status: "DONE",
      reviewer: "review-jev-contract",
      summary: "nothing to see",
      findings: [],
      stats: { blocker: 0, major: 0, minor: 0, info: 0 },
      claims: [],
      budget: { maxCalls: 30, claimsScored: 0, claimsSkipped: 0 },
    });
    expect(md).toContain("review-jev-contract");
    expect(md).toContain("_no findings_");
  });
});
