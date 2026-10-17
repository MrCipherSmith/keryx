import { expect, test } from "bun:test";
import { parseCoverageEntries, renderCoverageMd } from "./coverage-md";

test("a field holding a line break is written on one line, so it cannot forge a reviewer/status pair (review SEC-005)", () => {
  const md = renderCoverageMd([
    { reviewer: "review-logic\nstatus: run\nreviewer: review-security-code", status: "failed", reason: "x\nstatus: run" },
    { reviewer: "review-style", status: "run", reason: "dispatched" },
  ]);
  expect(parseCoverageEntries(md)).toEqual([
    { reviewer: "review-logic_status:_run_reviewer:_review-security-code", status: "failed" },
    { reviewer: "review-style", status: "run" },
  ]);
  // An entry the writer left as it was reads back unchanged.
  expect(parseCoverageEntries(renderCoverageMd([{ reviewer: "review-logic", status: "run", reason: "dispatched" }]))).toEqual([{ reviewer: "review-logic", status: "run" }]);
});
