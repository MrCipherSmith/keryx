# T71 — spec: close T66#F-001, T66#F-002 and T66#F-003 on the auto-fetch floor

Written before any edit. The three defects were each re-measured on the CURRENT
`src/security/detect/exfil.ts` (`63edcc57c8604ab5e66534ca5c92d30ef0f77d942494d898dc2f07f479ab15cc`,
956 lines — the file T67 rewrote after T66 measured it), not taken on report.

| Defect | Reviewer's line | Line on the CURRENT file | Reproduced? |
|---|---|---|---|
| F-001 gate compares the raw attribute value | `exfil.ts:520` `hasAttributeValue`, used at `:845`/`:848` | `exfil.ts:520` `hasAttributeValue`, used at `:845` (`input`) and `:849` (`meta`) | **yes** — `T71-before-gates.log`, `gateBypasses` = the same 7 ids |
| F-002 three CommonMark image forms released | `exfil.ts:431` `INLINE`, `:433` `REFERENCE_USE` | same lines | **yes** — `T71-before-md-oracle.log`, `bypasses` = the same 5 ids over 3 forms |
| F-003 the normative subsection is inaccurate both ways | `policies.md:28`, `:34` | same lines (`policies.md` unchanged since T46, hash `61ddb7f6…`) | **yes** — read against `FETCHING_ATTRIBUTES`, `HTML_START_TAG`, the `lastIndex` decision and `readStartTag`'s `close === -1` branch |

Ownership: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`, and the auto-fetch
subsection of `docs/requirements/keryx-agent-first-core/policies.md` (plus that document's `Version:`
line, which the same convention T46 followed bumps when the subsection changes — disclosed rather
than assumed). No other file. No `acceptance-criteria.md`, no `flow.json`, no reviewer probe, no
existing test weakened or removed.

---

## 1. F-001 — decode the gate value, because the renderer decodes it

### What is wrong

`hasAttributeValue` compares `attribute.value.trim().toLowerCase()` against the expected literal.
The HTML tokenizer consumes character references in the attribute-value states (§13.2.5.35–.39), so
`type="&#105;mage"` **is** an image submit button and `http-equiv="&#114;efresh"` **is** a refresh.
The module already holds that premise in two places a few lines away — `renderableUrl` decodes the
destination, and `metaRefreshDestination` decodes `content` "because a renderer decodes the attribute
value before running the grammar" — and withholds it from the two gates that decide whether the value
is read at all.

### The fix

One line inside `hasAttributeValue`: compare
`decodeCharacterReferences(attribute.value).trim().toLowerCase()`. Decode first, then trim, so
`type="&#32;image"` (a reference that decodes to a space) trims the same way a literal space does.

This is deliberately fixed **in the helper, not at the two call sites**, so that the class the
reviewer enumerated — "every gate that decides on an attribute value rather than an attribute name" —
is closed at its single choke point and a third gate added later inherits the fix. The class is
closed at two members today: `hasAttributeValue` has exactly two call sites, and every other branch
in the module keys off the attribute NAME, which a tokenizer does not entity-decode.

### What must NOT change

- `metaEquivNamedRef` (`http-equiv="refresh&#59;"` → decodes to `refresh;`) must stay **released**:
  the decoded value is not `refresh`, and no renderer refreshes on it. Decoding must not be followed
  by any prefix or substring match.
- Masking offsets stay on the raw bytes: the gate decodes for CLASSIFICATION only, and never feeds
  `attribute.valueStart` or `attribute.value` (the mask span) from a decoded string.
- `inputDupTypeTextFirst` (`<input type=text type=image src=…>`) stays a flagged false positive
  (T66#F-008, info, explicitly not in scope here); duplicate resolution stays eager.

## 2. F-002 — the markdown description and label grammars, judged as a renderer judges them

### What is wrong

Three CommonMark image forms render an auto-fetching `<img>` and produce zero findings:

- **collapsed reference** `![a][]` — `REFERENCE_USE`'s second group is `([^\]]+)`, which cannot match
  the empty label.
- **shortcut reference** `![a]` — there is no second bracket pair at all, so the pattern never starts.
- **balanced brackets in the description** `![a[b]c](URL)` — `INLINE`'s `\[[^\]]*\]` cannot span a
  `]`, so neither the inner nor the outer bracket run reaches the `(`.

Verified against `marked` (an independent CommonMark renderer already in this checkout, offline) in
`T71-before-md-oracle.log`: all five reviewer rows render `<img src="https://attacker.invalid/…">`
while `detectExfil` returns 0 findings.

### The fix, and why it is not a bracket-counting bound

The recurring cause on this surface has been a layer that judges text in a form the renderer does not
use, and every previous repair that put a **bound** on the judgement (a digit count in the decoder, a
negated character class in the extractor) was defeated by writing one more of whatever was bounded.
A description matcher that allows brackets "one level deep" would be the same mistake: the attacker
writes two.

So the description span is not matched by a regex at all. A helper `descriptionEnds(content, open)`
walks forward from the `[` counting depth and reports up to two candidate ends:

1. the **balanced** end — the `]` that returns depth to 0, at any nesting depth, unbounded; and
2. the **first** `]` at any depth — the span the current `[^\]]*` regex produces.

Both are returned, balanced first, and the caller tries them in order. Returning the old span as a
fallback is what makes this change a strict SUPERSET of the current extraction: every shape the
current regex matches is still reachable, so no existing over-approximation id in the 88-case
extraction matrix can disappear. (Checked concretely on `![a[](URL)`, where the balanced walk finds no
close and the old first-`]` span is the one that matches.)

Backslash escapes are deliberately NOT honoured in the walk, for the same reason: honouring `\]`
would REMOVE current matches (`![a\](URL)` is flagged today), which is the one direction this floor
may not move.

With the span in hand, the construct is classified the way CommonMark classifies it:

- `(` immediately after the description ⇒ **inline**; the existing destination grammar runs, unchanged,
  as a sticky (`/y`) regex anchored at that `(`.
- `[` immediately after ⇒ **reference**; the label is the bracket pair's content when non-empty
  (**full**) and the description otherwise (**collapsed**).
- neither ⇒ **shortcut**; the label is the description.

The label is normalised exactly as today (`trim().toLowerCase()`), matching how `REFERENCE_DEF`
stores it — so `![Logo][]` against `[logo]: URL` resolves, which is the `collapsedUppercaseRef` row.

### Structure: still two passes, deliberately

The inline pass and the reference pass stay separate loops in the same order they are in today
(inline, then reference, then HTML). Merging them into one walk would reorder the `matches` array for
a document containing both, and match order is observable through `applyRedaction` and through the
prior matrices. Both loops use the same scanner.

The reference pass SKIPS a construct whose description is followed by an inline destination, so
`![a](URL)` does not additionally register `[a]` as a shortcut use. The `!`-only gate stays exactly as
it is, so a plain reference LINK (`[a]`, `[a][]`, `[a][b]`) remains click-gated and unflagged — the
`ctlPlainLinkShortcut` row.

The reference-definition line `[a]: URL` is itself a shortcut-shaped bracket run; it carries no `!`
and is therefore skipped by the same gate, exactly as it is today.

### Costs this widening accepts, to be measured not assumed

A shortcut reference image is the ordinary README badge shape (`![logo]` + `[logo]: https://…`), so
this fix can only make the benign corpus count go UP, never down. The dispatch's rule is that benign
cost is disclosed rather than discovered: §Verification records `benignFilesWithFindings` and the
Part B flagged-id list before and after, and any new benign carrier is named. Nothing else is widened
to chase it.

Bracket scanning is O(n) per opening bracket in the worst case (a run of `[` with no `]`), which is
the same worst case the current `[^\]]*` already has at each start position; re-measured on dense
markup in §Verification so the claim is not merely asserted.

## 3. F-003 — the normative subsection, corrected in both directions

`docs/requirements/keryx-agent-first-core/policies.md`, `### Auto-fetch floor: покрытая и непокрытая
область`. Three corrections, all inside that subsection, and the module header comment
(`exfil.ts:41-63`, the reviewer's third site for the same class) is corrected to match:

- **(a) completeness.** The covered list is marked *«перечень полный, не пример»* over entries that
  were spelling-dependent. After §1 and §2 the claim becomes true, so it stays — but the markdown
  entry is written out as the four image forms it now actually covers (inline, full, collapsed,
  shortcut), and the two gated entries say that the gate value is read after character-reference
  decoding, which is what makes them spelling-independent.
- **(b) context exceptions.** *«Исключение сделано только для `<base href>`»* names one exception where
  there are three. The other two both make coverage NARROWER than the sentence promises, and both are
  deliberate: markup written inside another element's quoted attribute value is not a finding (the
  `HTML_START_TAG.lastIndex` decision, T53#F-004), and an unterminated quoted value suppresses
  detection for the remainder of the fragment (T53#F-003). Note that `<base href>` is not an exception
  in the same sense as the other two — it is the one place where the context-blindness is disclosed as
  a cost, not a place where context is consulted; the corrected wording says so.
- **(c) case-insensitivity.** Nothing says element and attribute names match ASCII case-insensitively,
  so a reader cannot learn that a quoted `.tsx` or MDX carrying `<Video src>`, `<Iframe src>` or
  `<Embed src>` is masked. This is coverage WIDER than the document implies — the direction the
  dispatch asked about — and it is added as one clause.

The `Version:` line goes `0.1.3` (from `0.1.2`). The credential-locator sentence in §Redaction is NOT
touched (T46 offered that change and did not apply it; nothing here changes the reason).

---

## 4. Tests (RED first)

New tests in `src/security/detect/exfil.test.ts`, each failing on the pre-fix detector:

1. `T71#F-001: the type=image and http-equiv=refresh gates read the value a renderer reads` — the four
   `type=` and three `http-equiv=` spellings from `T66-gates.ts`, each flagged and masked; plus the
   negatives that must stay released (`refresh&#59;`, `type=text`, no type, a non-refresh meta).
2. `T71#F-002: every CommonMark image spelling a renderer auto-fetches is a finding` — collapsed,
   shortcut, shortcut-in-prose, uppercase-collapsed, balanced-bracket description, plus the two
   controls that must stay released (a relative shortcut, a plain reference LINK) and the full/inline
   baselines that must stay flagged.
3. `T71#F-002: the balanced-bracket description is unbounded, not bounded` — nesting depth 1..4, each
   flagged, so the fix cannot silently become a depth bound.
4. Boundary rows: the seven bypass vectors added to a `T71_CLASS_VECTORS` list driven through
   `prepareOutputForPersistence` and `validateOutputForTransport`, mirroring `T46_CLASS_VECTORS`
   (which also answers T66#F-009's pinning gap for these rows).

## 5. Verification to run, before and after

- The reviewer's three probes: `T66-gates.ts`, `T66-md-oracle.ts`, `T66-boundary.ts` (unmodified).
- All prior matrices: `T42-exfil-attack`, `T24-recheck2-exfil`, `T42-charrefs`, `T53-extract`,
  `T53-resolve`, `T53-base`, `T53-boundary`, `T42-boundary`, `T24-recheck2-boundary`, `T52-base`,
  `T46-surfaces`.
- The benign corpus: `T53-corpus.ts`, Part A `benignFilesWithFindings` and Part B `flaggedIds`.
- `bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts
  src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
  src/security/persistence-sinks.test.ts`
- `bun run typecheck`; `bunx eslint` on every changed file.

Probes run directly with `bun`, not through `ctx run`: its compaction drops the per-case rows that are
the evidence. Disclosed here and in the implementation report.
