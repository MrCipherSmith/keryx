import { describe, expect, test } from "bun:test";
import { OUTCOME_HINT } from "./description-intent";
import { renderDescription } from "./templates";

describe("renderDescription", () => {
  const description = renderDescription("Speed up checkout", "user description");
  const headings = description.split("\n").filter((line) => line.startsWith("## "));

  test("has an Outcome criteria section after Expected Outcome and before Out of Scope", () => {
    expect(headings).toEqual(["## Problem", "## Expected Outcome", "## Outcome criteria", "## Out of Scope"]);
  });

  test("the hint asks for an outcome criterion, or `not measured — <reason>`", () => {
    const hint = description.split("\n").find((line) => line.startsWith(OUTCOME_HINT));
    expect(hint).toBeDefined();
    expect(hint).toContain("not measured — <reason>");
  });

  test("the rest of the template is unchanged", () => {
    expect(description).toContain("# Speed up checkout\n\nStatus: draft (flow-init skill formalizes this)\nSource: user description\n");
    expect(description).toContain("Describe the problem precisely");
    expect(description).toContain("What must be true when this flow is done.");
    expect(description).toContain("Explicitly excluded work.");
  });
});
