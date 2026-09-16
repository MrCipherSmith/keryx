// Cost is estimated before, recorded after, and never invented.

import { describe, expect, test } from "bun:test";
import { costFrom, estimateTokens, renderCostPerFinding, renderScopeEstimate } from "./cost";

describe("estimateTokens", () => {
  test("characters divided by four, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("renderScopeEstimate", () => {
  test("multiplies by the fan-out, because every reviewer gets the diff", () => {
    const rendered = renderScopeEstimate("a".repeat(4000), 5);
    expect(rendered).toContain("1,000 prompt tokens of scoped diff per reviewer");
    expect(rendered).toContain("5,000 across 5 reviewers");
  });

  test("says the estimate is an estimate, every time", () => {
    expect(renderScopeEstimate("abcd", 1)).toContain("an estimate, not a measurement");
  });

  test("with no reviewer count it declines to multiply rather than assuming one", () => {
    const rendered = renderScopeEstimate("a".repeat(400), 0);
    expect(rendered).toContain("reviewer count not supplied");
    expect(rendered).not.toContain("across 0 reviewers");
  });
});

describe("costFrom", () => {
  test("nothing reported is undefined, not a zeroed record", () => {
    expect(costFrom({})).toBeUndefined();
    expect(costFrom({ inputTokens: undefined, outputTokens: undefined, spentUsd: undefined })).toBeUndefined();
  });

  test("a reported zero IS a measurement and survives", () => {
    expect(costFrom({ inputTokens: 0 })).toEqual({ input_tokens: 0 });
  });

  test("each half is independent", () => {
    expect(costFrom({ outputTokens: 12 })).toEqual({ output_tokens: 12 });
    expect(costFrom({ spentUsd: 1.5 })).toEqual({ spent_usd: 1.5 });
  });
});

describe("renderCostPerFinding", () => {
  test("an unreported cost says so, and says it is not zero", () => {
    const lines = renderCostPerFinding(undefined, 3).join("\n");
    expect(lines).toContain("cost: not recorded");
    expect(lines).toContain("NOT zero");
  });

  test("tokens per retained finding", () => {
    const lines = renderCostPerFinding({ input_tokens: 440_000, output_tokens: 10_000 }, 5).join("\n");
    expect(lines).toContain("tokens: 450,000");
    expect(lines).toContain("per retained finding: 90,000 tokens");
  });

  test("dollars per retained finding, to four places", () => {
    const lines = renderCostPerFinding({ spent_usd: 1.23 }, 4).join("\n");
    expect(lines).toContain("per retained finding: 0.3075 USD");
  });

  test("REGRESSION — a small-but-real cost never prints as a bare zero", () => {
    // `0` in this package means somebody measured zero. Rounding 2/10 down to
    // it said the round was free one line under `tokens: 2`.
    const tokens = renderCostPerFinding({ input_tokens: 2 }, 10).join("\n");
    expect(tokens).toContain("tokens: 2");
    expect(tokens).toContain("per retained finding: < 1 token");
    expect(tokens).not.toContain("per retained finding: 0 tokens");

    const usd = renderCostPerFinding({ spent_usd: 0.00001 }, 10).join("\n");
    expect(usd).toContain("per retained finding: < 0.0001 USD");
    expect(usd).not.toContain("per retained finding: 0.0000 USD");
  });

  test("BOUNDARY — a genuinely zero cost still prints zero", () => {
    // The guard above must not turn a measured zero into `< 1`.
    expect(renderCostPerFinding({ input_tokens: 0 }, 10).join("\n")).toContain("per retained finding: 0 tokens");
  });

  test("a round that retained nothing reports the bill, not an infinity", () => {
    const lines = renderCostPerFinding({ input_tokens: 38_000 }, 0).join("\n");
    expect(lines).toContain("tokens: 38,000");
    expect(lines).toContain("retained findings: 0");
    expect(lines).toContain("only the bill");
    expect(lines).not.toContain("Infinity");
  });
});
