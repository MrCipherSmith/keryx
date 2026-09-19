import { describe, expect, test } from "bun:test";
import { busEnabled, busPollMs } from "./enabled";

// AC10 (resolver part): named reasons and the poll clamp.

describe("busEnabled", () => {
  test("enabled by default", () => {
    expect(busEnabled({ env: {} })).toEqual({ enabled: true, reason: null });
    expect(busEnabled({ env: { CI: "false" }, shellConfig: { bus: { enabled: true } } })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  test("KERYX_BUS=off disables it", () => {
    expect(busEnabled({ env: { KERYX_BUS: "off" } })).toEqual({ enabled: false, reason: "KERYX_BUS=off" });
    expect(busEnabled({ env: { KERYX_BUS: " OFF " } }).enabled).toBe(false);
    expect(busEnabled({ env: { KERYX_BUS: "on" } }).enabled).toBe(true);
  });

  test("shell config bus.enabled: false disables it", () => {
    expect(busEnabled({ env: {}, shellConfig: { bus: { enabled: false } } })).toEqual({
      enabled: false,
      reason: "shell config bus.enabled is false",
    });
    expect(busEnabled({ env: {}, shellConfig: { apiKeys: {} } }).enabled).toBe(true);
    expect(busEnabled({ env: {}, shellConfig: null }).enabled).toBe(true);
  });

  test("a CI environment disables it, naming the variable", () => {
    expect(busEnabled({ env: { CI: "true" } })).toEqual({ enabled: false, reason: "CI environment (CI is set)" });
    expect(busEnabled({ env: { GITHUB_ACTIONS: "true" } }).enabled).toBe(false);
  });
});

describe("busPollMs", () => {
  test("defaults to 1500 and clamps to 250-10000", () => {
    expect(busPollMs({})).toBe(1500);
    expect(busPollMs({ KERYX_BUS_POLL_MS: "abc" })).toBe(1500);
    expect(busPollMs({ KERYX_BUS_POLL_MS: "-5" })).toBe(1500);
    expect(busPollMs({ KERYX_BUS_POLL_MS: "10" })).toBe(250);
    expect(busPollMs({ KERYX_BUS_POLL_MS: "600" })).toBe(600);
    expect(busPollMs({ KERYX_BUS_POLL_MS: "99999" })).toBe(10_000);
  });
});
