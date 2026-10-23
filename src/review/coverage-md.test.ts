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

test("a key starts its line: a `reviewer:` inside a sentence is no entry, an indented or CRLF one is (TP4-002)", () => {
  expect(parseCoverageEntries("note reviewer: x\nstatus: y")).toEqual([]);
  expect(parseCoverageEntries("reviewer: a\n  note status: y")).toEqual([]);
  expect(parseCoverageEntries("reviewer: a\r\nstatus: run\r\nreason: ok\r\n\r\nreviewer: b\r\nstatus: failed")).toEqual([
    { reviewer: "a", status: "run" },
    { reviewer: "b", status: "failed" },
  ]);
  expect(parseCoverageEntries("  reviewer: a\n\tstatus: run")).toEqual([{ reviewer: "a", status: "run" }]);
});
