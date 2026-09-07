# T36 spec — close the residual serialized-byte and entity-decoding bypasses by canonical structural equivalence

Written before any code change, per the dispatch. Governing norm:
`docs/requirements/keryx-agent-first-core/policies.md` §Redaction line 20 — when the safe part
preserves the operation schema, return it with `redaction.state=redacted` and a safe reason carrying
neither the rejected value nor its fingerprint; return `format-unsafe` only when the schema admits no
marker and no safe representation exists.

Independent evidence this spec answers: `T24-recheck.md` findings T24R#F-001 (blocker),
T24R#F-002 (blocker), T24R#F-003 (major).

## 1. Why the first fix was structurally wrong, not merely incomplete

`parsedValueAccountsForBytes` decides byte preservation **before** the structural walk, by running
the raw-text detectors over the serialized bytes and requiring every span they find to be a substring
of some reachable scalar. Two consequences follow from the shape of that rule, and both were
reproduced by the reviewer:

- **It recognizes strictly less than the floor it stands in for.** The gate uses only the pattern
  detectors on escaped-and-quoted text. It does not decode JSON string escapes, and it does not apply
  the contextual rules (`isSensitiveFieldKey`, `isSensitivePropertyName`, `sensitive-numeric-field`)
  that the walk applies. `spans.length === 0` therefore short-circuits to "accounted for" for a
  JSON-escaped credential and for any credential that is sensitive only by field context. The bytes
  are then restored verbatim with `state:"none"`.
- **It refuses payloads the contract requires it to accept.** A detector span in the raw text can
  straddle the `","` between two members (`secrets.url-credentials` matching across
  `…example.com","note":"ping…`). Such a span is a substring of no scalar, so the gate rejects — before
  the walk has had a chance to produce the safe redacted representation that demonstrably exists.

Both failure modes are properties of *deciding on raw-text spans*, so widening the recognizer would
only move the boundary. The decision has to stop being about spans.

## 2. Decision rule (replacement)

Byte preservation is decided **after** the structural walk, by canonical structural equivalence:

```
parse → walk (validateOutputForTransport, format "json")
  walk says unsafe                                   → format-unsafe (unchanged reason)
  walk says safe:
     bytes canonically equivalent to the structure   → return the ORIGINAL bytes, state unchanged
     bytes NOT canonically equivalent                → return the CANONICAL serialization,
                                                        state "redacted"
```

`format-unsafe` is now reachable only from the walk itself — i.e. only when the *structure* has no safe
representation (`sensitive-property-name`, `sensitive-numeric-field`, `non-json-value`, `cyclic-value`,
`schema.*`). That is exactly the policies.md condition.

### Canonical structural equivalence

The bytes are canonically equivalent to the validated structure when, after removing the whitespace
that separates JSON tokens outside string literals, they are identical to `JSON.stringify` of the
validated value. Whitespace between tokens carries no content; everything else in the byte stream is
significant. Consequently:

- a duplicate member's dropped value is extra tokens → **not** equivalent → canonical form emitted,
  and the hidden bytes are gone. This holds regardless of how the dropped value is spelled, so JSON
  escaping and field-context sensitivity are no longer axes the rule has to know about;
- a pretty-printed serialization produced by `JSON.stringify(value, null, n)` **is** equivalent, so
  ordinary artifacts stay byte-for-byte preserved;
- a differently spelled escape (`A` for `A`), a differently spelled number (`1.0` for `1`) or a
  reordered integer-like key is not equivalent, so the canonical form is emitted. That is the
  conservative direction: content is preserved, only its spelling is normalized.

The comparison is sound in the direction that matters — it never reports "equivalent" for bytes that
carry content the walk did not see, because such content is extra tokens.

### Reason token

The `state:"redacted"` branch that only normalizes carries the fixed token
`serialized-content-normalized`. It is a constant: no rejected value, no fingerprint, no length.
`serialized-content-mismatch` is retired — with the pre-walk gate gone there is no longer any
serialization that has no safe representation *because of its bytes*.

### Contract points preserved

- constant `Output withheld: format-unsafe` text on every rejection;
- fixed reason tokens only;
- byte-for-byte preservation of safe scalars and of clean canonical JSON;
- a numeric value under a sensitive credential key still `sensitive-numeric-field`;
- an own `undefined` member still `format-unsafe`;
- non-JSON text still routed to the text floor unchanged.

## 3. Character-reference decoding and URL classification

`CHARACTER_REFERENCE` bounds the decimal form to `\d{1,7}` and the hex form to 6 digits. An HTML
tokenizer consumes an *unbounded* digit run and then range-checks the code point, so `&#00000058;`
matches only the prefix `&#0000000` today, decodes to code point 0, is rejected, and the raw text
survives with no scheme — `exfilHost` returns null and nothing is flagged.

Replacement, matching the grammar a renderer applies:

- unbounded digit runs (`&#(\d+)`, `&#[xX]([0-9a-fA-F]+)`), with the **code point** clamped
  (`0 < code <= 0x10FFFF`) instead of the digit count;
- before host classification, apply the removals the WHATWG URL parser applies: strip every ASCII
  tab, LF and CR from the decoded string, then strip leading and trailing C0-or-space. This closes
  `ht&#9;tps://…`, a literal tab or newline inside the scheme, and a leading space, newline or
  `&#9;` before the URL.

`start`/`end` stay on the **raw** span throughout, so `applyRedaction` masks the bytes exactly as they
were written and the host disappears from the output. The normalization is confined to
`considerUrl`, which is the single classification funnel for inline images, inline links, reference
definitions, `<img src>` and every `<img srcset>` candidate, so one change covers all five surfaces.

## 4. Regressions (RED before GREEN)

`src/security/output-validation.test.ts`

| Case | Expected after |
|---|---|
| `{"a":"AKIAIOSFODNN7EXAMPLE","a":"safe"}` (JSON-escaped duplicate) | ok, canonical `{"a":"safe"}`, `redacted`, no escaped or decoded secret bytes |
| `{"a":"AKIAIOSFODNN7EXAMPLE","a":"safe"}` (fully escaped) | same |
| `{"pwd":"<cred>","pwd":""}` | ok, canonical `{"pwd":""}`, `redacted`, credential absent |
| `{"api_key":"<cred>","api_key":null}` | ok, canonical `{"api_key":null}`, `redacted`, credential absent |
| `{"secret":"<cred>","secret":false}` | ok, canonical `{"secret":false}`, `redacted`, credential absent |
| `{"token":"<secret>","token":"safe"}` (the shape the committed test pins) | ok, canonical, `redacted`, secret absent — the assertion moves from "refused" to "safe representation returned", which is what policies.md requires and what the T24 finding actually asked for (no restored secret bytes) |
| `{"docs":"https://example.com","note":"ping@host.example"}` | ok, `redacted`, byte-identical to the same value validated directly as a parsed object |
| clean compact JSON, and the same value pretty-printed | byte-preserved, `state:"none"` |
| non-JSON text | unchanged |
| `{"password":1234,"password":1}` | still `format-unsafe` / `sensitive-numeric-field` |
| `{"AKIA…":"x"}` as a key | still `format-unsafe` / `sensitive-property-name` |

`src/security/detect/exfil.test.ts`

| Case | Expected after |
|---|---|
| `&#00000058;`, `&#0000000058;`, `&#x000003a;` in `<img src>` | flagged `egress.html-image-exfil`, host absent after `applyRedaction` |
| `ht&#9;tps://…`, literal `\t`, literal `\n` inside the scheme | flagged, host absent |
| leading space, leading newline, leading `&#9;` before the URL | flagged, host absent |
| ordinary public Markdown link, bare public URL, relative `<img src>`, `data:` image | unchanged and unflagged |
| existing entity and `srcset` regressions | unchanged |

## 5. Files

- `src/security/output-validation.ts` — replace `reachableScalarText` / `parsedValueAccountsForBytes`
  with token-whitespace normalization; rewrite `validateSerializedContentForTransport`.
- `src/security/output-validation.test.ts` — the table above.
- `src/security/detect/exfil.ts` — `CHARACTER_REFERENCE`, code-point clamp, `considerUrl`
  normalization.
- `src/security/detect/exfil.test.ts` — the table above.
- `src/mcp/redact-seam.ts` — comment only: it already goes through the `../security/service` facade
  (`src/mcp/boundary.test.ts` forbids importing the validator directly), so the seam inherits the new
  rule with no code change; its comment must stop describing the retired accountability gate.
- `src/security/service.ts` — the `validateSerializedOutput` helper comment only.

No other file. No git, network, model, dependency or flow-state change. Synthetic credentials only
(`AKIA` + `IOSFODNN7EXAMPLE`, `tr0ub4dor-correct-horse`) and the reserved `attacker.invalid` /
`example.com` domains.
