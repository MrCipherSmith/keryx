// Flow 289, AC3 — every recorded identity carries a `basis` (stated/derived/
// unknown) and a `source`, and a derived value is never promoted to stated.
import { expect, test } from "bun:test";
import { describeIdentity, ownerIdentity, resolveSignerIdentity } from "./identity";

test("AC3: --signed-by wins and is stated", () => {
  const identity = resolveSignerIdentity({
    stated: "aleks",
    env: "ci-bot",
    gitIdentity: "someone@example.com",
  });
  expect(identity).toEqual({ value: "aleks", basis: "stated", source: "`--signed-by` flag" });
});

test("AC3: KERYX_ACTOR is stated when --signed-by is absent", () => {
  const identity = resolveSignerIdentity({ env: "ci-bot", gitIdentity: "someone@example.com" });
  expect(identity.basis).toBe("stated");
  expect(identity.value).toBe("ci-bot");
  expect(identity.source).toContain("KERYX_ACTOR");
});

test("AC3: local git identity is derived, never promoted to stated", () => {
  const identity = resolveSignerIdentity({ gitIdentity: "someone@example.com" });
  expect(identity.basis).toBe("derived");
  expect(identity.value).toBe("someone@example.com");
  expect(identity.source).toContain("git config user.email");
});

test("AC3: nothing available is unknown, and no value is invented", () => {
  const identity = resolveSignerIdentity({});
  expect(identity).toEqual({
    value: null,
    basis: "unknown",
    source: "no --signed-by flag, KERYX_ACTOR environment variable, or readable git identity",
  });
});

test("AC3: blank inputs are treated as absent, not as stated empty strings", () => {
  const identity = resolveSignerIdentity({ stated: "   ", env: "  ", gitIdentity: "  " });
  expect(identity.basis).toBe("unknown");
  expect(identity.value).toBeNull();
});

test("AC1: an owner identity is always stated, never derived or unknown", () => {
  const identity = ownerIdentity("aleks", "`--owner` flag on `flow init`");
  expect(identity).toEqual({ value: "aleks", basis: "stated", source: "`--owner` flag on `flow init`" });
});

test("describeIdentity renders value and basis for a history/journal line", () => {
  expect(describeIdentity({ value: "aleks", basis: "stated", source: "x" })).toBe("aleks [stated]");
  expect(describeIdentity({ value: null, basis: "unknown", source: "x" })).toBe("unknown [unknown]");
});
