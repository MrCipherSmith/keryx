// The reachable set may not shrink.
//
// This guard exists because of a specific, measured loss. An earlier attempt at
// the routing fix denied the order-free path to any trigger that had lost a
// word to the three-character filter. It read as a tightening. What it actually
// did was take the count of triggers with NO order-free path from 11 to 17, and
// cost 29 one-word triggers their inflected matching — and nothing noticed for
// three review rounds, because every test of the day asserted cases expected to
// work. A trigger that quietly stopped matching produced no failure anywhere.
//
// A count alone would not have been enough either: 11 -> 17 is visible, but
// which six is the question a reader needs answered, and a count lets one
// trigger regain a path while another loses it. So the SET is pinned by name.
//
// Ranked through `scoreBundledSkillRoute`, the same function the CLI calls, per
// AC3. There is no test-local reimplementation of the scoring here.

import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { normalizeRouteText, scoreBundledSkillRoute } from "./skills";

/**
 * Whether this trigger can still fire when it is not typed as the whole query.
 *
 * For a MULTI-word trigger the probe reverses the words and pads between them
 * with a token the tokenizer discards, so the verbatim scan cannot be what
 * answers and the order-free path is being measured.
 *
 * For a ONE-word trigger it is not. A single word has no order to vary, and
 * `please <word> it now` is answered by `containsPhrase`'s word-boundary scan —
 * the verbatim path — not by the order-free fallback. Review established this
 * by reimplementing `containsPhrase` standalone and finding all twenty one-word
 * triggers satisfied by it alone, and cross-checked it: none of the 36 triggers
 * stranded by the historical regression is one word.
 *
 * The docstring here used to claim that branch exercised the inflected matching
 * the earlier attempt cost 29 one-word triggers. It does not, and saying so was
 * the same defect this file guards against — a measurement described as
 * something it is not. What this function measures is REACHABILITY: the trigger
 * fires when it is not the entire query. Which path delivers it differs by
 * arity, and the inflected property has its own test below.
 */
function reachableOutOfOrder(entry: (typeof BUNDLED_GDSKILLS)[number], trigger: string): boolean {
  const words = normalizeRouteText(trigger).split(" ").filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const probe =
    words.length === 1
      ? `please ${words[0]} it now`
      : [...words].reverse().join(" qq ");

  // `qq` is two characters, so `routeTokens` drops it: the padding cannot
  // itself contribute a match.
  const { reasons } = scoreBundledSkillRoute(entry, probe);
  return reasons.some((reason) => reason.startsWith("trigger"));
}

/** Every `skill::trigger` in the catalog that cannot be reached out of order. */
function unreachableTriggers(): string[] {
  const out: string[] = [];
  for (const entry of BUNDLED_GDSKILLS) {
    for (const trigger of entry.triggers) {
      if (!reachableOutOfOrder(entry, trigger)) {
        out.push(`${entry.name}::${trigger}`);
      }
    }
  }
  return out.sort();
}

describe("no trigger loses a matching path it had", () => {
  test("the set of triggers with no order-free path is exactly what is recorded", () => {
    // Recorded as a set, not a count. If this fails, read the diff: a trigger
    // ADDED here lost a path and that is a regression to justify or revert; a
    // trigger REMOVED here gained one, which is usually the point of the change
    // and still belongs in the record.
    expect(unreachableTriggers()).toMatchSnapshot();
  });

  test("the guard is measuring a real catalog, not an empty one", () => {
    // The assertion above passes trivially against an empty catalog, which is
    // what a broken import gives it — and the failure mode being guarded is
    // exactly "nothing noticed".
    const triggers = BUNDLED_GDSKILLS.flatMap((entry) => entry.triggers);
    expect(BUNDLED_GDSKILLS.length).toBeGreaterThan(20);
    expect(triggers.length).toBeGreaterThan(100);
  });

  test("most triggers ARE reachable out of order, so the probe is not rejecting everything", () => {
    // Anti-vacuity for the probe itself. If `reachableOutOfOrder` were broken
    // shut, every trigger would land in the unreachable set and the snapshot
    // would simply record that — a guard passing while measuring nothing.
    const triggers = BUNDLED_GDSKILLS.flatMap((entry) => entry.triggers);
    const unreachable = unreachableTriggers();
    expect(unreachable.length).toBeLessThan(triggers.length / 2);
  });

  test("one-word triggers still match an inflected form, the property the earlier attempt cost 29 of them", () => {
    // The loss this flow exists to prevent, measured directly rather than
    // assumed from the reachability set above — which, for one-word triggers,
    // is answered by the verbatim scan and would stay green through exactly
    // this regression.
    //
    // `matchesInflected` allows a suffix on the LAST word of a trigger with a
    // stem of at least four characters, so `-ing` on a long enough trigger is
    // the honest probe. Triggers too short to inflect are excluded rather than
    // asserted, because the mechanism does not claim them.
    const oneWord = BUNDLED_GDSKILLS.flatMap((entry) =>
      entry.triggers
        .map((trigger) => ({ entry, trigger: normalizeRouteText(trigger) }))
        .filter(({ trigger }) => trigger.split(" ").filter(Boolean).length === 1 && trigger.length >= 4),
    );

    expect(oneWord.length).toBeGreaterThan(5);

    // Scored against an entry carrying ONLY the trigger under test.
    //
    // `scoreBundledSkillRoute` computes its trigger hit over ALL of an entry's
    // triggers, so a sibling can answer for the one being probed and the result
    // reads as covered. Verification found this on `review-orchestrator::ревью`:
    // its probe passes through RU synonym expansion satisfying the sibling
    // English trigger `review`, by a completely different mechanism than the
    // inflection this test names — so that trigger would stay "not lost" even
    // with `matchesInflected` broken for it. One of nineteen, and the same
    // shape of defect as the finding that produced this test: a case counted as
    // measured while something else did the answering.
    const lost = oneWord
      .filter(({ entry, trigger }) => {
        const isolated = { ...entry, triggers: [trigger] };
        const { reasons } = scoreBundledSkillRoute(isolated, `${trigger}ing the thing now`);
        return !reasons.some((reason) => reason.startsWith("trigger"));
      })
      .map(({ entry, trigger }) => `${entry.name}::${trigger}`);

    expect(lost).toEqual([]);
  });

  test("a two-word trigger is reached with its words reversed", () => {
    // The probe's own mechanism, pinned on a concrete case rather than assumed.
    // `review-frontend` carries `ui review`; "review qq ui" is not the phrase
    // verbatim, and the order-free path is the only thing that can match it.
    const frontend = BUNDLED_GDSKILLS.find((entry) => entry.name === "review-frontend");
    expect(frontend).toBeDefined();
    if (frontend !== undefined) {
      expect(reachableOutOfOrder(frontend, "ui review")).toBe(true);
    }
  });
});
