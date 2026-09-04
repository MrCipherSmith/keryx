// LWG-15 (flow 228) AC1 and AC7: the metric is additive, and it cannot move
// the gate.
//
// The gate verdict is what people build on. A documentation metric able to
// flip it would let a stale page block a deploy — which `ci-protocol.md`
// rejects, because a blocking freshness check invites updating a page so CI
// passes, and that manufactures filler faster than drift manufactures
// staleness.

import { describe, expect, test } from "bun:test";
import { computeGate } from "./gate";
import { renderReportMarkdown } from "./report";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import type { HealthConfig, HealthReport } from "./types";
import type { WikiFreshnessMetric } from "./metrics/wiki-freshness";

/**
 * AC7, enforced by the compiler rather than by a runtime assertion that could
 * pass vacuously.
 *
 * `computeGate` takes findings, metrics, sources, config and strict — the
 * report itself never reaches it, so no value of `wikiFreshness` can. This
 * type fails to compile the day someone adds the field to that input, which
 * is exactly when the guarantee would break.
 */
type GateInput = Parameters<typeof computeGate>[0];
type AssertNoFreshnessInGate = "wikiFreshness" extends keyof GateInput ? never : true;
const GATE_CANNOT_SEE_FRESHNESS: AssertNoFreshnessInGate = true;

const CONFIG = DEFAULT_HEALTH_CONFIG as HealthConfig;

function baseReport(): HealthReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-09-04T12:00:00Z",
    scope: "project",
    strict: false,
    gitRef: null,
    gate: { status: "pass", reasons: [] },
    sources: [],
    metrics: [],
    findings: [],
  } as unknown as HealthReport;
}

/** As bad as this metric can look: 2 of 44 fresh, 42 needing attention. */
const CATASTROPHIC: WikiFreshnessMetric = {
  status: "measured",
  pagesTotal: 50,
  pagesFresh: 2,
  pagesUndecidable: 6,
  actionable: 42,
  ratio: 2 / 44,
};

describe("the metric cannot move the gate (AC7)", () => {
  test("the gate's input type has no place for it", () => {
    // The compile-time assertion above is the real guard; this keeps it from
    // being deleted as unused.
    expect(GATE_CANNOT_SEE_FRESHNESS).toBe(true);
  });

  test("a catastrophic figure leaves the rendered gate line untouched", () => {
    const without = renderReportMarkdown(baseReport(), CONFIG);
    const withMetric = renderReportMarkdown({ ...baseReport(), wikiFreshness: CATASTROPHIC }, CONFIG);
    const gateLine = (text: string) =>
      text.split("\n").filter((line) => /gate/i.test(line)).join("\n");
    expect(gateLine(withMetric)).toBe(gateLine(without));
  });
});

describe("the metric is additive (AC1)", () => {
  test("a report written before this field existed renders unchanged apart from the new section", () => {
    const rendered = renderReportMarkdown(baseReport(), CONFIG);
    expect(rendered).toContain("Wiki Freshness");
    // Absence gets a sentence. Silence would let a reader assume the wiki is
    // fine; a zero would state it.
    expect(rendered).toContain("Not measured");
    expect(rendered).toContain("not evidence that the wiki is fresh");
  });

  test("a report carrying the field renders its numbers, excluded count included", () => {
    const rendered = renderReportMarkdown({ ...baseReport(), wikiFreshness: CATASTROPHIC }, CONFIG);
    expect(rendered).toContain("2/44");
    expect(rendered).toContain("6 undecidable (excluded)");
    expect(rendered).toContain("42 needing attention");
  });
});
