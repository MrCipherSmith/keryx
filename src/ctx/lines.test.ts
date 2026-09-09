import { expect, test } from "bun:test";
import {
  classifyLine,
  compactLines,
  detectStructuredFormat,
  excerptNotice,
  importantLines,
  omissionNote,
  shownSuffix,
} from "./lines";

// The defect this predicate exists to close: `failed|failure` had no spelling
// for the bare token `FAIL`, so a failing test line in the middle of a long log
// was compacted away while the footer reported 98% saved. Fixing it by adding
// the string "FAIL" would leave the next tool's spelling to be discovered the
// same way, so the rule is "a verdict that is not success" and the cases below
// are the evidence that the rule, not one word, is what got implemented.

test("classifyLine keeps the failure vocabulary the tools this repo runs emit", () => {
  for (const line of [
    "FAIL src/thing/broken.test.ts > it keeps the receipt",
    "failed 3 of 12",
    "1 failing",
    "Failure: connection reset",
    "src/a.ts(4,1): error TS2345: Argument of type X",
    "npm ERR! code ELIFECYCLE",
    "FATAL: unable to open database",
    "panic: runtime error: index out of range",
    "Traceback (most recent call last):",
    "AssertionError: expected 1 to be 2",
    "Segmentation fault",
    "Error: ENOENT: no such file or directory",
    "Permission denied",
    "the request timed out",
    "process exited with code 1",
  ]) {
    expect([line, classifyLine(line)]).toEqual([line, "failure"]);
  }
});

test("classifyLine keeps the failure markers this repository's own code uses", () => {
  // src/health/sources/tests.ts parses `(fail)`; src/lib/ui.ts renders `✗`.
  expect(classifyLine("(fail) summarizeRg marks the gap")).toBe("failure");
  expect(classifyLine("  ✗ 3 checks did not pass")).toBe("failure");
});

test("classifyLine separates warnings from failures, and passes from both", () => {
  expect(classifyLine("warning: unused variable")).toBe("warning");
  expect(classifyLine("DeprecationWarning: x is deprecated")).toBe("warning");
  expect(classifyLine("(pass) summarizeRg shows everything [1ms]")).toBeNull();
  expect(classifyLine("pass line 4000 ok some padding")).toBeNull();
});

test("classifyLine does not promote a success verdict spelled with failure words", () => {
  // A bounded rescue budget spent on "0 failed" is a budget not spent on the
  // line that says what broke.
  expect(classifyLine("0 failed, 812 passed")).toBeNull();
  expect(classifyLine("Found 0 errors.")).toBeNull();
  expect(classifyLine("no warnings")).toBeNull();
  // …but a mixed verdict is still a failure.
  expect(classifyLine("0 failed, 2 errored")).toBe("failure");
});

test("compactLines carries a verdict out of the range it elides, and says so", () => {
  const lines = Array.from({ length: 5_000 }, (_, i) =>
    i === 2_499 ? "FAIL src/thing/broken.test.ts" : `pass line ${i + 1}`,
  );
  const out = compactLines(lines, 120, 60);

  expect(out.lines).toContain("FAIL src/thing/broken.test.ts");
  expect(out.rescued).toBe(1);
  expect(out.droppedVerdicts).toBe(0);
  // The marker has to disclose the rescue as well as the cut — a reader who
  // sees only "omitted 4,880 lines" cannot tell whether a verdict went with it.
  expect(out.lines.join("\n")).toContain("kept below");
});

test("compactLines names the verdicts it could not fit", () => {
  const lines = Array.from({ length: 5_000 }, (_, i) =>
    i > 200 && i < 400 ? `FAIL case ${i}` : `pass line ${i + 1}`,
  );
  const out = compactLines(lines, 120, 60);
  expect(out.rescued).toBe(60);
  expect(out.droppedVerdicts).toBeGreaterThan(0);
  expect(out.lines.join("\n")).toContain("more not shown");
});

test("compactLines says plainly when the elided range held no verdict at all", () => {
  const out = compactLines(
    Array.from({ length: 500 }, (_, i) => `pass line ${i + 1}`),
    120,
    60,
  );
  expect(out.lines.join("\n")).toContain("no failure or warning lines in that range");
});

test("compactLines leaves input that fits byte-identical", () => {
  // The opposite defect, fixed in flow 238: small input must not grow a
  // truncation apparatus it does not need.
  const lines = ["a", "b", "c"];
  const out = compactLines(lines, 120, 60);
  expect(out.lines).toEqual(lines);
  expect(out.omitted).toBe(0);
});

test("omissionNote and shownSuffix are silent when nothing was dropped", () => {
  expect(omissionNote(4, 50, "matches")).toContain("omitted 46 of 50 matches");
  expect(omissionNote(50, 50, "matches")).toBeNull();
  expect(shownSuffix(4, 50)).toContain("4 shown");
  expect(shownSuffix(50, 50)).toBe("");
});

test("importantLines ranks failures above warnings and reports the true total", () => {
  const { kept, total } = importantLines(
    ["warning: a", "FAIL b", "pass c", "error: d", "warning: a"],
    2,
  );
  expect(kept).toEqual(["FAIL b", "error: d"]);
  expect(total).toBe(3); // the duplicate warning collapses; the total is honest
});

test("detectStructuredFormat only claims a format the SOURCE actually parses", () => {
  // Otherwise "this excerpt does not parse" would be a claim about input that
  // was already broken.
  expect(detectStructuredFormat('{"a": 1}')).toBe("json");
  expect(detectStructuredFormat("[1, 2, 3]")).toBe("json");
  expect(detectStructuredFormat('{"a": 1}\n{"a": 2}')).toBe("jsonl");
  expect(detectStructuredFormat('{"a": 1,')).toBeNull();
  expect(detectStructuredFormat("plain log line\nanother")).toBeNull();
  expect(detectStructuredFormat("")).toBeNull();
});

test("excerptNotice names the format and refuses to imply the fragment is whole", () => {
  const notice = excerptNotice("json", 200, 1_304);
  expect(notice).toContain("200 of 1,304".replace(",", ""));
  expect(notice).toContain("json");
  expect(notice).toContain("does not parse");
});
