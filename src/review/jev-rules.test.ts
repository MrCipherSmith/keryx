// flow 330 — pure-core tests for `review-jev-rules`. AC8: pure tests for
// discovery/applicability/pair selection/finding synthesis, hermetic and
// macOS-safe (no filesystem, no network — everything here is in-memory).

import { describe, expect, test } from "bun:test";
import {
  batchAllRulePairs,
  batchRulePairsForRegion,
  cappedSeverity,
  clauseApplicability,
  DEFAULT_JEV_RULES_THRESHOLD,
  declaredSeverityAndCleanText,
  extractRuleRationale,
  findingStats,
  firstChangedLineQuote,
  globToRegExp,
  inferLanguage,
  isCodingConventionSkill,
  matchesAnyGlob,
  metadataScalar,
  probabilityToConfidence,
  probabilityToUncappedSeverity,
  RULE_TOKEN_BUDGET,
  selectRuleHunkPairs,
  symbolsTouched,
  synthesizeFindingsFromViolations,
  type RuleHunkPair,
  type RuleSourceFile,
  type RuleViolationCandidate,
} from "./jev-rules";
import type { ScopedRegion } from "./scope";
import type { DetectedStack } from "./stack";
import type { RawReferenceClause } from "./conform-clauses";

function region(overrides: Partial<ScopedRegion> = {}): ScopedRegion {
  return {
    path: "src/example.ts",
    startLine: 10,
    endLine: 12,
    changedLines: 1,
    contextTruncated: false,
    text: "+export function widget() {}\n",
    ...overrides,
  };
}

function clause(id: string, text: string, headingPath: readonly string[] = []): RawReferenceClause {
  return { clause_id: id, text, heading_path: [...headingPath] };
}

const CERTAIN_STACK: DetectedStack = {
  tags: { nestjs: false, react: false, mobx: false, prisma: false, playwright: false, sql: false, "http-server": false },
  uncertain: false,
  reason: "detected from package.json",
  matched: [],
};

describe("globToRegExp / matchesAnyGlob", () => {
  test("`*` does not cross a path separator, `**` does", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/nested/a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/nested/a.ts")).toBe(true);
  });

  test("matchesAnyGlob is true when any glob in the list matches", () => {
    expect(matchesAnyGlob("src/core/x.ts", ["src/ui/**", "src/core/**"])).toBe(true);
    expect(matchesAnyGlob("src/other/x.ts", ["src/ui/**", "src/core/**"])).toBe(false);
  });
});

describe("metadataScalar", () => {
  test("reads a nested metadata field, quoted or bare", () => {
    const content = '---\nname: x\nmetadata:\n  engine: "jev"\n  category: conventions\n---\nbody\n';
    expect(metadataScalar(content, "engine")).toBe("jev");
    expect(metadataScalar(content, "category")).toBe("conventions");
    expect(metadataScalar(content, "missing")).toBeUndefined();
  });

  test("no frontmatter, or no metadata block, yields undefined rather than throwing", () => {
    expect(metadataScalar("no frontmatter here", "engine")).toBeUndefined();
    expect(metadataScalar("---\nname: x\n---\nbody", "engine")).toBeUndefined();
  });
});

describe("isCodingConventionSkill", () => {
  test("a name naming conventions matches", () => {
    expect(isCodingConventionSkill("review-frontend-conventions", "---\nname: x\n---\n").matches).toBe(true);
  });

  test("metadata.category: conventions matches even with a plain name", () => {
    const content = "---\nname: house-rules\nmetadata:\n  category: conventions\n---\n";
    expect(isCodingConventionSkill("house-rules", content).matches).toBe(true);
  });

  test("a plain review skill with neither marker does not match", () => {
    const content = "---\nname: review-style\nmetadata:\n  category: review\n---\n";
    const decision = isCodingConventionSkill("review-style", content);
    expect(decision.matches).toBe(false);
    expect(decision.reason).toContain("no convention marker");
  });
});

describe("clauseApplicability", () => {
  const source: RuleSourceFile = { path: "rules/core/x.mdc", kind: "project-rule", text: "# x\n- a clause\n" };

  test("no declared restriction applies to every changed file", () => {
    const decision = clauseApplicability(source, "any/file.ts", CERTAIN_STACK);
    expect(decision.applicable).toBe(true);
    expect(decision.reason).toContain("no path/stack restriction");
  });

  test("a declared path glob gates the file", () => {
    const scoped: RuleSourceFile = { ...source, declaredPaths: ["src/core/**"] };
    expect(clauseApplicability(scoped, "src/core/x.ts", CERTAIN_STACK).applicable).toBe(true);
    expect(clauseApplicability(scoped, "src/ui/x.ts", CERTAIN_STACK).applicable).toBe(false);
  });

  test("a declared stack requirement gates on detection, failing open when uncertain", () => {
    const scoped: RuleSourceFile = { ...source, stackRequires: ["react"] };
    expect(clauseApplicability(scoped, "src/any.ts", CERTAIN_STACK).applicable).toBe(false);
    const uncertain: DetectedStack = { ...CERTAIN_STACK, uncertain: true, reason: "no package.json" };
    expect(clauseApplicability(scoped, "src/any.ts", uncertain).applicable).toBe(true);
  });
});

describe("selectRuleHunkPairs", () => {
  const sources: RuleSourceFile[] = [
    { path: "rules/b.mdc", kind: "project-rule", text: "# B\n- clause one\n- clause two\n" },
    { path: "rules/a.mdc", kind: "project-rule", text: "# A\n- only clause\n" },
  ];

  test("deterministic order: regions in input order, sources sorted by path, clauses in extraction order", () => {
    const regions = [region({ path: "src/one.ts" }), region({ path: "src/two.ts" })];
    const result = selectRuleHunkPairs(regions, sources, CERTAIN_STACK, 100);
    expect(result.selected.map((p) => `${p.region.path}/${p.ruleId}/${p.clause.clause_id}`)).toEqual([
      "src/one.ts/rules/a.mdc/a-1",
      "src/one.ts/rules/b.mdc/b-1",
      "src/one.ts/rules/b.mdc/b-2",
      "src/two.ts/rules/a.mdc/a-1",
      "src/two.ts/rules/b.mdc/b-1",
      "src/two.ts/rules/b.mdc/b-2",
    ]);
  });

  test("a `--max-calls` cap keeps a stable prefix and reports the rest as dropped, never silently", () => {
    const regions = [region({ path: "src/one.ts" })];
    const full = selectRuleHunkPairs(regions, sources, CERTAIN_STACK, 100);
    const capped = selectRuleHunkPairs(regions, sources, CERTAIN_STACK, 2);
    expect(capped.selected).toEqual(full.selected.slice(0, 2));
    expect(capped.dropped).toEqual(full.selected.slice(2));
    expect(capped.maxCalls).toBe(2);
  });

  test("a rule inapplicable to a file is reported in notApplicable, not silently dropped", () => {
    const scoped: RuleSourceFile[] = [{ ...sources[0]!, declaredPaths: ["src/only-here/**"] }];
    const result = selectRuleHunkPairs([region({ path: "src/elsewhere.ts" })], scoped, CERTAIN_STACK);
    expect(result.selected).toEqual([]);
    expect(result.notApplicable).toHaveLength(1);
    expect(result.notApplicable[0]?.reason).toContain("no declared path glob");
  });
});

describe("batchRulePairsForRegion / batchAllRulePairs", () => {
  test("small pair sets fit in one batch", () => {
    const r = region();
    const pairs: RuleHunkPair[] = [
      { region: r, ruleId: "rules/a.mdc", clause: clause("a-1", "short clause"), reason: "x" },
      { region: r, ruleId: "rules/b.mdc", clause: clause("b-1", "another short clause"), reason: "x" },
    ];
    const batches = batchRulePairsForRegion(r, pairs);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["rules/a.mdc::a-1", "rules/b.mdc::b-1"]);
    expect(batches[0]!.state).toContain("--- state ---");
  });

  test("a huge questions set is split rather than exceeding the token budget", () => {
    const r = region();
    const bigText = "x".repeat(90_000);
    const pairs: RuleHunkPair[] = [
      { region: r, ruleId: "rules/a.mdc", clause: clause("a-1", bigText), reason: "x" },
      { region: r, ruleId: "rules/b.mdc", clause: clause("b-1", bigText), reason: "x" },
    ];
    const batches = batchRulePairsForRegion(r, pairs);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const questionsChars = Object.values(batch.questions).reduce((total, q) => total + q.instructions.length, 0);
      expect(questionsChars / 4).toBeLessThanOrEqual(RULE_TOKEN_BUDGET);
    }
  });

  test("batchAllRulePairs groups by region and covers every pair exactly once", () => {
    const r1 = region({ path: "a.ts" });
    const r2 = region({ path: "b.ts" });
    const pairs: RuleHunkPair[] = [
      { region: r1, ruleId: "rules/a.mdc", clause: clause("a-1", "c1"), reason: "x" },
      { region: r2, ruleId: "rules/a.mdc", clause: clause("a-1", "c1"), reason: "x" },
    ];
    const batches = batchAllRulePairs(pairs);
    const total = batches.reduce((sum, b) => sum + b.items.length, 0);
    expect(total).toBe(2);
    expect(new Set(batches.map((b) => b.region.path))).toEqual(new Set(["a.ts", "b.ts"]));
  });
});

describe("severity/confidence mapping", () => {
  test("probabilityToUncappedSeverity bands", () => {
    expect(probabilityToUncappedSeverity(0.95)).toBe("blocker");
    expect(probabilityToUncappedSeverity(0.8)).toBe("major");
    expect(probabilityToUncappedSeverity(0.6)).toBe("minor");
    expect(probabilityToUncappedSeverity(0.3)).toBe("info");
  });

  test("probabilityToConfidence: certainty (distance from 0.5) decides the band, both directions", () => {
    expect(probabilityToConfidence(0.95)).toBe("high");
    expect(probabilityToConfidence(0.05)).toBe("high");
    expect(probabilityToConfidence(0.7)).toBe("medium");
    expect(probabilityToConfidence(0.55)).toBe("low");
  });

  test("declaredSeverityAndCleanText strips a trailing marker and reports it", () => {
    expect(declaredSeverityAndCleanText("must not do X [severity: major]")).toEqual({ text: "must not do X", declared: "major" });
    expect(declaredSeverityAndCleanText("no marker here")).toEqual({ text: "no marker here" });
  });

  test("cappedSeverity caps at minor unless the rule declares higher", () => {
    expect(cappedSeverity("blocker", undefined)).toBe("minor");
    expect(cappedSeverity("major", undefined)).toBe("minor");
    expect(cappedSeverity("info", undefined)).toBe("info");
    expect(cappedSeverity("blocker", "major")).toBe("major");
    expect(cappedSeverity("info", "major")).toBe("info");
    expect(cappedSeverity("blocker", "blocker")).toBe("blocker");
  });
});

describe("firstChangedLineQuote / inferLanguage / symbolsTouched", () => {
  test("quotes the first non-empty changed line, prefix stripped", () => {
    const r = region({ text: " context line\n+  const widget = build();\n-old line\n" });
    expect(firstChangedLineQuote(r)).toBe("const widget = build();");
  });

  test("inferLanguage reads the extension, unknown is honest about it", () => {
    expect(inferLanguage("src/a.ts")).toBe("typescript");
    expect(inferLanguage("README")).toBe("unknown");
    expect(inferLanguage("a.exotic")).toBe("unknown");
  });

  test("symbolsTouched picks up declaration-shaped identifiers from changed lines only", () => {
    expect(symbolsTouched("+function widget() {}\n context.notThis()\n-class Old {}\n")).toBe("widget, Old");
    expect(symbolsTouched(" context.only()\n")).toBe("(none matched)");
  });
});

describe("extractRuleRationale", () => {
  test("finds the clause under a rationale/why/purpose heading", () => {
    const text = "# Rule\n\n## Rationale\n\n- keeps things consistent\n\n## Clauses\n\n- do the thing\n";
    expect(extractRuleRationale(text)).toBe("keeps things consistent");
  });

  test("undefined when no such heading exists", () => {
    expect(extractRuleRationale("# Rule\n\n- do the thing\n")).toBeUndefined();
  });
});

describe("synthesizeFindingsFromViolations", () => {
  test("one finding per (clause, file), deduped across every hunk with a hunk list", () => {
    const r1 = region({ path: "src/a.ts", startLine: 5, endLine: 7 });
    const r2 = region({ path: "src/a.ts", startLine: 20, endLine: 22 });
    const c = clause("core-1", "always do X", ["Core"]);
    const candidates: RuleViolationCandidate[] = [
      { region: r1, ruleId: "rules/core.mdc", clause: c, probability: 0.6 },
      { region: r2, ruleId: "rules/core.mdc", clause: c, probability: 0.9 },
    ];
    const findings = synthesizeFindingsFromViolations(candidates, DEFAULT_JEV_RULES_THRESHOLD);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.file).toBe("src/a.ts");
    expect(finding.line).toBe(5);
    expect(finding.evidence).toContain("src/a.ts:5-7");
    expect(finding.evidence).toContain("src/a.ts:20-22");
    expect(finding.dedupe_key).toBe("rules/core.mdc::core-1::src/a.ts");
    // Severity is driven by the WORST hunk (0.9 -> uncapped blocker, capped at minor).
    expect(finding.severity).toBe("minor");
    expect(finding.reviewer).toBe("review-jev-rules");
  });

  test("below threshold produces no finding", () => {
    const candidates: RuleViolationCandidate[] = [
      { region: region(), ruleId: "rules/x.mdc", clause: clause("x-1", "text"), probability: 0.2 },
    ];
    expect(synthesizeFindingsFromViolations(candidates, 0.5)).toEqual([]);
  });

  test("a rule with a stated rationale supplies impact; otherwise the fixed template is used", () => {
    const withRationale: RuleViolationCandidate[] = [
      { region: region({ path: "a.ts" }), ruleId: "rules/a.mdc", clause: clause("a-1", "text"), probability: 0.9 },
    ];
    const rationales = new Map([["rules/a.mdc", "because consistency matters"]]);
    const [f1] = synthesizeFindingsFromViolations(withRationale, DEFAULT_JEV_RULES_THRESHOLD, rationales);
    expect(f1?.impact).toBe("because consistency matters");

    const [f2] = synthesizeFindingsFromViolations(withRationale, DEFAULT_JEV_RULES_THRESHOLD);
    expect(f2?.impact).toContain("Violating a documented project rule");
  });

  test("findingStats counts by severity", () => {
    const candidates: RuleViolationCandidate[] = [
      { region: region({ path: "a.ts" }), ruleId: "r1", clause: clause("c1", "x [severity: major]"), probability: 0.99 },
      { region: region({ path: "b.ts" }), ruleId: "r2", clause: clause("c2", "y"), probability: 0.6 },
    ];
    const findings = synthesizeFindingsFromViolations(candidates, DEFAULT_JEV_RULES_THRESHOLD);
    expect(findingStats(findings)).toEqual({ blocker: 0, major: 1, minor: 1, info: 0 });
  });
});
