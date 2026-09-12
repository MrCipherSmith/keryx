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

test("a capacity word elsewhere on the line does not silence the bar that moved", () => {
  // T20/MAJOR-2. The carve-out above used to tokenise the WHOLE line, so one
  // unrelated word switched the guard off. This is the module's own headline
  // example — `--max-warnings 0` becoming `50` — and it went silent purely
  // because `--max-size` also appears on the line.
  const lintScript = diffOf(
    "package.json",
    4,
    ['-    "lint": "eslint --max-warnings 0 --max-size 10"', '+    "lint": "eslint --max-warnings 50 --max-size 10"'].join("\n"),
  );
  const findings = report(lintScript).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["threshold-lowered"]);
  expect(findings[0]?.detail).toContain("0 -> 50");
  // The unmoved number on the same line is not reported as movement.
  expect(findings[0]?.detail).not.toContain("10 ->");
});

test("a floor named in capacity units still fires; the same unit under a ceiling does not", () => {
  // The asymmetry, pinned. "at least 3 items" relaxed to "at least 0" is a
  // demand removed. "at most N items" raised is a budget, and raising a budget
  // weakens nothing — which is the measured case CAPACITY_WORDS was added for.
  const minimum = diffOf("schema.json", 4, ['-    "minItems": 3,', '+    "minItems": 0,'].join("\n"));
  const budget = diffOf("schema.json", 4, ['-    "maxItems": 3,', '+    "maxItems": 300,'].join("\n"));

  expect(kinds(minimum)).toEqual(["threshold-lowered"]);
  expect(kinds(budget)).toEqual([]);
});

test("a trailing comment added in the same edit does not break the pairing", () => {
  // The one-word evasion of a guard whose entire purpose is to be hard to slip
  // past: lower the number and explain yourself on the same line. Before the
  // fix the skeletons differed by the comment, so the pair never formed at all.
  const excused = diffOf("jest.config.js", 10, ["-      minCoverage: 80,", "+      minCoverage: 70, // keeps the page size sane"].join("\n"));
  const findings = report(excused).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["threshold-lowered"]);
  expect(findings[0]?.detail).toContain("80 -> 70");
  // The evidence is still the line as written, comment and all.
  expect(findings[0]?.added).toBe("minCoverage: 70, // keeps the page size sane");
});

test("the ordinary TypeScript spelling of a threshold constant is not silenced by its type", () => {
  // T23/2. The adjacent identifier is `number` — the type annotation — so the
  // plainest way to write a coverage floor in this repository's own language was
  // silent. The walk steps over a type keyword instead of reading it as a name.
  const annotated = diffOf("src/gate.ts", 4, ["-  const minCoverage: number = 80;", "+  const minCoverage: number = 70;"].join("\n"));
  const findings = report(annotated).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["threshold-lowered"]);
  expect(findings[0]?.detail).toContain("80 -> 70");

  // And stepping over the type does not switch the carve-outs off on the way:
  // the name behind it is still read, capacity words included.
  const budget = diffOf("src/gate.ts", 4, ["-  const maxSize: number = 10;", "+  const maxSize: number = 100;"].join("\n"));
  expect(kinds(budget)).toEqual([]);
});

test("a threshold named by the key one container out is reported", () => {
  // T23/2. `global` names nothing; `thresholds` does, and it is the enclosing
  // key. The walk continues only through an opener, so an argument after a comma
  // still borrows nothing from the identifier before it.
  const nested = diffOf("jest.config.js", 4, ["-  thresholds: { global: 80 },", "+  thresholds: { global: 70 },"].join("\n"));
  expect(kinds(nested)).toEqual(["threshold-lowered"]);

  const argument = diffOf("src/gate.ts", 4, ["-  computeThreshold(scores, 80);", "+  computeThreshold(scores, 70);"].join("\n"));
  expect(kinds(argument)).toEqual([]);
});

test("a threshold written through a constant index is reported", () => {
  // T23/2. `minScores[0] = 80` ends in `]`, which matched no identifier at all.
  const indexed = diffOf("src/gate.ts", 4, ["-  minScores[0] = 80;", "+  minScores[0] = 70;"].join("\n"));
  expect(kinds(indexed)).toEqual(["threshold-lowered"]);
});

test("an unnamed number on the line is carried by the named one, not allowed to void it", () => {
  // T23/2. Unanimity was demanded of every moved number, so `count` — which
  // names nothing — switched off the coverage floor sitting beside it.
  const together = diffOf(
    "jest.config.js",
    4,
    ["-  const gate = { minCoverage: 80, count: 7 };", "+  const gate = { minCoverage: 70, count: 4 };"].join("\n"),
  );
  const findings = report(together).findings;
  expect(findings.map((finding) => finding.kind)).toEqual(["threshold-lowered"]);
  expect(findings[0]?.detail).toContain("80 -> 70, 7 -> 4");

  // The unmixed-move rule still binds the unnamed number: if it went the other
  // way the line is doing two things and nothing fires.
  const opposed = diffOf(
    "jest.config.js",
    4,
    ["-  const gate = { minCoverage: 80, count: 7 };", "+  const gate = { minCoverage: 70, count: 9 };"].join("\n"),
  );
  expect(kinds(opposed)).toEqual([]);
});

test("a number with no identifier in front of it is never a threshold", () => {
  // Measured over the 200 commits ending at `main` = 5d5e1acc, each read as
  // `git diff <sha>^ <sha> -U3` at contextLines 3: whole-line reading produced
  // 25 threshold findings, 22 of them a renumbered ordered list (14) or step
  // heading (8). Reading the identifier the number belongs to leaves 2, both the
  // same real ceiling in two copies of one JSON schema.
  const renumbered = diffOf(
    "SKILL.md",
    12,
    ["-5. Explicitly allowed global fallback skills", "+6. Explicitly allowed global fallback skills"].join("\n"),
  );
  const step = diffOf(
    "SKILL.md",
    12,
    ["-□ Step 9: Analyze tests (understand coverage)", "+□ Step 7: Analyze tests (understand coverage)"].join("\n"),
  );

  expect(kinds(renumbered)).toEqual([]);
  expect(kinds(step)).toEqual([]);
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

test("a sentence that merely mentions a disable form is not reported", () => {
  // T20/MINOR-3. Statement position alone was not enough: `;`, `{` and `}` are
  // ordinary English punctuation, so both of these fired — on a branch that
  // ships thousands of lines of prose about skipped tests. A sentence does not
  // call anything, so the detector now requires the `(`.
  const semicolon = diffOf("docs/guide.md", 4, ["+We ban this; it.skip is the usual culprit."].join("\n"));
  const braces = diffOf("docs/guide.md", 4, ["+Bad: { describe.only is worse }"].join("\n"));

  expect(kinds(semicolon)).toEqual([]);
  expect(kinds(braces)).toEqual([]);
  // And the call form in the very same file still fires, so this is a narrowing
  // and not an off switch.
  expect(kinds(diffOf("docs/guide.md", 4, ['+  it.skip("x", () => {}); // in a fenced block'].join("\n")))).toEqual(["test-disabled"]);
});

test("a chained modifier and vitest's conditional forms are reported", () => {
  // T20/MINOR-4. Both are mainstream jest/vitest API and both returned nothing.
  const concurrent = diffOf("src/pay/pay.test.ts", 12, ['+  test.concurrent.skip("refunds", async () => {', "   });"].join("\n"));
  const conditional = diffOf("src/pay/pay.test.ts", 12, ['+  describe.skipIf(process.env.CI)("refunds", () => {', "   });"].join("\n"));

  expect(kinds(concurrent)).toEqual(["test-disabled"]);
  expect(kinds(conditional)).toEqual(["test-disabled"]);
});

test("the table-driven spellings the pattern claimed to cover are reported", () => {
  // T23/5. The docstring cited `describe.each(cases).skip` as the reason one
  // chained segment is allowed, but the pattern admitted no CALL between
  // segments, so that exact shape — and the one jest and vitest document,
  // `describe.skip.each(table)(…)` — matched nothing. Each of these turns off a
  // whole table of tests on one added line.
  const eachThenSkip = diffOf("src/pay/pay.test.ts", 12, ['+  describe.each(cases).skip("refunds", (c) => {', "   });"].join("\n"));
  const skipThenEach = diffOf("src/pay/pay.test.ts", 12, ['+  describe.skip.each(table)("refunds %s", (c) => {', "   });"].join("\n"));
  const twoModifiers = diffOf("src/pay/pay.test.ts", 12, ['+  test.concurrent.failing.skip("refunds", async () => {', "   });"].join("\n"));

  expect(kinds(eachThenSkip)).toEqual(["test-disabled"]);
  expect(kinds(skipThenEach)).toEqual(["test-disabled"]);
  expect(kinds(twoModifiers)).toEqual(["test-disabled"]);

  // The stated boundary, pinned so it is a decision and not a surprise: the
  // argument list is paren-free, because this is a regex and not a parser.
  const computed = diffOf("src/pay/pay.test.ts", 12, ['+  describe.each(buildCases(x)).skip("refunds", (c) => {', "   });"].join("\n"));
  expect(kinds(computed)).toEqual([]);
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

test("a suppression that merely MOVED within the region is not reported", () => {
  // T20/MINOR-6. `detectRemovedAssertions` nets per region deliberately; this
  // did not, so a reindent that deleted a marker and re-added the identical line
  // two lines down demanded a justification for a change nobody made.
  const moved = diffOf(
    "src/pay/refund.ts",
    8,
    [
      "-  // eslint-disable-next-line no-control-regex",
      "   const pattern = /\\x00/;",
      "+  // eslint-disable-next-line no-control-regex",
      "   apply(pattern);",
    ].join("\n"),
  );
  expect(kinds(moved)).toEqual([]);

  // A marker whose rule list GREW is a different line, and is still reported.
  const widened = diffOf(
    "src/pay/refund.ts",
    8,
    [
      "-  // eslint-disable-next-line no-control-regex",
      "   const pattern = /\\x00/;",
      "+  // eslint-disable-next-line no-control-regex, no-misused-promises",
      "   apply(pattern);",
    ].join("\n"),
  );
  expect(kinds(widened)).toEqual(["suppression-added"]);
});

test("one removed marker forgives one identical addition, not every addition", () => {
  // T23/1. The netting was set membership, so a region that removed ONE stale
  // marker and added THREE identical ones reported nothing at all: deleting one
  // marker bought unlimited new ones inside the window. The same three with
  // nothing removed reported three, which is the contradiction that named it.
  // Written as a concatenation so this file's own diff does not carry the
  // marker, the way the fixtures above keep it behind a quote.
  const IGNORE = "  // @ts-" + "ignore the ledger types are wrong here";
  const oneForThree = diffOf(
    "src/pay/refund.ts",
    8,
    [`-${IGNORE}`, "   const total = sum(order.lines);", `+${IGNORE}`, `+${IGNORE}`, `+${IGNORE}`, "   ledger.post(total);"].join("\n"),
  );
  // Three added, one forgiven by the removal: two are new suppressions.
  expect(kinds(oneForThree)).toEqual(["suppression-added", "suppression-added"]);

  // The control the old spelling passed for the wrong reason: with nothing
  // removed, all three are additions.
  const threeAdded = diffOf(
    "src/pay/refund.ts",
    8,
    ["   const total = sum(order.lines);", `+${IGNORE}`, `+${IGNORE}`, `+${IGNORE}`, "   ledger.post(total);"].join("\n"),
  );
  expect(kinds(threeAdded)).toEqual(["suppression-added", "suppression-added", "suppression-added"]);

  // And the reindent this netting exists for is still forgiven: one out, one in.
  const oneForOne = diffOf(
    "src/pay/refund.ts",
    8,
    [`-${IGNORE}`, "   const total = sum(order.lines);", `+${IGNORE}`, "   ledger.post(total);"].join("\n"),
  );
  expect(kinds(oneForOne)).toEqual([]);
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
  expect(Object.keys(result).sort()).toEqual(["counts", "findings", "outcome", "scanned", "schemaVersion"]);
  expect(result.schemaVersion).toBe(1);
  // The discriminant. A reader that cannot tell "the guard looked and found
  // nothing" from "the guard could not look" has lost the one distinction this
  // module's `scanned` counts exist for — see `floorCannotScan`.
  expect(result.outcome).toBe("scanned");
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
