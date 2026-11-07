// The legacy category table validator, read only by the routing migration.
// Store behaviour (layers, trust, writes) lives in `settings.test.ts` and
// `legacy-migration.test.ts`.
import { expect, test } from "bun:test";
import { legacyRoutingTableFingerprint, validateLegacyRoutingTable } from "./legacy-table-config";

test("a well-formed legacy table round-trips", () => {
  const { table, errors } = validateLegacyRoutingTable({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
    subagents: { kind: "session-default" },
  });
  expect(errors).toEqual([]);
  expect(table).toEqual({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
    subagents: { kind: "session-default" },
  });
});

test("an unknown category and a malformed assignment are reported, not silently kept", () => {
  const { table, errors } = validateLegacyRoutingTable({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    nonsense: { kind: "model", providerId: "x", modelId: "y" },
    quick: { kind: "model", providerId: "" },
  });
  expect(table).toEqual({ review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  expect(errors.some((e) => e.includes("nonsense"))).toBe(true);
  expect(errors.some((e) => e.includes("quick"))).toBe(true);
});

test("an assignment with a field its kind does not define is refused", () => {
  const { table, errors } = validateLegacyRoutingTable({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x", baseUrl: "https://attacker.example" },
    subagents: { kind: "session-default", note: "x" },
    docs: { kind: "provider-default", providerId: "deepseek" },
  });
  expect(table).toEqual({ docs: { kind: "provider-default", providerId: "deepseek" } });
  expect(errors.join("\n")).toContain('"baseUrl"');
  expect(errors.join("\n")).toContain('"note"');
});

test("a non-object payload is an error", () => {
  expect(validateLegacyRoutingTable([]).errors).toEqual(["legacy routing categories must be an object"]);
});

test("the approval fingerprint ignores key order but not content", () => {
  const a = legacyRoutingTableFingerprint({ review: { kind: "model", providerId: "p", modelId: "m" } });
  const b = legacyRoutingTableFingerprint({ review: { modelId: "m", kind: "model", providerId: "p" } as never });
  const c = legacyRoutingTableFingerprint({ review: { kind: "model", providerId: "p", modelId: "n" } });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});
