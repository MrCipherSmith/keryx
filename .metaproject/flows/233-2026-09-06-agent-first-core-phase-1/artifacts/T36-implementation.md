STATUS: DONE_WITH_CONCERNS

# T36 implementation — canonical structural equivalence and a renderer-grammar URL decoder

Second approach to T24 F-002 / F-004, not a retry. Spec written before any code change:
`T36-spec.md`. Independent evidence answered: `T24-recheck.md` (T24R#F-001 blocker,
T24R#F-002 blocker, T24R#F-003 major).

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`. Every command,
search and probe went through `bun src/cli.ts ctx run` / `ctx rg`. Synthetic credentials only
(`AKIA` + `IOSFODNN7EXAMPLE`, `tr0ub4dor-correct-horse`) and the reserved `attacker.invalid` /
`example.com` domains.

## Files changed

| File | Change |
|---|---|
| `src/security/output-validation.ts` | Removed `reachableScalarText` and `parsedValueAccountsForBytes`. Added `withoutInsignificantWhitespace` / `bytesAreCanonicalFor` and the constant `serialized-content-normalized`. Rewrote `validateSerializedContentForTransport` to decide byte preservation after the structural walk. |
| `src/security/output-validation.test.ts` | Rewrote the duplicate-member regression to the new contract and added five regressions (escaped duplicate, contextual-key duplicates, false-rejection parity, byte preservation incl. pretty-printed, still-fail-closed structures). |
| `src/security/detect/exfil.ts` | Unbounded numeric character-reference runs with the bound moved to the code point; new `renderableUrl` (`stripC0OrSpace` + tab/LF/CR removal) applied in `considerUrl`. |
| `src/security/detect/exfil.test.ts` | Three regressions: zero-padded decimal/hex references, whitespace and controls inside or before the URL, benign controls under the new decoder. |
| `src/mcp/redact-seam.ts` | Comment only — it described the retired accountability gate. No code change: the seam already reaches the adapter through the `../security/service` facade, which is what `src/mcp/boundary.test.ts` (M-3) requires. |
| `src/security/service.ts` | Comment only, in the `validateSerializedOutput` helper region. |

Nothing else was touched. `src/security/guard.ts`, `path-scan.ts`, the `scan`/`runGate` regions of
`service.ts`, `schemas.ts`, `src/mcp/dispatch.ts`, `src/commands/*`, flow files, `package.json` and
the lockfile are untouched; two other workers own those concurrently.

## Defect 1 (T24R#F-001, blocker) — byte accountability recognized less than the floor

**Root cause.** `parsedValueAccountsForBytes` ran *before* the structural walk and asked a question
about detector spans in the raw bytes. That question is answerable only by a recognizer, and the
recognizer it used was strictly weaker than the floor: no JSON-escape normalization, and none of the
contextual rules (`isSensitiveFieldKey`, `isSensitivePropertyName`, `sensitive-numeric-field`).
`spans.length === 0` therefore short-circuited to "accounted for" and the bytes were returned intact.

**Fix.** The decision moved after the walk and stopped being about spans. The bytes are returned
only when they are canonically equivalent to the validated structure — the original text with the
whitespace *between* JSON tokens removed, compared against `JSON.stringify` of the validated value.
A dropped duplicate member is extra tokens, so it survives normalization and the comparison fails,
regardless of what it holds or how it is spelled. Escape spelling and field-context sensitivity are
no longer axes the rule has to know about.

**Evidence, before → after** (`T36-before-after-compare.txt`, built from
`T36-before-f002-class.json` / `T36-after-f002-class.json`; probe runs
`2026-09-06T13-40-43-566Z_run.log` and `2026-09-06T13-47-22-793Z_run.log`):

| Shape | before | after |
|---|---|---|
| `{"a":"AKIAIOSFODNN7EXAMPLE","a":"safe"}` | ok, `none`, bytes restored, **hides secret** | ok, `redacted`, `{"a":"safe"}`, no secret |
| fully escaped variant | ok, `none`, **hides secret** | ok, `redacted`, no secret |
| `{"pwd":"<cred>","pwd":""}` | ok, `none`, **hides credential** | ok, `redacted`, `{"pwd":""}` |
| `{"api_key":"<cred>","api_key":null}` | ok, `none`, **hides credential** | ok, `redacted`, `{"api_key":null}` |
| `{"secret":"<cred>","secret":false}` | ok, `none`, **hides credential** | ok, `redacted`, `{"secret":false}` |

`hidesSecret` is `false` for all five after the change. Controls unchanged:
`escapedSecretDuplicateKey` stays `format-unsafe`/`sensitive-property-name`,
`numberUnderCredentialKeyDuplicate` stays `format-unsafe`/`sensitive-numeric-field`.

At the real boundaries (`T36-before-boundary.json` → `T36-after-boundary.json`,
runs `2026-09-06T13-40-45-379Z_run.log` → `2026-09-06T13-47-24-451Z_run.log`):

- `persistence.escapedDuplicate`: `leakedEscapedBytes true → false`, content now `{"a":"safe"}`.
- `persistence.credentialDuplicate`: `leakedCredential true → false`, content now `{"pwd":""}`.
- `seam.escapedDuplicate` / `seam.credentialDuplicate`: `identicalToInput true → false`, no leak.

## Defect 2 (T24R#F-003, major) — a payload with a safe representation was refused

**Root cause.** The same pre-walk gate. A `secrets.url-credentials` span can straddle the `","`
between two members, making it a substring of no scalar; the gate rejected before the walk could
produce the safe representation that demonstrably existed.

**Fix.** Fixed by the same change: `format-unsafe` is now reachable **only** from the walk, i.e.
only when the structure itself has no safe representation. `serialized-content-mismatch` is retired.

**Evidence.** `f002.urlThenEmailAcrossMembers` moves from
`{ok:false, ["serialized-content-mismatch"]}` to `{ok:true, state:"redacted", ["pii.email"]}`, and
its text is now byte-identical to `f002.urlThenEmailParsedDirect`
(`{"docs":"https://example.com","note":"[REDACTED:email]"}`) — the serialized and parsed paths agree.
`persistence.urlThenEmailFalseRejection` moves from
`allowed:false, "format-unsafe: output cannot be persisted safely"` to `allowed:true`.
Over the reviewer's 401-file sweep of real repository JSON, rejections go **5 → 0** and
`serialized-content-mismatch` rejections **5 → 0**, with no other rejection class appearing.

This is what `policies.md` (Redaction, line 20) requires: return the safe part with
`redaction.state=redacted` and a safe reason whenever it preserves the operation schema; reserve
`format-unsafe` for the case where the schema admits no marker and no safe representation exists.

## Defect 3 (T24R#F-002, blocker) — decoder bounded by digit count, no URL-syntax stripping

**Root cause.** `CHARACTER_REFERENCE` capped the decimal form at `\d{1,7}` and the hex form at 6
digits, so `&#00000058;` matched only the prefix `&#0000000`, decoded to code point 0, was rejected
and left raw — `exfilHost` then saw no scheme. Separately, `considerUrl` classified the decoded
string without the removals every URL parser applies, so a tab or newline inside the scheme and
leading whitespace before the URL also produced no host.

**Fix.** Unbounded digit runs (`&#(\d+)`, `&#[xX]([0-9a-fA-F]+)`) with the bound moved onto the code
point (`0 < code <= 0x10FFFF`), which is what an HTML tokenizer does. `renderableUrl` then removes
every ASCII tab, LF and CR and strips leading/trailing C0-or-space (`stripC0OrSpace`, written with
code units so the source carries no invisible control characters) before `exfilHost`. `start`/`end`
stay on the **raw** span, so `applyRedaction` masks the bytes as written. The normalization sits in
`considerUrl`, the single classification funnel for inline images, inline links, reference
definitions, `<img src>` and every `<img srcset>` candidate, so one change covers all five surfaces.

**Evidence** (`T36-before-validator.json` → `T36-after-validator.json`, runs
`2026-09-06T13-40-36-375Z_run.log` → `2026-09-06T13-47-20-229Z_run.log`). Nine vectors move from
`flagged:false, hostStillPresent:true` to `flagged:true, hostStillPresent:false`:
`zeroPadded8`, `zeroPadded10`, `hexZeroPadded7`, `tabInsideSchemeEntity`, `literalTabInsideScheme`,
`newlineInsideScheme`, `leadingSpace`, `leadingNewline`, `leadingTabEntity`.

All 24 previously-correct F-004 cases are unchanged, including the four benign controls
(`ordinaryPublicLink`, `bareUrl`, `relativeImage`, `dataUriImage`) and `srcsetProtocolLess`, which
correctly stays unflagged (no scheme ⇒ no cross-origin channel).

At the transport: `mcp.paddedEntityImage` and `mcp.leadingSpaceImage` move from
`isError:false, state:"none", leaksHost:true` to `state:"redacted"`,
`["egress.html-image-exfil"]`, `leaksHost:false`, text `<img src="[REDACTED:url]">`.
`mcp.publicLink` is unchanged.

## Contract points verified intact

From the validator probe after the change: constant `Output withheld: format-unsafe` on every
rejection; only fixed reason tokens; `{"password":123456789}` → `sensitive-numeric-field`; an own
`undefined` member → `non-json-value`; safe digit keys, numeric-string keys, path keys, public-URL
keys and env-var-named keys all byte-preserved with `state:"none"`; `{"password":"hunter"}` still
redacted by value; a purely numeric property name still does not trip `pii.phone`; an attacker-named
`$ref` leaks nothing (`reasonLeaksAttackerText.leaks:false`); all F-001 and F-003 verdicts identical
before and after. `secretPlusLongDigitRun` — the case `src/security/persistence-sinks.test.ts`
requires — stays allowed-and-redacted with `count:123456789` intact.

## Verification

| Check | Before | After | Raw log |
|---|---|---|---|
| Recheck validator probe | wrote `T36-before-validator.json` | wrote `T36-after-validator.json` | `2026-09-06T13-40-36-375Z_run.log` / `2026-09-06T13-47-20-229Z_run.log` |
| Recheck F-002 class probe | 401 files, 5 rejections | 401 files, 0 rejections | `2026-09-06T13-40-43-566Z_run.log` / `2026-09-06T13-47-22-793Z_run.log` |
| Recheck boundary probe | 3 leaks + 1 false rejection | 0 leaks, 0 false rejections | `2026-09-06T13-40-45-379Z_run.log` / `2026-09-06T13-47-24-451Z_run.log` |
| Before/after comparison | — | `T36-before-after-compare.txt` | `2026-09-06T13-47-46-785Z_run.log` |
| New regressions (RED → GREEN) | 21 pass / **6 fail** | 27 pass / 0 fail / 163 assertions | `2026-09-06T13-45-26-967Z_run.log` / `2026-09-06T13-46-57-688Z_run.log` |
| Required suite (7 targets) | — | **249 pass, 3 skip, 0 fail**, 916 assertions | `2026-09-06T13-47-15-029Z_run.log` |
| `T24-stage1-probe.ts` | — | all four findings closed, no leak | `2026-09-06T13-48-02-187Z_run.log` |
| `bun run typecheck` | — | exit 0 | `2026-09-06T13-48-22-670Z_run.log` |
| `bunx eslint` (6 changed files) | — | exit 0, no output | `2026-09-06T13-48-28-721Z_run.log` |
| `bun test src/security` (wider sweep) | — | 182 pass, **1 fail** (pre-existing, not mine) | `2026-09-06T13-48-35-387Z_run.log` |

### `T24-stage1-probe.ts` — all four original findings stay closed

`duplicateKeySerialized.leaked:false`, `duplicateKeyPersistence.leaked:false`,
`refSibling` `format-unsafe`/`schema.unsupported-reference-siblings`,
`attackerControlledReasons.keyReasonLeaks:false` and `.refReasonLeaks:false`,
`optionalUndefined` `format-unsafe`/`non-json-value`, `secretPropertyName.leaked:false`,
`mcpBoundary.secretPropertyNameIsError:true` with `leaks:false`, `refSiblingIsError:true` with the
constant text, `autoFetch.encodedHtmlImageChanged:true`, `.srcsetHtmlImageChanged:true`,
`.ordinaryLinkChanged:false`.

Two fields in that probe report a *different value* while the finding stays closed, and this is the
intended change, not a regression: `duplicateKeySerialized.ok` is now `true` and
`duplicateKeyPersistence.allowed` is now `true`. Closure for F-002 means the hidden bytes are not
restored — `leaked` is `false` in both, before and after. What changed is that the safe canonical
representation is now *returned* instead of the whole payload being withheld, which is exactly what
`policies.md` requires and what T24R#F-003 recorded as a defect in the previous fix.

## Concerns

1. **One committed test changed its expected verdict.** `src/security/output-validation.test.ts`,
   `"duplicate serialized members cannot restore hidden secret bytes"`, previously asserted
   `format-unsafe` / `serialized-content-mismatch` for `{"token":"<secret>","token":"safe"}`. It now
   asserts that the canonical safe form is returned with `state:"redacted"` and that the secret
   appears nowhere in the result. The test's stated intent — no restored secret bytes — is preserved
   and its leak assertion strengthened, but a reviewer should confirm the verdict change is the one
   the dispatch intended. It is the direct consequence of the required rule ("format-unsafe only
   when the structure itself is unsafe") and of T24R#F-003.
2. **Byte-preservation is now decided conservatively, so a serialization whose tokens are not in
   `JSON.stringify` form is re-serialized.** A differently spelled escape, a differently spelled
   number (`1.0` for `1`) or a reordered integer-like key produces `state:"redacted"` with
   `serialized-content-normalized` and the canonical bytes, even though no content was removed.
   Whitespace is not affected — pretty-printed `JSON.stringify(value, null, n)` output is still
   byte-preserved with `state:"none"` (regression test added, and 401/401 real repository JSON files
   pass). The direction is fail-safe: content is preserved, only its spelling is normalized.
3. **Pre-existing failure in a file another worker owns.** `bun test src/security` reports one
   failure, `src/security/service.memo.test.ts` → "one service keeps the config it loaded; a fresh
   one picks up the change": a fresh service still redacts PII after the policy is disabled. That
   path is `src/security/redact.ts` / the config-memo region of `src/security/service.ts`, both
   locally modified by other workers; `service.memo.test.ts` itself is unmodified. It cannot come
   from this change — the fixture is plain text with no markdown image, link, reference definition
   or `<img>` tag, so `detectExfil` returns `[]` on it both before and after, and
   `output-validation.ts` is not on the `service.redact` path at all. It is outside this dispatch's
   ownership and was left alone. Raw: `2026-09-06T13-48-45-436Z_run.log`.
4. **Transport-level regressions for the new shapes are still not committed** (the reviewer's
   T24R#F-004, tracked as T32). This change was verified at the transport with the reviewer's own
   boundary probe, but `src/mcp/structural-redaction.test.ts` and
   `src/security/persistence-sinks.test.ts` still pin nothing for duplicate members or padded
   character references. Both files are outside this dispatch's ownership.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  predates this session's uncommitted changes, so it could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing text is
  `docs/requirements/keryx-agent-first-core/policies.md` plus the T19 contract restated in the
  dispatch and the T24 recheck; all were read directly.
- `ctx_used: yes` — every command, code search, test run and probe execution went through
  `bun src/cli.ts ctx run` / `ctx rg`.
- `raw_rg_used: no` — no bare `rg`/`grep`. Four bounded `sed -n` reads used the documented
  `# keryx:raw` escape with a stated reason: routing this evidence through `ctx run` applies the very
  output floor under review and withholds it (the reviewer recorded the same behaviour, and it was
  observed again here — a `ctx rg` result rendered the fixture e-mail as `[REDACTED:email]`).
