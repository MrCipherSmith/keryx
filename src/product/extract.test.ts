// Outcome-criterion extraction: the `flow init` hint is a slot, not a
// declaration. An untouched hint must not count as a stated criterion, or the
// first-hour measure of "do people fill the slot" would measure the template.

import { describe, expect, test } from "bun:test";
import { renderDescription } from "../flow/templates";
import { extractFlowIntent, hasInstrument, outcomeCriterionFrom } from "./extract";

const source = (description: string) => ({ flowJson: JSON.stringify({ id: "9", title: "T", status: "done" }), description, criteria: null, journal: null });

describe("the outcome criteria slot", () => {
  test("the untouched template declares no criterion", () => {
    const description = renderDescription("A flow", "user description");
    expect(description).toContain("## Outcome criteria");
    expect(outcomeCriterionFrom(description)).toBeNull();
    expect(extractFlowIntent(source(description), ".metaproject/flows/9-x").outcome.criterion).toBeNull();
  });

  test("the hint does not count even when it is written as a bullet or wrapped over two lines", () => {
    expect(outcomeCriterionFrom("## Outcome criteria\n\n- State an outcome criterion: what you would look at.\n")).toBeNull();
    expect(outcomeCriterionFrom("## Outcome criteria\n\nState an outcome criterion:\nwhat you would look at.\n")).toBeNull();
  });

  test("a bullet written under the untouched hint is the declaration", () => {
    const filled = renderDescription("A flow", "user description").replace(
      "## Out of Scope",
      "- Median checkout time, read from the payment log a week after release\n\n## Out of Scope",
    );
    expect(outcomeCriterionFrom(filled)).toBe("Median checkout time, read from the payment log a week after release");
    expect(hasInstrument(outcomeCriterionFrom(filled))).toBe(true);
  });

  test("`not measured — <reason>` is a stated criterion that is no instrument", () => {
    const filled = renderDescription("A flow", "user description").replace("## Out of Scope", "- not measured — internal refactor, no user-facing surface\n\n## Out of Scope");
    const criterion = outcomeCriterionFrom(filled);
    expect(criterion).toBe("not measured — internal refactor, no user-facing surface");
    expect(hasInstrument(criterion)).toBe(false);
  });
});
