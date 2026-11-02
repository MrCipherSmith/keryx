import { expect, test } from "bun:test";
import type { DetectorMatch } from "../types";
import { dedupeOverlaps } from "./index";

function match(category: DetectorMatch["category"], start: number, end: number, confidence: number): DetectorMatch {
  return { category, policyId: `${category}.x`, severity: "low", confidence, start, end, value: "" };
}

test("a span inside a stronger span of the same category is dropped", () => {
  const strong = match("secret", 0, 20, 0.9);
  const inner = match("secret", 5, 10, 0.5);
  const otherCategory = match("pii", 5, 10, 0.5);
  const partial = match("secret", 15, 25, 0.5);
  expect(dedupeOverlaps([inner, strong, otherCategory, partial])).toEqual([strong, otherCategory, partial]);
});

test("a stronger span is never dropped for a weaker one that contains it", () => {
  const weakOuter = match("secret", 0, 20, 0.3);
  const strongInner = match("secret", 5, 10, 0.9);
  expect(dedupeOverlaps([weakOuter, strongInner])).toEqual([weakOuter, strongInner]);
});

test("of two equal spans with equal confidence the first is kept", () => {
  const first = match("secret", 0, 10, 0.5);
  const second = { ...match("secret", 0, 10, 0.5), policyId: "secret.y" };
  expect(dedupeOverlaps([first, second])).toEqual([first]);
});

test("tens of thousands of disjoint matches dedupe in near-linear time", () => {
  const matches = Array.from({ length: 60_000 }, (_, i) => match("pii", i * 10, i * 10 + 5, 0.6));
  const started = performance.now();
  expect(dedupeOverlaps(matches)).toHaveLength(60_000);
  expect(performance.now() - started).toBeLessThan(250);
});

// The quadratic original, kept as the oracle for the indexed version.
function referenceDedupe(matches: DetectorMatch[]): DetectorMatch[] {
  const kept: DetectorMatch[] = [];
  for (const candidate of [...matches].sort((a, b) => b.confidence - a.confidence)) {
    const covered = kept.some(
      (e) => e.category === candidate.category && candidate.start >= e.start && candidate.end <= e.end,
    );
    if (!covered) {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

test("agrees with the quadratic original on random overlapping spans", () => {
  let state = 7;
  const random = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const categories: DetectorMatch["category"][] = ["secret", "pii", "egress"];
  for (let round = 0; round < 300; round += 1) {
    const matches = Array.from({ length: 1 + random(40) }, () => {
      const start = random(60);
      return match(categories[random(3)] as DetectorMatch["category"], start, start + 1 + random(20), random(5) / 4);
    });
    expect(dedupeOverlaps(matches)).toEqual(referenceDedupe(matches));
  }
});
