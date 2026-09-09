# T19 Implementation Spec — Core Structural Output Validation

## Scope

Implement the deterministic, pure core seam used by later guard and MCP adapters. This task owns `src/security/output-validation.ts`, its focused tests, and narrowly required detector corrections in `src/security/detect/secrets.ts` and `src/security/detect/exfil.ts`. It does not wire the helper into `guard.ts`, `service.ts`, MCP dispatch, or recursive scan code.

## Public contract

`validateOutputForTransport(input)` accepts:

- `value: unknown`
- `format: "json" | "text"`
- optional schema data as `Record<string, unknown>`

It exports `OutputTransportFormat`, `OutputRedaction`, `OutputValidationInput`, and the discriminated `OutputValidationResult`.

Success returns `{ ok: true, value, text, redaction }`. JSON mode preserves the original JSON-compatible shape and scalar types while replacing sensitive string spans. Text mode accepts a string and returns the redacted string as both `value` and `text`. JSON string scalars remain JSON-quoted in `text`.

Failure returns `{ ok: false, text, redaction: { state: "format-unsafe", reasons } }`. Failure text is a fixed constant and reasons contain only policy/category tokens. Neither can include the rejected value, a raw secret, or a fingerprint.

## Structural classification

- Walk arrays and plain objects recursively without serializing first.
- Detect secret and PII spans in every string leaf, independent of its field name, and apply existing fixed-width masks.
- Preserve safe booleans, nulls, finite numbers, decimal metrics, numeric IDs, and safe strings byte-for-byte.
- Reject a numeric value under a sensitive credential key because replacing it with a string would change its representation.
- Reject cyclic values, non-plain objects, non-finite numbers, bigint, symbol, function, and undefined as format-unsafe.
- Keep reasons deterministic, deduplicated, and leak-safe.

## Schema handling

Use the existing `validateAgainstSchema` implementation only after recursively screening the supplied schema. Support only the subset the existing validator actually enforces: `type`, `enum`, `minimum`, `maximum`, `minLength`, `pattern`, `format: "date-time"`, `required`, `properties`, `additionalProperties`, `items`, local `#/$defs/*` references, and the existing registered security schema references. Annotation keys `$schema`, `$id`, and `title` are accepted but make no validation claim.

Unsupported keywords, malformed supported keywords, unsupported formats/types/references, invalid regex patterns, unresolved references, and a redacted value that fails the supported schema all fail closed as format-unsafe. `uniqueItems` is unsupported because the current validator does not enforce it.

## Detector corrections

- Add deterministic secret matching for sensitive URL query values and explicit sensitive path segments; redact only the value span.
- Treat Markdown images and HTML images as auto-fetch exfil surfaces. Ordinary Markdown links are not an egress operation; existing `detectEgress` continues to classify actual send instructions and URL policy violations.
- Preserve existing prompt-injection and provider-pattern secret rules.

## Test plan

1. RED: pure JSON validation preserves safe numeric fields while masking provider-pattern secrets under benign field names.
2. RED: numeric credential fields, unsupported schema constructs, schema-incompatible masks, and non-JSON values return the constant format-unsafe result without leaking rejected data.
3. RED: text and JSON-string modes use the correct serialization form.
4. RED: sensitive URL query/path values are masked; public Markdown links are ignored by exfil detection while auto-fetch images remain findings.
5. GREEN: run only `src/security/output-validation.test.ts`, `src/security/structural-detection.test.ts`, and existing focused detector tests affected by the changes.
6. Verify targeted ESLint and TypeScript without running the global test suite.

## Constraints

No network, model, dependency, package, lockfile, git, flow-state, service, guard, MCP, or recursive-scanner changes. Fixtures are synthetic and local.
