import { expect, test } from "bun:test";
import { reviewAssignmentTier } from "./assignment-tier";
import type { SliceEntry } from "./slice";

const small: SliceEntry = {
  id: "small", path: "small.diff", bytes: 100, files: ["src/source.ts"], domain: "src", split: "file",
  depth: "light",
};
const risky = { ...small, id: "risky", risk: { score: 0.9, why: ["auth/permissions"] } };
const tier = (reviewer: string, slices: SliceEntry[], settings: Partial<Parameters<typeof reviewAssignmentTier>[0]> = {}) =>
  reviewAssignmentTier({ reviewer, slices, ...settings });

test("a mixed workload uses light, middle and strong by role and assigned slice", () => {
  expect(tier("review-style", [small, risky])).toMatchObject({ tier: "light", modelClass: "light" });
  expect(tier("review-logic", [small])).toMatchObject({ tier: "middle", modelClass: "standard" });
  expect(tier("review-logic", [small, risky])).toEqual({
    tier: "strong", modelClass: "expert", tierReason: "Assigned slice has high recorded risk.",
  });
  expect(tier("review-logic", [small], { changedLines: 800 }).tier).toBe("strong");
  expect(tier("review-security-code", [small]).tier).toBe("strong");
});

test("skill floors and fixed launch choices are honored", () => {
  expect(tier("review-style", [small], { declared: "deep" }).tier).toBe("strong");
  expect(tier("review-logic", [risky], { declared: "light", adaptive: false }).tier).toBe("light");
  expect(tier("review-doc-contract", [{ ...small, kind: "fix" }], { declared: "light", round: 2 }).tier).toBe("middle");
});
