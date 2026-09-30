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

// --- Flow 352 AC3: lint is a capability, not a tool name -------------------
//
// A project that adopted oxlint and switched ESLint off was blocked with
// `INCOMPLETE: required source unavailable: eslint` while its lint check was
// in fact running and parsing. `sources.eslint.required` means "this project is
// linted"; one linter producing a result satisfies that. The family is every
// source whose adapter declares `capability: "lint"` (runAdapter copies it).
function lintRan(name: string): SourceRunInfo {
  return source({
    source: name,
    capability: "lint",
    status: "available",
    required: name === "eslint",
    findings: 3,
    execution: "completed",
    parse: "parsed",
  });
}
function lintSkipped(name: string, required: boolean): SourceRunInfo {
  return source({ source: name, capability: "lint", status: "skipped", required });
}

test("AC3: oxlint satisfying lint keeps a skipped required eslint from blocking", () => {
  const sources = [lintRan("oxlint"), lintSkipped("eslint", true)];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("pass");
  // Coverage still claims nothing it did not measure: lint ran, so the family
  // is not counted as an unmeasured check.
  expect(g.coverage).toBe("complete");
  // And the excuse is visible, not silent.
  expect(g.reasons.some((r) => /eslint skipped/i.test(r) && /oxlint/.test(r))).toBe(true);
});

test("AC3: the reverse direction works too -- eslint ran, oxlint skipped", () => {
  const sources = [lintRan("eslint"), lintSkipped("oxlint", false)];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("pass");
  expect(g.coverage).toBe("complete");
  // Reasons agree with coverage: an excused sibling is not reported as an
  // optional source that produced nothing.
  expect(g.reasons.some((r) => /OPTIONAL: oxlint/.test(r))).toBe(false);
});

test("the family is declared by capability, not by id -- a new linter joins without editing the gate", () => {
  const sources = [lintRan("biome"), lintSkipped("eslint", true)];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("pass");
  expect(g.reasons).toContain("NOTE: eslint skipped; lint capability provided by biome");
});

test("a source without the lint capability cannot excuse a required linter", () => {
  const typecheck = source({ source: "typescript", status: "available", required: true, findings: 0, execution: "completed", parse: "parsed" });
  const g = computeGate({ findings: [], projectMetrics: project(), sources: [typecheck, lintSkipped("eslint", true)], config: C, strict: true });
  expect(g.status).toBe("incomplete");
});

test("AC2: with NEITHER linter the required-eslint INCOMPLETE behavior is unchanged", () => {
  const sources = [lintSkipped("eslint", true), lintSkipped("oxlint", false)];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("incomplete");
  expect(g.coverage).toBe("incomplete");
  expect(g.reasons.some((r) => /required source unavailable: eslint/.test(r))).toBe(true);
  // The family excuse must not fire when nothing in it ran.
  expect(g.reasons.some((r) => /lint capability provided by/.test(r))).toBe(false);
});

test("AC3: only `skipped` is excused -- a missing required eslint still blocks", () => {
  // Config present, binary absent: a half-installed tool is a broken check,
  // not an unused one, so the sibling linter running does not excuse it.
  const sources = [lintRan("oxlint"), source({ source: "eslint", status: "missing", required: true })];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("incomplete");
});

test("AC3: a required eslint that ran and FAILED to parse still blocks", () => {
  const sources = [
    lintRan("oxlint"),
    source({ source: "eslint", required: true, status: "configured-but-failed", parse: "failed", execution: "completed" }),
  ];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("incomplete");
});

test("AC3: a DISABLED required eslint is excused when oxlint ran (new with the lint family)", () => {
  // Before flow 352 a disabled REQUIRED source blocked: `brokenRequired` has no
  // mode check, and `mode: "disabled"` is excused only on the optional side.
  // The family excuse is what unblocks it here -- and only because oxlint ran.
  const sources = [lintRan("oxlint"), { ...lintSkipped("eslint", true), mode: "disabled" as const }];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("pass");
  expect(g.coverage).toBe("complete");
});

test("a DISABLED required eslint with no other linter still blocks, as it always did", () => {
  const sources = [{ ...lintSkipped("eslint", true), mode: "disabled" as const }];
  const g = computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true });
  expect(g.status).toBe("incomplete");
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
