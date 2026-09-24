import { describe, expect, test } from "bun:test";
import {
  applyDecay,
  applyEvidence,
  confidenceLevelFor,
  CONTRADICT_RATE,
  DECAY_RATE,
  LEVEL_HIGH_MIN,
  LEVEL_MEDIUM_MIN,
  MAX_EVIDENCE_WEIGHT,
  REINFORCE_RATE,
  SEED_DETERMINISTIC,
  SEED_MODEL_BACKED,
} from "./confidence";

describe("constants", () => {
  test("documented literal values", () => {
    expect(SEED_DETERMINISTIC).toBe(0.4);
    expect(SEED_MODEL_BACKED).toBe(0.3);
    expect(REINFORCE_RATE).toBe(0.35);
    expect(CONTRADICT_RATE).toBe(0.5);
    expect(DECAY_RATE).toBe(0.02);
    expect(MAX_EVIDENCE_WEIGHT).toBe(1.5);
    expect(LEVEL_MEDIUM_MIN).toBe(0.5);
    expect(LEVEL_HIGH_MIN).toBe(0.8);
  });
});

describe("applyEvidence", () => {
  test("W3-AC3: one reinforcement from 0.4 at weight 1.0 yields exactly 0.61", () => {
    const next = applyEvidence(SEED_DETERMINISTIC, "reinforcement", 1.0);
    expect(next).toBe(0.61);
    expect(confidenceLevelFor(next)).toBe("medium");
  });

  test("contradiction moves faster than reinforcement", () => {
    const next = applyEvidence(0.61, "contradiction", 1.0);
    expect(next).toBe(0.305);
  });

  test("weight defaults to 1.0", () => {
    expect(applyEvidence(SEED_DETERMINISTIC, "reinforcement")).toBe(0.61);
  });

  test("weight is clamped to [0, MAX_EVIDENCE_WEIGHT]", () => {
    const overWeighted = applyEvidence(SEED_DETERMINISTIC, "reinforcement", 999);
    const atCeiling = applyEvidence(SEED_DETERMINISTIC, "reinforcement", MAX_EVIDENCE_WEIGHT);
    expect(overWeighted).toBe(atCeiling);

    const negativeWeighted = applyEvidence(SEED_DETERMINISTIC, "reinforcement", -5);
    expect(negativeWeighted).toBe(SEED_DETERMINISTIC);
  });

  test("clamps to [0, 1]", () => {
    expect(applyEvidence(0.99, "reinforcement", MAX_EVIDENCE_WEIGHT)).toBeLessThanOrEqual(1);
    expect(applyEvidence(0.01, "contradiction", MAX_EVIDENCE_WEIGHT)).toBeGreaterThanOrEqual(0);
  });
});

describe("applyDecay", () => {
  test("0.98^34 approx 0.50 (half-life around 34 days of silence)", () => {
    const decayed = applyDecay(1.0, 34);
    expect(decayed).toBeCloseTo(Math.pow(0.98, 34), 9);
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  test("days < 1 leaves confidence unchanged", () => {
    expect(applyDecay(0.61, 0)).toBe(0.61);
    expect(applyDecay(0.61, 0.9)).toBe(0.61);
  });

  test("decay is counted in whole UTC days (floor)", () => {
    expect(applyDecay(1.0, 2.9)).toBe(applyDecay(1.0, 2));
  });

  test("never goes below 0", () => {
    expect(applyDecay(0.0001, 10000)).toBeGreaterThanOrEqual(0);
  });
});

describe("confidenceLevelFor", () => {
  test("level boundaries", () => {
    expect(confidenceLevelFor(0)).toBe("low");
    expect(confidenceLevelFor(0.4999999999)).toBe("low");
    expect(confidenceLevelFor(0.5)).toBe("medium");
    expect(confidenceLevelFor(0.7999999999)).toBe("medium");
    expect(confidenceLevelFor(0.8)).toBe("high");
    expect(confidenceLevelFor(1)).toBe("high");
  });
});
