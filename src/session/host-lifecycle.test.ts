import { expect, test } from "bun:test";
import { lifecycleCommandSchemas, sessionAttachmentSchema } from "./host-lifecycle";
import { validateArguments } from "../remote-control/protocol";

test("session identity commands use closed typed pins and clear retains the shipped new-session semantics", () => {
  expect(validateArguments(lifecycleCommandSchemas.new, {}).ok).toBe(true);
  expect(lifecycleCommandSchemas.clear).toEqual(lifecycleCommandSchemas.new);
  expect(validateArguments(lifecycleCommandSchemas.clear, { shell: "anything" }).ok).toBe(false);
  expect(validateArguments(lifecycleCommandSchemas["sessions.resume"], { sessionId: "target", expectedSessionVersion: 1 }).ok).toBe(false);
  expect(validateArguments(lifecycleCommandSchemas["sessions.fork"], { throughHistoryCursor: 0, expectedHistoryVersion: 1, targetCheckoutId: "checkout", expectedInventoryVersion: 1, expectedHeadSha: "a".repeat(40), title: "fork" }).ok).toBe(true);
  expect(validateArguments(sessionAttachmentSchema, { sessionId: "target", sessionVersion: 1, machineId: "machine", checkoutId: "checkout", title: "session", readOnly: true, controllerGranted: false }).ok).toBe(true);
  expect(validateArguments(sessionAttachmentSchema, { sessionId: "target", sessionVersion: 1, machineId: "machine", checkoutId: "checkout", title: "session", readOnly: true, controllerGranted: false, nativePath: "/private" }).ok).toBe(false);
});
