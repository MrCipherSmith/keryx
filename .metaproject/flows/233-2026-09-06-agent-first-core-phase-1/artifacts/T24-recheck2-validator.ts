// T24 recheck 2 — pure-validator probes for Stage 1 rows 1, 2, 3 and 5.
// Read-only. Synthetic credentials only (AKIA + IOSFODNN7EXAMPLE assembled at
// runtime, and `tr0ub4dor-correct-horse`), reserved example/invalid domains.
import {
  validateOutputForTransport,
  validateSerializedContentForTransport,
} from "../../../../src/security/output-validation";

const S = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CRED = "tr0ub4dor-correct-horse";
const ATT = "attacker.invalid";
const CONSTANT = "Output withheld: format-unsafe";

type V = {
  ok: boolean;
  state: string;
  reasons: string[];
  text: string;
  constantText: boolean;
  leaksSecret: boolean;
  leaksCred: boolean;
  leaksHost: boolean;
};

function j(value: unknown, schema?: Record<string, unknown>): V {
  const r = validateOutputForTransport(
    schema === undefined
      ? { value, format: "json" }
      : { value, format: "json", schema },
  );
  const whole = JSON.stringify(r);
  return {
    ok: r.ok,
    state: r.redaction.state,
    reasons: r.redaction.reasons,
    text: r.text,
    constantText: r.text === CONSTANT,
    leaksSecret: whole.includes(S),
    leaksCred: whole.includes(CRED),
    leaksHost: whole.includes(ATT),
  };
}

function s(content: string): V & { bytesRestored: boolean; input: string } {
  const r = validateSerializedContentForTransport(content);
  const whole = JSON.stringify(r);
  return {
    ok: r.ok,
    state: r.redaction.state,
    reasons: r.redaction.reasons,
    text: r.text,
    constantText: r.text === CONSTANT,
    leaksSecret: whole.includes(S),
    leaksCred: whole.includes(CRED),
    leaksHost: whole.includes(ATT),
    bytesRestored: r.ok && r.text === content,
    input: content,
  };
}

// ───────────────────────── ROW 1 — secret / PII in a property name ──────────
const f001 = {
  // must fail closed, key never renamed
  topLevelSecretKey: j({ [S]: "safe" }),
  nestedSecretKey: j({ rows: [{ meta: { [S]: 1 } }] }),
  deepArraySecretKey: j([[{ [S]: true }]]),
  emailKey: j({ "ping@host.example": "x" }),
  urlCredentialKey: j({ "https://user:pw@host.example/x": 1 }),
  imgTagKey: j({ [`<img src="https://${ATT}/p">`]: 1 }),
  // key only sensitive after JSON unescaping — the parsed key is decoded
  escapedSecretKeySerialized: s(`{"AKIA\\u0049OSFODNN7EXAMPLE":"safe"}`),
  // the key must never come back renamed/masked anywhere in the result
  keyNeverRenamed: (() => {
    const r = validateOutputForTransport({ value: { [S]: "safe" }, format: "json" });
    return {
      ok: r.ok,
      hasValue: "value" in r,
      textIsConstant: r.text === CONSTANT,
      wholeResult: JSON.stringify(r),
      containsRedactedMarker: JSON.stringify(r).includes("REDACTED"),
    };
  })(),
  // approved-contract controls that must keep passing
  ctlDigitKeys: j({ user_id_12345: "a", buildNumber7: 7 }),
  ctlNumericStringKeys: j({ "1234567890": "a", "17251234567": 1 }),
  ctlPasswordKeyValue: j({ password: "hunter" }),
  ctlPasswordKeyNumeric: j({ password: 123456789 }),
  ctlPathKey: j({ "src/security/output-validation.ts": 1 }),
  ctlEnvKey: j({ AWS_REGION: "eu-west-1" }),
  ctlPublicUrlKey: j({ "https://docs.example.org/guide": 1 }),
};

// ───────────────────────── ROW 2 — duplicate serialized members ─────────────
const ESCAPED = "AKIA\\u0049OSFODNN7EXAMPLE";
const FULLY_ESCAPED =
  "\\u0041\\u004b\\u0049\\u0041\\u0049\\u004f\\u0053\\u0046\\u004f\\u0044\\u004e\\u004e\\u0037\\u0045\\u0058\\u0041\\u004d\\u0050\\u004c\\u0045";

const f002 = {
  // the five shapes the first recheck enumerated
  plainDuplicate: s(`{"a":"${S}","a":"safe"}`),
  escapedDuplicate: s(`{"a":"${ESCAPED}","a":"safe"}`),
  fullyEscapedDuplicate: s(`{"a":"${FULLY_ESCAPED}","a":"safe"}`),
  credEmptySurvivor: s(`{"pwd":"${CRED}","pwd":""}`),
  credNullSurvivor: s(`{"api_key":"${CRED}","api_key":null}`),
  credBooleanSurvivor: s(`{"secret":"${CRED}","secret":false}`),

  // new duplicate shapes this recheck adds
  duplicateNested: s(`{"outer":{"k":"${S}","k":"safe"}}`),
  duplicateInArray: s(`[{"k":"${CRED}","k":"safe"}]`),
  duplicateObjectSurvivor: s(`{"k":"${S}","k":{"inner":"safe"}}`),
  duplicateArraySurvivor: s(`{"k":"${S}","k":[]}`),
  duplicateThreeWay: s(`{"k":"${S}","k":"${CRED}","k":"safe"}`),
  // the DROPPED member's KEY is spelled with an escape while the survivor is plain
  duplicateEscapedKeySpelling: s(`{"\\u006b":"${S}","k":"safe"}`),
  // duplicate whose dropped value is hidden behind whitespace padding
  duplicateWithWhitespace: s(`{ "k" : "${S}" , "k" : "safe" }`),
  // duplicate where the survivor makes the object fail closed anyway
  duplicateSurvivorNumericCredential: s(`{"password":"${CRED}","password":1}`),
  duplicateSecretKey: s(`{"${S}":"x","${S}":"y"}`),

  // ── attacks on canonical re-serialization itself ────────────────────────
  // can canonicalization LOSE or ALTER meaning?
  bigIntegerPrecision: s(`{"n":12345678901234567890}`),
  negativeZero: s(`{"n":-0}`),
  exponentSpelling: s(`{"n":1e3}`),
  trailingZeroDecimal: s(`{"n":1.0}`),
  integerLikeKeyOrder: s(`{"b":1,"10":2,"2":3}`),
  escapeSpelling: s(`{"a":"\\u0041"}`),
  solidusEscape: s(`{"a":"https:\\/\\/docs.example.org/x"}`),
  protoKey: s(`{"__proto__":{"a":1}}`),
  unicodeKeyOrder: s(`{"\\u00e9":1,"a":2}`),
  // deep nesting + duplicate at depth
  deepDuplicate: s(`{"a":{"b":{"c":{"d":"${S}","d":"safe"}}}}`),

  // ── byte preservation controls ──────────────────────────────────────────
  ctlCleanCompact: s(`{"id":"safe-id","count":12,"ok":true,"nothing":null,"ratio":1.25}`),
  ctlCleanPretty: s(
    JSON.stringify({ id: "safe-id", count: 12, ok: true, nothing: null, ratio: 1.25 }, null, 2),
  ),
  ctlCleanPretty4: s(JSON.stringify({ a: [1, 2, { b: "c" }] }, null, 4)),
  ctlCleanTabIndent: s(JSON.stringify({ a: [1, 2, { b: "c" }] }, null, "\t")),
  ctlNonJsonText: s(`this is not JSON at all, just prose about ${"safe"} things`),
  ctlNonJsonTextWithSecret: s(`the key is ${S} in prose`),
  ctlTopLevelString: s(`"just a json string"`),
  ctlTopLevelNumber: s(`42`),
  ctlEmptyObject: s(`{}`),
  ctlEmptyArray: s(`[]`),

  // ── row 5 — no new false rejection ──────────────────────────────────────
  urlThenEmailAcrossMembers: s(
    JSON.stringify({ docs: "https://example.com", note: "ping@host.example" }),
  ),
  urlThenEmailParsedDirect: j({ docs: "https://example.com", note: "ping@host.example" }),
  repoThenOwner: s(JSON.stringify({ repo: "https://github.com/o/r", owner: "a@b.example" })),
  linkThenContact: s(
    JSON.stringify({ link: "https://docs.example.org", contact: "team@corp.example" }),
  ),
  emailThenUrl: s(JSON.stringify({ email: "x@y.example", url: "https://z.example" })),
  requiredAllowedAndRedacted: s(JSON.stringify({ metric: S, count: 123456789 })),

  // ── T19 contract points that must not regress ───────────────────────────
  ctlNumericUnderCredentialKey: s(`{"password":123456789}`),
  ctlSecretPropertyName: s(`{"${S}":"x"}`),
  ctlOwnUndefined: j({ a: undefined }),
  ctlCycle: (() => {
    const a: Record<string, unknown> = {};
    a.self = a;
    return j(a);
  })(),
  ctlNonFinite: j({ n: Number.POSITIVE_INFINITY }),
};

// ───────────────────────── ROW 3 — $ref siblings ────────────────────────────
const base = { $defs: { base: { type: "string" } } };
const f003 = {
  refPlusMinLength: j("short", { ...base, $ref: "#/$defs/base", minLength: 20 }),
  refPlusType: j("ok", { ...base, $ref: "#/$defs/base", type: "string" }),
  refPlusPattern: j("ok", { ...base, $ref: "#/$defs/base", pattern: "^z" }),
  refPlusEnum: j("ok", { ...base, $ref: "#/$defs/base", enum: ["a"] }),
  refPlusFormat: j("ok", { ...base, $ref: "#/$defs/base", format: "date-time" }),
  refPlusRequired: j({ a: 1 }, { $defs: { base: { type: "object" } }, $ref: "#/$defs/base", required: ["zz"] }),
  refSiblingNestedInProperties: j(
    { a: "short" },
    { $defs: { base: { type: "string" } }, type: "object", properties: { a: { $ref: "#/$defs/base", minLength: 20 } } },
  ),
  refSiblingNestedInItems: j(["short"], {
    $defs: { base: { type: "string" } },
    type: "array",
    items: { $ref: "#/$defs/base", minLength: 20 },
  }),
  refSiblingInsideDefs: j("ok", {
    $defs: { base: { type: "string" }, other: { $ref: "#/$defs/base", minLength: 20 } },
    $ref: "#/$defs/base",
  }),
  refSiblingInAdditionalProperties: j(
    { a: "short" },
    { $defs: { base: { type: "string" } }, type: "object", additionalProperties: { $ref: "#/$defs/base", minLength: 20 } },
  ),
  // must still PASS
  ctlBareRefValid: j("ok", { $ref: "#/$defs/base", ...base }),
  ctlBareRefInvalidValue: j(123, { $ref: "#/$defs/base", ...base }),
  ctlRefPlusAnnotations: j("ok", {
    ...base,
    $ref: "#/$defs/base",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:x",
    title: "T",
  }),
  // unresolvable ref keeps its own reason and no attacker text
  ctlUnresolvableRef: j("ok", { $ref: "#/$defs/does-not-exist", ...base }),
  ctlAttackerNamedRef: (() => {
    const attacker = `${S}-${ATT}-leak-me`;
    const r = validateOutputForTransport({
      value: "ok",
      format: "json",
      schema: { $ref: `#/$defs/${attacker}`, $defs: { base: { type: "string" } } },
    });
    const whole = JSON.stringify(r);
    return {
      ok: r.ok,
      state: r.redaction.state,
      reasons: r.redaction.reasons,
      text: r.text,
      constantText: r.text === CONSTANT,
      leaks: whole.includes(attacker) || whole.includes(S) || whole.includes(ATT),
    };
  })(),
  ctlForeignRef: j("ok", { $ref: "https://evil.example/schema.json" }),
  ctlExternalAllowedRef: j({ any: 1 }, { $ref: "security-finding.schema.json" }),
};

const { writeFileSync } = await import("node:fs");
const out = process.argv[2] ?? "/tmp/T24-recheck2-validator.json";
writeFileSync(out, JSON.stringify({ f001, f002, f003 }, null, 2));

// compact console verdicts so the evidence survives ctx compaction
const line = (id: string, v: { ok: boolean; state: string; reasons: string[] }) =>
  `${id}\tok=${v.ok}\tstate=${v.state}\treasons=${v.reasons.join("|")}`;
console.log("== ROW1 property names ==");
for (const [k, v] of Object.entries(f001)) {
  if ("state" in (v as object)) console.log(line(k, v as never));
}
console.log(`keyNeverRenamed.containsRedactedMarker=${f001.keyNeverRenamed.containsRedactedMarker} hasValue=${f001.keyNeverRenamed.hasValue}`);
console.log("== ROW2 serialized ==");
for (const [k, v] of Object.entries(f002)) {
  const x = v as never as { ok: boolean; state: string; reasons: string[]; bytesRestored?: boolean; leaksSecret: boolean; leaksCred: boolean; text: string };
  console.log(
    `${line(k, x)}\tbytesRestored=${x.bytesRestored ?? "n/a"}\tleaksSecret=${x.leaksSecret}\tleaksCred=${x.leaksCred}`,
  );
}
console.log("== ROW3 schema refs ==");
for (const [k, v] of Object.entries(f003)) console.log(line(k, v as never));
console.log(`ctlAttackerNamedRef.leaks=${f003.ctlAttackerNamedRef.leaks}`);
console.log(`wrote ${out}`);
