// The baseline is the deliverable, and it comes first.
//
// An earlier attempt at this fix was reviewed three times and each round found
// regressions the round before had introduced — 29 one-word triggers silently
// losing inflected matching, the count of triggers with no order-free path going
// from 11 to 17, a synonym family keeping a mapping its sibling had lost. All of
// them traced to one cause: the corpus of the day asserted only cases expected
// to WORK. Improvements were visible; losses were not.
//
// So this file asserts what the router DOES, including what it does wrong. A
// change to the scorer either leaves it alone or shows up as a diff someone has
// to justify line by line. That is the whole mechanism.

import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { ROUTING_BASELINE } from "./routing-baseline";
import { scoreBundledSkillRoute } from "./skills";

function top(query: string): { name: string | null; score: number } {
  const best = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))[0];
  return { name: best?.entry.name ?? null, score: best?.score ?? 0 };
}

describe("the recorded baseline is what the router actually does", () => {
  for (const entry of ROUTING_BASELINE) {
    test(`${entry.verdict}: ${entry.query} -> ${entry.top ?? "(nothing)"}`, () => {
      const actual = top(entry.query);
      expect(actual.name).toBe(entry.top);
      // The score is pinned too. Without it a change can move a result from a
      // confident match to a marginal one, or the reverse, with the name intact
      // — and the ROUTING_FLOOR that governs what the orient hook prints is a
      // score threshold, so that movement is exactly what goes unnoticed.
      expect(actual.score).toBe(entry.score);
    });
  }
});

describe("the baseline is honest about itself", () => {
  test("it records failures, not only successes", () => {
    // A baseline of things that work is the artefact that failed three rounds.
    // If this ever reaches zero it is because the router improved, and the
    // entries have to be re-verdicted deliberately rather than deleted.
    const wrong = ROUTING_BASELINE.filter((entry) => entry.verdict === "wrong");
    expect(wrong.length).toBeGreaterThan(0);
    for (const entry of wrong) {
      expect(entry.note, `${entry.query} is marked wrong with no reason`).toBeDefined();
    }
  });

  test("it covers the three classes that went unwatched", () => {
    const queries = ROUTING_BASELINE.map((entry) => entry.query);
    // Negatives: prompts that should name nothing.
    expect(queries).toContain("commitment issues");
    expect(queries).toContain("open the file");
    expect(queries).toContain("проверка почты");
    // Inflected forms of one-word triggers, which a boundary-anchored verbatim
    // test silently loses.
    expect(queries).toContain("run the deployment");
    expect(queries).toContain("brainstorming ideas");
    // Both directions of the defect under repair.
    expect(queries).toContain("review");
    expect(queries).toContain("frontend review");
  });

  test("every skill it names exists", () => {
    // A typo in a `top` field would make the pair assert nothing forever.
    for (const entry of ROUTING_BASELINE) {
      if (entry.top === null) continue;
      expect(BUNDLED_GDSKILLS.some((skill) => skill.name === entry.top), entry.query).toBe(true);
    }
  });

  test("it is big enough to be a corpus", () => {
    expect(ROUTING_BASELINE.length).toBeGreaterThanOrEqual(20);
    expect(BUNDLED_GDSKILLS.length).toBeGreaterThan(50);
  });
});

describe("no second copy of the ranking exists", () => {
  test("the baseline ranks through the shipped scorer, not a private reimplementation", () => {
    // Three copies of this pipeline existed at one point — the CLI router, the
    // per-prompt router, and a helper duplicated across two test files — and
    // they disagreed. The duplication is what let a corpus pass while the
    // shipped surface was silent.
    const direct = top("frontend review");
    const viaScorer = scoreBundledSkillRoute(
      BUNDLED_GDSKILLS.find((skill) => skill.name === "review-frontend")!,
      "frontend review",
    );
    expect(direct.score).toBe(viaScorer.score);
  });
});
