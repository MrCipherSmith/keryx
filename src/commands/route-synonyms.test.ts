// The synonym table is routing DATA, and 27 of its 33 new entries had no test.
//
// Measured, not supposed: a mutation deleting all 33 newly-added prefixes turned
// only 6 corpus tests red, and deleting `["полн", ["full","complete"]]` — the
// entry the change names as the root cause of the reported incident — turned
// none red at all, because the literal `"полное ревью"` catalog trigger masks
// it. So the corpus could not say which mechanism carried the fix, and a wrong
// prefix would ship silently.
//
// Driving `expandQueryTokens` directly pins the table itself, which is far
// cheaper than one end-to-end corpus pair per entry and does not depend on any
// catalog trigger staying where it is.

import { describe, expect, test } from "bun:test";
import { expandQueryTokens, normalizeRouteText } from "./skills";

function tokensFor(text: string): Set<string> {
  return new Set(expandQueryTokens(normalizeRouteText(text)).keys());
}

/** One inflected form a user would actually type, per prefix family. */
const EXPANSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["сделай ревью", ["review"]],
  ["ревьюирование кода", ["review"]],
  ["проверь это", ["check", "verify"]],
  ["реализуй фичу", ["implement"]],
  ["внедри это", ["implement"]],
  ["закрой задачу", ["task", "tasks"]],
  ["заведи тикет", ["issue", "ticket"]],
  ["напиши тесты", ["test", "tests", "testing", "write", "create"]],
  ["верифицируй результат", ["verify", "verification"]],
  ["оцени качество", ["quality"]],
  ["собери документацию", ["documentation", "docs", "document", "build"]],
  ["собери требования", ["requirements"]],
  ["подготовь пакет", ["package"]],
  ["напиши спецификацию", ["specification", "spec"]],
  ["проверь безопасность", ["security"]],
  ["найди уязвимости", ["security", "vulnerability"]],
  ["предотврати утечку", ["security", "exfiltration", "leak"]],
  ["собери контекст", ["context"]],
  ["составь план", ["plan", "planning"]],
  ["сделай рефакторинг", ["refactor"]],
  ["накати миграцию", ["migration", "migrate"]],
  ["измерь производительность", ["performance"]],
  ["проверь здоровье проекта", ["health"]],
  ["построй граф", ["graph"]],
  ["обнови вики", ["wiki"]],
  ["создай скилл", ["skill", "create"]],
  ["разверни сервис", ["deploy"]],
  ["обнови зависимости", ["dependency", "dependencies", "update", "upgrade"]],
  ["проведи интервью", ["interview"]],
  ["устрой брейншторм", ["brainstorm"]],
  ["опиши продукт", ["product", "prd"]],
  ["создай фло", ["flow", "create"]],
  ["запусти оркестратор", ["orchestrator", "orchestrate", "run"]],
  ["проанализируй код", ["analyze", "analysis"]],
  // The families added by this change, each named in its own right.
  ["полное покрытие", ["full", "complete"]],
  ["целиком проект", ["full", "whole"]],
  ["весь проект", ["all", "full"]],
  ["напиши функцию", ["write", "create"]],
  ["начни работу", ["start", "begin"]],
  ["исправь баг", ["fix"]],
  ["почини это", ["fix"]],
  ["найди файл", ["find"]],
  ["поиск по коду", ["find", "search"]],
  ["объясни архитектуру", ["explain"]],
  ["измени поведение", ["change", "changes"]],
  ["заведи флоу", ["create", "start", "flow"]],
  ["сделай коммит", ["commit"]],
  ["открой файл", ["open"]],
  ["пулл реквест", ["pull", "request"]],
  ["влей ветку", ["merge", "branch"]],
  ["запусти сборку", ["run", "build"]],
  ["проанализируй ишью", ["analyze", "analysis", "issue"]],
];

describe("every synonym family expands to the tokens it claims", () => {
  for (const [phrase, expected] of EXPANSIONS) {
    test(`${phrase} -> ${expected.join("+")}`, () => {
      const tokens = tokensFor(phrase);
      for (const token of expected) {
        expect(tokens.has(token)).toBe(true);
      }
    });
  }

  test("the table is exercised broadly, not by a handful of families", () => {
    // Non-vacuity: an emptied EXPANSIONS list would make every loop above
    // vanish and this file would pass while testing nothing.
    expect(EXPANSIONS.length).toBeGreaterThanOrEqual(45);
  });

  test("`проверь` does NOT imply review — it means check", () => {
    // It used to. One `провер*` word expanded to check+verify+review, which
    // satisfied review-verifier's two-word trigger "review --verify" on its own,
    // so "проверь почту" ("check the mail") routed there at 100.
    const tokens = tokensFor("проверь почту");
    expect(tokens.has("check")).toBe(true);
    expect(tokens.has("review")).toBe(false);
  });

  test("a token records the query word it came from", () => {
    // The map, not the set, is what stops one word satisfying a multi-word
    // trigger. Without the source, `sources.size` in triggerSpecificity is
    // meaningless.
    const map = expandQueryTokens(normalizeRouteText("проанализируй ишью"));
    expect(map.get("analyze")).toBe("проанализируй");
    expect(map.get("issue")).toBe("ишью");
  });
});
