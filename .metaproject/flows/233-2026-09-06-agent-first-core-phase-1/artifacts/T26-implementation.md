# T26 — implementation report: the four T24 structural-output blockers

Flow `233-2026-09-06-agent-first-core-phase-1`, dispatch `233-T26`, worker `task-implementer`.
Spec written before any production edit: `T26-spec.md`.

## RED first

`bun src/cli.ts ctx run -- bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts`

- **14 pass / 5 fail**, 19 tests, 73 assertions
- raw: `.metaproject/data/gdctx/raw/2026-09-06T13-12-32-484Z_run.log`
- per-failure detail: `.metaproject/data/gdctx/raw/2026-09-06T13-12-38-987Z_run.log`

The dispatch expected six RED tests (4 in `output-validation.test.ts` + 2 in `exfil.test.ts`).
The repository contains **five**: three in `output-validation.test.ts` and two in
`exfil.test.ts`. No test was added, removed, renamed or weakened — the count is reported
as found.

## Changes

### F-001 — secret/PII span in a JSON property name (`src/security/output-validation.ts`)

`sanitizeJsonValue`'s object branch now screens each member **name** with the deterministic
floor before recursing (`isSensitivePropertyName`: `detectSecrets` + `detectPii` +
`detectExfil`). Any span ⇒ `{ ok: false, reason: "sensitive-property-name" }` ⇒ the constant
format-unsafe result. Keys are never renamed, and the rejected name never reaches
`reasons` or `text`.

Two deliberate boundaries, both documented in code:
- a purely numeric name keeps `pii.phone` from firing (digit length alone is not
  sensitive — `policies.md`, Redaction; same exception the value side already applies),
  so an object keyed by ids or epoch millis does not newly fail closed;
- the contextual `SENSITIVE_NUMERIC_KEYS` rule is **not** applied to names, so a member
  named `password` stays redactable by value (existing test unchanged).

Evidence: probe `secretPropertyName.leaked:false`, `redaction.reasons:["sensitive-property-name"]`;
MCP transport `secretPropertyNameIsError:true`, `secretPropertyNameLeaks:false`
(`.metaproject/data/gdctx/raw/2026-09-06T13-18-25-093Z_run.log`).

### F-002 — duplicate serialized members restoring hidden bytes

New `validateSerializedContentForTransport()` in `src/security/output-validation.ts`:
before the parsed verdict is allowed to speak for the original bytes, every sensitive span
found in the **serialized text** (`detectSecrets` + `detectPii` + `detectExfil`) must also
be present in the **parsed value** — as a substring of a scalar rendered as text, or of a
property name (`parsedValueAccountsForBytes` / `reachableScalarText`). A span that exists
only in the bytes is data `JSON.parse` dropped and the structural walker never saw ⇒
`format-unsafe`, reason `serialized-content-mismatch`.

Why not a bare "the text floor would change the original" test: that also fires for the
ordinary `{"metric":"<secret>","count":123456789}` payload (`123456789` matches
`pii.phone` on raw text) which `persistence-sinks.test.ts` requires to stay
allowed-and-redacted. Accountability separates the two: there, both spans are present in
the parsed value, so the structural result governs; with a duplicate member the dropped
value is not.

`validateSerializedOutput` in the owned helper region at the top of
`src/security/service.ts` is now a one-line delegation, and `redactToolOutput` in
`src/mcp/redact-seam.ts` calls the same adapter through the allow-listed
`../security/service` facade, so the two wrappers cannot drift apart again. (A first
attempt imported `../security/output-validation` directly and was correctly rejected by
`src/mcp/boundary.test.ts` — raw `.metaproject/data/gdctx/raw/2026-09-06T13-17-57-013Z_run.log`;
the import now goes through the facade and the boundary test is green.)

Evidence: probe `duplicateKeySerialized.ok:false`, `reasons:["serialized-content-mismatch"]`,
`leaked:false`; `duplicateKeyPersistence.allowed:false, leaked:false`.

### F-003 — `$ref` siblings (`src/security/output-validation.ts`)

`screenSchema` rejects a `$ref` that carries any sibling outside
`REFERENCE_SAFE_SIBLINGS` (`$ref`, `$schema`, `$id`, `title`, `$defs`) with
`schema.unsupported-reference-siblings`. `schemas.ts:walk` resolves a reference and
returns, so every other supported keyword next to a `$ref` would be silently dropped.
The ref-resolution check runs first, so an unresolvable ref still reports
`schema.unsupported-reference` and no attacker-controlled schema text enters a reason.

`src/security/schemas.ts` was **not** changed: every `$ref` in the repository is a bare
reference, so screening at the boundary closes the class without touching the shared
validator other modules depend on.

Evidence: probe `refSibling.ok:false` with the token, MCP `refSiblingIsError:true`,
`refSiblingText:"Output withheld: format-unsafe"`.

### F-004 — HTML-entity `src` and `srcset` auto-fetch (`src/security/detect/exfil.ts`)

- `decodeCharacterReferences()` — decimal (`&#58;`), hex (`&#x3a;`) and a named table
  restricted to URL syntax characters; the trailing `;` is optional, and decoding repeats
  up to three passes so `&amp;#58;` also resolves.
- `considerUrl()` classifies the **decoded** URL but keeps `start`/`end` on the raw span,
  so `applyRedaction` masks the bytes as written. This covers inline images, reference
  definitions, `src` and `srcset` in one place.
- `HTML_IMG_SRCSET` enumerates every comma-separated candidate, maps each URL back to its
  offset inside the raw attribute, and runs it through the existing allowlist rule and the
  existing `egress.html-image-exfil` policy id — so an allowlisted candidate stays
  unflagged next to a blocked one.
- The public-link control is untouched: `SENSITIVE_URL_VALUE` still gates non-image
  inline links, and a bare public URL still produces no exfil match.

Evidence: probe `autoFetch.encodedHtmlImageChanged:true`, `srcsetHtmlImageChanged:true`,
`ordinaryLinkChanged:false`.

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| RED baseline | `bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts` | 14 pass / **5 fail** | `2026-09-06T13-12-32-484Z_run.log` |
| RED → GREEN | same command | **19 pass / 0 fail**, 79 assertions | `2026-09-06T13-17-47-772Z_run.log` |
| Focused security/MCP suite | `bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts src/security/structural-detection.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/security/detect src/security/redact.test.ts src/mcp` | **274 pass, 3 skip, 0 fail**, 902 assertions, 277 tests / 29 files | `2026-09-06T13-18-20-357Z_run.log` |
| T24 stage-1 probe | `bun …/artifacts/T24-stage1-probe.ts` | no leak on any of the four findings | `2026-09-06T13-18-25-093Z_run.log` |
| Typecheck | `bun run typecheck` | exit 0 | `2026-09-06T13-18-42-358Z_run.log` |
| ESLint (changed files only) | `bunx eslint src/security/output-validation.ts src/security/detect/exfil.ts src/security/service.ts src/mcp/redact-seam.ts` | exit 0, no output | `2026-09-06T13-18-47-396Z_run.log` |
| Whole `src/security` | `bun test src/security` | 174 pass, **1 pre-existing fail** (see below) | `2026-09-06T13-18-55-880Z_run.log` |
| Guarded sinks regression | `bun test src/memory src/wiki src/gdskills` | 569 pass, 0 fail | `2026-09-06T13-20-07-561Z_run.log` |

All four `SUPPORTED_SCHEMA_KEYS`-era invariants hold: the only failure text is the constant
`Output withheld: format-unsafe`, reasons are fixed tokens
(`sensitive-property-name`, `serialized-content-mismatch`,
`schema.unsupported-reference-siblings`), and neither the rejected value, a raw secret nor
a fingerprint appears in any reason, text or metadata (probe
`attackerControlledReasons.keyReasonLeaks:false`, `refReasonLeaks:false`).

### Pre-existing failure, not caused by T26

`src/security/service.memo.test.ts › one service keeps the config it loaded; a fresh one
picks up the change` fails: its control asserts a fresh service *stops* redacting when the
PII policy is disabled, while `createSecurityService().redact` has applied the mandatory
floor since T19/T22, which redacts regardless of advisory config. That input is not JSON,
and for non-JSON input the new adapter is byte-identical to the previous one — proven by
replaying the pre-T26 adapter side by side (`identical:true` for the memo fixture and two
controls, raw `.metaproject/data/gdctx/raw/2026-09-06T13-19-57-058Z_run.log`). The test is
outside this dispatch's ownership and outside the required focused set; it is reported, not
touched.

## Files changed

- `src/security/output-validation.ts` — property-name screen (F-001), `$ref` sibling screen
  (F-003), serialized-content adapter with byte accountability (F-002).
- `src/security/detect/exfil.ts` — character-reference canonicalization for classification
  and `srcset` candidate enumeration (F-004).
- `src/security/service.ts` — the `validateSerializedOutput` helper region only: import swap
  and one-line delegation.
- `src/mcp/redact-seam.ts` — `redactToolOutput` now shares the serialized adapter through
  the `../security/service` facade.
- `src/security/schemas.ts` — **not changed** (no `$ref` in this repository carries siblings).
- No test file was modified.

## Routing audit

`graph_used: no (not-relevant — the dispatch enumerated every file, and the graph predates
this session's uncommitted changes)` / `wiki_used: no (not-relevant — the approved
AFC-02/AFC-15 policy text in docs/requirements/keryx-agent-first-core/policies.md is the
governing source and was read directly)` / `ctx_used: yes (every command, search, file
excerpt and test run went through keryx ctx)` / `raw_rg_used: no`.
