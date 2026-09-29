// Outcome-criterion extraction: the `flow init` hint is a slot, not a
// declaration. An untouched hint must not count as a stated criterion, or the
// first-hour measure of "do people fill the slot" would measure the template.

import { describe, expect, test } from "bun:test";
import { OUTCOME_HINT } from "../flow/description-intent";
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

  test("the exact hint does not count, plain or written as a bullet", () => {
    expect(outcomeCriterionFrom(`## Outcome criteria\n\n${OUTCOME_HINT}\n`)).toBeNull();
    expect(outcomeCriterionFrom(`## Outcome criteria\n\n- ${OUTCOME_HINT}\n`)).toBeNull();
  });

  test("only the exact hint is skipped: a real bullet that starts with the same words survives", () => {
    expect(outcomeCriterionFrom("## Outcome criteria\n\n- State an outcome criterion for checkout: p95 under 2s\n")).toBe("State an outcome criterion for checkout: p95 under 2s");
    const beside = outcomeCriterionFrom(`## Outcome criteria\n\n${OUTCOME_HINT}\n- State an outcome criterion: p95 under 2s\n`);
    expect(beside).toBe("State an outcome criterion: p95 under 2s");
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

  test("`not measured` is judged per bullet: beside a real bullet, an instrument exists", () => {
    const mixed = outcomeCriterionFrom("## Outcome criteria\n\n- not measured — the retry path has no metric\n- p95 checkout time from the payment log\n");
    expect(mixed).toBe("not measured — the retry path has no metric | p95 checkout time from the payment log");
    expect(hasInstrument(mixed)).toBe(true);
    expect(hasInstrument(outcomeCriterionFrom("## Outcome criteria\n\n- p95 checkout time\n- not measured — no metric for retries\n"))).toBe(true);
    expect(hasInstrument("not measured — a | not measured — b")).toBe(false);
    expect(hasInstrument(null)).toBe(false);
  });
});
