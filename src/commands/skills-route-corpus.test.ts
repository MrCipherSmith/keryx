// Routing is pinned by a corpus, because spot checks are what let it break.
//
// A live session was asked, in Russian, for a full review. It never reached
// `review-orchestrator`. The cause was not the language: `review-frontend`
// carries the trigger "ui review", `routeTokens` drops tokens under three
// characters, so the trigger reduced to ["review"] — and the order-free test is
// `every(token => queryTokens.has(token))`, which a one-element list satisfies
// for ANY query containing "review". The specialist therefore claimed a full
// trigger hit on every review request in every language and outscored the
// orchestrator, inverting the orchestrator's own contract: it exists for the
// request that names no specialist, and that is the request it lost.
//
// The same collapse hit "open PR" -> "open" and "db migrate" -> "migrate".
//
// Two directions have to hold at once, and fixing either one alone breaks the
// other, which is why they are asserted together rather than in separate tests:
// a GENERIC request must reach the orchestrator, and a request NAMING a
// specialist must reach that specialist.

import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { routePrompt } from "../ctx/orient-routing";
import { scoreBundledSkillRoute, triggerSpecificity, normalizeRouteText } from "./skills";

function topSkill(query: string): { name: string; category: string; score: number } | null {
  const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const best = ranked[0];
  return best ? { name: best.entry.name, category: best.entry.category, score: best.score } : null;
}

/**
 * (query, expected top-1). Every pair here is one a human would answer the same
 * way; genuinely ambiguous requests ("проверь качество", "объясни архитектуру")
 * are deliberately absent rather than pinned to whichever skill happens to win.
 */
const RU_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["сделай мне полное ревью без исправления", "review-orchestrator"],
  ["полное ревью проекта", "review-orchestrator"],
  ["сделай код ревью всего проекта", "review-orchestrator"],
  ["проведи ревью пулл реквеста", "review-orchestrator"],
  ["проверь безопасность кода", "review-security-code"],
  ["найди узкие места по производительности", "review-performance"],
  ["создай фло на эту задачу", "flow-orchestrator"],
  ["заведи флоу из этой ишьи", "flow-orchestrator"],
  ["проанализируй ишью", "issue-analyzer"],
  ["реализуй задачу", "task-implementer"],
  ["напиши спецификацию", "spec-writer"],
  ["напиши тесты для этого модуля", "test-gen"],
  ["оформи пакет документации", "docpack-orchestrator"],
  ["создай PRD", "prd-creator"],
  ["обнови зависимости", "dependency-update"],
  ["сделай коммит", "commit"],
  ["открой пулл реквест", "pr"],
  ["создай скилл для этого модуля", "entity-skill-creator"],
  ["разбери CLAUDE.md", "agent-entrypoint-distiller"],
];

const EN_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["review", "review-orchestrator"],
  ["do a review", "review-orchestrator"],
  ["do a full review without fixing", "review-orchestrator"],
  ["review the changes", "review-orchestrator"],
  ["frontend review", "review-frontend"],
  ["security review", "review-security-code"],
  ["architecture review", "review-architecture"],
  ["backend review", "review-backend"],
  ["logic review", "review-logic"],
  ["highload review", "review-highload"],
  ["layout review", "review-layout"],
  ["clean code review", "review-clean-code"],
  ["review the mobx store", "code-mobx-store-review"],
  ["verify the findings", "review-verifier"],
  ["review PR feedback", "review-pr-feedback"],
  ["implement this issue end to end", "job-orchestrator"],
  ["create a flow from this issue", "flow-orchestrator"],
  ["analyze the issue", "issue-analyzer"],
  ["brainstorm options", "brainstorm"],
  ["write a technical specification", "spec-writer"],
  ["open a PR", "pr"],
  ["commit changes", "commit"],
  ["update dependencies", "dependency-update"],
  ["generate a changelog", "changelog"],
  ["run the quality gate", "code-verifier"],
  ["security audit", "security-audit"],
];

describe("routing corpus", () => {
  test("the corpus is real — an empty catalog would pass every assertion vacuously", () => {
    expect(BUNDLED_GDSKILLS.length).toBeGreaterThan(50);
    expect(RU_CORPUS.length + EN_CORPUS.length).toBeGreaterThanOrEqual(30);
    // Russian is not a token afterthought: the reported failure was a Russian
    // request, and an English-only corpus would not have caught it.
    expect(RU_CORPUS.length * 3).toBeGreaterThanOrEqual(RU_CORPUS.length + EN_CORPUS.length);
    // Every expected skill must exist, or a typo becomes a silent pass.
    for (const [, expected] of [...RU_CORPUS, ...EN_CORPUS]) {
      expect(BUNDLED_GDSKILLS.some((s) => s.name === expected)).toBe(true);
    }
  });

  for (const [query, expected] of RU_CORPUS) {
    test(`ru: ${query} -> ${expected}`, () => {
      expect(topSkill(query)?.name).toBe(expected);
    });
  }

  for (const [query, expected] of EN_CORPUS) {
    test(`en: ${query} -> ${expected}`, () => {
      expect(topSkill(query)?.name).toBe(expected);
    });
  }
});

// Ranking is not what ships. `topSkill` above filters `score > 0`; the surface a
// user meets is `routePrompt`, which filters `score >= ROUTING_FLOOR` and is what
// the orient hook prints. Three pairs of this corpus were green while the hook
// emitted NOTHING for them — including `open a PR`, one of the very collapses
// this file's header says the change fixed. Asserting ranking alone let the
// headline regression asset pass while the feature was silent.
describe("the corpus holds through the surface that actually ships", () => {
  for (const [query, expected] of [...RU_CORPUS, ...EN_CORPUS]) {
    test(`routePrompt: ${query} -> ${expected}`, () => {
      const emitted = routePrompt(query);
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted[0]?.name).toBe(expected);
    });
  }

  test("ranking and emission agree on every pair — no pair ranks one way and emits another", () => {
    const disagreements = [...RU_CORPUS, ...EN_CORPUS]
      .map(([query]) => ({ query, ranked: topSkill(query)?.name, emitted: routePrompt(query)[0]?.name }))
      .filter((row) => row.ranked !== row.emitted);
    expect(disagreements).toEqual([]);
  });
});

describe("a trigger cannot fire on fewer words than it was written with", () => {
  // The scorer now needs token -> source-word, so one query word cannot satisfy
  // a multi-word trigger through synonym expansion.
  const tokensOf = (q: string) =>
    new Map(
      normalizeRouteText(q)
        .split(" ")
        .filter((t) => t.length >= 3)
        .map((t) => [t, t] as const),
    );

  test('"ui review" no longer degenerates to "review"', () => {
    // The regression in one line: before the fix this returned a hit, because
    // "ui" was filtered out and `every` over ["review"] is trivially true.
    expect(triggerSpecificity("ui review", "review", tokensOf("review"))).toBe(0);
    // It still fires when the query actually says it.
    expect(triggerSpecificity("ui review", "ui review", tokensOf("ui review"))).toBe(2);
  });

  test('"open pr" no longer fires on any query containing "open"', () => {
    expect(triggerSpecificity("open pr", "open the file", tokensOf("open the file"))).toBe(0);
  });

  test("a genuine one-word trigger still works, because verbatim is what it meant", () => {
    expect(triggerSpecificity("brainstorm", "brainstorm options", tokensOf("brainstorm options"))).toBe(1);
  });

  test("a two-token trigger still matches order-free", () => {
    // The behaviour the order-free path exists for, unchanged.
    expect(
      triggerSpecificity("requirements package", "prepare a requirements documentation package", tokensOf("prepare a requirements documentation package")),
    ).toBe(2);
  });

  test("a longer match outranks a shorter one, which is what keeps both directions right", () => {
    const generic = triggerSpecificity("review", "frontend review", tokensOf("frontend review"));
    const specific = triggerSpecificity("frontend review", "frontend review", tokensOf("frontend review"));
    expect(specific).toBeGreaterThan(generic);
  });
});

describe("the orchestrator takes the request that names no specialist", () => {
  test("a generic review outranks every specialist reviewer", () => {
    const generic = topSkill("review");
    expect(generic?.name).toBe("review-orchestrator");
    const frontend = scoreBundledSkillRoute(
      BUNDLED_GDSKILLS.find((s) => s.name === "review-frontend")!,
      "review",
    );
    expect(frontend.reasons).not.toContain("trigger");
    expect(frontend.score).toBeLessThan(generic!.score);
  });

  test("naming a specialist still reaches it — the direction that is easy to break while fixing the other", () => {
    for (const [query, expected] of [
      ["frontend review", "review-frontend"],
      ["security review", "review-security-code"],
      ["backend review", "review-backend"],
    ] as const) {
      expect(topSkill(query)?.name).toBe(expected);
    }
  });
});
