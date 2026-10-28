import { expect, test } from "bun:test";
import { OWNED_CONTROL_COMMANDS, isOwnedControlCommand } from "./owned-controls";
test("only exact existing-resource controls share the busy-session exception", () => {
  expect(OWNED_CONTROL_COMMANDS).toEqual(["tasks.kill", "demote", "approvals.allow-once", "approvals.deny", "interrupt", "questions.answer"]);
  for (const name of OWNED_CONTROL_COMMANDS) expect(isOwnedControlCommand(name)).toBe(true);
  for (const name of ["tasks.spawn", "tasks.kill.all", "new", "ci.triage", "status"]) expect(isOwnedControlCommand(name)).toBe(false);
});
