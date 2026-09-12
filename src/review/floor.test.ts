// The floor guard (flow 258, T11).
//
// Every detection here is tested twice: once with a diff that MUST fire, and
// once with the mirror-image diff that must NOT — a threshold moving up, a
// `.skip` being removed, an assertion being added, a suppression being deleted.
// A guard against quiet weakening that fires on the repair as well as the
// damage is worse than no guard, because it teaches the reader to skip it.
//
// Each detector was also mutated in a scratch copy and the firing test watched
// to fail; the controls stayed green, which is what says the controls are
// controls and not tests that pass for free.

import { expect, test } from "bun:test";
import { detectFloorRegressions, renderFloorMarkdown, FLOOR_FINDING_KINDS, type FloorFindingKind } from "./floor";
import { buildReviewScope } from "./scope";

function diffOf(path: string, oldStart: number, body: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldStart},8 +${oldStart},8 @@`, body].join("\n");
}

function report(diff: string) {
  return detectFloorRegressions(buildReviewScope(diff));
}

function kinds(diff: string): FloorFindingKind[] {
  return report(diff).findings.map((finding) => finding.kind);
}

// ---------------------------------------------------------------------------
// 1. Lowered thresholds
// ---------------------------------------------------------------------------

const COVERAGE_LOWERED = diffOf(
  "jest.config.js",
  10,
  [" coverageThreshold: {", "   global: {", "-      minCoverage: 80,", "+      minCoverage: 70,", "   },", " },"].join("\n"),
);

const COVERAGE_RAISED = diffOf(
  "jest.config.js",
  10,
  [" coverageThreshold: {", "   global: {", "-      minCoverage: 80,", "+      minCoverage: 90,", "   },", " },"].join("\n"),
);

test("a coverage floor moved DOWN is reported", () => {
  const findings = report(COVERAGE_LOWERED).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["threshold-lowered"]);
  expect(findings[0]?.detail).toContain("80 -> 70");
  expect(findings[0]?.removed).toBe("minCoverage: 80,");
  expect(findings[0]?.added).toBe("minCoverage: 70,");
  expect(findings[0]?.path).toBe("jest.config.js");
});

test("the same floor moved UP is not reported", () => {
  expect(kinds(COVERAGE_RAISED)).toEqual([]);
});

test("a ceiling moved UP is reported and the same ceiling moved DOWN is not", () => {
  // A raised timeout is the canonical way to silence a flaky test, so the
  // direction that weakens depends on what the line NAMES, not on the sign.
  const raised = diffOf("src/wait.ts", 4, ["-  const timeoutMs = 5000;", "+  const timeoutMs = 30000;"].join("\n"));
  const tightened = diffOf("src/wait.ts", 4, ["-  const timeoutMs = 5000;", "+  const timeoutMs = 3000;"].join("\n"));

  expect(kinds(raised)).toEqual(["threshold-lowered"]);
  expect(kinds(tightened)).toEqual([]);
});

test("a bare number with no floor or ceiling word on the line is never reported", () => {
  // The narrowing that keeps this out of every version bump and page size.
  const bare = diffOf("src/page.ts", 4, ["-  const rows = 50;", "+  const rows = 10;"].join("\n"));
  const version = diffOf("src/deps.ts", 4, ['-  const pinned = "18.3.0";', '+  const pinned = "18.2.0";'].join("\n"));

  expect(kinds(bare)).toEqual([]);
  expect(kinds(version)).toEqual([]);
});

test("a ceiling on how much DATA a thing carries is not a bar and is not reported", () => {
  // Measured, not guessed: this was the only finding the guard produced over
  // four merged commits on `main`, and it was noise. A token, byte or row
  // budget is a resource dimension; raising one weakens nothing.
  const tokens = diffOf("src/tui/game-modal.ts", 4, ["-      maxOutputTokens: 16,", "+      maxOutputTokens: 256,"].join("\n"));
  const rows = diffOf("src/tui/table.ts", 4, ["-  const maxRows = 20;", "+  const maxRows = 200;"].join("\n"));

  expect(kinds(tokens)).toEqual([]);
  expect(kinds(rows)).toEqual([]);
});

test("a line whose numbers move in both directions is not reported", () => {
  const mixed = diffOf("src/retry.ts", 4, ["-  retry({ maxAttempts: 3, backoff: 200 });", "+  retry({ maxAttempts: 5, backoff: 100 });"].join("\n"));
  expect(kinds(mixed)).toEqual([]);
});

test("a rewrite that is not the same line with a different number is not reported", () => {
  // The skeleton match: without it, any removed line holding a digit next to
  // any added line holding a digit becomes a finding.
  const rewrite = diffOf(
    "src/limits.ts",
    4,
    ["-  const maxItems = 100;", "+  const maxItems = readConfig().items ?? 10;"].join("\n"),
  );
  expect(kinds(rewrite)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 2. Disabled tests
// ---------------------------------------------------------------------------

const SKIP_ADDED = diffOf(
  "src/pay/pay.test.ts",
  12,
  [
    ' describe("refunds", () => {',
    '-  it("refuses a double refund", async () => {',
    '+  it.skip("refuses a double refund", async () => {',
    "     await refund(order);",
    "   });",
  ].join("\n"),
);

const SKIP_REMOVED = diffOf(
  "src/pay/pay.test.ts",
  12,
  [
    ' describe("refunds", () => {',
    '-  it.skip("refuses a double refund", async () => {',
    '+  it("refuses a double refund", async () => {',
    "     await refund(order);",
    "   });",
  ].join("\n"),
);

test("a test disabled with .skip is reported", () => {
  const findings = report(SKIP_ADDED).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["test-disabled"]);
  expect(findings[0]?.detail).toContain("it.skip");
  expect(findings[0]?.path).toBe("src/pay/pay.test.ts");
});

test("a .skip being REMOVED is not reported", () => {
  expect(kinds(SKIP_REMOVED)).toEqual([]);
});

test(".only is reported too, because it disables every other test in the file", () => {
  const only = diffOf("src/pay/pay.test.ts", 12, ['-  describe("refunds", () => {', '+  describe.only("refunds", () => {'].join("\n"));
  expect(kinds(only)).toEqual(["test-disabled"]);
});

test("python and go forms are reported", () => {
  const python = diffOf("tests/test_pay.py", 3, ["+@pytest.mark.skip(reason=\"flaky\")", " def test_refund():", "     pass"].join("\n"));
  const go = diffOf("pay/pay_test.go", 3, [" func TestRefund(t *testing.T) {", "+\tt.Skip(\"flaky\")", " }"].join("\n"));

  expect(kinds(python)).toEqual(["test-disabled"]);
  expect(kinds(go)).toEqual(["test-disabled"]);
});

test("a marker that merely appears inside a string or mid-expression is not reported", () => {
  // The statement-position rule. Without it this module's own marker lists and
  // every linter rule in the repository become findings.
  const mention = diffOf(
    "src/lint/markers.ts",
    4,
    ['+  const disabledForms = ["it.skip(", "describe.only("];', "+  const pattern = buildPattern(disabledForms);"].join("\n"),
  );
  expect(kinds(mention)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 3. Removed assertions
// ---------------------------------------------------------------------------

const ASSERTIONS_REMOVED = diffOf(
  "src/pay/pay.test.ts",
  30,
  [
    '   it("refunds once", async () => {',
    "     const result = await refund(order);",
    "-    expect(result.status).toBe(\"refunded\");",
    "-    expect(ledger.entries).toHaveLength(1);",
    "   });",
  ].join("\n"),
);

const ASSERTIONS_ADDED = diffOf(
  "src/pay/pay.test.ts",
  30,
  [
    '   it("refunds once", async () => {',
    "     const result = await refund(order);",
    "+    expect(result.status).toBe(\"refunded\");",
    "+    expect(ledger.entries).toHaveLength(1);",
    "   });",
  ].join("\n"),
);

test("a test that ends up checking fewer things is reported", () => {
  const findings = report(ASSERTIONS_REMOVED).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["assertion-removed"]);
  expect(findings[0]?.detail).toContain("removes 2 assertion-carrying line(s) and adds 0");
});

test("assertions being ADDED are not reported", () => {
  expect(kinds(ASSERTIONS_ADDED)).toEqual([]);
});

test("an assertion moved within the same region nets to zero and is not reported", () => {
  const moved = diffOf(
    "src/pay/pay.test.ts",
    30,
    [
      "     const result = await refund(order);",
      "-    expect(result.status).toBe(\"refunded\");",
      "     await settle(order);",
      "+    expect(result.status).toBe(\"refunded\");",
    ].join("\n"),
  );
  expect(kinds(moved)).toEqual([]);
});

test("an assert removed from production code is not reported", () => {
  // Test files only: an `assert(` deleted from a service is a different
  // conversation and would drown this one.
  const production = diffOf("src/pay/refund.ts", 30, ["-  assert(order.id !== undefined);", "   return refund(order);"].join("\n"));
  expect(kinds(production)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. Added suppressions
// ---------------------------------------------------------------------------

const SUPPRESSION_ADDED = diffOf(
  "src/pay/refund.ts",
  8,
  ["   const total = sum(order.lines);", "+  // @ts-expect-error the ledger types are wrong here", "   ledger.post(total);"].join("\n"),
);

const SUPPRESSION_DELETED = diffOf(
  "src/pay/refund.ts",
  8,
  ["   const total = sum(order.lines);", "-  // @ts-expect-error the ledger types are wrong here", "   ledger.post(total);"].join("\n"),
);

test("a new suppression comment is reported", () => {
  const findings = report(SUPPRESSION_ADDED).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["suppression-added"]);
  expect(findings[0]?.detail).toContain("@ts-expect-error");
});

test("a suppression being DELETED is not reported", () => {
  expect(kinds(SUPPRESSION_DELETED)).toEqual([]);
});

test("eslint and python suppressions are reported in their own comment syntax", () => {
  const eslint = diffOf(
    "src/pay/refund.ts",
    8,
    ["+  // eslint-disable-next-line @typescript-eslint/no-unsafe-call", "   ledger.post(total);"].join("\n"),
  );
  const python = diffOf("src/pay/refund.py", 8, ["+    ledger.post(total)  # type: ignore[arg-type]"].join("\n"));

  expect(kinds(eslint)).toEqual(["suppression-added"]);
  expect(kinds(python)).toEqual(["suppression-added"]);
});

test("a suppression marker inside a string literal is not reported", () => {
  // The position rule: the marker must sit after a comment opener with no
  // quote before it. This is what keeps the guard's own marker list, and every
  // lint config in the repository, out of its own output.
  const listed = diffOf("src/lint/config.ts", 4, ['+  const allow = ["eslint-disable", "@ts-ignore"];'].join("\n"));
  expect(kinds(listed)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Ordinary diffs, and the report itself
// ---------------------------------------------------------------------------

test("a diff that only adds ordinary code reports nothing", () => {
  const ordinary = diffOf(
    "src/pay/refund.ts",
    20,
    [
      " export function refund(order: Order): Refund {",
      "+  const reference = createReference(order.id);",
      "+  logger.info({ reference }, \"refund started\");",
      "   return ledger.refund(order);",
      " }",
    ].join("\n"),
  );
  const result = report(ordinary);
  expect(result.findings).toEqual([]);
  expect(result.counts.total).toBe(0);
  // The scanned counts are the guard against a vacuous pass: a detector that
  // saw nothing would also report nothing.
  expect(result.scanned.regions).toBeGreaterThan(0);
  expect(result.scanned.changedLines).toBe(2);
});

test("the report shape is fixed: schema version, every kind counted, what was scanned", () => {
  // Nothing consumes this JSON yet, so this test IS the pin. A field renamed
  // without a reader is how `attempts.count` stayed wrong for a release.
  const result = report(COVERAGE_LOWERED);
  expect(Object.keys(result).sort()).toEqual(["counts", "findings", "scanned", "schemaVersion"]);
  expect(result.schemaVersion).toBe(1);
  expect(Object.keys(result.counts.byKind).sort()).toEqual([...FLOOR_FINDING_KINDS].sort());
  expect(Object.keys(result.scanned).sort()).toEqual(["changedLines", "files", "regions"]);
  expect(Object.keys(result.findings[0] ?? {}).sort()).toEqual(["added", "detail", "kind", "line", "path", "removed"]);
  expect(result.counts.byKind["threshold-lowered"]).toBe(1);
});

test("one diff carrying all four weakenings reports all four", () => {
  const everything = [
    COVERAGE_LOWERED,
    SKIP_ADDED.replace("src/pay/pay.test.ts", "src/cart/cart.test.ts"),
    ASSERTIONS_REMOVED.replace("src/pay/pay.test.ts", "src/order/order.test.ts"),
    SUPPRESSION_ADDED.replace("src/pay/refund.ts", "src/order/post.ts"),
  ].join("\n");

  expect(kinds(everything).sort()).toEqual(["assertion-removed", "suppression-added", "test-disabled", "threshold-lowered"]);
});

test("an empty diff says it scanned nothing rather than reporting a clean bill of health", () => {
  const empty = report("");
  expect(empty.counts.total).toBe(0);
  expect(empty.scanned.regions).toBe(0);
  expect(renderFloorMarkdown(empty)).toContain("nothing was scanned");
  expect(renderFloorMarkdown(report(COVERAGE_LOWERED))).toContain("minCoverage");
});
