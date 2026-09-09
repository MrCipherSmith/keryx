import { detectPii } from "./detect/pii";
import { detectSecrets } from "./detect/secrets";
import { detectExfil } from "./detect/exfil";
import { applyRedaction, redactSensitiveText } from "./redact";
import { validateAgainstSchema, type JsonSchema } from "./schemas";
import type { DetectorMatch } from "./types";

export type OutputTransportFormat = "json" | "text";

export type OutputRedaction =
  | { state: "none" | "redacted"; reasons: string[] }
  | { state: "format-unsafe"; reasons: string[] };

export type OutputValidationInput = {
  value: unknown;
  format: OutputTransportFormat;
  schema?: Record<string, unknown>;
};

export type OutputValidationResult =
  | {
      ok: true;
      value: unknown;
      text: string;
      redaction: Extract<OutputRedaction, { state: "none" | "redacted" }>;
    }
  | {
      ok: false;
      text: string;
      redaction: Extract<OutputRedaction, { state: "format-unsafe" }>;
    };

export const FORMAT_UNSAFE_OUTPUT_TEXT = "Output withheld: format-unsafe";

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "pattern",
  "format",
]);

const JSON_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const EXTERNAL_SCHEMA_REFS = new Set([
  "security-finding.schema.json",
  "security-report.schema.json",
]);

const SENSITIVE_NUMERIC_KEYS = new Set([
  "apikey",
  "accesskey",
  "accesstoken",
  "authkey",
  "authtoken",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "pwd",
  "secret",
  "secretkey",
  "token",
]);

// Keywords that JSON Schema 2020-12 evaluates *alongside* `$ref`. `schemas.ts`
// resolves the reference and returns, so any sibling assertion would be silently
// dropped and a value that violates its declared schema would be transmitted
// (T24 F-003). Only annotations and the `$defs` container are safe next to a ref.
const REFERENCE_SAFE_SIBLINGS = new Set(["$ref", "$schema", "$id", "title", "$defs"]);

type SafeValueResult =
  | { ok: true; value: unknown; reasons: string[] }
  | { ok: false; reason: string };

type SchemaSupport = { ok: true } | { ok: false; reason: string };
type RedactedString = { value: string; reasons: string[] };

function failure(reason: string): OutputValidationResult {
  return {
    ok: false,
    text: FORMAT_UNSAFE_OUTPUT_TEXT,
    redaction: { state: "format-unsafe", reasons: [reason] },
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveFieldKey(key: string | undefined): boolean {
  return key !== undefined && SENSITIVE_NUMERIC_KEYS.has(normalizedKey(key));
}

function isNumericContextKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  const normalized = normalizedKey(key);
  return (
    normalized.endsWith("id") ||
    normalized.includes("metric") ||
    normalized.includes("score") ||
    normalized.includes("count") ||
    normalized.includes("sample") ||
    normalized.includes("total") ||
    normalized.includes("duration") ||
    normalized.includes("timestamp")
  );
}

function isNumericText(value: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
}

function redactString(value: string, key: string | undefined): RedactedString {
  const secretMatches = detectSecrets(value);
  const piiMatches = detectPii(value);
  const exfilMatches = detectExfil(value);
  const contextualMatches: DetectorMatch[] =
    isSensitiveFieldKey(key) && value.length > 0 && secretMatches.length === 0
      ? [
          {
            category: "secret",
            policyId: "secrets.sensitive-field",
            severity: "high",
            confidence: 0.9,
            start: 0,
            end: value.length,
            value,
            mask: "secret",
            remediation: "Keep credential fields out of transport output.",
          },
        ]
      : [];
  const matches = isNumericContextKey(key) && isNumericText(value)
    ? [
        ...secretMatches,
        ...contextualMatches,
        ...piiMatches.filter((match) => match.policyId !== "pii.phone"),
        ...exfilMatches,
      ]
    : [...secretMatches, ...contextualMatches, ...piiMatches, ...exfilMatches];

  if (matches.length === 0) {
    return { value, reasons: [] };
  }

  // Keep the established deterministic text helper as the normal redaction
  // path. The contextual numeric-ID exception needs the already-filtered spans.
  const redacted = matches.length ===
      secretMatches.length + piiMatches.length + exfilMatches.length &&
    contextualMatches.length === 0
    ? redactSensitiveText(value)
    : applyRedaction(value, matches);

  return {
    value: redacted,
    reasons: matches.map((match) => match.policyId),
  };
}

// A property name is not a value: masking it would rename the member and break the
// object's declared schema, so a recognized span inside a NAME leaves no safe
// representation and the object fails closed (T24 F-001). Field placement is never
// a bypass — the name is screened with the same deterministic floor as a value.
//
// One exception, identical to the value side: digit length alone never makes data
// sensitive (policies.md, Redaction), so a purely numeric name — an id or an epoch
// used as a map key — keeps `pii.phone` from firing. The contextual
// SENSITIVE_NUMERIC_KEYS rule is deliberately NOT applied here: a member named
// `password` must stay redactable by value, not make its object unrepresentable.
function isSensitivePropertyName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  const numeric = isNumericText(name);
  const matches: DetectorMatch[] = [
    ...detectSecrets(name),
    ...detectPii(name).filter(
      (match) => !(numeric && match.policyId === "pii.phone"),
    ),
    ...detectExfil(name),
  ];
  return matches.length > 0;
}

function sanitizeJsonValue(
  value: unknown,
  key: string | undefined,
  active: WeakSet<object>,
): SafeValueResult {
  if (value === null || typeof value === "boolean") {
    return { ok: true, value, reasons: [] };
  }
  if (typeof value === "string") {
    const redacted = redactString(value, key);
    return { ok: true, value: redacted.value, reasons: redacted.reasons };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || isSensitiveFieldKey(key)) {
      return {
        ok: false,
        reason: isSensitiveFieldKey(key)
          ? "sensitive-numeric-field"
          : "non-json-value",
      };
    }
    return { ok: true, value, reasons: [] };
  }
  if (typeof value !== "object") {
    return { ok: false, reason: "non-json-value" };
  }
  if (active.has(value)) {
    return { ok: false, reason: "cyclic-value" };
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      const reasons: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          return { ok: false, reason: "non-json-value" };
        }
        const nested = sanitizeJsonValue(value[index], undefined, active);
        if (!nested.ok) return nested;
        output.push(nested.value);
        reasons.push(...nested.reasons);
      }
      return { ok: true, value: output, reasons };
    }

    if (!isPlainRecord(value)) {
      return { ok: false, reason: "non-json-value" };
    }

    const entries: Array<[string, unknown]> = [];
    const reasons: string[] = [];
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (isSensitivePropertyName(nestedKey)) {
        return { ok: false, reason: "sensitive-property-name" };
      }
      const nested = sanitizeJsonValue(nestedValue, nestedKey, active);
      if (!nested.ok) return nested;
      entries.push([nestedKey, nested.value]);
      reasons.push(...nested.reasons);
    }
    return { ok: true, value: Object.fromEntries(entries), reasons };
  } finally {
    active.delete(value);
  }
}

function validPrimitiveEnum(values: unknown): boolean {
  return (
    Array.isArray(values) &&
    values.every(
      (value) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    )
  );
}

function screenSchema(
  schema: unknown,
  root: Record<string, unknown>,
  active: WeakSet<object>,
): SchemaSupport {
  if (!isPlainRecord(schema)) {
    return { ok: false, reason: "schema.invalid" };
  }
  if (active.has(schema)) {
    return { ok: false, reason: "schema.invalid" };
  }

  active.add(schema);
  try {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
        return { ok: false, reason: "schema.unsupported-keyword" };
      }
    }

    for (const annotation of ["$schema", "$id", "title"] as const) {
      if (schema[annotation] !== undefined && typeof schema[annotation] !== "string") {
        return { ok: false, reason: "schema.invalid" };
      }
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (
        types.length === 0 ||
        !types.every((type) => typeof type === "string" && JSON_TYPES.has(type))
      ) {
        return { ok: false, reason: "schema.unsupported-type" };
      }
    }

    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string") {
        return { ok: false, reason: "schema.invalid" };
      }
      if (schema.$ref.startsWith("#/$defs/")) {
        const name = schema.$ref.slice("#/$defs/".length);
        const definitions = root.$defs;
        if (!name || !isPlainRecord(definitions) || !isPlainRecord(definitions[name])) {
          return { ok: false, reason: "schema.unsupported-reference" };
        }
      } else if (!EXTERNAL_SCHEMA_REFS.has(schema.$ref)) {
        return { ok: false, reason: "schema.unsupported-reference" };
      }
      if (Object.keys(schema).some((key) => !REFERENCE_SAFE_SIBLINGS.has(key))) {
        return { ok: false, reason: "schema.unsupported-reference-siblings" };
      }
    }

    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((item) => typeof item === "string"))
    ) {
      return { ok: false, reason: "schema.invalid" };
    }
    if (schema.enum !== undefined && !validPrimitiveEnum(schema.enum)) {
      return { ok: false, reason: "schema.unsupported-enum" };
    }
    for (const numeric of ["minimum", "maximum"] as const) {
      if (
        schema[numeric] !== undefined &&
        (typeof schema[numeric] !== "number" || !Number.isFinite(schema[numeric]))
      ) {
        return { ok: false, reason: "schema.invalid" };
      }
    }
    if (
      schema.minLength !== undefined &&
      (typeof schema.minLength !== "number" ||
        !Number.isInteger(schema.minLength) ||
        schema.minLength < 0)
    ) {
      return { ok: false, reason: "schema.invalid" };
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") {
        return { ok: false, reason: "schema.invalid" };
      }
      try {
        new RegExp(schema.pattern);
      } catch {
        return { ok: false, reason: "schema.invalid" };
      }
    }
    if (schema.format !== undefined && schema.format !== "date-time") {
      return { ok: false, reason: "schema.unsupported-format" };
    }

    if (schema.$defs !== undefined) {
      if (!isPlainRecord(schema.$defs)) {
        return { ok: false, reason: "schema.invalid" };
      }
      for (const nested of Object.values(schema.$defs)) {
        const support = screenSchema(nested, root, active);
        if (!support.ok) return support;
      }
    }
    if (schema.properties !== undefined) {
      if (!isPlainRecord(schema.properties)) {
        return { ok: false, reason: "schema.invalid" };
      }
      for (const nested of Object.values(schema.properties)) {
        const support = screenSchema(nested, root, active);
        if (!support.ok) return support;
      }
    }
    if (schema.items !== undefined) {
      const support = screenSchema(schema.items, root, active);
      if (!support.ok) return support;
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      const support = screenSchema(schema.additionalProperties, root, active);
      if (!support.ok) return support;
    }
    return { ok: true };
  } finally {
    active.delete(schema);
  }
}

function schemaFailure(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  if (schema === undefined) return undefined;
  const support = screenSchema(schema, schema, new WeakSet());
  if (!support.ok) return support.reason;
  try {
    // The recursive screen above narrows the external record to the exact subset
    // implemented by schemas.ts before this boundary cast.
    return validateAgainstSchema(value, schema as JsonSchema).length > 0
      ? "schema.validation-failed"
      : undefined;
  } catch {
    return "schema.invalid";
  }
}

export function validateOutputForTransport(
  input: OutputValidationInput,
): OutputValidationResult {
  try {
    if (input.format === "text") {
      if (typeof input.value !== "string") {
        return failure("non-text-value");
      }
      const safe = redactString(input.value, undefined);
      const schemaReason = schemaFailure(safe.value, input.schema);
      if (schemaReason !== undefined) return failure(schemaReason);
      const reasons = uniqueSorted(safe.reasons);
      return {
        ok: true,
        value: safe.value,
        text: safe.value,
        redaction: {
          state: reasons.length > 0 ? "redacted" : "none",
          reasons,
        },
      };
    }

    const safe = sanitizeJsonValue(input.value, undefined, new WeakSet());
    if (!safe.ok) return failure(safe.reason);
    const schemaReason = schemaFailure(safe.value, input.schema);
    if (schemaReason !== undefined) return failure(schemaReason);
    const reasons = uniqueSorted(safe.reasons);
    return {
      ok: true,
      value: safe.value,
      text: JSON.stringify(safe.value),
      redaction: {
        state: reasons.length > 0 ? "redacted" : "none",
        reasons,
      },
    };
  } catch {
    return failure("validation.error");
  }
}

// A constant, value-free reason for the one case where the structure is safe but
// its serialization is not the structure: the canonical form is returned instead
// of the original bytes. It names the transformation, never the dropped content.
const SERIALIZED_NORMALIZED_REASON = "serialized-content-normalized";

// `JSON.parse` is lossy — a duplicate member drops every earlier value — so a clean
// verdict on the parsed value never speaks for the bytes it came from (T24 F-002).
// The question is therefore not "is every sensitive span in the bytes accounted
// for" (a recognizer, always weaker than the floor it stands in for, and blind to
// the escape spelling and the contextual field rules) but "are these bytes the
// structure the walk just validated".
//
// That question used to be asked of two STRINGS — the whitespace-stripped original
// against `JSON.stringify(validatedValue)` — which answered "no" for a payload that
// merely SPELLS the same structure differently, and then substituted a canonical
// form that is not always the same value. A numeric literal outside IEEE-754 double
// range came back with its low digits rewritten and `-0` came back `0`, so the floor
// altered the data it exists to protect (T24R2#F-002); and a payload spelling
// non-ASCII as `\uXXXX` — Python `json.dumps`, Go `encoding/json` — was rewritten and
// then labelled a redaction although nothing was removed (T24R2#F-003).
//
// So the question is asked of the STRUCTURE instead: walk the original bytes in
// lockstep with the validated value and require them to be a faithful spelling of
// it. Spelling is free (escapes, `1.0`, `1e3`, `-0`, member order); membership is
// not. A duplicate member is an extra member — its key has already been consumed —
// so it fails before its value is even read, whatever it holds, however it is
// escaped, padded or nested. Congruence proves every decoded key and scalar in the
// byte stream equals the corresponding member of the approved structure and that
// nothing else is present, which is strictly stronger than the string test it
// replaces. And since valid JSON can only carry more than its parse through a
// duplicate member, a congruence failure IS a dropped member — which is what makes
// the `redacted` label on the substituted canonical form truthful.
type ByteScanner = { readonly text: string; index: number };

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

const JSON_KEYWORDS = [
  ["true", true],
  ["false", false],
  ["null", null],
] as const;

function skipWhitespace(scanner: ByteScanner): void {
  while (
    scanner.index < scanner.text.length &&
    JSON_WHITESPACE.has(scanner.text[scanner.index]!)
  ) {
    scanner.index += 1;
  }
}

// The raw bytes of one string literal, quotes included, or `null` when the scanner
// is not on one. A backslash consumes the character after it, so a `\"` inside the
// literal never ends it and structure spelled inside a string is never mistaken for
// structure.
function readStringLiteral(scanner: ByteScanner): string | null {
  const { text } = scanner;
  if (text[scanner.index] !== '"') return null;
  const start = scanner.index;
  let index = scanner.index + 1;
  while (index < text.length) {
    const char = text[index]!;
    index += 1;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') {
      scanner.index = index;
      return text.slice(start, index);
    }
  }
  return null;
}

function readNumberLiteral(scanner: ByteScanner): string | null {
  const { text } = scanner;
  const start = scanner.index;
  let index = start;
  while (index < text.length && /[-+0-9.eE]/.test(text[index]!)) {
    index += 1;
  }
  if (index === start) return null;
  scanner.index = index;
  return text.slice(start, index);
}

function matchesLiteralWord(
  scanner: ByteScanner,
  word: string,
  value: unknown,
  expected: unknown,
): boolean | undefined {
  if (!scanner.text.startsWith(word, scanner.index)) return undefined;
  scanner.index += word.length;
  return expected === value;
}

function matchesObject(scanner: ByteScanner, expected: unknown): boolean {
  if (!isPlainRecord(expected)) return false;
  // A map, not property lookup: a member named `__proto__` is an own data
  // property here and must be matched as one, never through the prototype chain.
  const unmatched = new Map(Object.entries(expected));
  scanner.index += 1;
  skipWhitespace(scanner);
  if (scanner.text[scanner.index] === "}") {
    scanner.index += 1;
    return unmatched.size === 0;
  }
  for (;;) {
    skipWhitespace(scanner);
    const rawKey = readStringLiteral(scanner);
    if (rawKey === null) return false;
    let key: unknown;
    try {
      key = JSON.parse(rawKey);
    } catch {
      return false;
    }
    if (typeof key !== "string" || !unmatched.has(key)) {
      // Either a member the validated structure does not have, or the second
      // occurrence of one it does: a duplicate whose earlier value `JSON.parse`
      // dropped. Both mean these bytes are not that structure.
      return false;
    }
    const child = unmatched.get(key);
    unmatched.delete(key);
    skipWhitespace(scanner);
    if (scanner.text[scanner.index] !== ":") return false;
    scanner.index += 1;
    if (!matchesValue(scanner, child)) return false;
    skipWhitespace(scanner);
    const next = scanner.text[scanner.index];
    if (next === ",") {
      scanner.index += 1;
      continue;
    }
    if (next === "}") {
      scanner.index += 1;
      return unmatched.size === 0;
    }
    return false;
  }
}

function matchesArray(scanner: ByteScanner, expected: unknown): boolean {
  if (!Array.isArray(expected)) return false;
  scanner.index += 1;
  skipWhitespace(scanner);
  if (scanner.text[scanner.index] === "]") {
    scanner.index += 1;
    return expected.length === 0;
  }
  let position = 0;
  for (;;) {
    if (position >= expected.length) return false;
    if (!matchesValue(scanner, expected[position])) return false;
    position += 1;
    skipWhitespace(scanner);
    const next = scanner.text[scanner.index];
    if (next === ",") {
      scanner.index += 1;
      continue;
    }
    if (next === "]") {
      scanner.index += 1;
      return position === expected.length;
    }
    return false;
  }
}

function matchesValue(scanner: ByteScanner, expected: unknown): boolean {
  skipWhitespace(scanner);
  const char = scanner.text[scanner.index];
  if (char === undefined) return false;
  if (char === "{") return matchesObject(scanner, expected);
  if (char === "[") return matchesArray(scanner, expected);
  if (char === '"') {
    const raw = readStringLiteral(scanner);
    if (raw === null) return false;
    try {
      return JSON.parse(raw) === expected;
    } catch {
      return false;
    }
  }
  for (const [word, value] of JSON_KEYWORDS) {
    const verdict = matchesLiteralWord(scanner, word, value, expected);
    if (verdict !== undefined) return verdict;
  }
  const raw = readNumberLiteral(scanner);
  if (raw === null) return false;
  // Loose equality on purpose: the literal need only DENOTE the validated number,
  // so `1e3`, `1.0`, `-0` and an integer beyond double range are all faithful
  // spellings of the double the walk saw. Preserving the literal is what stops the
  // floor from emitting a different number than the one it was given.
  return typeof expected === "number" && Number(raw) === expected;
}

function bytesAreFaithfulTo(content: string, expected: unknown): boolean {
  try {
    const scanner: ByteScanner = { text: content, index: 0 };
    if (!matchesValue(scanner, expected)) return false;
    skipWhitespace(scanner);
    return scanner.index === content.length;
  } catch {
    // Fail closed to the canonical form: preservation is never the fallback.
    return false;
  }
}

/**
 * Validate serialized JSON structurally, or ordinary text without changing its
 * format. Byte preservation is decided AFTER the structural walk, by structural
 * congruence: the original bytes are returned whenever they are a faithful
 * spelling of the validated structure — same members, same values, spelling and
 * member order free. When they are not, they carry a member the structure does
 * not have (for valid JSON, a duplicate whose earlier value `JSON.parse` dropped),
 * and the safe canonical serialization is returned with `state:"redacted"`.
 * `format-unsafe` is reachable only from the walk, i.e. only when the STRUCTURE
 * itself has no safe representation. Refusing a payload whose safe part preserves
 * the operation schema is a defect, not caution (policies.md, Redaction) — and so
 * is returning a different value than the one that was validated, which is why a
 * number literal is preserved rather than re-serialized (T24R2#F-002).
 */
export function validateSerializedContentForTransport(
  content: string,
): OutputValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return validateOutputForTransport({ value: content, format: "text" });
  }
  const result = validateOutputForTransport({ value, format: "json" });
  if (!result.ok || result.redaction.state === "redacted") {
    // Unsafe structure, or a walk that already produced the canonical safe form.
    return result;
  }
  return bytesAreFaithfulTo(content, result.value)
    ? { ...result, text: content }
    : {
        ...result,
        redaction: { state: "redacted", reasons: [SERIALIZED_NORMALIZED_REASON] },
      };
}
