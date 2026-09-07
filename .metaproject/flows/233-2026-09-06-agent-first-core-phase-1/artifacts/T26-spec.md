# T26 — implementation spec for the four T24 structural-output blockers

Flow: `233-2026-09-06-agent-first-core-phase-1`
Task: T26 (`dispatches/T26-resume.json`), worker `task-implementer`
Written **before** any production edit, after confirming the RED baseline.

## RED baseline (confirmed first)

`bun src/cli.ts ctx run -- bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts`

- 14 pass, **5 fail**, 19 tests, raw log `.metaproject/data/gdctx/raw/2026-09-06T13-12-32-484Z_run.log`
- Failing (the RED set):
  1. `secret-bearing property names fail closed instead of bypassing the floor` (F-001)
  2. `duplicate serialized members cannot restore hidden secret bytes` (F-002)
  3. `$ref siblings are rejected until the validator can enforce them` (F-003)
  4. `HTML entity encoded image URLs are treated as auto-fetch exfiltration` (F-004)
  5. `every srcset candidate is checked while ordinary public links stay unchanged` (F-004)

The dispatch text expected six RED tests (4 + 2). Only **five** exist: three in
`src/security/output-validation.test.ts` and two in `src/security/detect/exfil.test.ts`.
No test was added, deleted or weakened; the count difference is reported, not repaired.

## Invariants that constrain every fix (T19 approved contract)

- The only failure text is the constant `Output withheld: format-unsafe`.
- `redaction.reasons` carry fixed policy tokens only — never the rejected value,
  a raw secret, a fingerprint, or attacker-controlled schema text.
- A safe representation that preserves the operation schema is returned with
  `redaction.state = "redacted"`; when no safe representation exists the result is
  `format-unsafe`. A field name is never an unconditional bypass.
- A public Markdown link is not a network send. Auto-fetch surfaces are.

## F-001 — secret/PII span inside a JSON property name

**Decision (from the dispatch):** never rename a key. A property name that carries a
redactable span makes the whole object unrepresentable → `format-unsafe`.

Change (`src/security/output-validation.ts`, `sanitizeJsonValue` object branch):
before recursing into a member's value, screen the member *name* with the deterministic
floor (`detectSecrets` + `detectPii` + `detectExfil`). Any span ⇒
`{ ok: false, reason: "sensitive-property-name" }`.

Exception kept identical to the value side: a purely numeric property name does not
become sensitive by digit length alone, so `pii.phone` is dropped for a numeric name.
This mirrors `isNumericContextKey`/`isNumericText` on values and the policy sentence
"safe metrics, decimal values and IDs are not masked merely by digit length"
(`docs/requirements/keryx-agent-first-core/policies.md`, Redaction). Without it, an
object keyed by ids/epoch millis would newly fail closed.

The contextual `SENSITIVE_NUMERIC_KEYS` rule is deliberately **not** applied to names:
a member literally named `password` must stay redactable-by-value (existing test), not
turn the object format-unsafe.

## F-002 — duplicate serialized members restoring hidden bytes

**Decision (from the dispatch):** do not return byte-identical serialized content unless
the original text also survives the deterministic text floor; otherwise a structurally
safe canonical serialization or `format-unsafe`. The RED test fixes the outcome for the
duplicate-member case: `format-unsafe` with reason `serialized-content-mismatch`.

A plain "did the text floor change the original?" test is not sufficient by itself: it
also fires for the ordinary `{"metric":"<secret>","count":123456789}` payload that
`persistence-sinks.test.ts` requires to stay allowed-and-redacted. The rule is therefore
stated over *accountability* of each detected span:

> Every sensitive span found in the serialized **bytes** must also be present in the
> **parsed value** (as a substring of one of its scalars rendered as text, or of one of
> its property names). A span that exists in the bytes but not in the parsed value is a
> byte the structural validator never saw ⇒ `format-unsafe`,
> reason `serialized-content-mismatch`.

- duplicate member `{"token":"<secret>","token":"safe"}` — `JSON.parse` drops the first
  value, so the secret span is present in the bytes and absent from the parsed value ⇒
  format-unsafe. (Note the current code does not leak *this* fixture, because `token` is
  a sensitive field name and the value gets contextually redacted; the probe's
  `{"metric":…}` variant is the one that leaks today. The rule closes both.)
- `{"metric":"<secret>","count":123456789}` — both the secret and the `123456789`
  (`pii.phone` on raw text) are present in the parsed value ⇒ the structural result
  governs, and the payload stays allowed with `state:"redacted"`.
- clean payloads — no spans at all ⇒ the byte-identical original is still returned.

Implementation: a new exported `validateSerializedContentForTransport(content)` in
`src/security/output-validation.ts` (the module that owns the floor), with
`validateSerializedOutput` in the owned helper region at the top of
`src/security/service.ts` delegating to it, and `redactToolOutput` in
`src/mcp/redact-seam.ts` reduced to the same call so the MCP compatibility wrapper
cannot diverge again.

## F-003 — `$ref` siblings

**Decision (from the dispatch):** enforce the siblings, or fail closed with
`schema.unsupported-reference-siblings`. The RED test fixes the token, so fail closed.

Change (`src/security/output-validation.ts`, `screenSchema`): when `$ref` is present,
any sibling other than the annotations `$schema`, `$id`, `title` and the `$defs`
container is a validation keyword that `schemas.ts:walk` silently ignores after
resolving the reference ⇒ `{ ok: false, reason: "schema.unsupported-reference-siblings" }`.

`src/security/schemas.ts` is left unchanged: every `$ref` in the repository is a bare
reference (`{ $ref: … }`), so screening at the boundary closes the class without
touching the shared validator that other modules depend on.

## F-004 — HTML-entity `src` and `srcset` auto-fetch

**Decision (from the dispatch):** canonicalize HTML character references for
classification while masking on the original offsets; enumerate every `srcset`
candidate; leave the ordinary public-link control unchanged.

Changes (`src/security/detect/exfil.ts`):

1. `decodeCharacterReferences()` — decimal (`&#58;`), hex (`&#x3a;`) and a named table
   restricted to URL syntax characters, semicolon optional, applied repeatedly (bounded)
   so `&amp;#58;` also resolves. Used **only** for classification.
2. `considerUrl()` extracts the host from the decoded form, while `start`/`end` stay on
   the raw span, so `applyRedaction` masks the original entity-encoded bytes.
3. `HTML_IMG_SRCSET` — every comma-separated candidate of an `<img … srcset="…">`
   attribute is offset-mapped inside the raw attribute value and classified with the
   existing `egress.html-image-exfil` policy id and the existing allowlist rule, so an
   allowlisted candidate stays unflagged.
4. Ordinary links keep the existing `SENSITIVE_URL_VALUE` gate — a plain public link and
   a bare public URL remain unchanged.

## Verification plan

1. Focused security/MCP suite (the exact list is reported with counts).
2. `bun run typecheck`.
3. `bunx eslint` on every changed file.
4. `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T24-stage1-probe.ts`
   must show no leak for all four findings.

## Ownership

Touched: `src/security/output-validation.ts`, `src/security/detect/exfil.ts`,
`src/mcp/redact-seam.ts`, and the `validateSerializedOutput` helper region at the top of
`src/security/service.ts`. `src/security/schemas.ts` needed no change. No test file was
modified. `guard.ts`, `path-scan.ts`, `dispatch.ts` and the scan/runGate part of
`service.ts` were read only.
