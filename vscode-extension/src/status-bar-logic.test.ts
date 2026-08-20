import { expect, test } from "bun:test";
import {
  computeStatusBarSeverity,
  failingChecks,
  HEALTHY_DETAIL_MESSAGE,
  parseHealthGate,
  parseSecurityConfigState,
  statusBarDetailLines,
  statusBarText,
  type StatusBarInputs,
} from "./status-bar-logic";

// --- parsing -----------------------------------------------------------

test("parseHealthGate reads 'gate: pass|warn|fail' from `keryx health status` output", () => {
  expect(parseHealthGate("enabled: yes\ngate: pass\nproject score: 93\n")).toBe("pass");
  expect(parseHealthGate("gate: warn\n")).toBe("warn");
  expect(parseHealthGate("gate: fail\n")).toBe("fail");
});

test("parseHealthGate treats 'n/a' and garbled/missing output as unknown, never throws", () => {
  expect(parseHealthGate("gate: n/a\n")).toBe("unknown");
  expect(parseHealthGate("")).toBe("unknown");
  expect(parseHealthGate("a stale binary printed nothing recognisable")).toBe("unknown");
});

test("parseSecurityConfigState reads 'configChecksum: ok' from `keryx security status` output", () => {
  expect(parseSecurityConfigState("  configChecksum: ok\n")).toBe("ok");
});

test("parseSecurityConfigState treats any other checksum value as broken", () => {
  expect(parseSecurityConfigState("  configChecksum: mismatch\n")).toBe("broken");
});

test("parseSecurityConfigState treats missing output as unknown, never throws", () => {
  expect(parseSecurityConfigState("")).toBe("unknown");
});

// --- severity rollup -----------------------------------------------------

const healthyInputs: StatusBarInputs = {
  metaprojectState: "ready",
  healthGate: "pass",
  securityConfig: "ok",
};

test("computeStatusBarSeverity is 'healthy' when every signal is good", () => {
  expect(computeStatusBarSeverity(healthyInputs)).toBe("healthy");
});

test("computeStatusBarSeverity is 'healthy' for genuinely unknown/never-run signals (never false-alarms)", () => {
  expect(
    computeStatusBarSeverity({ metaprojectState: "ready", healthGate: "unknown", securityConfig: "unknown" }),
  ).toBe("healthy");
});

test("computeStatusBarSeverity is 'error' when Metaproject is not-initialized", () => {
  expect(computeStatusBarSeverity({ ...healthyInputs, metaprojectState: "not-initialized" })).toBe("error");
});

test("computeStatusBarSeverity is 'error' when the health gate is failing", () => {
  expect(computeStatusBarSeverity({ ...healthyInputs, healthGate: "fail" })).toBe("error");
});

test("computeStatusBarSeverity is 'warning' when Metaproject is incomplete", () => {
  expect(computeStatusBarSeverity({ ...healthyInputs, metaprojectState: "incomplete" })).toBe("warning");
});

test("computeStatusBarSeverity is 'warning' when the health gate warns", () => {
  expect(computeStatusBarSeverity({ ...healthyInputs, healthGate: "warn" })).toBe("warning");
});

test("computeStatusBarSeverity is 'warning' when the security config checksum is broken", () => {
  expect(computeStatusBarSeverity({ ...healthyInputs, securityConfig: "broken" })).toBe("warning");
});

test("computeStatusBarSeverity: an error-level signal outranks a simultaneous warning-level one", () => {
  expect(
    computeStatusBarSeverity({ metaprojectState: "incomplete", healthGate: "fail", securityConfig: "ok" }),
  ).toBe("error");
});

test("statusBarText renders a distinct glyph per severity", () => {
  expect(statusBarText("healthy")).toContain("$(check)");
  expect(statusBarText("warning")).toContain("$(warning)");
  expect(statusBarText("error")).toContain("$(error)");
});

// --- AC4: click-through names the specific failing check ------------------

test("AC4: failingChecks is empty when everything is healthy", () => {
  expect(failingChecks(healthyInputs)).toEqual([]);
});

test("AC4: failingChecks names the Metaproject check by label when not-initialized", () => {
  const checks = failingChecks({ ...healthyInputs, metaprojectState: "not-initialized" });
  expect(checks).toHaveLength(1);
  expect(checks[0]?.label).toBe("Metaproject");
  expect(checks[0]?.detail).toContain("Initialize Project");
});

test("AC4: failingChecks names the health gate check by label when failing", () => {
  const checks = failingChecks({ ...healthyInputs, healthGate: "fail" });
  expect(checks).toHaveLength(1);
  expect(checks[0]?.label).toBe("Health gate");
  expect(checks[0]?.detail).toContain("health run");
});

test("AC4: failingChecks names the security config check by label when broken", () => {
  const checks = failingChecks({ ...healthyInputs, securityConfig: "broken" });
  expect(checks).toHaveLength(1);
  expect(checks[0]?.label).toBe("Security config");
  expect(checks[0]?.detail).toContain("policy validate");
});

test("AC4: failingChecks lists every unhealthy signal at once, not just the worst one", () => {
  const checks = failingChecks({ metaprojectState: "incomplete", healthGate: "warn", securityConfig: "broken" });
  expect(checks.map((c) => c.label)).toEqual(["Metaproject", "Health gate", "Security config"]);
});

test("AC4: statusBarDetailLines renders one explanatory line per failing check, never a bare status", () => {
  const lines = statusBarDetailLines({ ...healthyInputs, healthGate: "fail" });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Health gate:");
  expect(lines[0]).toContain("health run");
});

test("AC4: statusBarDetailLines renders the healthy message when nothing is failing", () => {
  expect(statusBarDetailLines(healthyInputs)).toEqual([HEALTHY_DETAIL_MESSAGE]);
});
