import { test, expect } from "bun:test";
import { computeGate } from "./gate";
import { DEFAULT_HEALTH_CONFIG as C } from "./config";
import type { Finding, Priority, ScopeMetrics, SourceRunInfo } from "./types";

function project(over: Partial<ScopeMetrics> = {}): ScopeMetrics {
  return {
    key: "project",
    kind: "project",
    name: "project",
    loc: 1000,
    findingCounts: {
      total: 0,
      bySeverity: { error: 0, warning: 0, info: 0 },
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      bySource: {},
    },
    coverage: null,
    churn: null,
    complexity: null,
    health_score: 90,
    risk_score: 0,
    trend: "unknown",
    regression_score: 0,
    ...over,
  };
}

function source(over: Partial<SourceRunInfo>): SourceRunInfo {
  return {
    source: "x",
    status: "available",
    mode: "auto",
    required: false,
    imported: false,
    command: null,
    toolVersion: null,
    findings: 0,
    ...over,
  };
}

function finding(priority: Priority): Finding {
  return {
    schemaVersion: 1,
    id: "id",
    source: "s",
    severity: "error",
    priority,
    category: "c",
    message: "m",
    file: null,
    line: null,
    symbol: null,
    scope: { project: "current", module: null, file: null, entity: null, skill: null },
    suggestedAction: null,
    provenance: { command: null, toolVersion: null, rawLog: null },
  };
}

test("clean state passes", () => {
  const g = computeGate({ findings: [], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("pass");
});

test("a P0 finding fails the gate", () => {
  const g = computeGate({ findings: [finding("P0")], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("fail");
});

test("P1/P2 findings alone do not fail", () => {
  const g = computeGate({ findings: [finding("P1"), finding("P2")], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("pass");
});

test("regression at/above fail threshold fails", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ regression_score: 12 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("fail");
});

test("regression in warn band warns", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ regression_score: 5 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("warn");
});

test("missing required source is incomplete in strict and non-strict runs", () => {
  const sources = [source({ source: "typescript", required: true, status: "missing" })];
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true }).status).toBe("incomplete");
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: false }).status).toBe("incomplete");
});

test("optional skipped source does not affect gate", () => {
  const sources = [source({ source: "coverage", required: false, status: "skipped" })];
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true }).status).toBe("pass");
});

// Flow 237 T6 defect 2 (AFC-28/AC-28): an inventory measured that a MISSING
// health source (SourceStatus "missing", e.g. tests and coverage both
// absent) printed no reason line at all, even though a SKIPPED optional
// source does get one (`OPTIONAL: <source> source skipped`, right above).
// Whether a missing optional source should BLOCK is a separate policy
// question the required/optional distinction already answers (see the
// "missing required source is incomplete" test above) — this only asserts
// its absence stops being invisible in the reasons a reader actually acts
// on. The gate's pass/fail verdict must be unaffected (same as the
// pre-existing skipped-source behavior right above).
test("an optional missing source is named in reasons, the same way a skipped one already is (verdict unaffected)", () => {
  const sources = [source({ source: "coverage", required: false, status: "missing" })];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });

  expect(g.status).toBe("pass");
  expect(g.reasons.some((r) => r.includes("coverage") && /missing/i.test(r))).toBe(true);
});

test("two optional missing sources (tests and coverage) are each named, not silently merged away", () => {
  const sources = [
    source({ source: "tests", required: false, status: "missing" }),
    source({ source: "coverage", required: false, status: "missing" }),
  ];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });

  expect(g.status).toBe("pass");
  expect(g.reasons.some((r) => r.includes("tests") && /missing/i.test(r))).toBe(true);
  expect(g.reasons.some((r) => r.includes("coverage") && /missing/i.test(r))).toBe(true);
});

test("coverage below soft floor warns", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ coverage: 50 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("warn");
});

// T64: `loadHealthConfig` (T59) forces the strictest reachable gate when
// `.metaproject/health.config.json` exists but is unusable, but nothing in
// the returned `GateResult` said why -- an operator could not tell "the
// config is unusable" from "there is a real broken required source" without
// reading `config.ts`'s source. Mirrors `security/config.ts`'s
// `configUnreadable` flag (T54), consumed here the same way `guard.ts`
// consumes it: a constant, non-interpolated reason, never a status escalation
// by itself.
test("configUnreadable adds a discoverable, constant reason without changing the verdict", () => {
  const withoutFlag = computeGate({
    findings: [],
    projectMetrics: project(),
    sources: [],
    config: C,
    strict: false,
  });
  const withFlag = computeGate({
    findings: [],
    projectMetrics: project(),
    sources: [],
    config: { ...C, configUnreadable: true },
    strict: false,
  });
  // Same inputs otherwise, same verdict: the flag alone never escalates.
  expect(withFlag.status).toBe(withoutFlag.status);
  expect(withFlag.coverage).toBe(withoutFlag.coverage);
  expect(withFlag.reasons).not.toEqual(withoutFlag.reasons);
  expect(withFlag.reasons.some((r) => /config/i.test(r) && /unreadable|unusable/i.test(r))).toBe(true);
  // Leak-safe: no path, no raw error text, no interpolated value.
  const joined = withFlag.reasons.join(" ");
  expect(joined).not.toContain(process.cwd());
  expect(joined).not.toContain("undefined");
  expect(joined).not.toMatch(/\.metaproject|\.json/);
});

test("configUnreadable is reported even when it is the only gate condition (clean project)", () => {
  const g = computeGate({
    findings: [],
    projectMetrics: project(),
    sources: [],
    config: { ...C, configUnreadable: true },
    strict: false,
  });
  expect(g.reasons.some((r) => /unreadable|unusable/i.test(r))).toBe(true);
});
