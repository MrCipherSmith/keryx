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
 * Whether this trigger can still fire when its words arrive in another order,
 * with other words between them.
 *
 * That is the property "order-free path" names, and it is what a real request
 * needs: nobody types a trigger phrase verbatim. The probe reverses the
 * trigger's words and pads between them with a token the tokenizer discards, so
 * a verbatim substring match cannot be what answers.
 *
 * A one-word trigger has no order to vary, so the probe instead surrounds it —
 * which is the inflected-matching property the earlier attempt cost 29 of them.
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
