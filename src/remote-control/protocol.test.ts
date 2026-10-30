import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateControl, parseMachineFrame, canonicalDigest, PROTOCOL_VERSION, MACHINE_SUBPROTOCOL } from "./protocol";

test("named definitions validate closed shapes rather than empty control root", () => {
  expect(PROTOCOL_VERSION).toBe(2); expect(MACHINE_SUBPROTOCOL).toBe("keryx.hub.machine.v2");
  expect(validateControl("PairingCreate", { displayName: "machine", projectIds: ["project"] }).ok).toBe(true);
  for (const body of [{}, { displayName: "machine", projectIds: [] }, { displayName: "machine", projectIds: ["p"], secret: "extra" }]) expect(validateControl("PairingCreate", body).ok).toBe(false);
  expect(validateControl("SessionCapabilities", { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true }).ok).toBe(true);
});
test("machine frame rejects duplicate JSON keys unknown fields direction version and excessive bytes", () => {
  const valid = JSON.stringify({ v: 2, type: "heartbeat", messageId: "m", epoch: 1, payload: { daemonId: "d" } });
  expect(parseMachineFrame(valid, "machine-to-hub").ok).toBe(true);
  expect(parseMachineFrame(valid, "hub-to-machine").ok).toBe(false);
  expect(parseMachineFrame(valid.replace('"v":2', '"v":2,"v":2'), "machine-to-hub").ok).toBe(false);
  expect(parseMachineFrame(valid.replace('"v":2', '"v":1'), "machine-to-hub").ok).toBe(false);
  expect(parseMachineFrame(" ".repeat(65537), "machine-to-hub").ok).toBe(false);
});
test("canonical digest sorts nested Unicode code-point keys and preserves array order", () => {
  const expected = createHash("sha256").update('{"a":{"x":1,"z":2},"b":[2,1]}').digest("hex");
  expect(canonicalDigest({ b: [2, 1], a: { z: 2, x: 1 } })).toBe(expected);
  expect(canonicalDigest({ b: [1, 2], a: { z: 2, x: 1 } })).not.toBe(expected);
});

test("selected command schema rejects missing required properties and bounded malformed schemas", async () => {
  const { validateArguments } = await import("./protocol");
  const schema = { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 8 } }, required: ["text"] } as const;
  expect(validateArguments(schema, { text: "okay" }).ok).toBe(true);
  expect(validateArguments(schema, { text: "longer-than-eight" }).ok).toBe(false);
  expect(validateArguments(schema, { text: "okay", injected: true }).ok).toBe(false);
  expect(validateArguments({ ...schema, required: ["missing"] }, {}).ok).toBe(false);
});
