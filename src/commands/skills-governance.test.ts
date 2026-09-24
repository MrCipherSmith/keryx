// F9 (flow 309 review round 1): `keryx skills eval` argument validation.
// `--trials abc` used to parse as `NaN` and flow straight through; `--trials=N`
// (the `=` spelling) was silently ignored by a hand-rolled `args.indexOf`
// parser and fell back to the default; an unknown `--strictness` value fell
// back to "low" (the weakest gate) instead of being refused. All three are
// now refused up front with `process.exitCode = 1` and a named message.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { skillsGovernanceCommand } from "./skills-governance";

let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  process.exitCode = 0;
});

afterEach(() => {
  errorSpy?.mockRestore();
  process.exitCode = 0;
});

describe("keryx skills eval: --trials validation", () => {
  test("--trials abc (non-numeric) is refused, not silently NaN", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "abc"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--trials 0 is refused (not a positive integer)", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "0"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--trials=3 (equals form) is honored, not silently ignored", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials=3", "--json"]);
    // A valid --trials=3 must not hit the validation-error exit path.
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(false);
  });
});

describe("keryx skills eval: --strictness validation", () => {
  test("an unknown --strictness value is refused, not silently downgraded to 'low'", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "hihg"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness must be one of low, medium, high"))).toBe(true);
  });

  test("a valid --strictness value is accepted", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "medium", "--json"]);
    expect(errors.some((line) => line.includes("--strictness must be one of"))).toBe(false);
  });
});
