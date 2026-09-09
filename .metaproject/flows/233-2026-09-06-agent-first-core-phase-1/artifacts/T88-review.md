STATUS: DONE_WITH_CONCERNS

# T88 — independent verification of T85's closure of T84#F-001 and T84#F-003, and that this closes the module

## Scope

Bounded exactly as dispatched: verify T85's closure of the two fixable T84 findings — the unmemoised
destination read (T84#F-001, a second independent quadratic) and the escape-blind description bracket
pairing (T84#F-003) — confirm nothing else moved (18 of 19 prior matrices, the benign corpus, the
container-block class), and confirm the accepted limitation (T84#F-002, reference definitions inside a
block container) is unchanged in extent. I wrote none of the code, tests, specs, or prior reviews under
examination. Per the dispatch, container-block coverage and a parser dependency are settled by user
decision and are not reopened here; I propose neither.

Read first, in order: `.metaproject/index.md`, `RESIDUALS.md` (including the accepted-limitation box),
`T84-review.md` (F-001, F-003), `T85-spec.md`, `T85-implementation.md`. Then
`src/security/detect/exfil.ts`, `exfil.test.ts`, `src/security/detect/index.ts`, `src/mcp/dispatch.ts`.

**Hash check before touching anything.** `exfil.ts` = `4e6668b8295ead46963385553b037d5718d7b35416cfea37bdfcf517e53bb44c`,
`exfil.test.ts` = `aec80e0562be8f9964d3b400e9ba756a250289cbb153a4a425dcd2f28ae58e6b` — both byte-identical
to the values T85-implementation.md recorded as its own "after" state. Re-hashed at the end of this review:
unchanged. This review touched neither file.

**Independence note.** I did not merely re-run T85's own probes and read its logs. For every claim I
could cheaply re-derive from first principles rather than trust, I did: I built my own pre-T85
reconstruction from the shipped file by reverting exactly the two documented mechanisms (not diffing
against a saved copy — none of the prior mkdtemp reconstructions survive between sessions), reproduced
both defects on it independently, then ran T84-bypass.ts, T84-escape.ts, T84b-destfail-check.ts and
T85-parity.ts against that reconstruction myself. I also wrote a new probe (`T88-neveroffset.ts`) with
three shapes of my own construction that never repeat a destination offset, to attack the disjointness
argument directly rather than accept it because a cache exists.

## Summary by severity

| Severity | Count | Ids |
|---|---|---|
| blocker | 0 | — |
| info | 2 | T88#F-001, T88#F-002 |

No blocking-and-reproduced finding. Both target fixes are closed, at the detector and all four public
boundaries, pinned by regressions I independently confirmed fail on the pre-change mechanism. Nothing
previously closed reopened. The accepted limitation is unchanged in extent.

## One row per item in the dispatch

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | The memoisation is gone, the cache changes no answer, and a shape that never repeats an offset still costs linearly | **CONFIRMED** | Own reconstruction (cache lookup removed, nothing else) reproduces the quadratic: `destFailWhitespaceTail`/`destFailNewlineTail` at 200 001 bytes cost 7 213.8–7 228.4 ms on the reconstruction vs 6.1–24.9 ms on the shipped code (`T88-destfail-check-reconstruction.log`). Cache-changes-no-answer: `exfil.test.ts`'s `T84#F-001` test asserts a resolving/allowlist scenario unaffected by the cache (three offsets, three distinct answers, middle one released by allowlist) — read and confirmed present. Never-repeats-offset: my own three shapes (`growingDistinct`, `manyShortDistinctFails`, `growingRunsDistinct`, none reused from the test suite or from T85's own probes) stay linear-or-sub-linear (exponents 0.47–0.80) up to 1 MB with zero shapes over budget (`T88-neveroffset.log`) |
| 2 | The escape-aware pairing release is gone; ruling on the "flag but never skip" rule | **CONFIRMED closed; rule RATIFIED as the right permanent shape, not merely accepted** | All 8 class-B rows in `T84-bypass.ts`/`T84-escape.ts` read `closed` against the shipped code, including on my own reconstruction where the same rows read `BYPASS`/`prechangeFindings:0` (`T88-bypass-reconstruction.log`). `x09EscapeInAltOnly` closed. The cursor guard is implemented exactly as described — four cursor-affecting writes (`exfil.ts:1772`, `1774-1775`, `1849`, `1864`) are each reached only when `!construct.escapeAware`/`!inline.escapeAware`; a construct found only through end 3/4 falls through to classification without moving `BRACKET_OPEN.lastIndex`. See "Ruling on the cursor-guard rule" below |
| 3 | Nothing else moved | **CONFIRMED, with one tooling caveat disclosed** | 18/19 matrices byte-identical to T82's own recorded logs, re-run by me independently (`T83-T88check-*.log`, phase `T88check`). `T53-corpus`: `benignFilesWithFindings: 16`, `benignFindings: 62`, Part B 7 flagged with the same 7 ids — all byte-identical to T85's claim. `totalFindings`/`filesWithFindings`/`egress.html-image-exfil` moved by exactly +1 against T85's own last recorded corpus log, traced to a `.metaproject/data/gdctx/artifacts/*.md` file this review's own `keryx ctx rg` calls created, which echoes `exfil.ts`'s header comment text (`<img src="URL">`) verbatim — the identical dynamic T85 itself disclosed for its own session ("this round's prose writes URL where a host would sit... T83's spec moved the header because it quoted `<img src=...>` verbatim"). Not a module regression; see Evidence |
| accepted limitation | Container-block class (T84#F-002) unchanged in extent | **CONFIRMED unchanged** | `T84-bypass.ts` re-run: exactly the same 12 class-A ids `BYPASS` (`a01`…`a12`), zero others. `T84-escape.ts` re-run: exactly the same 5 class-A ids `BYPASS` (`x20`, `x20b`, `x21`, `x21b`, `x22`) — 17 total, matching the dispatch's count exactly. `RESIDUALS.md` re-read in full: the accepted-limitation box's text is unchanged from what T84-review.md quotes it as |

## Findings

### T88#F-001 — info — no length gate exists at any of the four public boundaries before invoking detection, and the destination-read fix removes the only reason that mattered this round

- **file / line / symbol**: `src/mcp/dispatch.ts` (`dispatchCallTool`, `:83-101`); `src/security/detect/index.ts` (`runDetectors`, `:31-53`, unconditionally calls `detectExfil` when the egress policy is enabled).
- **problem**: read both files in full. Neither dispatch nor `runDetectors`/`runDetectorsAsync` caps input length before running detection. This is structurally the same absence T84#F-001's `class_scope` named across `dispatch.ts`, `redact-seam.ts` and `guard.ts`.
- **impact**: none currently — T84#F-001's quadratic is the only live cost defect this absence made exploitable, and it is closed (worst shape found at 1 MB across all four boundaries: `escapedCloseRunWithDef`, 660.3 ms, independently re-measured — see Evidence). Recorded so a future change to the detection pipeline that reintroduces superlinear cost on any shape is not silently unguarded a second time; a size cap is defense-in-depth, not a fix for anything open right now.
- **suggested_fix**: none required by this round's scope. If ever revisited: a length gate at the boundary layer, independent of any one detector's own asymptotic argument.
- **evidence**: full read of `src/mcp/dispatch.ts` (127 lines) and `src/security/detect/index.ts` (140 lines); no length check present in either.
- **confidence**: high
- **blocking_merge**: false

### T88#F-002 — info — this round's own review tooling inflated the corpus scan's `totalFindings` by exactly one, and it is not a module regression

- **file / line / symbol**: `.metaproject/data/gdctx/artifacts/2026-09-07T03-59-21-027Z_read.md` (a review-session artifact, not a production, test or documentation file).
- **problem**: `T53-corpus`, re-run by me, shows `totalFindings: 636` / `filesWithFindings: 105` / `egress.html-image-exfil: 398` against T85's own last-recorded `filesScanned 23513→23527` sweep's `635`/`104`/`397`. Traced the +1 to a `gdctx` artifact this review's own `keryx ctx rg "escapeAware|BracketConstruct|lastIndex = "` search created, which — because `exfil.ts`'s own header comment literally contains `` `<img src="URL">` `` as illustrative prose — is picked up by the corpus's html-image-exfil pattern once persisted as a new file under `.metaproject/data/gdctx/artifacts/`.
- **impact**: none on the module. The 16-file/62-finding benign list and the 7 Part-B flagged ids — the numbers the acceptance criteria actually name — are byte-identical to T85's claim. This is the identical class of noise T85-implementation.md itself disclosed for its own session's artifacts, now recurring for mine, which is worth naming precisely rather than leaving as an unexplained one-count drift for the next round to puzzle over.
- **suggested_fix**: none; this is a property of how the corpus scan and the routing tool's own artifact-writing interact, already understood and out of this round's scope to change.
- **evidence**: `T83-T88check-T53-corpus.log` vs `T85-final-T53-corpus.log` (diff: `filesScanned`, `totalFindings` 635→636, `filesWithFindings` 104→105, `egress.html-image-exfil` 397→398, `elapsedMs`; benign list and Part B otherwise byte-identical); `keryx ctx rg "img src|<img" ...` isolating the one artifact file carrying the match, at the exact header-comment line `exfil.ts` quotes as illustrative prose.
- **confidence**: high
- **blocking_merge**: false

## Ruling on the cursor-guard rule

The dispatch asks me to rule on "flag but never skip" as a permanent shape, not merely note it exists.
Having read the mechanism in full (`descriptionEnds`'s `blind` count, `readBracketConstructs`'s
`escapeAware` tag, and all four guarded cursor writes at `exfil.ts:1769-1776`, `1848-1855`, `1864`) and
having independently reproduced the release the guard prevents is real (the fuzz-found document T85
documents — a spurious link swallowing the next line's genuine image — is a direct, mechanical
consequence of letting an escape-aware-only construct move `BRACKET_OPEN.lastIndex`, and the guard's
absence is exactly what T85-parity.ts's `spanMoveCount`/`hostReleaseCount` would stop being zero on if it
were removed): **I ratify it.** The asymmetry it creates — an escape-aware construct can only ADD a
finding, never suppress one by skipping ahead — is the correct permanent shape for a floor whose stated
invariant is "no release," not "no over-flag." A scanner that is allowed to skip past a construct it just
discovered via a candidate end it invented itself is reasoning about renderer behavior it has not
established; flagging without skipping costs only extra findings (an allowlist's remedy), while skipping
costs a silent release (nothing's remedy). The two are not symmetric risks, and the rule correctly weighs
them asymmetrically. I would not defer this to "restore the skip once a renderer differential covers it"
as T85's own concern 1 leaves open as a live question — a renderer differential covering the general case
would need to hold for every future shape, not just the ones fuzzed so far, and "flag but never skip" has
no failure mode in the release direction by construction, which a restored skip would reopen. Keep it.

## Ruling on the three disclosed items

1. **Three new false positives, one shape (`![a[b[c]d]\]e](URL)`), zero benign instances in 23 000+
   files.** Independently reproduced: `detectExfil` flags it, `marked` renders no `<img>` for it
   (checked directly against the installed `marked`, not assumed). Direction is toward over-flagging,
   the remedy is the allowlist, and the benign-corpus check above confirms zero real-world instances.
   **Accepted as documentation-grade**, consistent with this floor's stated bias (a release is the thing
   that must never happen; an occasional over-flag on a shape this obscure is the acceptable cost of the
   nested-balanced end that closes the real bypass).
2. **`x09EscapeInAltOnly` pinned by probe, not by unit test.** Independently confirmed byte-identical to
   `b01FullRefEscapedAlt`, which the regression suite does pin (`` `![a\\]][b]\n\n[b]: ${U}\n` `` appears
   verbatim in both `T84-escape.ts:56` and `exfil.test.ts:1964`). Since the two are the same input driven
   through two different harnesses, `b01`'s unit-test pin is durable coverage for `x09` in every practical
   sense — a future change that regresses `x09` regresses `b01` identically, and `b01` is a `bun test`
   failure, not a probe someone has to remember to re-run. **Accepted as documentation-grade**; the
   "probe-only, not unit test" framing slightly understates the actual coverage, and I'd say so rather
   than leave the concern reading as more open than it is.
3. **First boundary probe's false failure, corrected to best-of-three, correction written into the
   probe.** Verified directly: `T85-cost.ts:162-167` carries the exact disclosure in a comment (single
   cold call read 1 120.1 ms for a shape that reads 590.9 ms warm, reported as a false acceptance
   failure; methodology corrected to best-of-three, matching every prior round in this flow). This is the
   correct place to write the correction — a methodology fix belongs in the instrument, not as a caveat
   bolted onto the claim it would otherwise call into question. **Accepted as documentation-grade**, and
   I independently re-ran `T85-cost.ts boundary` to completion myself (34.8 s — the run T84 abandoned as
   impractical before the fix, T85 completed and I have now completed a second time from a cold process):
   `boundariesOverOneSecond: []`, worst shape `escapedCloseRunWithDef` at 1 048 615 bytes, **660.3 ms** at
   the `persist` boundary — consistent in magnitude with T85's own 607.4–691.2 ms range for the same
   shape family, not a discrepancy.

## Residual classification

| Finding | Class | Where it belongs |
|---|---|---|
| T88#F-001 | documentation-grade | No live exploit; recorded as a structural absence for whoever next changes the detection pipeline |
| T88#F-002 | documentation-grade | Tooling/methodology note about this review's own footprint on the corpus scan, not a code defect |
| T84#F-002 (container-block class) | accepted, unchanged | Confirmed still exactly 17 bypassing rows (12 + 5), `RESIDUALS.md`'s accepted-limitation box unchanged; not reopened, per the scope decision |
| T84#F-004 (record correction) | already resolved | No code implication; not revisited |

No finding this round fires the scope decision's one exception (blocker reproduced at a public boundary).

## State of this module at close

Twelve prior rounds plus this one: the module now has two independently-derived, empirically pinned
linearity arguments (label-side disjointness from T81/T82/T83, destination-side disjointness from T85)
covering every path this detector's own reference-definition and description-pairing machinery can take,
and I re-derived and attacked both rather than accepted them — the "never repeats an offset" shapes I
built myself, independent of the test suite's own two, stay linear, and my own reconstruction (not a
saved copy, built fresh from the shipped file by reverting exactly the two documented mechanisms)
reproduces both pre-T85 defects at the magnitude every prior round recorded. The escape-aware pairing
closes a real, renderer-confirmed bypass class without widening the floor's over-approximation appetite
beyond one narrow, disclosed, zero-benign-instance shape, and does so under a cursor-discipline rule that
I read carefully enough to rule on rather than pass through: it is the right rule, for the reason given
above, and I would resist relaxing it without the kind of renderer-differential coverage this file does
not yet have.

What remains genuinely open is exactly what the user's decision already named and closed as a decision,
not a gap in this round's work: reference definitions inside a block container. Nothing in this round
touches that surface, nothing in this round's evidence suggests it has moved by so much as one case, and
I found nothing adjacent to it that should reopen it. For whoever picks this module up next: the two
structural defects this flow spent its last two rounds on are closed and re-verified independently by a
reviewer who wrote none of the fix; the one thing left on the table is the one thing already decided to
stay on the table. I would call this module's mandatory-floor obligation, as scoped by the twelve rounds
that preceded this one, closed.

## Confirmed clean areas

- **T84#F-001 is closed and the cache is proven sound**, independently, on a reconstruction I built
  myself rather than one I inherited: quadratic (~7.2 s at 200 001 bytes) on the reconstruction, linear
  (single-digit to low-double-digit ms) on shipped code; a cache-changes-no-answer regression is present
  in `exfil.test.ts`; three shapes of my own that never repeat an offset stay sub-linear to linear
  (0.47–0.80) to 1 MB.
- **T84#F-003 is closed for all 8 class-B rows**, at the detector and all four public boundaries,
  independently reproduced as bypassing on my own reconstruction and closed on shipped code.
- **The cursor guard is real, correctly placed at all four write sites, and ratified** as the module's
  permanent behaviour for escape-aware-only constructs.
- **The accepted limitation (container-block class) is unchanged**: same 17 rows, same `RESIDUALS.md`
  text.
- **18 of 19 prior matrices are byte-identical**, independently re-run by me under a fresh phase name so
  as not to disturb the recorded logs.
- **The benign corpus is unchanged**: 16 files, 62 findings, 7 Part-B flagged ids, all byte-identical.
- **`bun test` on the four focused suites: 119 pass / 0 fail / 1393 expect(), exit 0** — exactly T85's
  reported count, independently re-run.
- **`bun run typecheck` clean; `bunx eslint` on both changed files: 0 problems** — independently re-run.
- **No shape found over 1 000 ms at any public boundary up to 1 MB.** Worst shape I independently
  measured: `escapedCloseRunWithDef` at 1 048 615 bytes, **660.3 ms** at the `persist` boundary
  (`T88-cost-boundary.log`), consistent with T85's own reported range for the same shape.

## Evidence

Every command run from `/Users/Goodea/goodea/keryx` on branch `codex/agent-first-core`. No git state
change, no flow state change, no dependency change, no network, no model call. Synthetic and reserved
hosts only (`attacker.invalid`, `ok.example.org`, `cdn.example.org`). Production, test and documentation
files were read-only; the only files this review wrote are `T88-review.md`, `T88-result.json` and the
probe scripts named `T88-*.ts`, all under this flow's artifacts directory, plus raw log files under
`.metaproject/data/gdctx/raw/` (the flow's established convention for tool output, used by every prior
round including T84 and T85). A `mkdtemp` directory held the pre-T85 reconstruction and the run shims;
removed at the end of this session.

`src/security/detect/exfil.ts` hashes `4e6668b8295ead46963385553b037d5718d7b35416cfea37bdfcf517e53bb44c`
and `exfil.test.ts` hashes `aec80e0562be8f9964d3b400e9ba756a250289cbb153a4a425dcd2f28ae58e6b` — both
re-checked at the end of this review, both unchanged from the values recorded at the top.

### Reconstruction method

Built fresh from the shipped `exfil.ts`, not reused from any prior round's (removed) temp directory:
(1) `readDefinitionDestination`'s `cache.get`/early-return removed, so every call recomputes — reproducing
T84#F-001's mechanism exactly, since the cache is the only change that mechanism describes; (2)
`descriptionEnds` returns immediately after computing the two escape-blind ends (`blind = ends.length`),
before the escape-aware appending — reproducing T84#F-003's mechanism exactly, since appending is the
only change that mechanism describes. Nothing else in the file was touched; the two relative imports were
made absolute so the copy runs outside the source tree. Verified faithful by reproducing both defects at
the expected magnitude before using it as a comparison baseline.

### Probes run (all re-run by me; none trusted from a log alone without also being executed)

| Path | Raw log | What it shows |
|---|---|---|
| `T84b-destfail-check.ts` (shim: `pre`=`post`=shipped) | `.metaproject/data/gdctx/raw/T88-destfail-check-shim.log` | shipped code fast at all six rows (2.2–24.9 ms) and at the 262 144-byte `redactToolOutput` call (24.1 ms) |
| `T84b-destfail-check.ts` (real reconstruction) | `.metaproject/data/gdctx/raw/T88-destfail-check-reconstruction.log` | reconstruction quadratic (433–7 228 ms), shipped code fast (2.2–12.4 ms), same run, same process |
| `T84b-destfail-4boundary.ts` | `.metaproject/data/gdctx/raw/T88-destfail-4boundary.log` | all four boundaries at 196 610 bytes: 15.8–25 ms, `allOverOneSecond: false` |
| `T84-bypass.ts` (shim) | `.metaproject/data/gdctx/raw/T88-bypass-shim.log` | 12 class-A `BYPASS`, all class-B `closed` |
| `T84-bypass.ts` (real reconstruction) | `.metaproject/data/gdctx/raw/T88-bypass-reconstruction.log` | all class-B rows `prechangeFindings: 0` on the reconstruction, `closed` on shipped code |
| `T84-escape.ts` (shim) | `.metaproject/data/gdctx/raw/T88-escape-shim.log` | 5 class-A `BYPASS` (`x20`/`x20b`/`x21`/`x21b`/`x22`), `x09EscapeInAltOnly` `closed` |
| `T85-parity.ts` (real reconstruction) | `.metaproject/data/gdctx/raw/T88-parity-reconstruction.log` | 28 000 documents, `spanMoveCount: 0`, `hostReleaseCount: 0`, `additionsWithoutBackslash: 0` — byte-identical to T85's own recorded run |
| `T88-neveroffset.ts` (mine, new) | `.metaproject/data/gdctx/raw/T88-neveroffset.log` | three never-repeat-offset shapes, exponents 0.47–0.80, zero over 1 000 ms to 1 MB |
| `T85-cost.ts boundary` | `.metaproject/data/gdctx/raw/T88-cost-boundary.log` | full sweep to 1 MB, all four boundaries: `boundariesOverOneSecond: []`, worst `escapedCloseRunWithDef` 660.3 ms |
| `T83-matrices.sh T88check` | `.metaproject/data/gdctx/raw/T83-T88check-*.log` (19 files) | 18/19 byte-identical to T82's own logs; `T53-corpus` differs only as described in T88#F-002 |
| `bun test` (4 focused files) | `.metaproject/data/gdctx/raw/T88-focused-suites.log` | 119 pass / 0 fail / 1393 expect(), exit 0 |
| `bun run typecheck` | `.metaproject/data/gdctx/raw/T88-typecheck.log` | clean, exit 0 |
| `bunx eslint` (both changed files) | `.metaproject/data/gdctx/raw/T88-eslint.log` | 0 problems, exit 0 |

### Tooling disclosure

`bun` was invoked directly for every probe and suite rather than through `keryx ctx run`: the per-shape
timing rows are the evidence and this project's compaction elides them — the same disclosure every prior
round in this flow has made. `keryx ctx rg`'s summary silently dropped rows twice this round in exactly
the way the dispatch warned it would: a search for `descriptionEnds|readReferenceDefinitions|...` (4
matches) rendered correctly, but a search for `escapeAware|BracketConstruct|lastIndex = ` reported
"Matches: 50" while rendering only 4, and a search over `exfil.test.ts` reported "Matches: 6" while
rendering only 4; both times the raw log under `.metaproject/data/gdctx/raw/` was read directly with the
hook's own `# keryx:raw` escape marker and a stated reason, per the dispatch's own disclosure. The
routing hook additionally refused raw `cat`, `grep`, `sed`, `find`, `tail`, `head` and `git log`; every
refusal was honoured and the command reissued through the routed form or with `# keryx:raw` and a stated
reason.

No git state change, no flow state change, no dependency change, no network, no model call, no `git
stash`, no worktree touched, no `bun test` without file arguments.

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file was named in the dispatch or found by direct
  inspection of files that were; there was no blast-radius question for gdgraph to answer.
- `wiki_used`: **no** — *not-relevant*. The normative sources for this task are the flow's own artifacts
  (`RESIDUALS.md`, `T84-review.md`, `T85-spec.md`, `T85-implementation.md`) plus CommonMark and `marked`'s
  own rendering behaviour, not the project wiki.
- `ctx_used`: **yes** — `keryx ctx rg` for code searches and `keryx ctx read` for artifact/log reads,
  with two dropped-row incidents disclosed above and their raw logs read directly with a stated reason.
- `raw_rg_used`: **no** raw `rg`/`grep` ran as a code search; `cat`/`grep`/`sed`/`find`/`tail`/`head`/`git
  log` were each refused by the routing hook and reissued through the routed form or with `# keryx:raw`
  and a stated reason, per the dispatch's own disclosure that this project's routed tooling can withhold
  evidence.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T88#F-001",
    "reviewer": "T88-independent-verifier",
    "severity": "info",
    "file": "src/mcp/dispatch.ts",
    "line": 83,
    "symbol": "dispatchCallTool",
    "problem": "Neither dispatchCallTool (src/mcp/dispatch.ts:83-101) nor runDetectors/runDetectorsAsync (src/security/detect/index.ts:31-101) caps input length before running detection. This is the same structural absence T84#F-001's class_scope named across dispatch.ts, redact-seam.ts and guard.ts.",
    "impact": "None currently: the only live cost defect this absence made exploitable (T84#F-001, the unmemoised destination read) is closed and independently re-verified in this round. Recorded so a future change to the detection pipeline that reintroduces superlinear cost on any shape is not silently unguarded a second time.",
    "suggested_fix": "None required by this round's scope. If ever revisited: a length gate at the boundary layer, independent of any one detector's own asymptotic argument, as defense in depth.",
    "evidence": "Full read of src/mcp/dispatch.ts (127 lines) and src/security/detect/index.ts (140 lines); no length check present in either.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-002",
    "global_id": "T88#F-002",
    "reviewer": "T88-independent-verifier",
    "severity": "info",
    "file": ".metaproject/data/gdctx/artifacts/2026-09-07T03-59-21-027Z_read.md",
    "symbol": "T53-corpus scan artifact interaction",
    "problem": "T53-corpus, re-run in this review, reports totalFindings 636 / filesWithFindings 105 / egress.html-image-exfil 398 against T85's own last-recorded 635/104/397. Traced to a keryx ctx rg search this review ran, whose gdctx artifact persists exfil.ts's own header-comment prose (which illustrates `<img src=\"URL\">` as an example) as a new file the corpus's html-image-exfil pattern then matches.",
    "impact": "None on the module. The benign-corpus numbers the acceptance criteria actually name (benignFilesWithFindings: 16, benignFindings: 62, 7 Part-B flagged ids) are byte-identical to T85's claim. This is the identical class of noise T85-implementation.md disclosed for its own session's artifacts, now recurring for this review's.",
    "suggested_fix": "None; a property of how the corpus scan and the routing tool's own artifact-writing interact, already understood and out of this round's scope to change.",
    "evidence": "T83-T88check-T53-corpus.log vs T85-final-T53-corpus.log: filesScanned, totalFindings 635->636, filesWithFindings 104->105, egress.html-image-exfil 397->398, elapsedMs differ; benign list (16 rows) and Part B (7 ids) byte-identical. keryx ctx rg \"img src|<img\" over the new artifact files isolated the one match, at exfil.ts's own illustrative header-comment line.",
    "confidence": "high",
    "blocking_merge": false
  }
]
```
