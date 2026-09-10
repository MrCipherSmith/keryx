import { describe, expect, test } from "bun:test";
import { CONTRACTS, loadSchema, validateJson } from "./contracts";

/**
 * AC6 of flow 213: the contracts that already refused something still refuse it.
 *
 * One rejecting payload per enforced contract, run through the same
 * `loadSchema` + `validateJson` pair the production modules use. This does not
 * prove the modules CALL that pair — `contract-enforcement.test.ts` checks the
 * call exists, and `review-result-contract.test.ts` runs the real command for
 * the one added here. What it proves is narrower and still worth pinning: the
 * schemas themselves have not been loosened into accepting what they used to
 * reject, which is how an enforcement stops enforcing without anyone editing
 * the code that enforces it.
 */
const REJECTING_PAYLOAD: Record<string, { payload: unknown; because: string }> = {
  "job-orchestrator-state": {
    payload: { schemaVersion: 1 },
    because: "a state file missing every required field",
  },
  "review-finding": {
    payload: { id: "F-1" },
    because: "a finding with an id and nothing else",
  },
  "subagent-result": {
    payload: { status: "not-a-status" },
    because: "a result whose status is outside the enum",
  },
  "review-pr-feedback-output": {
    payload: {
      status: "DONE",
      mode: "analyze",
      pr: "o/r#1",
      head_sha: "0123abc",
      collected: 0,
      verdicts: {},
      plan_items: 0,
      summary: "s",
      screen_status: "ran",
      screened: 0,
      excluded_for_injection: [],
      filtered: [],
      fix: { flow_id: "1", flow_status: "done", merged_into: "main", operator_confirmed: {} },
    },
    because: "an analyze-mode result carrying a populated fix",
  },
};

describe("the contracts that refuse in production still refuse", () => {
  const enforced = CONTRACTS.filter((c) => c.enforcement.kind === "production");

  test("every enforced contract has a rejecting payload pinned here", () => {
    // Otherwise this file silently stops covering a contract the moment one is
    // added — the same omission the enforcement guard exists to prevent, one
    // layer out.
    const missing = enforced.map((c) => c.name).filter((name) => !(name in REJECTING_PAYLOAD));
    expect(missing).toEqual([]);
    expect(enforced.length).toBeGreaterThanOrEqual(4);
  });

  for (const [name, { payload, because }] of Object.entries(REJECTING_PAYLOAD)) {
    test(`${name} rejects ${because}`, async () => {
      const schema = await loadSchema(name as (typeof CONTRACTS)[number]["name"]);
      const errors = await validateJson(payload, schema);
      expect(errors.length).toBeGreaterThan(0);
    });
  }

  test("a conforming value is accepted, so the rejections above are not vacuous", async () => {
    // If every payload were rejected, the tests above would pass with the
    // validator broken shut rather than working.
    const schema = await loadSchema("review-pr-feedback-output");
    const errors = await validateJson(
      {
        status: "DONE",
        mode: "analyze",
        pr: "o/r#1",
        head_sha: "0123abc",
        collected: 0,
        verdicts: {},
        plan_items: 0,
        summary: "s",
        screen_status: "ran",
        screened: 0,
        excluded_for_injection: [],
        filtered: [],
        fix: null,
      },
      schema,
    );
    expect(errors).toEqual([]);
  });
});
