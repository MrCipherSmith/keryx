import { expect, test } from "bun:test";
import { detectEntropy, looksSecretShaped } from "./entropy";

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

// --- review 2026-07-26, finding B-03: redactor false positives on real paths --

test("does NOT flag a filesystem path near a sensitive label (the `/` shape gate)", () => {
  // `src/security/detect/entropy` is 27 chars of slashes and letters. Accepting
  // `/` as a secret-shaped character made every path ≥20 chars a candidate.
  expect(detectEntropy("the key file is src/security/detect/entropy.ts")).toEqual([]);
  expect(detectEntropy("api docs at docs/decisions/keryx-harness/index")).toEqual([]);
});

test("does NOT flag an ADR filename slug even with a version-like digit segment", () => {
  expect(detectEntropy("ADR-0008-interactive-shell-delegate-risk-gate.md")).toEqual([]);
  expect(detectEntropy("token: ADR-0008-interactive-shell-delegate-risk-gate.md")).toEqual([]);
});

test("the label window is bounded to the current line", () => {
  // The reported repro: the SAME second line was masked only when the previous
  // line happened to contain the word "credential".
  const withoutLabel = "harmless-line-here.md\ndocs/decisions/0008-shell-gate.md";
  const withLabel =
    "ADR-0007-tls-terminate-https-credential-masking.md\ndocs/decisions/0008-shell-gate.md";

  expect(detectEntropy(withoutLabel)).toEqual(detectEntropy(withLabel));
  expect(detectEntropy(withLabel)).toEqual([]);
});

test("a label on the current line still applies", () => {
  const sameLine = "unrelated preamble\napi_key = 'AKIAIOSFODNN7EXAMPLE0123'";
  expect(detectEntropy(sameLine).length).toBeGreaterThanOrEqual(1);
});

// --- keryx session 4a24a760 (2026-08-19): a live API key survived redaction ---

test("masks a dotted composite credential across its WHOLE span", () => {
  // The Z.AI key shape: 32 hex + "." + 16 alnum. Splitting on `.` left the tail
  // (below the 20-char floor) unexamined, so half the key was published.
  const key = "7ab31d0c62f94e8ab5c1739de28f406b.Kq3nZt7vXb1mR9wa";
  const matches = detectEntropy(`  "ZAI_API_KEY": "${key}"`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(key);
});

test("masks a long hex credential whose entropy sits below the 3.6 floor", () => {
  // 24 hex chars over 6 distinct symbols → ~2.59 bits, under the generic floor.
  // A 32-char hex key averages ~3.7, so which real keys cleared the floor came
  // down to how their own digits happened to repeat.
  const key = "1111222233334444aaaabbbb";
  const matches = detectEntropy(`api_key = '${key}'`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(key);
});

test("a hex blob with NO sensitive label on the line is still not a secret", () => {
  expect(detectEntropy("commit 1111222233334444aaaabbbb landed")).toEqual([]);
});

test("dots cannot assemble a candidate out of short segments", () => {
  expect(detectEntropy("key: build.output.filename.resolved")).toEqual([]);
});

test("a short file extension is not absorbed into a secret span", () => {
  const matches = detectEntropy("api_key file AKIAIOSFODNN7EXAMPLE0123.ts");
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe("AKIAIOSFODNN7EXAMPLE0123");
});

test("STILL flags a hyphenated token whose segments are alphanumeric, not words", () => {
  // The word-slug guard must not swallow real credentials that happen to carry
  // hyphens: every segment here is mixed alphanumeric, so it is not a slug.
  const input = "secret = xoxb-A1b2C3d4E5f6-G7h8I9j0K1l2-MnOpQ7rStU9vWxYz";
  expect(detectEntropy(input).length).toBeGreaterThanOrEqual(1);
});

// --- flow 355 (audit remediation 2), S-6 / AC2: allow-shapes ---------------

test("does NOT flag a 40-hex git commit SHA even right next to a sensitive label", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"; // 40 hex chars
  expect(sha.length).toBe(40);
  expect(detectEntropy(`api_key file: ${sha}`)).toEqual([]);
});

test("does NOT flag a UUID even right next to a sensitive label", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  expect(detectEntropy(`credential id: ${uuid}`)).toEqual([]);
});

test("does NOT flag an npm/yarn sha512- integrity string even near a sensitive label", () => {
  const integrity = `sha512-${"A".repeat(50)}==`;
  expect(detectEntropy(`auth integrity="${integrity}"`)).toEqual([]);
});

test("STILL flags an opaque high-entropy bearer token with no named shape", () => {
  // The AC2 positive case: a random-looking base64 bearer token near "auth".
  const token = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(token.length).toBe(43);
  const matches = detectEntropy(`Authorization: Bearer ${token}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(token);
  expect(matches[0]?.mask).toBe("entropy");
});

test("looksSecretShaped: the label-free shape check a URL path segment can use (S-9)", () => {
  expect(looksSecretShaped("0123456789abcdef0123456789abcdef")).toBe(true); // 32-hex blob
  expect(looksSecretShaped("users")).toBe(false);
  expect(looksSecretShaped("0123456789abcdef0123456789abcdef01234567")).toBe(false); // allow-shaped (git SHA)
});
