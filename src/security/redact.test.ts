import { afterEach, describe, expect, test } from "bun:test";
import { redactSensitiveText } from "./redact";
import { resetEntropyGateForTests, setEntropyBackendEnabledForTests } from "./entropy-gate";

// F3: tool output is scrubbed before it enters provider-bound agent history, so a
// command that reads a credential does not leak the raw value into the model
// context. These lock the redactor's behaviour on representative secrets.

test("F3: an AWS access key in tool output is redacted", () => {
  const out = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n";
  const scrubbed = redactSensitiveText(out);
  expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(scrubbed).toContain("[REDACTED:");
});

test("F3: a GitHub token in tool output is redacted", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const scrubbed = redactSensitiveText(`token=${token}`);
  expect(scrubbed).not.toContain(token);
  expect(scrubbed).toContain("[REDACTED:");
});

// keryx session 4a24a760: a `cat`-style read of the provider credential store
// reached the transcript with one key masked and the other printed in full. The
// masked one merely happened to carry an `sk-` prefix; the JSON assignment form
// itself was never recognised, so ANY key without a known prefix was published.
test("F3: every key in a JSON credential store is redacted, not just prefixed ones", () => {
  const zai = "7ab31d0c62f94e8ab5c1739de28f406b.Kq3nZt7vXb1mR9wa";
  // Deliberately not key-shaped beyond the prefix: the point is only that a
  // recognised prefix is what the provider-shaped rules key on. A hex body here
  // trips push protection on a fixture that is not a credential at all.
  const deepseek = "sk-fixture-value-not-a-real-credential";
  const authJson = [
    "{",
    '  "provider": "deepseek",',
    `  "apiKeys": {`,
    `    "DEEPSEEK_API_KEY": "${deepseek}",`,
    `    "ZAI_API_KEY": "${zai}"`,
    "  }",
    "}",
  ].join("\n");

  const scrubbed = redactSensitiveText(authJson);

  expect(scrubbed).not.toContain(zai);
  expect(scrubbed).not.toContain(deepseek);
  // The key NAMES stay readable — the operator must still see which credential
  // was involved; only the values are masked.
  expect(scrubbed).toContain("ZAI_API_KEY");
  expect(scrubbed).toContain("DEEPSEEK_API_KEY");
});

test("F3: a quoted YAML-style credential assignment is redacted", () => {
  const value = "7ab31d0c62f94e8ab5c1739de28f406b";
  const scrubbed = redactSensitiveText(`AUTH_TOKEN: "${value}"`);
  expect(scrubbed).not.toContain(value);
});

test("F3: benign output is returned unchanged (no false positives on plain text)", () => {
  const out = "total 4\ndrwxr-xr-x  2 user group 4096 Jan  1 00:00 src\n";
  expect(redactSensitiveText(out)).toBe(out);
});

test("F3: empty output is a no-op", () => {
  expect(redactSensitiveText("")).toBe("");
});

describe("the case redactSensitiveText's own contract names", () => {
  // Its doc comment says it exists so that "a contained shell command that
  // reads a credential (`cat ~/.aws/credentials`, `env`) must not leak the raw
  // value into the model context and onward to the provider". Both forms of
  // that exact file went through untouched until 2026-09-09: the uppercase
  // env-assignment rule only matched names ENDING in SECRET/API_KEY/TOKEN, and
  // `AWS_SECRET_ACCESS_KEY` ends in ACCESS_KEY — while the file itself writes
  // the name in lower case, which that rule could not match in any form.
  const value = "Kq3nZ8vTt1cLpR7yWx0bA5dGf2HjMn6QsUv9Ye4Z";

  test("the credentials file, as the file actually writes it", () => {
    const text = `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${value}\n`;
    expect(redactSensitiveText(text)).not.toContain(value);
  });

  test("the environment variable, as `env` prints it", () => {
    expect(redactSensitiveText(`AWS_SECRET_ACCESS_KEY=${value}`)).not.toContain(value);
  });

  test("an OAuth client secret", () => {
    expect(redactSensitiveText("client_secret: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  test("prose and identifiers are left alone", () => {
    // A redactor that mangles legitimate text gets turned off, so the lowercase
    // rule is a short list of names that mean one thing rather than a
    // case-insensitive sweep for the word "secret".
    const prose = "the secret access key is stored elsewhere";
    expect(redactSensitiveText(prose)).toBe(prose);
    const code = 'const secretAccessKeyName = "aws";';
    expect(redactSensitiveText(code)).toBe(code);
  });
});

describe("S-6 (flow 355, AC2): the entropy detector runs after the pattern pass", () => {
  test("an opaque 43-char base64 bearer token with no named shape is redacted", () => {
    const token = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    const scrubbed = redactSensitiveText(`Authorization: Bearer ${token}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain("[REDACTED:entropy]");
  });

  test("an UNLABELLED 40-hex git commit SHA is left untouched", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const text = `commit ${sha} landed`;
    expect(redactSensitiveText(text)).toBe(text);
  });

  test("an UNLABELLED UUID is left untouched", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const text = `request id: ${uuid}`;
    expect(redactSensitiveText(text)).toBe(text);
  });

  test("an UNLABELLED npm/yarn sha512- integrity string is left untouched", () => {
    const integrity = "sha512-9WYDliBTiEXPIkZ5Zc32qJ6b7QP2b6m5v2kDEe57lecTulaDIuNTPy3Ry4G==";
    const text = `resolved "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz", integrity ${integrity}`;
    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe("F-REG-F3 (flow 355 review, PR #776): honours backends.entropy.enabled", () => {
  afterEach(() => {
    resetEntropyGateForTests();
  });

  test("entropy stays off: an opaque bearer token is NOT redacted when the backend is disabled", () => {
    setEntropyBackendEnabledForTests(false);
    const token = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    const text = `Authorization: Bearer ${token}`;
    expect(redactSensitiveText(text)).toBe(text);
  });

  test("entropy on: the SAME opaque bearer token is redacted when the backend is enabled", () => {
    setEntropyBackendEnabledForTests(true);
    const token = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    const scrubbed = redactSensitiveText(`Authorization: Bearer ${token}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain("[REDACTED:entropy]");
  });

  test("a NAMED pattern (not entropy) is still redacted regardless of the entropy gate", () => {
    setEntropyBackendEnabledForTests(false);
    const scrubbed = redactSensitiveText("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("F-SEC-F2 (flow 355 review, PR #776): a label overrides an allow-shape", () => {
  test("a LABELLED 40-hex SHA is redacted", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const scrubbed = redactSensitiveText(`leaked api_key: ${sha}`);
    expect(scrubbed).not.toContain(sha);
    expect(scrubbed).toContain("[REDACTED:entropy]");
  });

  test("a LABELLED UUID is redacted", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const scrubbed = redactSensitiveText(`leaked credential: ${uuid}`);
    expect(scrubbed).not.toContain(uuid);
  });

  // SEC-F2 (flow 355 review round 2, residual): `bareShapeQualifies`'s own
  // 3.6-bit entropy floor used to run BEFORE the label was consulted at all,
  // so a labelled UUID's redaction depended on whether its own hex digits
  // happened to repeat enough to clear the floor — the canonical RFC 4122
  // example UUID (entropy 3.39) did not. Test with a representative sample,
  // not one hand-picked value that happens to clear the floor by luck.
  test("the canonical RFC 4122 example UUID (below the entropy floor) is redacted when labelled", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const scrubbed = redactSensitiveText(`leaked credential: ${uuid}`);
    expect(scrubbed).not.toContain(uuid);
    expect(scrubbed).toContain("[REDACTED:entropy]");
  });

  // TEST-F1 (flow 355 review round 3): this used to draw 20 UNSEEDED
  // `crypto.randomUUID()` values and assert `not.toContain(uuid)` on the
  // labelled half — a real detector, but the WRONG one, could also make that
  // assertion pass: `pii.credit-card`'s Luhn check is unrelated to this
  // file's entropy.ts diff, yet a random UUID's digit run can occasionally
  // pass it, replacing the value with `[REDACTED:cc]` instead of
  // `[REDACTED:entropy]` and producing a red run roughly one time in four.
  // Fixed two ways: (1) 20 FIXED UUIDs, committed here, so the sample is
  // deterministic across every run — no more "reproduced once in 4 runs";
  // (2) the next test asserts, ONCE, that none of these 20 fixtures trips
  // `pii.credit-card` on their own — a canary against silent drift in that
  // UNRELATED detector's regex re-poisoning this fixture again — and this
  // test itself asserts only the ENTROPY/secret redaction marker, not a
  // looser "the raw value is gone" check that any detector could satisfy.
  const FIXED_UUIDS = [
    "f7813ab3-5012-4e71-9fc3-653d498cb79d",
    "6c2b6eca-918c-44c6-b77c-d10199ba8114",
    "2de6d562-dd32-4bdc-be9a-603eb11bcb67",
    "994c28cd-08ba-4a06-be4e-5a58878c7a75",
    "92a31105-a47e-4e04-a6e1-1bfa185c4125",
    "2dde8c83-4283-4ce7-aa76-fcde8f62306e",
    "76f73ce0-7b6e-44c4-ab6f-c8829c58ec40",
    "a834a3f9-9eac-454d-9424-836004a20fd8",
    "2a84e5d4-2134-4fd0-b283-b3b68f3fb20a",
    "d5d35dca-25f2-44e9-a94f-8913bd365d79",
    "f25a18d6-6e9f-4625-b936-6d37ae1c047a",
    "f4923350-97ec-45be-8413-e4aa36276bef",
    "e67a368b-8490-471a-9132-ea48e1e3cd30",
    "08069024-779a-4bec-9b70-7016ec4c6f2f",
    "4d58e4d7-341b-42b4-8f08-206dd318431a",
    "dfa0b7ce-f0d7-4723-92d7-7e04b3f0d0f0",
    "531b2d3f-b8b6-4879-bc1e-d9d7a2a462cd",
    "f358768a-4e70-4162-91db-67582e6b4a9a",
    "a122e415-ffdf-4f11-9ba7-c784094ab844",
    "e63aca54-e1e7-4096-9849-b02155b89efd",
  ];

  test("canary: none of the 20 fixed UUID fixtures trips the UNRELATED pii.credit-card detector on its own", () => {
    for (const uuid of FIXED_UUIDS) {
      const scrubbed = redactSensitiveText(`request id: ${uuid}`);
      expect(scrubbed).not.toContain("[REDACTED:cc]");
    }
  });

  test("20 fixed UUIDs: ALL redacted with the entropy marker when labelled, NONE redacted when unlabelled", () => {
    for (const uuid of FIXED_UUIDS) {
      const labelled = redactSensitiveText(`leaked credential: ${uuid}`);
      expect(labelled).toBe(`leaked credential: [REDACTED:entropy]`);
      const unlabelled = redactSensitiveText(`request id: ${uuid}`);
      expect(unlabelled).toBe(`request id: ${uuid}`);
    }
  });

  test("a LABELLED sha512- integrity-shaped string is redacted", () => {
    const integrity = "sha512-9WYDliBTiEXPIkZ5Zc32qJ6b7QP2b6m5v2kDEe57lecTulaDIuNTPy3Ry4G==";
    const scrubbed = redactSensitiveText(`leaked auth secret: ${integrity}`);
    expect(scrubbed).not.toContain(integrity);
  });
});

describe("SEC-F3 (flow 355 review round 3): no slug exemption survives adjacency to a real label", () => {
  test("the reviewer's exact input — a word-slug-with-hex-tail secret IS redacted when labelled", () => {
    const scrubbed = redactSensitiveText("leaked api_key: log-report-deadbeef01234567");
    expect(scrubbed).toBe("leaked api_key: [REDACTED:entropy]");
  });

  test("the same value, UNLABELLED, is unchanged (accepted residual, see findings.md S-8)", () => {
    const text = "log-report-deadbeef01234567 appeared in the log";
    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe("F-LOG-F1 (flow 355 review, PR #776): URLs are decomposed, not joined into one run", () => {
  test("a commit-detail URL with a SHA in the path passes through unchanged", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const url = `https://api.github.com/repos/o/r/commits/${sha}`;
    expect(redactSensitiveText(url)).toBe(url);
  });

  test("a secret-free webhook URL passes through unchanged (no 'api' hostname false label)", () => {
    const url = "https://api.example.com/webhooks/abc";
    expect(redactSensitiveText(url)).toBe(url);
  });

  test("an opaque secret as a URL path segment is still redacted", () => {
    const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    const scrubbed = redactSensitiveText(`https://api.example.com/webhooks/${secret}`);
    expect(scrubbed).not.toContain(secret);
  });

  // Review round 2: the coordinator's own probe found these two exact URLs
  // still redacted — see `detect/entropy.ts`'s header for the root cause
  // (a versioned filename evaluated whole; a `+`-joined query never split).
  test("BOUNDARY (review round 2) — an npm tarball URL with a version number is untouched", () => {
    const url = "https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz";
    expect(redactSensitiveText(url)).toBe(url);
  });

  test("BOUNDARY (review round 2) — a plus-joined multi-word search query is untouched", () => {
    const url = "https://www.google.com/search?q=bun+test+timeout+flaky";
    expect(redactSensitiveText(url)).toBe(url);
  });
});

describe("R3 (flow 355 review round 3): LABEL=VALUE and camelCase labels, the common shapes", () => {
  const value = "kd8Fj2LmQp9xZr4TvWn7Yb3";

  test("API_KEY=… (uppercase, already worked via detectSecrets's named pattern)", () => {
    const scrubbed = redactSensitiveText(`API_KEY=${value}`);
    expect(scrubbed).not.toContain(value);
  });

  test("api_key=… (lowercase — the reported gap)", () => {
    const scrubbed = redactSensitiveText(`api_key=${value}`);
    expect(scrubbed).not.toContain(value);
    expect(scrubbed).toContain("[REDACTED:entropy]");
  });

  test('apiKey: "…" (camelCase — the second reported gap)', () => {
    const scrubbed = redactSensitiveText(`apiKey: "${value}"`);
    expect(scrubbed).not.toContain(value);
  });

  test('"api_key": "…" (JSON, already worked)', () => {
    const scrubbed = redactSensitiveText(`"api_key": "${value}"`);
    expect(scrubbed).not.toContain(value);
  });

  test("--api-key … (CLI flag, space-separated, already worked)", () => {
    const scrubbed = redactSensitiveText(`--api-key ${value}`);
    expect(scrubbed).not.toContain(value);
  });

  test("--token=… (CLI flag with '=', no separator before the label)", () => {
    const scrubbed = redactSensitiveText(`--token=${value}`);
    expect(scrubbed).not.toContain(value);
  });

  test("export OPENAI_API_KEY=… (shell export, already worked via detectSecrets)", () => {
    const scrubbed = redactSensitiveText(`export OPENAI_API_KEY=${value}`);
    expect(scrubbed).not.toContain(value);
  });

  test("Authorization: token … (header, already worked)", () => {
    const scrubbed = redactSensitiveText(`Authorization: token ${value}`);
    expect(scrubbed).not.toContain(value);
  });

  test("BOUNDARY — a genuinely low-entropy labelled value stays unmasked (the floor is not bypassed)", () => {
    const lowEntropy = `${"z".repeat(24)}1`;
    const text = `api_key=${lowEntropy}`;
    expect(redactSensitiveText(text)).toBe(text);
  });
});

// Flow 355, orchestrator probe after review round 3: the camelCase label
// boundary `(?=[A-Z])` matched lowercase letters under the `i` flag, so a
// package NAME containing a label word ("keyv", "eslint-visitor-keys") turned
// every bun.lock line naming it into a labelled line and its public integrity
// hash was redacted. Real lines from this repository's bun.lock.
test("a lockfile line whose package name contains a label word keeps its integrity hash", () => {
  const lines = [
    '    "keyv": ["keyv@5.6.0", "", { "dependencies": { "@keyv/serialize": "^1.1.1" } }, "sha512-CYDD3SOtsHtyXeEORYRx2qBtpDJFjRTGXUtmNEMGyzYOKj1TE3tycdlho7kvRmD3hEsRnDlPFJ3Ra4F2cz1Q2A=="],',
    '    "eslint-visitor-keys": ["eslint-visitor-keys@5.0.1", "", {}, "sha512-tD40eHxA35h0PEIZNeIjkHoDR4YjjJp34biM0mDvplBe//mB+IHCqHDGV7pxF+7MklTvighcCPPZC7ynWyjdTA=="],',
    // The label word ends a JSON key here, but the key names a package, not the value.
    '    "path-key": ["path-key@3.1.1", "", {}, "sha512-ecdbF0M9W1oKcB3E1vEX5wBgMAhI5UhhqnESa6vHAjRdOLnIkHPPUc9LWNDD2ZBnlSnaWvbuMfnqz8Ul1pk0A=="],',
  ];
  for (const line of lines) expect(redactSensitiveText(line)).toBe(line);
  // BOUNDARY: an adjacent label still overrides the allow-shape (F-SEC-F2).
  expect(redactSensitiveText("leaked token: 503c20c60ceb7755c389a6ce0ed7756b0537037a")).toContain("[REDACTED");
  // BOUNDARY: a real camelCase label still counts.
  expect(redactSensitiveText('apiKey: "kd8Fj2LmQp9xZr4TvWn7Yb3"')).not.toContain("kd8Fj2LmQp9xZr4TvWn7Yb3");
});
