import { expect, test } from "bun:test";
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
