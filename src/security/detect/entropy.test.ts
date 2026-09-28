import { describe, expect, test } from "bun:test";
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
  // LOG-F1 (flow 355 review round 2): the label must be ADJACENT to the
  // value now, not merely present somewhere in the same-line window — see
  // this file's header — so the label here sits right next to the value.
  const matches = detectEntropy("api_key: AKIAIOSFODNN7EXAMPLE0123.ts");
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

test("does NOT flag an UNLABELLED 40-hex git commit SHA", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"; // 40 hex chars
  expect(sha.length).toBe(40);
  expect(detectEntropy(`commit ${sha} landed`)).toEqual([]);
});

test("does NOT flag an UNLABELLED UUID", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  expect(detectEntropy(`request id: ${uuid}`)).toEqual([]);
});

test("does NOT flag an UNLABELLED npm/yarn sha512- integrity string", () => {
  const integrity = "sha512-9WYDliBTiEXPIkZ5Zc32qJ6b7QP2b6m5v2kDEe57lecTulaDIuNTPy3Ry4G==";
  expect(detectEntropy(`resolved "https://registry.npmjs.org/x/-/x-1.0.0.tgz", integrity ${integrity}`)).toEqual([]);
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

// --- flow 355 review round (PR #776), F-SEC-F2: a label overrides an allow-shape ---

test("F-SEC-F2: a LABELLED 40-hex SHA IS redacted — the label overrides the allow-shape", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const matches = detectEntropy(`leaked token: ${sha}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(sha);
});

test("F-SEC-F2: a LABELLED UUID IS redacted", () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const matches = detectEntropy(`leaked credential: ${uuid}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(uuid);
});

test("F-SEC-F2: a LABELLED sha512- integrity-shaped string IS redacted", () => {
  const integrity = "sha512-9WYDliBTiEXPIkZ5Zc32qJ6b7QP2b6m5v2kDEe57lecTulaDIuNTPy3Ry4G==";
  const matches = detectEntropy(`leaked auth secret: ${integrity}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(integrity);
});

// --- flow 355 review round (PR #776), F-LOG-F1: URLs are decomposed, not joined ---

test("F-LOG-F1: a real commit-detail URL with a SHA in the path is NOT redacted", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const url = `https://api.github.com/repos/o/r/commits/${sha}`;
  expect(detectEntropy(url)).toEqual([]);
});

test("F-LOG-F1: a secret-free webhook URL is NOT redacted (no 'api' hostname false label)", () => {
  const url = "https://api.example.com/webhooks/abc";
  expect(detectEntropy(url)).toEqual([]);
});

test("F-LOG-F1: an opaque high-entropy value AS A PATH SEGMENT is still caught", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  const url = `https://api.example.com/webhooks/${secret}`;
  const matches = detectEntropy(url);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(secret);
});

test("F-LOG-F1: an opaque high-entropy QUERY VALUE is caught regardless of the param name", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  const matches = detectEntropy(`https://x.example/c?d=${secret}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(secret);
});

test("F-LOG-F1: a versioned tarball filename in a URL path is NOT redacted (dots re-guarded)", () => {
  // Below the URL-component 20-char floor either way, but pinned so a future
  // change to that floor does not quietly start flagging package filenames.
  expect(detectEntropy("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz")).toEqual([]);
});

// --- flow 355 review round (PR #776), F-REG-F3: digits-only is never a hex blob ---

test("F-REG-F3: a 24-digit numeric id near a label is NOT flagged (no a-f letter)", () => {
  const id = "123456789012345678901234";
  expect(id.length).toBe(24);
  expect(detectEntropy(`order api_key ref ${id}`)).toEqual([]);
});

test("F-REG-F3: a 30-digit numeric id is NOT flagged", () => {
  const id = "123456789012345678901234567890";
  expect(detectEntropy(`token: ${id}`)).toEqual([]);
});

test("F-REG-F3: BOUNDARY — a 32-char hex token (has a-f letters) is still flagged", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  const matches = detectEntropy(`token: ${hex}`);
  expect(matches.length).toBe(1);
});

test("looksSecretShaped: the label-free shape check a URL path segment can use (S-9)", () => {
  expect(looksSecretShaped("0123456789abcdef0123456789abcdef")).toBe(true); // 32-hex blob
  expect(looksSecretShaped("users")).toBe(false);
  expect(looksSecretShaped("0123456789abcdef0123456789abcdef01234567")).toBe(false); // allow-shaped (git SHA)
  expect(looksSecretShaped("123456789012345678901234")).toBe(false); // F-REG-F3: digits-only, 24 chars
});

// --- flow 355 review round 3: LABEL=VALUE and camelCase labels ------------
//
// Pre-existing on `main`, found squarely inside what S-6 promises: a
// LABELLED `key=value` secret was not redacted. See this file's header for
// the two separate root causes (`=` inside `TOKEN`'s class fusing the label
// into the candidate; camelCase having no boundary character at all) and
// their fixes (`LABEL_ASSIGNMENT_RE`; `SENSITIVE_LABEL`'s new
// uppercase-lookahead trailing boundary).

test("R3: lowercase 'key=value' (no prior mechanism covered this at all)", () => {
  const value = "kd8Fj2LmQp9xZr4TvWn7Yb3";
  const matches = detectEntropy(`api_key=${value}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(value);
});

test("R3: a CLI flag with '=' and no separator before it ('--token=…')", () => {
  const value = "kd8Fj2LmQp9xZr4TvWn7Yb3";
  const matches = detectEntropy(`--token=${value}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(value);
});

test("R3: camelCase label before a colon ('apiKey: \"…\"')", () => {
  const value = "kd8Fj2LmQp9xZr4TvWn7Yb3";
  const matches = detectEntropy(`apiKey: "${value}"`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(value);
});

test("R3: does NOT regress the PascalCase-identifier false positive the trailing-boundary change touches", () => {
  // `PipelineVariablesApi` — the ORIGINAL false positive `SENSITIVE_LABEL`'s
  // boundary check exists to fix. Its "Api" sits on the LEADING side against
  // an alphanumeric character ("s"), which the new trailing-side uppercase
  // lookahead does not touch.
  const input = "import { PipelineVariablesApi, PipelineVariablesStore } from './x'";
  expect(detectEntropy(input)).toEqual([]);
});

test("R3 BOUNDARY — a genuinely low-entropy labelled value still stays unmasked", () => {
  // Repeats a single non-hex letter: entropy ~0.24, far below the 3.6 floor,
  // and not hex-blob shaped ('z' is outside 0-9a-f) — proves the label fix
  // did not quietly lower or bypass the entropy floor itself.
  const lowEntropy = `${"z".repeat(24)}1`;
  expect(detectEntropy(`api_key=${lowEntropy}`)).toEqual([]);
});

// --- flow 355 review round 2, second pass: SEC-F1, REG-F1, SEC-F2 ---------

describe("SEC-F1 (flow 355 review round 2): isWordSlug no longer exempts a re-segmented secret", () => {
  test("a real secret re-chunked into single-character-class pieces is STILL caught", () => {
    const secret = "aK9dQ2rN7zVbT4pXeYfWmC1oLaHsJtU8";
    const segmented = "aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8";
    expect(looksSecretShaped(secret)).toBe(true);
    expect(looksSecretShaped(segmented)).toBe(true);
    const scrubbed = detectEntropy(`leaked api_key: ${segmented}`);
    expect(scrubbed.length).toBe(1);
    expect(scrubbed[0]?.value).toBe(segmented);
  });

  test("the 'natural-looking' variant (a word-wrapped scrambled-case letters+digits run) is STILL caught", () => {
    const wrapped = "log-abcdefghijklmnopqrstuvwxyzAB1234-id";
    const matches = detectEntropy(`https://x.example/${wrapped}`);
    expect(matches.length).toBe(1);
    expect(matches[0]?.value).toBe(wrapped);
  });

  test("does NOT regress the existing slug fixtures", () => {
    // Kebab-case doc slugs.
    expect(detectEntropy("ADR-0008-interactive-shell-delegate-risk-gate.md")).toEqual([]);
    // A pip/uv wheel filename's platform/version tags (cp311, x86_64…).
    expect(
      detectEntropy(
        "https://files.pythonhosted.org/packages/py3/n/numpy/numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.whl",
      ),
    ).toEqual([]);
    // A `+`-joined multi-word search query.
    expect(detectEntropy("https://www.google.com/search?q=bun+test+timeout+flaky")).toEqual([]);
  });
});

describe("REG-F1 (flow 355 review round 2): a kebab slug ending in a 10-16-hex id is a public post id", () => {
  test("the exact Medium URL linked from this repo's own docs fetches/redacts as ordinary", () => {
    const url =
      "https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9";
    expect(detectEntropy(url)).toEqual([]);
  });

  test("a Gist-style '<slug>-<hex-id>' URL is not flagged", () => {
    const url = "https://gist.github.com/someuser/keryx-audit-remediation-notes-3a9bae9ec8f9";
    expect(detectEntropy(url)).toEqual([]);
  });
});

describe("SEC-F2 (flow 355 review round 2, residual): a labelled UUID is redacted regardless of its own entropy", () => {
  test("the canonical RFC 4122 example UUID (entropy 3.39, below the 3.6 floor) IS redacted when labelled", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const matches = detectEntropy(`leaked credential: ${uuid}`);
    expect(matches.length).toBe(1);
    expect(matches[0]?.value).toBe(uuid);
  });

  test("20 random UUIDs: ALL redacted when labelled, NONE redacted when unlabelled", () => {
    for (let i = 0; i < 20; i += 1) {
      const uuid = crypto.randomUUID();
      const labelled = detectEntropy(`leaked credential: ${uuid}`);
      expect(labelled.length).toBe(1);
      expect(labelled[0]?.value).toBe(uuid);
      const unlabelled = detectEntropy(`request id: ${uuid}`);
      expect(unlabelled).toEqual([]);
    }
  });
});

test("R3 — the coordinator's own 'low-entropy' example is actually maximal-entropy and IS caught", () => {
  // `abcdefghijklmnopqrstuvwx12345678` LOOKS sequential/low-complexity to a
  // human, but Shannon entropy only sees a probability distribution over
  // characters, not their ORDER: all 32 characters here are DISTINCT, so its
  // entropy is exactly log2(32) = 5 — the maximum a 32-character string can
  // have, comfortably above the 3.6 floor. This is the SAME `bareShapeQualifies`
  // every other value in this file goes through; nothing was added to force
  // this one, and nothing was added to spare it either.
  const value = "abcdefghijklmnopqrstuvwx12345678";
  const matches = detectEntropy(`token=${value}`);
  expect(matches.length).toBe(1);
  expect(matches[0]?.value).toBe(value);
});
