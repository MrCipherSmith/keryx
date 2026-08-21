import { expect, test } from "bun:test";
import { checkKeryxVersion, compareVersions, parseKeryxVersion, versionWarningMessage } from "./version-logic";

// AC8: activation warns (non-blocking) when the installed `keryx` version is
// below the extension's declared minimum — verified by unit test.

test("compareVersions orders dotted numeric versions correctly", () => {
  expect(compareVersions("0.2.49", "0.2.0")).toBeGreaterThan(0);
  expect(compareVersions("0.2.0", "0.2.49")).toBeLessThan(0);
  expect(compareVersions("0.2.49", "0.2.49")).toBe(0);
  expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
});

test("compareVersions treats missing/non-numeric components as 0, never throws", () => {
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(() => compareVersions("1.2.0-beta", "1.2.0")).not.toThrow();
});

test("parseKeryxVersion extracts a bare dotted version from `keryx --version` output", () => {
  expect(parseKeryxVersion("0.2.49\n")).toBe("0.2.49");
  expect(parseKeryxVersion("0.2.49")).toBe("0.2.49");
});

test("parseKeryxVersion returns undefined for garbled output", () => {
  expect(parseKeryxVersion("")).toBeUndefined();
  expect(parseKeryxVersion("not a version")).toBeUndefined();
});

test("AC8: checkKeryxVersion is 'ok' when installed >= minimum", () => {
  expect(checkKeryxVersion("0.2.49\n", "0.2.0")).toEqual({ state: "ok" });
  expect(checkKeryxVersion("0.2.0\n", "0.2.0")).toEqual({ state: "ok" });
});

test("AC8: checkKeryxVersion is 'below-minimum' (non-blocking) when installed < minimum", () => {
  const verdict = checkKeryxVersion("0.1.5\n", "0.2.0");
  expect(verdict).toEqual({ state: "below-minimum", installed: "0.1.5", minimum: "0.2.0" });
});

test("AC8: checkKeryxVersion is 'undetermined' (never blocks) on unparseable output", () => {
  expect(checkKeryxVersion("", "0.2.0")).toEqual({ state: "undetermined" });
});

test("AC8: versionWarningMessage names both the installed and minimum versions", () => {
  const message = versionWarningMessage({ state: "below-minimum", installed: "0.1.5", minimum: "0.2.0" });
  expect(message).toContain("0.1.5");
  expect(message).toContain("0.2.0");
});
