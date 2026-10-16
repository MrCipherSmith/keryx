import { describe, expect, test } from "bun:test";
import { parseReviewResult } from "./ledger";
import { describeUnusableResult, lenientReviewResult, mergeResults } from "./result-parse";

// Flow 458 AC12: the tolerant reader behind parseReviewResult. The strict rules (labels, markers, ambiguity) stay in ledger.test.ts.

const one = (extra: Record<string, unknown> = {}) => ({ status: "DONE", reviewer: "review-logic", slices: ["s1"], findings: [], ...extra });

describe("lenient reviewer results", () => {
  test("a fenced ```json block holding a wrapped result is read", () => {
    const reply = `Here is my review.\n\`\`\`json\n${JSON.stringify({ result: one() })}\n\`\`\`\nDone.`;
    expect(parseReviewResult(reply)?.reviewer).toBe("review-logic");
  });

  test("a bare object with leading and trailing prose is read", () => {
    expect(parseReviewResult(`I reviewed it.\n${JSON.stringify(one())}\nThanks!`)?.status).toBe("DONE");
  });

  test("common wrapper keys are unwrapped", () => {
    for (const key of ["result", "review_result", "reviewResult", "REVIEW_RESULT", "output", "response", "data"]) {
      expect(parseReviewResult(JSON.stringify({ [key]: one() }))?.reviewer).toBe("review-logic");
    }
  });

  test("a labelled fence holding a wrapper is unwrapped too", () => {
    expect(parseReviewResult(`\`\`\`REVIEW_RESULT\n${JSON.stringify({ review_result: one() })}\n\`\`\``)?.reviewer).toBe("review-logic");
  });

  test("a JSON array of one reviewer's results (one per wave) is merged: slices and findings are the union, the status the least finished", () => {
    const finding = (id: string) => ({ id, severity: "minor" });
    const waves = [
      one({ slices: ["s1", "s2"], findings: [finding("F-1")], model: "sonnet" }),
      one({ status: "INCOMPLETE", slices: ["s2", "s3"], findings: [finding("F-2")], needs_context: ["which branch?"] }),
    ];
    const merged = parseReviewResult(JSON.stringify(waves));
    expect(merged?.status).toBe("INCOMPLETE");
    expect(merged?.slices).toEqual(["s1", "s2", "s3"]);
    expect(merged?.findings?.map((f) => f.id)).toEqual(["F-1", "F-2"]);
    expect(merged?.needs_context).toEqual(["which branch?"]);
    expect(merged?.model).toBe("sonnet");
  });

  test("waves with the same status are merged too: the strict reader would keep only the last object", () => {
    const merged = parseReviewResult(JSON.stringify([one({ slices: ["s1"] }), one({ slices: ["s2"] })]));
    expect(merged?.slices).toEqual(["s1", "s2"]);
  });

  test("a results list under a wrapper key is the same as an array", () => {
    const merged = parseReviewResult(JSON.stringify({ results: [one({ slices: ["a"] }), one({ slices: ["b"] })] }));
    expect(merged?.slices).toEqual(["a", "b"]);
  });

  test("slice entries written as objects are kept as written and deduplicated by id", () => {
    const merged = lenientReviewResult(JSON.stringify([one({ slices: [{ id: "s1" }] }), one({ slices: [{ id: "s1" }, "s2"] })]));
    expect(merged?.slices).toEqual([{ id: "s1" }, "s2"]);
  });

  test("results of two different reviewers in one reply give nothing: a raw file is one reviewer's", () => {
    expect(lenientReviewResult(JSON.stringify([one(), one({ reviewer: "review-style" })]))).toBeUndefined();
    expect(mergeResults([one(), one({ reviewer: "review-style" })])).toBeUndefined();
  });

  test("separate lists with different statuses are ambiguous and give nothing", () => {
    expect(parseReviewResult(`${JSON.stringify([one()])}\n${JSON.stringify([one({ status: "BLOCKED" })])}`)).toBeUndefined();
  });

  test("a cut-off reply gives nothing, whatever complete value stands inside it", () => {
    const cut = `${JSON.stringify([one()]).slice(0, -3)}`;
    expect(parseReviewResult(cut)).toBeUndefined();
    expect(parseReviewResult(`{"result": {"status":"DONE","reviewer":"r","findings":[{"a":1}`)).toBeUndefined();
  });

  test("a status-only wrapper is not a result without a reviewer or findings, and a bare reviewer object stays the strict reader's", () => {
    expect(parseReviewResult('{"result":{"verdict":"ok"}}')).toBeUndefined();
    expect(lenientReviewResult(`${JSON.stringify(one())}\n${JSON.stringify([one({ status: "BLOCKED" })])}`)).toBeUndefined();
  });
});

describe("the message for an unusable reply names what is missing", () => {
  test("an object without reviewer, slices or findings", () => {
    const message = describeUnusableResult('Done: {"status":"DONE"}');
    expect(message).toContain("missing reviewer, slices, findings");
  });

  test("an object with a wrongly typed field", () => {
    expect(describeUnusableResult('{"status":"DONE","reviewer":"r","findings":"none"}')).toContain("findings is not an array");
  });

  test("a status that is not a string is named", () => {
    const message = describeUnusableResult('{"reviewer":"r","slices":[],"findings":[],"status":3}');
    expect(message).toContain("status is not a string");
  });

  test("no JSON at all, and an empty reply", () => {
    expect(describeUnusableResult("I looked and it was fine.")).toContain("no JSON object or array was found");
    expect(describeUnusableResult("   ")).toContain("empty");
  });

  test("results of several reviewers are named", () => {
    expect(describeUnusableResult(JSON.stringify([one(), one({ reviewer: "review-style" })]))).toContain("2 different reviewers (review-logic, review-style)");
  });
});
