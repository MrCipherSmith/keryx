// The synonym table asserted as a CLOSED contract, not a subset.
//
// A presence-only test — "does this phrase produce `review`?" — catches a family
// that is deleted or remapped away and is blind to the one direction that
// matters: a family mapped to an ADDITIONAL token it should not produce. That is
// precisely how this work began. `провер` carried check + verify + REVIEW, so
// "проверь почту" ("check the mail") routed to a review skill at full trigger
// score, and no positive corpus pair could see it.
//
// Each row therefore states what a phrase MUST produce and what it must NOT.

import { describe, expect, test } from "bun:test";
import { expandQueryTokens, normalizeRouteText } from "./skills";

function tokensFor(text: string): ReadonlySet<string> {
  return expandQueryTokens(normalizeRouteText(text));
}

/** Tokens hot enough that a stray mapping to one changes routing outcomes. */
const HOT = ["review", "security", "deploy", "flow", "test", "implement"] as const;

/** phrase -> [must produce, must NOT produce] */
const TABLE: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ["сделай ревью", ["review"], ["security", "deploy"]],
  ["проверь это", ["check", "verify"], ["review"]],
  ["проверка почты", ["check", "verify"], ["review"]],
  ["реализуй фичу", ["implement"], ["review", "security"]],
  ["закрой задачу", ["task"], ["review", "deploy"]],
  ["напиши тесты", ["test", "tests", "testing"], ["review", "deploy"]],
  ["оцени качество", ["quality"], ["review", "security"]],
  ["собери документацию", ["documentation", "docs"], ["review", "deploy"]],
  ["проверь безопасность", ["security", "check"], ["review"]],
  ["найди уязвимости", ["security", "vulnerability"], ["review"]],
  ["составь план", ["plan", "planning"], ["review", "deploy"]],
  ["сделай рефакторинг", ["refactor"], ["review", "security"]],
  ["накати миграцию", ["migration", "migrate"], ["review", "deploy"]],
  ["измерь производительность", ["performance"], ["review", "security"]],
  ["построй граф", ["graph"], ["review", "deploy"]],
  ["создай скилл", ["skill", "create"], ["review", "security"]],
  ["разверни сервис", ["deploy"], ["review", "security"]],
  ["проведи интервью", ["interview"], ["review", "deploy"]],
  ["создай фло", ["flow", "create"], ["review", "security"]],
  ["проанализируй код", ["analyze", "analysis"], ["review", "deploy"]],
];

describe("every synonym family is a closed contract", () => {
  for (const [phrase, must, mustNot] of TABLE) {
    test(`${phrase} -> ${must.join("+")} and not ${mustNot.join("/")}`, () => {
      const tokens = tokensFor(phrase);
      for (const token of must) {
        expect(tokens.has(token), `${phrase} should produce ${token}`).toBe(true);
      }
      for (const token of mustNot) {
        expect(tokens.has(token), `${phrase} must NOT produce ${token}`).toBe(false);
      }
    });
  }

  test("the table is exercised broadly", () => {
    // Non-vacuity: an emptied TABLE would make every loop above vanish.
    expect(TABLE.length).toBeGreaterThanOrEqual(18);
    expect(TABLE.every(([, must]) => must.length > 0)).toBe(true);
    expect(TABLE.every(([, , mustNot]) => mustNot.length > 0)).toBe(true);
  });

  test("`проверь` means check, and specifically does not mean review", () => {
    // The originating defect, stated on its own so it cannot be lost in a table
    // edit: one провер* word covered review-verifier's two-word trigger by
    // itself, and "check the mail" routed there at 100.
    const tokens = tokensFor("проверь почту");
    expect(tokens.has("check")).toBe(true);
    expect(tokens.has("verify")).toBe(true);
    expect(tokens.has("review")).toBe(false);
  });

  test("no family quietly produces a routing-hot token it never claimed", () => {
    // The additive direction, swept rather than spot-checked.
    for (const [phrase, must, mustNot] of TABLE) {
      const tokens = tokensFor(phrase);
      for (const hot of HOT) {
        if (must.includes(hot) || mustNot.includes(hot)) continue;
        // Not asserted either way by this row: only report if it appears AND the
        // row's own phrase has no business producing it.
        if (tokens.has(hot) && !phrase.includes(hot)) {
          expect(
            `${phrase} produces the hot token "${hot}" without claiming it`,
          ).toBe("declared in the table");
        }
      }
    }
  });
});
