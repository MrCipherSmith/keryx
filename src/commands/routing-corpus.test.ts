// The per-skill half of the routing guard.
//
// `routing-baseline.test.ts` pins exact scores for 27 hand-picked queries and
// watches the SCORER. This file watches the CATALOG: every bundled skill, in a
// user's own words, with the neighbour that must beat it on the prompts the two
// share. Descriptions and triggers are now read from each skill's SKILL.md, so
// an editor polishing one skill's prose can take another skill's queries away
// from it — and the 27-query baseline would not notice, because it never names
// most of these skills.
//
// Both files rank through the SHIPPED `scoreBundledSkillRoute`. A private copy
// of the ranking is how a corpus passes while the real surface is silent, and
// that has already happened here once.

import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import {
  AC7_REQUIRED_QUERIES,
  KNOWN_ROUTING_GAPS,
  RANK1_FIRST,
  RANK1_TOTAL,
  ROUTING_CORPUS,
  type RoutingCase,
} from "./routing-corpus";
import { normalizeRouteText, scoreBundledSkillRoute } from "./skills";

const MIN_POSITIVES = 3;
const MIN_NEGATIVES = 2;
// A single non-quoting positive proves the router survives one rewrite. Two
// prove the skill was not patched until exactly one lucky sentence got
// through — the floor T21 found 48 skills sitting on exactly.
const MIN_PARAPHRASES = 2;

function ranking(query: string): { name: string; score: number }[] {
  return BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((match) => ({ name: match.entry.name, score: match.score }));
}

function rankOf(ranked: { name: string }[], skill: string): number {
  const index = ranked.findIndex((match) => match.name === skill);
  return index < 0 ? Number.POSITIVE_INFINITY : index + 1;
}

function scoreOf(ranked: { name: string; score: number }[], skill: string): number {
  return ranked.find((match) => match.name === skill)?.score ?? 0;
}

function show(ranked: { name: string; score: number }[]): string {
  return ranked.slice(0, 4).map((m, i) => `${i + 1}.${m.name}(${m.score})`).join("  ") || "(nothing)";
}

/**
 * Whether `prompt` quotes `phrase` word for word.
 *
 * Deliberately stricter than the scorer's own `containsPhrase`, which also
 * accepts an inflected last word. "reviewing the diff" is the user's phrasing of
 * the trigger "review", not a copy of it, and the non-vacuity rule below is
 * about copying.
 */
function quotesVerbatim(prompt: string, phrase: string): boolean {
  const words = normalizeRouteText(prompt).split(" ").filter(Boolean);
  const target = normalizeRouteText(phrase).split(" ").filter(Boolean);
  if (target.length === 0) return false;
  for (let i = 0; i + target.length <= words.length; i += 1) {
    if (target.every((word, j) => words[i + j] === word)) return true;
  }
  return false;
}

const CATALOG_NAMES = new Set(BUNDLED_GDSKILLS.map((entry) => entry.name));
const BY_SKILL = new Map<string, RoutingCase>(ROUTING_CORPUS.map((entry) => [entry.skill, entry]));

const EXCLUDED_POSITIVES = new Set(
  KNOWN_ROUTING_GAPS.filter((gap) => gap.excluded && gap.kind === "positive").map(
    (gap) => `${gap.skill}\0${gap.prompt}`,
  ),
);
const EXCLUDED_NEGATIVES = new Set(
  KNOWN_ROUTING_GAPS.filter((gap) => gap.excluded && gap.kind === "negative").map(
    (gap) => `${gap.skill}\0${gap.prompt}`,
  ),
);

describe("the corpus covers the whole catalog", () => {
  test("every bundled skill has a case, rendered-only ones included", () => {
    // Rendered-only skills have no SKILL.md to read a description from, which is
    // exactly why they are the ones most likely to be forgotten here.
    const missing = BUNDLED_GDSKILLS.map((entry) => entry.name).filter((name) => !BY_SKILL.has(name));
    expect(missing, `skills with no routing case: ${missing.join(", ")}`).toEqual([]);
  });

  test("every case names a real skill, once", () => {
    for (const entry of ROUTING_CORPUS) {
      expect(CATALOG_NAMES.has(entry.skill), `${entry.skill} is not in the catalog`).toBe(true);
    }
    expect(BY_SKILL.size).toBe(ROUTING_CORPUS.length);
  });

  test("every case carries enough cases to mean something", () => {
    // A case with one positive and no negative passes forever and measures
    // nothing. The counts are the floor, not the target.
    for (const entry of ROUTING_CORPUS) {
      expect(entry.positives.length, `${entry.skill} positives`).toBeGreaterThanOrEqual(MIN_POSITIVES);
      expect(entry.negatives.length, `${entry.skill} negatives`).toBeGreaterThanOrEqual(MIN_NEGATIVES);
    }
  });

  test("every negative names an owner that exists and is not itself", () => {
    for (const entry of ROUTING_CORPUS) {
      for (const negative of entry.negatives) {
        expect(CATALOG_NAMES.has(negative.owner), `${entry.skill}: unknown owner ${negative.owner}`).toBe(true);
        expect(negative.owner, `${entry.skill} cannot outrank itself`).not.toBe(entry.skill);
      }
    }
  });
});

describe("the prompts are not copies of the trigger lists", () => {
  // A corpus assembled out of a skill's own triggers asserts that string
  // equality works. It passes on the day someone deletes the description, and it
  // passes on the day a trigger stops describing anything a user says.
  test(`every skill has at least ${MIN_PARAPHRASES} positives that quote none of its triggers`, () => {
    for (const entry of ROUTING_CORPUS) {
      const skill = BUNDLED_GDSKILLS.find((candidate) => candidate.name === entry.skill);
      if (!skill) continue;
      const paraphrases = entry.positives.filter(
        (prompt) => !skill.triggers.some((trigger) => quotesVerbatim(prompt, trigger)),
      );
      expect(
        paraphrases.length,
        `${entry.skill}: only ${paraphrases.length} positive(s) avoid quoting its own triggers word for ` +
          `word, need at least ${MIN_PARAPHRASES} — one paraphrase is a lucky sentence, not a floor`,
      ).toBeGreaterThanOrEqual(MIN_PARAPHRASES);
    }
  });

  test("no positive is a bare trigger phrase, except the ones AC7 names", () => {
    const allowed = new Set(AC7_REQUIRED_QUERIES.map(normalizeRouteText));
    for (const entry of ROUTING_CORPUS) {
      const skill = BUNDLED_GDSKILLS.find((candidate) => candidate.name === entry.skill);
      if (!skill) continue;
      for (const prompt of entry.positives) {
        const normalized = normalizeRouteText(prompt);
        if (allowed.has(normalized)) continue;
        const echoed = skill.triggers.some((trigger) => normalizeRouteText(trigger) === normalized);
        expect(echoed, `${entry.skill}: positive "${prompt}" is exactly a trigger phrase`).toBe(false);
      }
    }
  });

  test("the Russian phrasings are present where the skill carries Russian triggers", () => {
    // Bundled metadata is mostly English, and Russian intents reach it only
    // through the synonym table in the scorer. A corpus with no Cyrillic in it
    // cannot see that table break.
    const cyrillic = /\p{Script=Cyrillic}/u;
    const withRussianTriggers = BUNDLED_GDSKILLS.filter((entry) =>
      entry.triggers.some((trigger) => cyrillic.test(trigger)),
    );
    expect(withRussianTriggers.length).toBeGreaterThan(0);
    const covered = withRussianTriggers.filter((skill) =>
      (BY_SKILL.get(skill.name)?.positives ?? []).some((prompt) => cyrillic.test(prompt)),
    );
    expect(
      covered.length,
      `skills with Russian triggers and no Russian positive: ${withRussianTriggers
        .filter((skill) => !covered.includes(skill))
        .map((skill) => skill.name)
        .join(", ")}`,
    ).toBe(withRussianTriggers.length);
  });
});

describe("every positive puts its skill in the top 3", () => {
  for (const entry of ROUTING_CORPUS) {
    test(entry.skill, () => {
      for (const prompt of entry.positives) {
        if (EXCLUDED_POSITIVES.has(`${entry.skill}\0${prompt}`)) continue;
        const ranked = ranking(prompt);
        expect(rankOf(ranked, entry.skill), `"${prompt}" -> ${show(ranked)}`).toBeLessThanOrEqual(3);
      }
    });
  }
});

describe("every negative is won by the skill that owns it", () => {
  for (const entry of ROUTING_CORPUS) {
    test(entry.skill, () => {
      for (const negative of entry.negatives) {
        if (EXCLUDED_NEGATIVES.has(`${entry.skill}\0${negative.prompt}`)) continue;
        const ranked = ranking(negative.prompt);
        // Strictly above: a tie is decided alphabetically, which is not a
        // routing decision anyone should rely on.
        expect(
          scoreOf(ranked, negative.owner),
          `"${negative.prompt}": ${negative.owner} must outrank ${entry.skill} — ${show(ranked)}`,
        ).toBeGreaterThan(scoreOf(ranked, entry.skill));
      }
    });
  }
});

describe("rank-1 accuracy is a ratchet, pinned as two integers", () => {
  // `RANK1_FIRST`/`RANK1_TOTAL` replace a single float threshold
  // (`accuracy >= RANK1_BASELINE`) that a reviewer could quietly relax by
  // editing one number down to anything still under the live accuracy —
  // exactly what happened when it was set to 0.6 and nothing failed. Equality
  // against a live re-measurement closes that: no number smaller than the
  // true measured count can pass on its own, or the mismatch fails the test
  // both ways.

  function measure(): { total: number; first: number; lost: string[] } {
    let total = 0;
    let first = 0;
    const lost: string[] = [];
    for (const entry of ROUTING_CORPUS) {
      for (const prompt of entry.positives) {
        if (EXCLUDED_POSITIVES.has(`${entry.skill}\0${prompt}`)) continue;
        total += 1;
        const ranked = ranking(prompt);
        if (ranked[0]?.name === entry.skill) {
          first += 1;
        } else {
          lost.push(`${entry.skill} lost "${prompt}" to ${ranked[0]?.name ?? "(nothing)"}`);
        }
      }
    }
    return { total, first, lost };
  }

  test("RANK1_TOTAL equals the corpus's own counted-positive count", () => {
    // Pins the denominator to the corpus itself: adding, removing, or newly
    // excluding a positive changes this count, and the recorded constant has
    // to move with it in the same diff — it cannot go stale in either
    // direction.
    const { total } = measure();
    expect(
      RANK1_TOTAL,
      `RANK1_TOTAL (${RANK1_TOTAL}) does not match the corpus's counted positives (${total}) — ` +
        "update RANK1_TOTAL (and RANK1_FIRST) in the same change that changed the corpus",
    ).toBe(total);
  });

  test("RANK1_FIRST equals the measured first-place count exactly", () => {
    // Not `>=`: a regression (measured below RANK1_FIRST) fails here, same as
    // a floor would. An IMPROVEMENT (measured above RANK1_FIRST) fails here
    // too, on purpose — the fix is to raise RANK1_FIRST to the new measured
    // count in a reviewable diff, not to let the suite go on passing against
    // a stale, too-low record.
    const { first, lost } = measure();
    expect(
      first,
      first < RANK1_FIRST
        ? `rank-1 first-place count dropped to ${first}, below the recorded RANK1_FIRST (${RANK1_FIRST}) — ` +
            `this is a regression\n${lost.join("\n")}`
        : `rank-1 first-place count rose to ${first}, above the recorded RANK1_FIRST (${RANK1_FIRST}) — ` +
            "routing improved; raise RANK1_FIRST (and RANK1_TOTAL if the corpus also grew) to record it",
    ).toBe(RANK1_FIRST);
  });

  test("the recorded pair is a real measurement, not a placeholder", () => {
    // 0/anything would pass forever; RANK1_FIRST > RANK1_TOTAL could never be
    // measured at all.
    expect(RANK1_TOTAL).toBeGreaterThan(0);
    expect(RANK1_FIRST).toBeGreaterThan(0);
    expect(RANK1_FIRST).toBeLessThanOrEqual(RANK1_TOTAL);
  });
});

describe("the known routing gaps are honest", () => {
  test("each gap names two real skills, a reason, and a case that exists", () => {
    for (const gap of KNOWN_ROUTING_GAPS) {
      expect(CATALOG_NAMES.has(gap.skill), `${gap.prompt}: unknown skill ${gap.skill}`).toBe(true);
      expect(CATALOG_NAMES.has(gap.collidesWith), `${gap.prompt}: unknown skill ${gap.collidesWith}`).toBe(true);
      expect(gap.reason.length, `${gap.prompt} is recorded with no reason`).toBeGreaterThan(40);
      const entry = BY_SKILL.get(gap.skill);
      const prompts =
        gap.kind === "positive"
          ? (entry?.positives ?? [])
          : (entry?.negatives ?? []).map((negative) => negative.prompt);
      expect(prompts, `${gap.skill} has no ${gap.kind} "${gap.prompt}"`).toContain(gap.prompt);
    }
  });

  test("an exclusion cannot outlive the collision that earned it", () => {
    // An excluded case skips its assertion. If the router later handles it, the
    // exclusion has to be deleted deliberately rather than sitting there hiding
    // a case that now passes.
    for (const gap of KNOWN_ROUTING_GAPS.filter((candidate) => candidate.excluded)) {
      const ranked = ranking(gap.prompt);
      if (gap.kind === "positive") {
        expect(
          rankOf(ranked, gap.skill),
          `"${gap.prompt}" now reaches the top 3 for ${gap.skill} — remove the exclusion`,
        ).toBeGreaterThan(3);
      } else {
        const owner = BY_SKILL.get(gap.skill)?.negatives.find(
          (negative) => negative.prompt === gap.prompt,
        )?.owner;
        expect(owner, `${gap.skill} has no negative "${gap.prompt}"`).toBeDefined();
        expect(
          scoreOf(ranked, owner!),
          `"${gap.prompt}" is now won by ${owner} — remove the exclusion`,
        ).toBeLessThanOrEqual(scoreOf(ranked, gap.skill));
      }
    }
  });
});

describe("the queries AC7 names route to one owner", () => {
  // These are the prompts two skills both plausibly answer. The criterion is not
  // that the router picks well in general — it is that each of these lands on a
  // named owner, so the corpus records the decision rather than the tie.
  const owners: ReadonlyArray<readonly [string, string]> = [
    ["clarify requirements", "interviewer"],
    ["write tests", "test-gen"],
    ["generate tests", "test-gen"],
    ["create tests first", "tests-creator"],
    ["review my code", "review-orchestrator"],
    ["full review", "review-orchestrator"],
    ["implement this issue", "job-orchestrator"],
    ["check performance", "perf-check"],
    ["why is it slow", "perf-check"],
  ];

  for (const [query, owner] of owners) {
    test(`"${query}" -> ${owner}`, () => {
      const ranked = ranking(query);
      expect(ranked[0]?.name, show(ranked)).toBe(owner);
      expect(BY_SKILL.get(owner)?.positives, `${owner} does not carry "${query}"`).toContain(query);
    });
  }

  test("every AC7 query is in the corpus as a positive of its owner", () => {
    const positives = new Set(ROUTING_CORPUS.flatMap((entry) => entry.positives));
    for (const query of AC7_REQUIRED_QUERIES) {
      expect(positives, `AC7 query missing from the corpus: ${query}`).toContain(query);
    }
  });

  test('"implement this issue" carries the other two orchestrators as negatives', () => {
    // The criterion names this one explicitly: one orchestrator owns the query
    // and the other two have to be recorded as losing it, or the choice is a
    // coincidence rather than a decision.
    for (const loser of ["flow-orchestrator", "task-implementer"]) {
      const negative = BY_SKILL.get(loser)?.negatives.find(
        (candidate) => candidate.prompt === "implement this issue",
      );
      expect(negative?.owner, `${loser} does not record losing "implement this issue"`).toBe("job-orchestrator");
    }
  });

  test("perf-check owns the performance queries and review-performance records the loss", () => {
    // "check performance" was a three-way tie between perf-check,
    // review-performance and review-flow-graph. Naming the owner in one place
    // and leaving the losers silent is how a tie comes back.
    const losses = BY_SKILL.get("review-performance")?.negatives ?? [];
    expect(losses.map((negative) => negative.prompt)).toContain("check performance");
    expect(losses.map((negative) => negative.prompt)).toContain("why is it slow");
    const flowGraph = BY_SKILL.get("review-flow-graph")?.negatives ?? [];
    expect(flowGraph.map((negative) => negative.prompt)).toContain("check performance");
  });
});

describe("the corpus ranks through the shipped scorer", () => {
  test("no private reimplementation of the ranking", () => {
    // Three copies of this pipeline existed at one point and they disagreed.
    // The duplication is what let a corpus pass while the CLI stayed silent.
    const direct = ranking("frontend review")[0];
    const viaScorer = scoreBundledSkillRoute(
      BUNDLED_GDSKILLS.find((skill) => skill.name === "review-frontend")!,
      "frontend review",
    );
    expect(direct?.name).toBe("review-frontend");
    expect(direct?.score).toBe(viaScorer.score);
  });
});
