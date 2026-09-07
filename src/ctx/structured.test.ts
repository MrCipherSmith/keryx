import { expect, test } from "bun:test";
import { repairJsonLines, summarizeJsonDocument } from "./structured";

const BUDGET = { maxBytes: 4_000, recover: "keryx ctx show latest --raw" };

test("a document already within budget comes back byte-identical", () => {
  const source = JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2);
  const summary = summarizeJsonDocument(source, BUDGET);
  expect(summary?.complete).toBe(true);
  expect(summary?.text).toBe(source);
});

test("content that is not a whole JSON document is declined, not guessed at", () => {
  expect(summarizeJsonDocument("hello\nworld", BUDGET)).toBeNull();
  expect(summarizeJsonDocument('{"a": 1', BUDGET)).toBeNull();
  expect(summarizeJsonDocument("   ", BUDGET)).toBeNull();
});

// AC3, the clause this module exists for: "JSON валиден".
test("an oversized document becomes a summary that parses and admits it is one", () => {
  const source = JSON.stringify(
    {
      exitCode: 7,
      failedTests: 3,
      errors: [{ message: "boom", stack: "y".repeat(2_000) }],
      records: Array.from({ length: 5_000 }, (_, i) => ({ id: i, detail: "x".repeat(60) })),
    },
    null,
    2,
  );
  const summary = summarizeJsonDocument(source, BUDGET);
  expect(summary).not.toBeNull();
  expect(summary?.complete).toBe(false);
  expect(Buffer.byteLength(summary?.text ?? "")).toBeLessThanOrEqual(BUDGET.maxBytes);

  const parsed = JSON.parse(summary?.text ?? "") as Record<string, unknown>;
  const envelope = parsed.keryxSummary as Record<string, unknown>;
  expect(envelope.type).toBe("json-structure");
  expect(envelope.complete).toBe(false);
  expect(envelope.recover).toBe(BUDGET.recover);

  // Critical structural fields survive by construction, not by position.
  const doc = parsed.document as Record<string, unknown>;
  expect(doc.exitCode).toBe(7);
  expect(doc.failedTests).toBe(3);
  expect(Array.isArray(doc.errors)).toBe(true);
  // The array is still an array, and it says what is missing from it.
  expect(Array.isArray(doc.records)).toBe(true);
  expect(JSON.stringify(doc.records)).toContain("of 5000 items omitted");
});

test("a long string is cut with its true length stated, not silently shortened", () => {
  const source = JSON.stringify({ blob: "z".repeat(50_000) }, null, 2);
  const parsed = JSON.parse(summarizeJsonDocument(source, BUDGET)?.text ?? "") as {
    document: { blob: string };
  };
  expect(parsed.document.blob).toContain("(50000 chars)");
});

// A pathological shape must still produce JSON. The alternative — falling back
// to line truncation — is the exact defect this replaced.
test("a document too large even for the tightest limits still parses", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 20_000; i += 1) wide[`key-${i}`] = i;
  const summary = summarizeJsonDocument(JSON.stringify(wide), { ...BUDGET, maxBytes: 300 });
  expect(summary?.complete).toBe(false);
  const parsed = JSON.parse(summary?.text ?? "") as Record<string, unknown>;
  expect((parsed.document as Record<string, unknown>).keys).toBe(20_000);
});

// For JSON Lines the unit of validity is the row. Head/tail compaction leaves
// every source row intact, so the only line that breaks `map(JSON.parse)` is
// the prose marker compaction inserts.
test("a compacted JSONL body has no row that fails to parse", () => {
  const body = [
    JSON.stringify({ i: 0 }),
    "... omitted 95 of 100 lines — full file in raw ...",
    JSON.stringify({ i: 99 }),
  ];
  const repaired = repairJsonLines(body, "keryx ctx show latest --raw");

  expect(repaired.length).toBe(3);
  for (const row of repaired) {
    expect(() => JSON.parse(row) as unknown).not.toThrow();
  }
  // The marker's facts survive the rewrite rather than being dropped.
  expect(JSON.parse(repaired[1] as string)).toMatchObject({
    keryxOmitted: {
      note: "... omitted 95 of 100 lines — full file in raw ...",
      recover: "keryx ctx show latest --raw",
    },
  });
});

test("rows that already parse are left byte-identical", () => {
  const rows = [JSON.stringify({ i: 1 }), "", JSON.stringify({ i: 2 })];
  expect(repairJsonLines(rows, "x")).toEqual(rows);
});
