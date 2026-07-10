import { expect, test } from "bun:test";
import { detectEntropy } from "./entropy";

test("does NOT flag a PascalCase identifier near an 'api' substring (the reported FP)", () => {
  // `...VariablesApi` puts "api" in the label window before `PipelineVariablesStore`,
  // a 22-char alpha token — previously a false positive.
  const input = "import { PipelineVariablesApi, PipelineVariablesStore } from './x'";
  expect(detectEntropy(input)).toEqual([]);
});

test("does NOT flag long snake_case / SCREAMING constants (no digit / base64 symbol)", () => {
  expect(detectEntropy("const MAXIMUM_ALLOWED_RETRY_ATTEMPTS_KEY = 5")).toEqual([]);
});

test("STILL flags a real high-entropy secret with digits near a label", () => {
  const input = "api_key = 'AKIAIOSFODNN7EXAMPLE0123'";
  const matches = detectEntropy(input);
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(matches[0]?.policyId).toBe("secrets.high-entropy");
});

test("STILL flags a base64-looking token (has = / digits) near a label", () => {
  const input = "secret: dGhpc2lzYVZlcnlMb25nc2VjcmV0VmFsdWU9PQ==";
  expect(detectEntropy(input).length).toBeGreaterThanOrEqual(1);
});

test("does not flag a high-entropy token with no sensitive label nearby", () => {
  expect(detectEntropy("random blob QWxhZGRpbjpvcGVuIHNlc2FtZTEyMw")).toEqual([]);
});
