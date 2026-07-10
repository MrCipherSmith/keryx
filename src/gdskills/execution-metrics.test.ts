import { expect, test } from "bun:test";
import { EXECUTION_METRICS_RULE_PATH, ensureExecutionMetricsOptIn } from "./execution-metrics";

test("inserts the execution metrics gate after YAML frontmatter", () => {
  const skill = `---
name: example
description: Example skill.
---

# Example
`;

  const result = ensureExecutionMetricsOptIn(skill);

  expect(result).toContain(`---\n\n<!-- keryx:execution-metrics:begin -->`);
  expect(result).toContain(EXECUTION_METRICS_RULE_PATH);
  expect(result.indexOf("# Example")).toBeGreaterThan(result.indexOf("keryx:execution-metrics:end"));
});

test("execution metrics gate injection is idempotent", () => {
  const skill = "---\nname: example\n---\n\n# Example\n";
  const once = ensureExecutionMetricsOptIn(skill);

  expect(ensureExecutionMetricsOptIn(once)).toBe(once);
});

test("a reference-only mention does not suppress the managed start gate", () => {
  const skill = `---
name: example
---

Read \`${EXECUTION_METRICS_RULE_PATH}\` during final reporting.
`;

  const result = ensureExecutionMetricsOptIn(skill);

  expect(result).toContain("keryx:execution-metrics:begin");
  expect(result.indexOf("keryx:execution-metrics:begin")).toBeLessThan(result.indexOf("during final reporting"));
});
