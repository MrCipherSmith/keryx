import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { normalizeRouteText, scoreBundledSkillRoute } from "./skills";

function topBundled(query: string): { name: string; score: number } | undefined {
  const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const best = ranked[0];
  return best ? { name: best.entry.name, score: best.score } : undefined;
}

describe("normalizeRouteText", () => {
  test("preserves Cyrillic instead of erasing it", () => {
    expect(normalizeRouteText("Пакет Документации")).toBe("пакет документации");
  });

  test("splits camelCase and drops punctuation", () => {
    expect(normalizeRouteText("PipelineStepStore.ts")).toBe("pipeline step store ts");
  });

  test("a symbol-only query normalizes to empty (no false matches)", () => {
    expect(normalizeRouteText("!!! --- ???")).toBe("");
  });
});

describe("scoreBundledSkillRoute", () => {
  test("Russian 'пакет документации' routes to docpack-orchestrator", () => {
    const top = topBundled("подготовь пакет документации для реализации");
    expect(top?.name).toBe("docpack-orchestrator");
  });

  test("English 'requirements documentation package' routes to docpack-orchestrator", () => {
    const top = topBundled("prepare requirements documentation package");
    expect(top?.name).toBe("docpack-orchestrator");
  });

  test("an empty/symbol-only query matches nothing (no .includes(\"\") trap)", () => {
    const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, "?!?"))
      .filter((match) => match.score > 0);
    expect(ranked).toHaveLength(0);
  });

  test("stopwords alone do not produce a match", () => {
    const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, "для the и with"))
      .filter((match) => match.score > 0);
    expect(ranked).toHaveLength(0);
  });

  test("Russian intents reach English-only skills via synonym expansion", () => {
    // These skills carry English-only triggers/descriptions; the query is Russian.
    const cases: Array<[string, string]> = [
      ["реализуй задачу по тикету", "task-implementer"],
      ["оформи пакет документации модуля", "docpack-orchestrator"],
    ];
    for (const [query, expected] of cases) {
      const names = BUNDLED_GDSKILLS.map((entry) => ({
        name: entry.name,
        ...scoreBundledSkillRoute(entry, query),
      }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((match) => match.name);
      expect(names).toContain(expected);
    }
  });

  test("a Russian review intent surfaces a review skill", () => {
    const top = BUNDLED_GDSKILLS.map((entry) => {
      const scored = scoreBundledSkillRoute(entry, "проведи ревью пулл реквеста");
      return { category: entry.category, score: scored.score };
    })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    expect(top?.category).toBe("review");
  });

  test("every bundled skill is reachable by its own name", () => {
    for (const entry of BUNDLED_GDSKILLS) {
      const result = scoreBundledSkillRoute(entry, entry.name);
      expect(result.score).toBeGreaterThan(0);
    }
  });
});
