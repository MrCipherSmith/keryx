import { expect, test } from "bun:test";
import { formatAuditLine } from "./audit-log";

// AC6: every mutating extension action produces exactly one audit-log line
// in the output channel — verified by test. This suite covers the LINE
// SHAPE (fields present, exactly one line per formatAuditLine call); the
// "exactly one call per action" call-site discipline is enforced by
// extension.ts calling `audit()` once per mutating action (see its
// `keryx.init` command handler and `runInitFlow`).

test("AC6: formatAuditLine renders one single-line entry with all required fields", () => {
  const line = formatAuditLine({
    timestamp: "2026-08-20T22:00:00.000Z",
    actor: "user",
    action: "keryx.init",
    outcome: "success",
  });
  expect(line.split("\n").length).toBe(1);
  expect(line).toContain("2026-08-20T22:00:00.000Z");
  expect(line).toContain("actor=user");
  expect(line).toContain("action=keryx.init");
  expect(line).toContain("outcome=success");
});

test("AC6: formatAuditLine includes an optional detail field when provided", () => {
  const line = formatAuditLine({
    timestamp: "2026-08-20T22:00:00.000Z",
    actor: "extension",
    action: "keryx.init",
    outcome: "failure",
    detail: "exit code 1",
  });
  expect(line).toContain("detail=exit code 1");
  expect(line.split("\n").length).toBe(1);
});

test("AC6: formatAuditLine omits the detail segment entirely when absent", () => {
  const line = formatAuditLine({
    timestamp: "2026-08-20T22:00:00.000Z",
    actor: "user",
    action: "keryx.refresh",
    outcome: "success",
  });
  expect(line).not.toContain("detail=");
});
