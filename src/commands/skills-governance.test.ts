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

// R2-8 (flow 309 review round 2): a value-taking flag given with NO value at
// all (trailing, or immediately followed by another flag) used to read
// exactly like the flag being absent (`optionValue` returns `undefined`
// either way) and silently fall back to the default instead of being
// refused — same class as F3/F9/F13.
describe("R2-8: valueless flags are refused, not silently defaulted", () => {
  test("--strictness with no value (trailing) is refused", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness requires a value"))).toBe(true);
  });

  test("--strictness with no value (followed by another flag) is refused", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness requires a value"))).toBe(true);
  });

  test("--trials with no value is refused, not silently defaulted to 3", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--runner with no value is refused, not silently treated as omitted", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--runner", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--runner requires a value"))).toBe(true);
  });

  test("keryx skills scout --scope with no value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--scope"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope requires a value"))).toBe(true);
  });

  test("keryx skills scout --scope with an unknown value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--scope", "everything"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope must be 'bundled' or 'all'"))).toBe(true);
  });

  test("keryx skills stocktake --scope with no value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["stocktake", "--scope"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope requires a value"))).toBe(true);
  });

  test("keryx skills scout --record with no value is refused, not silently swallowing the next flag as its value", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--record", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--record requires a value"))).toBe(true);
  });
});
