import { expect, test } from "bun:test";
import { intersectLocalPlanPolicy } from "./plan-policy";

test("only locally changed restrictions narrow the trusted review policy", () => {
  const trusted = { model: "trusted", reviewPlan: { maxDispatches: 100, autoMaxMinutes: 600, autoApprove: true } };
  const head = { reviewPlan: { maxDispatches: 5, autoMaxMinutes: 20, autoApprove: false } };
  expect(intersectLocalPlanPolicy(trusted, head, head)).toEqual(trusted);
  expect(intersectLocalPlanPolicy(trusted, head, { reviewPlan: { maxDispatches: 20, autoMaxMinutes: 1200, autoApprove: false } }))
    .toEqual({ model: "trusted", reviewPlan: { maxDispatches: 20, autoMaxMinutes: 600, autoApprove: true } });
  expect(intersectLocalPlanPolicy(trusted, {}, { model: "untrusted", reviewPlan: { maxDispatches: 200, maxMinutes: 10, autoApprove: false } }))
    .toEqual({ model: "trusted", reviewPlan: { maxDispatches: 100, autoMaxMinutes: 600, maxMinutes: 10, autoApprove: false } });
  expect(intersectLocalPlanPolicy({}, {}, { reviewPlan: { maxDispatches: 500, autoApprove: true } })).toEqual({});
  expect(intersectLocalPlanPolicy({ reviewPlan: "invalid" }, {}, { reviewPlan: { maxDispatches: 10 } })).toEqual({ reviewPlan: "invalid" });
});
