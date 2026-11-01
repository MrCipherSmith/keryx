import { expect, test } from "bun:test";
import { resetEntropyGateForTests, setEntropyBackendEnabledForTests } from "./entropy-gate";
import { validateOutputForTransport } from "./output-validation";
import { validateSerializedOutput } from "./service";

const PROVIDER_SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const FORMAT_UNSAFE_TEXT = "Output withheld: format-unsafe";

test("JSON validation masks string secrets without changing safe scalar types", () => {
  const result = validateOutputForTransport({
    format: "json",
    value: {
      id: PROVIDER_SECRET,
      metric: PROVIDER_SECRET,
      publicId: "release-20260906-123456789012345",
      numericId: "123456789012345",
      metricValue: "0.00001234",
      samples: 123456789012345,
      score: 0.00001234,
      ready: true,
    },
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "metric", "publicId", "numericId", "metricValue", "samples", "score", "ready"],
      properties: {
        id: { type: "string" },
        metric: { type: "string" },
        publicId: { type: "string" },
        numericId: { type: "string" },
        metricValue: { type: "string" },
        samples: { type: "number" },
        score: { type: "number" },
        ready: { type: "boolean" },
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({
    id: "[REDACTED:secret]",
    metric: "[REDACTED:secret]",
    publicId: "release-20260906-123456789012345",
    numericId: "123456789012345",
    metricValue: "0.00001234",
    samples: 123456789012345,
    score: 0.00001234,
    ready: true,
  });
  expect(JSON.parse(result.text)).toEqual(result.value);
  expect(result.redaction).toEqual({
    state: "redacted",
    reasons: ["secrets.aws-access-key"],
  });
  expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET);
});

test("sensitive field context masks an otherwise generic string credential", () => {
  const credential = "synthetic-password-value";
  const result = validateOutputForTransport({
    format: "json",
    value: { password: credential, tokenCount: 42 },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({
    password: "[REDACTED:secret]",
    tokenCount: 42,
  });
  expect(result.redaction).toEqual({
    state: "redacted",
    reasons: ["secrets.sensitive-field"],
  });
  expect(result.text).not.toContain(credential);
});

test("text stays plain while a JSON string scalar stays JSON quoted", () => {
  const value = `credential ${PROVIDER_SECRET}`;
  const textResult = validateOutputForTransport({ value, format: "text" });
  const jsonResult = validateOutputForTransport({ value, format: "json" });

  expect(textResult.ok).toBe(true);
  expect(jsonResult.ok).toBe(true);
  if (!textResult.ok || !jsonResult.ok) return;
  expect(textResult.value).toBe("credential [REDACTED:secret]");
  expect(textResult.text).toBe("credential [REDACTED:secret]");
  expect(jsonResult.value).toBe("credential [REDACTED:secret]");
  expect(jsonResult.text).toBe('"credential [REDACTED:secret]"');
});

test("the mandatory text floor neutralizes auto-fetch images but preserves public links", () => {
  const image = "Render ![chart](https://metrics.example.org/render.png) now";
  const link = "Read [the documentation](https://docs.example.org/guide) now";
  const imageResult = validateOutputForTransport({ value: image, format: "text" });
  const linkResult = validateOutputForTransport({ value: link, format: "text" });

  expect(imageResult.ok).toBe(true);
  expect(linkResult.ok).toBe(true);
  if (!imageResult.ok || !linkResult.ok) return;
  expect(imageResult.text).toBe("Render ![chart]([REDACTED:url]) now");
  expect(imageResult.redaction).toEqual({
    state: "redacted",
    reasons: ["egress.markdown-image-exfil"],
  });
  expect(linkResult.text).toBe(link);
  expect(linkResult.redaction).toEqual({ state: "none", reasons: [] });
});

test("a numeric credential field fails closed without leaking its value", () => {
  const result = validateOutputForTransport({
    format: "json",
    value: { password: 123456789 },
    schema: {
      type: "object",
      required: ["password"],
      additionalProperties: false,
      properties: { password: { type: "number" } },
    },
  });

  expect(result).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: {
      state: "format-unsafe",
      reasons: ["sensitive-numeric-field"],
    },
  });
  expect(JSON.stringify(result)).not.toContain("123456789");
});

test("unsupported schema keywords and incompatible safe values fail closed", () => {
  const unsupported = validateOutputForTransport({
    format: "json",
    value: { value: "safe" },
    schema: { type: "object", oneOf: [{ type: "object" }] },
  });
  const incompatible = validateOutputForTransport({
    format: "json",
    value: { token: PROVIDER_SECRET },
    schema: {
      type: "object",
      required: ["token"],
      additionalProperties: false,
      properties: { token: { enum: [PROVIDER_SECRET] } },
    },
  });

  expect(unsupported).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: {
      state: "format-unsafe",
      reasons: ["schema.unsupported-keyword"],
    },
  });
  expect(incompatible).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: {
      state: "format-unsafe",
      reasons: ["schema.validation-failed"],
    },
  });
  expect(JSON.stringify(incompatible)).not.toContain(PROVIDER_SECRET);
});

test("non-JSON values and non-string text values fail closed", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const result of [
    validateOutputForTransport({ value: cyclic, format: "json" }),
    validateOutputForTransport({ value: Number.POSITIVE_INFINITY, format: "json" }),
    validateOutputForTransport({ value: { message: "safe" }, format: "text" }),
  ]) {
    expect(result.ok).toBe(false);
    expect(result.text).toBe(FORMAT_UNSAFE_TEXT);
    expect(result.redaction.state).toBe("format-unsafe");
  }
});

test("secret-bearing property names fail closed instead of bypassing the floor", () => {
  const result = validateOutputForTransport({
    value: { [PROVIDER_SECRET]: "safe" },
    format: "json",
  });

  expect(result).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: {
      state: "format-unsafe",
      reasons: ["sensitive-property-name"],
    },
  });
  expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET);
});

// The bytes are returned only when they are canonically equivalent to the
// structure the walk validated. A duplicate member is extra tokens, so the
// canonical serialization is emitted instead and the dropped value is gone —
// which is what T24 F-002 asked for. policies.md requires the safe part to be
// RETURNED redacted whenever it preserves the operation schema, so a refusal
// here would itself be the defect.
test("duplicate serialized members cannot restore hidden secret bytes", () => {
  const serialized = `{"token":"${PROVIDER_SECRET}","token":"safe"}`;
  const result = validateSerializedOutput(serialized);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).not.toBe(serialized);
  expect(JSON.parse(result.text)).toEqual({ token: "[REDACTED:secret]" });
  expect(result.redaction.state).toBe("redacted");
  expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET);
});

// T24R#F-001 (a): the dropped value is JSON-escaped, so the raw-text detectors
// see nothing at all. Structural equivalence does not depend on recognizing it.
test("a JSON-escaped duplicate member cannot restore hidden secret bytes", () => {
  const escaped = `{"a":"AKIA\\u0049OSFODNN7EXAMPLE","a":"safe"}`;
  const fullyEscaped = `{"a":"\\u0041\\u004bIAIOSFODNN7EXAMPLE","a":"safe"}`;

  for (const serialized of [escaped, fullyEscaped]) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text)).toEqual({ a: "safe" });
    expect(result.redaction.state).toBe("redacted");
    expect(result.text).not.toContain(PROVIDER_SECRET);
    expect(result.text).not.toContain("\\u0049");
    expect(result.text).not.toContain("\\u004b");
  }
});

// T24R#F-001 (b): the dropped value is sensitive only by field context, and the
// surviving value is empty / null / false so no detector fires on the parsed
// structure either.
test("a duplicate credential member cannot survive an empty, null or false survivor", () => {
  const credential = "tr0ub4dor-correct-horse";
  const shapes: Array<[string, unknown]> = [
    [`{"pwd":"${credential}","pwd":""}`, { pwd: "" }],
    [`{"api_key":"${credential}","api_key":null}`, { api_key: null }],
    [`{"secret":"${credential}","secret":false}`, { secret: false }],
  ];

  for (const [serialized, canonical] of shapes) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text)).toEqual(canonical);
    expect(result.redaction.state).toBe("redacted");
    expect(JSON.stringify(result)).not.toContain(credential);
  }
});

// T24R#F-003: a raw-text span straddling the member separator hides nothing —
// the walk already saw every scalar it covers. The serialized path must reach
// the same answer as the identical parsed value, not refuse it.
test("a serialized payload with a safe representation is redacted, never refused", () => {
  const value = { docs: "https://example.com", note: "ping@host.example" };
  const serializedResult = validateSerializedOutput(JSON.stringify(value));
  const parsedResult = validateOutputForTransport({ value, format: "json" });

  expect(serializedResult.ok).toBe(true);
  expect(parsedResult.ok).toBe(true);
  if (!serializedResult.ok || !parsedResult.ok) return;
  expect(serializedResult.text).toBe(parsedResult.text);
  expect(serializedResult.redaction).toEqual(parsedResult.redaction);
  expect(serializedResult.redaction.state).toBe("redacted");
});

// The preserved half of the contract: canonically equivalent bytes come back
// byte-for-byte, compact or pretty-printed, and non-JSON text is untouched.
test("canonically equivalent serialized bytes are preserved byte-for-byte", () => {
  const value = { id: "safe-id", count: 12, ok: true, nothing: null, ratio: 1.25 };
  const compact = JSON.stringify(value);
  const pretty = JSON.stringify(value, null, 2);
  const plain = "plain report line with no json";

  for (const serialized of [compact, pretty]) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(serialized);
    expect(result.redaction).toEqual({ state: "none", reasons: [] });
  }
  expect(validateSerializedOutput(plain).text).toBe(plain);
});

// A structure with no safe representation is still refused, and a duplicate
// member does not help it through.
test("serialized structures with no safe representation still fail closed", () => {
  for (const serialized of [
    `{"password":1234,"password":1}`,
    `{"${PROVIDER_SECRET}":"x","b":1}`,
    `{"AKIA\\u0049OSFODNN7EXAMPLE":"x","b":1}`,
  ]) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(false);
    expect(result.text).toBe(FORMAT_UNSAFE_TEXT);
    expect(result.redaction.state).toBe("format-unsafe");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET);
    expect(JSON.stringify(result)).not.toContain("1234");
  }
});

// T24R2#F-002: canonical re-serialization is lossy for a numeric literal outside
// IEEE-754 double range, so substituting it corrupted a snowflake id, an int64
// key or a nanosecond epoch. policies.md line 20 reserves `format-unsafe` for a
// structure with NO safe representation; here one exists — the original bytes,
// which are a faithful spelling of the structure the walk already approved — so
// the floor must return them, not a different number and not a refusal.
test("an out-of-double-range integer literal survives byte-exactly", () => {
  const shapes = [
    `{"n":12345678901234567890}`,
    `{"rows":[{"id":9007199254740993}]}`,
    `{"a":{"b":{"epochNs":1725631234567890123}}}`,
  ];

  for (const serialized of shapes) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(serialized);
    expect(result.redaction).toEqual({ state: "none", reasons: [] });
  }
  expect(validateSerializedOutput(`{"n":12345678901234567890}`).text).toContain("7890}");
});

test("negative zero keeps its sign instead of being re-emitted as zero", () => {
  const result = validateSerializedOutput(`{"delta":-0,"other":[-0]}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe(`{"delta":-0,"other":[-0]}`);
  expect(result.redaction).toEqual({ state: "none", reasons: [] });
});

// T24R2#F-003: a rewrite that removes nothing must not claim a redaction. Python
// `json.dumps` and Go `encoding/json` emit these spellings by default, and 22 of
// this repository's own JSON files were being relabelled because of it.
test("value-preserving spellings are preserved and never reported as a redaction", () => {
  const shapes = [
    `{"dash":"em \\u2014 dash","quote":"it\\u2019s"}`,
    `{"a":"https:\\/\\/docs.example.org/x"}`,
    `{"coveragePrecision":1.0}`,
    `{"n":1e3}`,
    `{"b":1,"10":2,"2":3}`,
    `{"\\u00e9":1,"a":2}`,
  ];

  for (const serialized of shapes) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(serialized);
    expect(result.redaction).toEqual({ state: "none", reasons: [] });
  }
});

// The rule that closed the hidden-byte class must not be weakened by the rule
// that preserves spelling: a duplicate member is still not the structure the
// walk validated, whatever its spelling, padding, depth or survivor.
test("a faithfully spelled duplicate member is still replaced by the canonical form", () => {
  const credential = "tr0ub4dor-correct-horse";
  const shapes = [
    `{"a":"${PROVIDER_SECRET}","a":"safe"}`,
    `{"\\u0061":"${PROVIDER_SECRET}","a":"safe"}`,
    `{ "k" : "${PROVIDER_SECRET}" , "k" : "safe" }`,
    `{"a":{"b":{"c":{"d":"${credential}","d":"safe"}}}}`,
    `[{"k":"${credential}","k":"safe"}]`,
    `{"n":12345678901234567890,"n":1}`,
  ];

  for (const serialized of shapes) {
    const result = validateSerializedOutput(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toBe(serialized);
    expect(result.redaction.state).toBe("redacted");
    expect(result.redaction.reasons).toContain("serialized-content-normalized");
    expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET);
    expect(JSON.stringify(result)).not.toContain(credential);
  }
});

// The scanner walks the bytes in lockstep with the validated structure, so the
// insignificant whitespace the old textual rule stripped must still round-trip,
// and a member the structure does not have must still lose preservation.
test("surrounding and inter-token whitespace is still preserved, extra members are not", () => {
  const padded = validateSerializedOutput(`  {"a": 1, "b": [ 2, 3 ] }\n`);
  expect(padded.ok).toBe(true);
  if (!padded.ok) return;
  expect(padded.text).toBe(`  {"a": 1, "b": [ 2, 3 ] }\n`);
  expect(padded.redaction).toEqual({ state: "none", reasons: [] });

  const extra = validateSerializedOutput(`{"a":1,"a":1}`);
  expect(extra.ok).toBe(true);
  if (!extra.ok) return;
  expect(extra.text).toBe(`{"a":1}`);
  expect(extra.redaction.state).toBe("redacted");
});

test("$ref siblings are rejected until the validator can enforce them", () => {
  const result = validateOutputForTransport({
    value: "short",
    format: "json",
    schema: {
      $defs: { base: { type: "string" } },
      $ref: "#/$defs/base",
      minLength: 20,
    },
  });

  expect(result).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: {
      state: "format-unsafe",
      reasons: ["schema.unsupported-reference-siblings"],
    },
  });
});

// GDCTX-2: `exemptExfil` lets a caller that has already resolved a
// (policyId, source) override (`guard.ts#redactRaw`) leave a specific
// `detectExfil` match unmasked, in both the text and JSON paths this module
// serves. Absent, behavior is unchanged (every prior test above passes no
// `exemptExfil` and still masks every exfil match it finds).
test("exemptExfil (text): an exempted match is left unmasked, others are not", () => {
  const value = '<img src="https://example.com/badge.svg"> and <img src="https://other.com/x.png">';
  const result = validateOutputForTransport({
    value,
    format: "text",
    exemptExfil: (match) => match.value === "https://example.com/badge.svg",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toContain("https://example.com/badge.svg");
  expect(result.text).not.toContain("https://other.com/x.png");
  expect(result.text).toContain("[REDACTED:url]");
});

test("exemptExfil (text): exempting the only finding produces state:none, byte-identical text", () => {
  const value = '<img src="https://example.com/badge.svg">';
  const result = validateOutputForTransport({
    value,
    format: "text",
    exemptExfil: () => true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe(value);
  expect(result.redaction).toEqual({ state: "none", reasons: [] });
});

test("exemptExfil never exempts a secret/PII match, only exfil ones", () => {
  const value = `token = ${PROVIDER_SECRET} <img src="https://example.com/badge.svg">`;
  const result = validateOutputForTransport({
    value,
    format: "text",
    exemptExfil: () => true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).not.toContain(PROVIDER_SECRET);
  expect(result.text).toContain("https://example.com/badge.svg");
});

test("exemptExfil (json): applies inside nested string values too", () => {
  const result = validateOutputForTransport({
    value: { badge: "https://example.com/badge.svg embedded via <img src=\"https://example.com/badge.svg\">" },
    format: "json",
    exemptExfil: (match) => match.value === "https://example.com/badge.svg",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.stringify(result.value)).toContain("https://example.com/badge.svg");
});

// review-logic-slice-36:F-001: the floor ran secrets/PII/exfil only, so a token
// that only the entropy pass recognises left it raw — alone (the empty-match early
// return) or next to an exempted exfil match (the `applyRedaction(value, matches)`
// branch, which never had entropy spans).
const ENTROPY_ONLY_URL =
  "https://api.example.com/webhooks/K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
const ENTROPY_TOKEN = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";

test("the floor masks a token only the entropy detector recognises", () => {
  setEntropyBackendEnabledForTests(true);
  try {
    const result = validateOutputForTransport({ value: `hook: ${ENTROPY_ONLY_URL}`, format: "text" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain(ENTROPY_TOKEN);
    expect(result.text).toContain("[REDACTED:entropy]");
    expect(result.redaction).toEqual({ state: "redacted", reasons: ["secrets.high-entropy"] });

    const serialized = validateSerializedOutput(JSON.stringify({ hook: ENTROPY_ONLY_URL }));
    expect(serialized.text).not.toContain(ENTROPY_TOKEN);
  } finally {
    resetEntropyGateForTests();
  }
});

test("an exfil exemption never drops entropy coverage from the same string", () => {
  setEntropyBackendEnabledForTests(true);
  try {
    const value = `<img src="https://example.com/badge.svg"> ${ENTROPY_ONLY_URL}`;
    const result = validateOutputForTransport({ value, format: "text", exemptExfil: () => true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("https://example.com/badge.svg");
    expect(result.text).not.toContain(ENTROPY_TOKEN);
  } finally {
    resetEntropyGateForTests();
  }
});

// review-backend-slice-36:F-003: a JSON number was never screened, so a card
// number carried as a number (or as a bare digit-only payload) left unmasked.
const CARD = 4111111111111111;

test("a card number carried as a JSON number fails closed without leaking it", () => {
  const result = validateOutputForTransport({ value: { cardNumber: CARD }, format: "json" });
  expect(result).toEqual({
    ok: false,
    text: FORMAT_UNSAFE_TEXT,
    redaction: { state: "format-unsafe", reasons: ["sensitive-numeric-value"] },
  });
  const nested = validateSerializedOutput(`{"items":[1,${CARD}]}`);
  expect(nested.ok).toBe(false);
  expect(nested.text).not.toContain(String(CARD));
});

test("a bare digit-only payload is screened as text", () => {
  const result = validateSerializedOutput(String(CARD));
  expect(result.ok).toBe(true);
  expect(result.text).not.toContain(String(CARD));
  expect(result.text).toContain("[REDACTED:cc]");
});

test("ordinary JSON numbers pass the number screen unchanged", () => {
  const value = {
    count: 42,
    port: 8080,
    // Luhn-valid by chance: a millisecond epoch is not a card (no network starts with 1).
    createdAt: 1730000000126,
    epochSeconds: 1730000000,
    userId: 123456789012345,
    ratio: 0.5,
    big: 1e21,
    negative: -17,
    phoneLike: 4155552671,
  };
  const content = JSON.stringify(value);
  const result = validateSerializedOutput(content);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe(content);
  expect(result.redaction).toEqual({ state: "none", reasons: [] });
  expect(validateSerializedOutput("8080").text).toBe("8080");
});
