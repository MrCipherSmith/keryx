STATUS: DONE_WITH_CONCERNS

# T76 — independent recheck of T75's repair of T70 F-001..F-004

Reviewer: independent `review-logic` + `review-security-code`. I wrote none of
the code, none of the earlier reviews, and none of the repairs under recheck.

## Scope

- Root: `/Users/Goodea/goodea/keryx` (`pwd` confirmed before the first read).
  No `.claude/worktrees/**` directory was entered. No `git stash` at any point.
- Branch: `codex/agent-first-core`. HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`.
  All work under review is uncommitted in this checkout.
- Rows verified: (1) the three F-001 guidance corrections, re-enumerated
  independently rather than re-read; (2) the F-002 fourth `SourceRunInfo.error`
  producer and its closed vocabulary; (3) the F-003 manifest §14 claim, plus
  the rest of that manifest; (4) the F-004 regressions, checked for whether
  they would actually fail if the leak returned and whether they assert on
  the artifact.

### File hashes (SHA-256), start → end

`T76-hashes-start.txt` / `T76-hashes-end.txt` (same directory). Every file is
**byte-identical start to end** — I made zero production/test/doc edits, and
the concurrently-reviewed files (`src/security/detect/exfil.ts`,
`docs/requirements/keryx-agent-first-core/policies.md`) did not drift during
this review window either:

| File | start = end |
|---|---|
| `src/health/run.ts` | `4b717b42…f059cca` |
| `src/health/types.ts` | `2ab7d681…6505a1` |
| `src/health/gate.ts` | `4d31021c…44514faa5` |
| `src/health/service.ts` | `dfe70c76…1b0b707` |
| `src/security/templates.ts` | `114236bc…7a5a8` |
| `src/security/templates.test.ts` | `1a6e1bcf…d7b47df5690` |
| `src/security/self-protect.ts` | `c9fbe520…65e6287` |
| `src/commands/security.ts` | `7e01dc0e…7f0` |
| `docs/docs/cli-reference.md` | `23d22fc2…068b4c58` |
| `docs/docs/modules.md` | `15c9f1a1…3e3` |
| `.metaproject/modules/security.md` | `29ba2cb4…c6ba84c` |
| `src/health/health-truthful-gate.test.ts` | `f7367dd0…593ad` |
| `src/security/detect/exfil.ts` (other worker's file) | `ef029fe3…efed8a` |
| `docs/requirements/keryx-agent-first-core/policies.md` (other worker's section) | `024d1d03…95beb97` |

## Summary

| Severity | Count |
|---|---|
| blocker | 0 |
| major | 2 |
| minor | 3 |
| info | 0 |

Stage 1 **FAILS on row 1**. Rows 2, 3 and 4 pass under my own execution. The
row-1 failure is not a defect in T75's own delta — T75's three corrected
sentences are verified accurate — it is a failure of the row's own mandate to
*re-enumerate independently*: two genuinely new, previously-unswept sites
still misdescribe security-mode exit behaviour, one of them shipped into
every scaffolded project's `.git/hooks/pre-push`. Stage 2 was therefore not
entered.

## Stage 1

| # | Item | Verdict | My probe and what it showed |
|---|---|---|---|
| 1 | The three guidance corrections; re-enumerate every description of exit/mode behaviour independently, both directions | **FAIL** (T75's own delta is correct; two new sites found) | `T76-guidance.log` (`bun …/T76-guidance.ts`, written fresh, not derived from T70's or T75's probe). **T75's own fix is accurate**: claim `T1` (the `cli-reference.md:2137-2148` paragraph — `advisory` always 0; `enforced`/`ci`/`gateway` exit 1 on anything but `pass`) is `CLAIM_HOLDS:true` against 19 load-bearing measured cells including `check-output`, which neither T70's nor T75's own probe ever measured. Claim `T2` (`modules.md:778`'s corrected Exit cell) is likewise `CLAIM_HOLDS:true`. **But a from-scratch re-enumeration (section B), extended to `src/lib/templates.ts` — a shipped-guidance surface NONE of T62/T68/T70/T73/T75 ever swept — finds two genuine new defects**, detailed in F-001 and F-002/F-003 below: (a) `renderSecurityPrePushHook()`'s own shell-comment enumeration of blocking modes omits `gateway`, in the exact literal text written into every scaffolded project's `.git/hooks/pre-push`; (b) `modules.md`'s CLI-surface table mislabels `scan-mcp` and `security hooks install\|uninstall`'s Exit column as "mode-gated" when both are measured (claims `T3`/`T3b`/`T4`/`T4b`, all executed) to be gated by something else entirely — `--strict` for `scan-mcp` (identical exit under every mode for the same `--strict` value), pure validation for `hooks install` (identical exit under every mode for the same runtime validity). A CI job that sets `mode: "ci"` believing that alone makes `security scan-mcp` gate on MCP threats — exactly what the adjacent paragraph at `modules.md:784-787` implies for every row marked "mode-gated" — never fails, regardless of what `scan-mcp` finds, unless `--strict` is also passed; that is the "a check that did not pass looks like a pass" shape this whole phase exists to close, one row this phase's five prior rounds never reached. |
| 2 | The fourth `SourceRunInfo.error` producer; verify the enumeration is complete and the closed vocabulary cannot be escaped | **PASS** | `T76-health-leak.log` (`bun …/T76-health-leak.ts`, written fresh, mock-free — drives the real unmodified `runAdapter`+`computeGate`+`writeOutputs`, never `mock.module`). **Enumeration verified complete by three independent axes**, none inherited from T69's or T75's own list: (a) `error:` object-literal grep over `src/health` excluding tests — raw log 15 lines (header said 15, the compacted summary rendered only 10 — the documented undercount reproduced again, raw read directly), giving exactly 5 write sites in `run.ts` (`:308,:343,:365,:385-387,:428`) plus the 7 constant-literal sites in the two adapters' `validate()`; (b) a `\.error\s*=[^=]` sweep for dot-notation assignment (a shape the `error:` literal grep cannot see) — zero hits, so no write bypasses the literal-object-key enumeration; (c) a `SourceRunInfo` type-usage grep — confirms `run.ts` is the *only* file in the module that constructs an object of this type (types.ts only declares it, gate.ts only imports the type for a parameter), so no other producer exists anywhere in the module. Traced `gate.ts:78` (the sole reader that folds `.error` into `gate.reasons`) and `report.ts` (contains no reference to `error` at all — the markdown renders from `gate.reasons`, already sanitized) to confirm there is no second path into the committable artifact. **The closed vocabulary resists every escape I tried**: 9 rows (`A1`-`A9`) through the real `runAdapter`, including a known-safe string with trailing whitespace, a case-differing known string, a known string used as a prefix of a longer attacker string, an empty string, `undefined`, and a 500-byte attacker-controlled string with no known substring — every non-exact-match row falls back to the safe constant (`LEAK_json`/`LEAK_md`/`LEAK_serviceReasons` all `{path:false,cred:false}`), while both genuinely known-safe strings (rows `A2`, `A6` — including one from the *other* adapter's vocabulary) survive unchanged, proving the fix keeps real diagnostic value rather than blanket-suppressing. Rows `C1`-`C5` re-confirm the three T69 catch-arm producers remain closed, including `safeErrorCode`'s regex rejecting a payload smuggled through `error.code` and a 64-character code exceeding the length bound. **Section B is the load-bearing proof that the shipped regressions are not vacuous**: I manually constructed a `SourceRunInfo` with raw attacker text in `.error` (bypassing `runAdapter` entirely — simulating exactly what `run.ts:356-388` would produce if `safeValidationError` were reverted) and fed it through the unmodified `computeGate`→`writeOutputs`→disk→`createCodeHealthService().gate()` pipeline: the leak surfaces at every hop (`LEAK_json`/`LEAK_md`/`LEAK_serviceReasons` all `{path:true,cred:true}`), proving the pipeline downstream of the producer sanitizes *nothing* on its own — the safety property depends entirely on `run.ts`'s producer being correct, which is exactly what the shipped `not.toContain` assertions are testing. |
| 3 | The manifest §14 claim; verify the corrected sentence and check the rest of the manifest for other unsupported claims | **PASS** (corrected sentence verified; one new minor finding elsewhere in the same manifest) | `T76-guidance.log`, row `Row3 manifest §14`: `correctedSentencePresent:true` (whitespace-normalized match, same discipline the shipped `templates.test.ts` regression uses — a naive byte match false-negatives on the template literal's line-wrap, caught and fixed in my own probe before trusting the result), `staleSentenceAbsent:true`, `findingsPushSitesInSelfProtect:1` — independently re-confirmed by reading `self-protect.ts` in full: `findings.push(` occurs exactly once (`:90`, the checksum arm); the mode-downgrade arm (`:122-132`) and disabled-policy arm (`:160-172`) each push a warning + an incident, never a finding, and `service.ts:107-111`'s `analyze()` folds only `selfProtection.findings` into the decision. Also ran the shipped regression directly (`bun test src/security/templates.test.ts`, part of `T76-tests.log`): pass. **The rest of the manifest**: one further claim the code does not fully support, shared with row 1 — four sites (`.metaproject/modules/security.md:49`, `src/security/templates.ts:64`, `src/commands/init.ts:497`, `src/lib/templates.ts:2064`, exact count confirmed by a clean, non-undercounted `ctx rg` for the literal phrase) say blocking happens "on a secret/critical finding," but `resolve.ts:132-161`'s `computeGate` (read in full) gates `fail` on *any* category's `action==="block"` or severity ≥ the configured `failOn` threshold, and `needs-approval` (which also exits non-zero in a blocking mode — confirmed by my own `report\|{enforced,ci,gateway}\|needs-approval` cells, all `1`) on *any* category's `require-approval` action — not specifically "secret" or "critical." See F-004. |
| 4 | The strengthened regressions; verify they would fail if the leak returned and that they assert on the artifact, not an in-memory value | **PASS** | Read `health-truthful-gate.test.ts:540-649` in full: both new tests (`F-004/F-005`, `F-004/F-002`) call the real `runAdapter`→`computeGate`→the real exported `writeOutputs` (writing to a `mkdtemp` root), then `readFile` the **actual** `.metaproject/data/health/artifacts/latest.{json,md}` bytes back from disk, then call the real `createCodeHealthService().gate({cwd: root})` — traced `service.ts:82-120`'s `readLatest` to confirm this genuinely re-reads `latest.json` from disk rather than reusing the in-memory report (a fresh `readJsonObjectFile` call, no shared closure). Executed directly: `bun test src/health/health-truthful-gate.test.ts src/security/templates.test.ts` → **21 pass / 0 fail / 121 expect()** (`T76-tests.log`), matching T75's own reported count. **"Would fail if the leak returned"**, proven rather than assumed: my Row-2 section-B probe (above) shows the identical `writeOutputs`/disk/`service.gate()` pipeline these two tests drive faithfully propagates whatever `.error` a producer supplies — so if `run.ts`'s fix at `:356-388` regressed, these tests' `not.toContain(ATTACKER_PATH)` assertions on `jsonBytes`/`mdBytes`/`serviceReasons` would fail exactly the way my simulated-revert row did. **Cross-file hazard re-checked myself, both orders**: `bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts` and the reverse → **18 pass / 0 fail / 118 expect()** both orders (`T76-hazard-order1.log`/`T76-hazard-order2.log`) — the shipped mock-free design is clean. |

## Judgement calls

### Two test-only exports in `src/health/run.ts` (`runAdapter`, `writeOutputs`) — **acceptable, on the same terms T70 already applied to the first one, now doubly earned**

1. **Blast radius, enumerated, not asserted.** `ctx rg "writeOutputs" src --glob '!*.test.ts'` → exactly 2 hits, both in `run.ts` itself (the definition and `runHealth`'s own call site); `ctx rg "writeOutputs" src --glob '*.test.ts'` → all 8 hits confined to `health-truthful-gate.test.ts`. Combined with T70's own confirmation for `runAdapter` (4 hits total, 2 production, 2 test, all inside this module), **nothing outside `src/health/run.ts` and its own test file can reach either export**; the module's public seam (`createCodeHealthService()`) is unchanged.
2. **The hazard is real, and I reproduced it myself** (not merely trusted the two narrative reports). `T76-hazard-repro.test.ts` — written fresh, mocking `./sources` with a same-test synchronous restore, the exact discipline `service.test.ts` uses successfully for `./store` — run together with `src/health/provenance.test.ts` (T69's own reproduction case): **when the mocking file runs first**, `provenance.test.ts`'s "strict health runs an available compiler instead of treating missing import format as missing source" test fails identically to both prior reports (`source?.status` comes back `undefined` instead of `"available"` — `T76-hazard-repro-order1-FAIL.log`). One caveat my own repro adds that neither prior report's narrative surfaced: **in my minimal repro this is order-sensitive** — the reverse order (`provenance.test.ts` first, my file second) passed clean (`T76-hazard-repro-order2-pass.log`), most likely because `run.ts`'s own static `import { FINDING_ADAPTERS } from "./sources"` binding is fixed at `run.ts`'s first evaluation in the process, and `provenance.test.ts` running first causes that first evaluation to happen before any mock is installed. This does not contradict "the hazard is real" — I reproduced the identical failure the two prior reports describe, in the direction that matters (a mock-based regression file placed anywhere `bun test` might run it before `provenance.test.ts`, which is not a controllable ordering) — it only means "either order" may be stronger than my own minimal repro demonstrates; not load-bearing for the ruling.
3. **The mock-free design covers what the mocked one would have, for the specific claim under test.** The two hops F-004 named are `SourceRunInfo.error → computeGate → gate.reasons` and `HealthReport → writeOutputs → disk → service.gate()`; both are exercised by calling the exact same production functions `runHealth` itself calls, in the same order, on the same data. What the mock-free design skips (coverage, complexity, churn, hotspots, wikiFreshness, baseline, skill-ownership tagging) is irrelevant to this claim: I confirmed by reading `gate.ts` and `report.ts` in full that nothing outside `run.ts`'s `error:` producers and `gate.ts:78` ever touches `SourceRunInfo.error`, so there is no other computation the mock-free design could have missed an interaction with. `runHealth`'s own fold-in step (`{ ...outcome.info, findings: filteredFindings.length }`, `run.ts:76`) is a plain spread that passes `.error` through unchanged — also confirmed by reading it, not assumed.
4. **The cost is documented at both sites** (`run.ts:266-275`, `:432-444`), naming the reason, the reproduced incident, and the invariant that no caller outside this module's tests uses either export.

**Ruling: both exports stay.** They leak no production surface, the hazard they avoid is independently confirmed rather than taken on faith, and the resulting design fully covers the claim it was built to cover.

## Findings

### [F-001] `src/lib/templates.ts`'s pre-push hook script — shipped into every scaffolded project's `.git/hooks/pre-push` — still enumerates blocking modes as `enforced`/`ci`, omitting `gateway`

- **Severity**: major
- **File**: `src/lib/templates.ts:2063-2065` (also `:2165`, same function)
- **Symbol**: `renderSecurityPrePushHook`
- **Problem**: the function's own header comment reads: *"Blocking is delegated to the CLI, which honors security.config.json mode: 'advisory' (default) always exits 0 (warn, never block); 'enforced'/'ci' exit non-zero on a blocking (secret/critical) finding."* A second comment inside the per-file loop reads *"# enforced/ci mode blocked on this file."* Since T61 (`isBlockingMode`) and T65 (`exitCodeFor`/`reportExitCode`), `gateway` blocks identically to `enforced`/`ci` at every layer this hook depends on (the underlying `keryx security scan` CLI call's own exit code). Both comments are written verbatim into `.git/hooks/pre-push` in every project where the operator accepts the install prompt (`init.ts:1369`) or runs `keryx update` (`update.ts:448`) — confirmed by reading both call sites. This is the identical defect shape T62 named, T68/T73/T75 corrected at eighteen other sites, and T70 re-confirmed closed at all eighteen — in a nineteenth site none of those five prior rounds ever swept, because `src/lib/templates.ts` was never in any of their enumerated surface lists (T73's own four-pass sweep covered `docs`, `.metaproject/modules`, `.metaproject/core`, `src/commands/init.ts` and `src/security/templates.ts`, never `src/lib/templates.ts`; T70's F-006 class covered `src/security/guard.ts`, `service.ts`, `src/flow/service.ts`, `src/flow/types.ts` — also never this file).
- **Impact**: AC8's "no shipped guidance describes behaviour the code does not have" fails on a surface with the same blast radius as the manifest/README the module already ships, and arguably more durable — a git hook, once installed, is not re-read casually the way a markdown doc is, and persists across `keryx update` unless the sentinel block is regenerated. An operator or an agent reading their own project's `.git/hooks/pre-push` to understand why (or whether) a push will be blocked under `gateway` mode is told only `enforced`/`ci` matter, which is exactly the "gateway mode is inert" misreading this entire phase exists to close.
- **Reproduction**: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T76-guidance.ts` (raw `.metaproject/data/gdctx/raw/2026-09-06T19-15-08-001Z_T76-guidance.log`, sha256 `2f5501d6ccb5d721662748d5786fcc4b2bdfd4d2df3089043c2fcb306ae1df78`), row `B pre-push hook script`: `containsEnforcedCiWithoutGateway:true`, `omitsGatewayLine:"  # mode: 'advisory' (default) always exits 0 (warn, never block); 'enforced'/'ci'"` — measured by calling `renderSecurityPrePushHook()` directly, the exact function `init.ts`/`update.ts` call. Independently corroborated by a byte-level `ctx rg` sweep (raw `.metaproject/data/gdctx/raw/2026-09-06T19-12-52-438Z_rg.log`, 8 lines, header undercounted to 4 in the compacted summary — read raw directly) that found this file's two lines as the only NEW suspects beyond the two already-classified non-defects (`cli-reference.md:1226`, `:2096`).
- **Suggested fix**: add `gateway` to both comments, matching the wording T68 already used at `src/security/templates.ts:63` ("`enforced`/`ci`/`gateway` block the push"). Add a `templates.test.ts`-style pinning regression for `renderSecurityPrePushHook()`'s own output, on the same pattern the shipped `renderSecurityManifest`/`renderSecurityCoreReadme` regressions already use, so this class cannot silently reopen a fourth time.
- **class_scope**:
  - sites: `src/lib/templates.ts:2063-2065` (header comment enumeration) — DEFECT; `src/lib/templates.ts:2165` (per-file loop comment) — DEFECT; correct and left alone, listed so the class is closed against this surface specifically: `src/security/templates.ts:63,125` (T68), `.metaproject/modules/security.md:48`, `.metaproject/core/security/README.md:17` (T73), `src/commands/init.ts:497` (T73), `docs/docs/cli-reference.md:330,754,912,993,1058,2095-2099,2137-2148` (T68/T73/T75), `docs/docs/modules.md:766,784-787,865,874,881` (T73/T75), `docs/docs/architecture.md:547,563,634` (T73), `docs/docs/workspace-and-lifecycle.md:339,350` (T73).
  - enumeration_method: a fresh, from-scratch regex sweep (not inheriting T68's, T70's or T73's site lists) over eight shipped surfaces — the same seven T70's own probe used, **plus `src/lib/templates.ts`**, which no prior round's surface list ever included — for lines naming `enforced`/`ci` with a blocking-behaviour verb and no `gateway` on the same line, executed in `T76-guidance.ts` §B. 4 raw suspects; 2 pre-classified non-defects (`cli-reference.md:1226` unrelated containment prose, `:2096` T68's own paragraph with `gateway` on the preceding line); 2 genuine, both in this file. Cross-confirmed by rendering the function directly rather than trusting the regex match alone.
- **Confidence**: high (measured against the function's actual rendered output, and against the two call sites that ship it into a real project).

### [F-002] `docs/docs/modules.md`'s CLI-surface table mislabels `security scan-mcp`'s Exit column "mode-gated"; measured, its exit code is a pure function of `--strict`, identical under every mode including `advisory`

- **Severity**: major
- **File**: `docs/docs/modules.md:774` (also implicated by the blanket claim at `:784-787`)
- **Symbol**: CLI-surface table, `scan-mcp` row
- **Problem**: the table's Exit column for `security scan-mcp <manifest|dir> [--json] [--pin]` reads simply "mode-gated," and the paragraph immediately below the table (`:784-787`) states "The mode-gated commands honor `config.mode`: **advisory** (default) always exits `0`; **enforced**, **ci**, and **gateway** exit `1` on any gate other than **pass**..." — a claim that, read against the table, applies to every row marked "mode-gated," `scan-mcp` included. Read `handleScanMcp` (`src/commands/security.ts:384-536`) in full: it never calls `modeOf(cwd)` and never reads `config.mode` anywhere; its only exit-affecting line is `if (args.includes("--strict") && (totalFindings > 0 || coverage === "incomplete")) { process.exitCode = 1; }` (`:533-535`).
- **Impact**: AC8's "no shipped guidance describes behaviour the code does not have" fails, and this is reachable in the exact "check did not pass, looks like a pass" shape this phase targets. `docs/docs/cli-reference.md`'s own separate `scan-mcp` description is accurate (says `--strict`, not mode) — but an operator relying on `modules.md`'s CLI-surface table and its adjoining paragraph, wiring `security scan-mcp` into a CI job under `mode: "ci"` without also passing `--strict` (reasonably inferred from "mode-gated" — why would `--strict` be needed if `ci` mode already gates it?), gets a job that **never fails on any MCP threat, in any mode**, silently passing a poisoned MCP manifest through CI.
- **Reproduction**: `T76-guidance.log`, claims `T3`/`T3b`: `scan-mcp|advisory|no-strict:0`, `scan-mcp|enforced|no-strict:0`, `scan-mcp|ci|no-strict:0`, `scan-mcp|gateway|no-strict:0` (a real threat present, all four modes clean); `scan-mcp|advisory|strict:1`, `…|enforced|strict:1`, `…|ci|strict:1`, `…|gateway|strict:1` (same threat, identical exit under every mode once `--strict` is added) — driven through the real `securityCommand(["scan-mcp", manifestPath, ...], root)` against a synthetic MCP manifest crafted to trip the `mcp.poisoning.ignore-instructions` detector (confirmed flagged: `1 finding(s)` at `conf 0.9` in the captured stdout).
- **Suggested fix**: change the `scan-mcp` row's Exit column to "`1` with `--strict`, on a threat or incomplete coverage (independent of mode)" and scope the `:784-787` paragraph explicitly to the rows it actually describes (`scan`, `check-input`, `check-output`, `report`) rather than leaving it to apply implicitly to every "mode-gated" row.
- **class_scope**:
  - sites: `docs/docs/modules.md:774` (scan-mcp Exit cell) — DEFECT; `docs/docs/modules.md:773,775,776` (scan/check-input/check-output rows) — correct, confirmed genuinely mode-gated by reading `handleScan`/`handleCheck`, both of which call `exitCodeFor(...,  await modeOf(cwd))`; `docs/docs/cli-reference.md:2145-2146` — correct, already describes `scan-mcp` by `--strict`, not mode.
  - enumeration_method: read every `handle*` function in `src/commands/security.ts` that a CLI-surface table row maps to (`handleScan`, `handleScanMcp`, `handleCheck`×2, `handleReport`, `handlePolicy`, `handleHooks`, `handleEval`) and noted, per function, whether `modeOf(cwd)`/`exitCodeFor`/`reportExitCode` is on the path that sets `process.exitCode`. Cross-checked every "mode-gated" table row against its handler this way, then confirmed the two genuine mismatches (this finding and F-003) by execution in `T76-guidance.ts`.
- **Confidence**: high (executed against the real command dispatcher across all four modes and both `--strict` states).

### [F-003] Same table: `security hooks install\|uninstall`'s Exit column is also mislabeled "mode-gated"; its exit code never reads `config.mode` at all

- **Severity**: minor
- **File**: `docs/docs/modules.md:782`
- **Symbol**: CLI-surface table, `hooks install|uninstall` row
- **Problem**: same shape as F-002, one row down. Read `handleHooks` (`src/commands/security.ts:764-817`) in full: `process.exitCode = 1` is set only for an invalid action, unknown runtime(s), or a post-install settings-validation error (`:808-809`); `modeOf(cwd)` is called once, only to decide whether to print an advisory *note* (`:799-802`), never to affect `process.exitCode`.
- **Impact**: lower than F-002 — `hooks install` is a one-time setup command, not something operators typically wire into a repeated CI gate the way `scan-mcp`/`scan`/`report` are, so the "silently passes" shape does not apply the same way. Still a shipped-guidance/code mismatch under AC8.
- **Reproduction**: `T76-guidance.log`, claims `T4`/`T4b`: `hooks-install|{advisory,enforced,ci,gateway}|unknown-runtime` all `1`; `hooks-install|{advisory,enforced,ci,gateway}|valid-runtime` all `0` — identical across every mode for both a bad and a good runtime, driven through the real `securityCommand(["hooks","install","--runtime",...], root)`.
- **Suggested fix**: change the Exit column to "`1` on an unknown runtime or a post-install validation error (independent of mode)."
- **Confidence**: high.

### [F-004] Four shipped sites narrow the pre-push block condition to "a secret/critical finding," but `computeGate` gates on any category's `block` action or its `require-approval` action, not on category or severity label alone

- **Severity**: minor
- **File**: `.metaproject/modules/security.md:49`, `src/security/templates.ts:64`, `src/commands/init.ts:497`, `src/lib/templates.ts:2064`
- **Symbol**: the shared "secret/critical finding" phrase
- **Problem**: `resolve.ts:132-161`'s `computeGate` (read in full) returns `"fail"` when `blockers.length > 0` (any finding, any category, whose resolved `action === "block"`) **or** `severe.length > 0` (any finding, any category, whose `severity` is at or above `config.gate.failOn`, default `"critical"`) — not specifically the `secret` category. It returns `"needs-approval"` on the strongest `require-approval` action across **any** category (e.g. `prompt-injection` escalated by a co-occurring `egress` signal, per `escalateInjection`, `:116-130`), and a `needs-approval` gate also exits non-zero under a blocking mode (confirmed: `report|{enforced,ci,gateway}|needs-approval` all `1` in my own probe). So a critical-severity PII finding, a block-action egress/exfil finding, or an escalated prompt-injection finding all trigger the identical push-blocking behaviour these four sites describe as specific to "a secret/critical finding."
- **Impact**: this is the *opposite* direction from F-001/F-002 — it undersells the blocking surface rather than oversells it, so the operational risk is an operator being surprised that a push was blocked for a reason they thought this text ruled out, not a security bypass. Recorded under AC8's "either direction" mandate; not blocking.
- **Reproduction**: `ctx rg "secret/critical" src docs/docs .metaproject/modules .metaproject/core` (raw `.metaproject/data/gdctx/raw/2026-09-06T19-21-03-823Z_rg.log`, sha256 `f1bf4b024fa6d2610be1a2f06114b46efc858c4ab4e0e4e1810fc2b05b084533`) — 4 matches, header and rendered list agree (no undercount this time), exactly the four sites listed above. `resolve.ts:132-161` read in full (unmodified, out of my ownership).
- **Suggested fix**: drop the category/severity qualifier — "blocks the push (non-zero exit) on a failing or needs-approval gate" — or, if a concrete example is wanted, "e.g. a secret, PII or escalated prompt-injection finding."
- **Confidence**: high.

## Confirmed clean areas

- **T75's three F-001 corrections are accurate**, measured against 19 load-bearing exit-code cells including `check-output`, a surface neither T70's nor T75's own probe ever exercised.
- **T75's F-002 fix (`safeValidationError`/`KNOWN_VALIDATION_ERRORS`) is complete and resists every escape I tried**: case, whitespace, prefix-of-attacker-string, empty, `undefined`, and a long no-substring string all fall back safely; both genuinely known-safe strings (including the sibling adapter's own vocabulary) survive unchanged.
- **T75's F-003 correction is present and matches `self-protect.ts`'s real behaviour** (exactly one `findings.push` in the whole module).
- **T75's F-004 regressions genuinely reach the persisted artifact and the real service-read gate**, not an in-memory value, and would fail if the producer's fix regressed (proven by my own simulated-revert probe, not assumed).
- **The mock.module cross-file hazard both T69 and T75 report is real** — I independently reproduced the identical `provenance.test.ts` failure — and the shipped mock-free design is clean against it in both file orders.
- **The three T69 catch-arm producers remain closed**, including `safeErrorCode`'s regex correctly rejecting both a payload smuggled through `error.code` and an over-length code.
- **`gate.ts`'s verdict-computation is unaffected by either fix**: `brokenRequired` branches only on `status`/`execution`/`parse`, never on `.error`'s content, confirmed by reading the function and by every probe row's `gate.status`/`serviceGateStatus` staying `incomplete` (leak rows) or `pass` (clean control), never moving.
- **Sixteen of the eighteen T68/T73-corrected sites plus T75's three new sites remain correct**, re-verified this round by direct measurement, not by re-reading the prior tables.
- **`docs/docs/guides/*` and the root project docs carry no mode-blocking claims at all** (re-confirmed with a narrowed sweep excluding generated data/flow-artifact noise; only hit was the already-correct `.metaproject/core/security/README.md:17`).

## Evidence

Raw logs, all under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`:

| Log | SHA-256 |
|---|---|
| `2026-09-06T19-10-12-000Z_T76-health-leak.log` | `5c71a66b76125fdd7f31d97a4f78202a044d617d5b7cd2ca09ee4ada07c60252` |
| `2026-09-06T19-15-08-001Z_T76-guidance.log` | `2f5501d6ccb5d721662748d5786fcc4b2bdfd4d2df3089043c2fcb306ae1df78` |
| `2026-09-06T19-15-33-002Z_T76-tests.log` | `8c99e4b12097c5062654265be82233daa50c7fb280169c87c1af332b3d9129b6` |
| `2026-09-06T19-15-33-003Z_T76-hazard-order1.log` (shipped design, clean) | `6d043772bfd37b6681fefbd6794dfe79d2e2168017899d9a5f55793df0d8ac03` |
| `2026-09-06T19-15-33-004Z_T76-hazard-order2.log` (shipped design, clean) | `6fea6fd8eede167acd7b4f0e2fcdfb29ae7cc809fc8ad81b2c805bc47caa7ab9` |
| `2026-09-06T19-17-53-005Z_T76-hazard-repro-order1-FAIL.log` (mock-based repro, hazard confirmed) | `03fde98764776329cba6f7267f18f4fa4a0d6e09034d60ebe63daa1f0472a969` |
| `2026-09-06T19-17-53-006Z_T76-hazard-repro-order2-pass.log` (mock-based repro, reverse order) | `43c18eccff31fe9a635f9d61de14708d14a35707d4e79937d42cbde97ea9ab71` |
| `2026-09-06T19-04-07-762Z_rg.log` (`error:` field enumeration, undercounted in summary) | `835e976218d2c874e8a871219778f70fbf7b8b7f76a1776e165030ff406e2f3a` |
| `2026-09-06T19-06-01-229Z_rg.log` (broad enforced/ci/gateway sweep, undercounted) | `13d82822980730caf5ea5b2d44251e81598cdd48b27f30f9f1578deac64f46a3` |
| `2026-09-06T19-12-52-438Z_rg.log` (`src/lib/templates.ts` sweep, undercounted) | `ec86d5304325bda6b720fbcad83911fec8a11956a6f5ea512d1a2ae266b6bc6a` |
| `2026-09-06T19-21-03-823Z_rg.log` (secret/critical enumeration, clean count) | `f1bf4b024fa6d2610be1a2f06114b46efc858c4ab4e0e4e1810fc2b05b084533` |
| `2026-09-06T19-15-49-444Z_rg.log` (provenance.test.ts imports, undercounted) | `58732b5a9622dcc89e32172910762ec4011dc596e3a3c97654eface8f4622fa2` |
| `2026-09-06T19-04-01-155Z_rg.log` (`SourceRunInfo` type-usage enumeration) | `0494fd137568894b1f930b52b00207941d747b9fc22b7e1d63f9cb54dada842f` |
| `2026-09-06T19-04-36-889Z_rg.log` (`.error` reads enumeration) | `3717aada3ab6526217c52b2886e094cf1a7e7f24f8e41609c9d99c58dca2c5ee` |
| `2026-09-06T19-04-58-490Z_rg.log` (dot-assignment sweep, zero hits) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `2026-09-06T19-04-58-678Z_rg.log` (`error =` sweep) | `7470214ec3efe0b32bfe48dc428739a847b7b2e647568b619f69cf0396b95492` |
| `2026-09-06T19-04-43-282Z_rg.log` (`report.ts` "error" sweep, zero hits) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `2026-09-06T19-13-17-031Z_rg.log` (`writeOutputs` production blast radius) | `58898b2b019a23b21847e92b4ba49d7b967468334b151a37738f550d69c92bcb` |
| `2026-09-06T19-19-59-717Z_rg.log` (guides/README narrow sweep) | `43ed49f6e3a0ad8dc430ee6a8bbebdc78e1929fbc38b5b25be75f90b279b9432` |

Probe scripts written by this review (new files, nothing else modified):
`T76-health-leak.ts`, `T76-guidance.ts`, `T76-hazard-repro.test.ts`.

`bun test src/health/health-truthful-gate.test.ts src/security/templates.test.ts`
→ 21 pass / 0 fail / 121 expect() (`T76-tests.log`).
`bun test src/health/health-truthful-gate.test.ts src/health/provenance.test.ts`
and the reverse → 18 pass / 0 fail / 118 expect() both orders
(`T76-hazard-order1.log`/`T76-hazard-order2.log`).

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file was either named by the
  dispatch or found by my own text sweeps; the questions are behavioural
  (what does the code do) and textual (what does shipped prose say), not
  structural/blast-radius. `keryx-tooling-caveats` project memory also flags
  gdgraph's answers as historically unreliable on this repo, and the graph
  predates this session's uncommitted tree regardless.
- `wiki_used`: **no** — *not-relevant*. The normative source for "what the
  code does" is the code itself, read directly throughout; the normative
  source for the acceptance criteria is `acceptance-criteria.md`, read
  directly; no wiki page adjudicates either.
- `ctx_used`: **yes** — every text search went through `bun src/cli.ts ctx
  rg`; every raw log cited above by path and hash.
- `raw_rg_used`: **no** bare `rg`/`grep`/`cat`/`find`/`sed` over project code
  or docs. `grep`/`cat`/`tail` were attempted twice during this session out of
  habit and both were blocked by the project's own hook before any output was
  produced; both were then done correctly via `ctx rg` or the `Read` tool with
  no raw bypass ever executed.
- **gdctx compaction defect, observed independently five more times this
  round** (matching the dispatch's own warning): the `error:` field sweep
  (header 15, summary rendered 10), the broad `enforced/ci/gateway` sweep
  (header ~100, summary rendered far fewer), the `src/lib/templates.ts` sweep
  (header 8, summary rendered 4 — this is the one that surfaced F-001), the
  `provenance.test.ts` import sweep (header 7, summary rendered 4), and the
  first broad `advisory.*enforced` sweep across `docs`/`.metaproject`/`README.md`
  (polluted by matching prior sessions' own logged output, re-run narrowed).
  Every one was read from the raw log directly before being relied on; no
  count in this review is cited from a compacted header alone.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T76#F-001",
    "reviewer": "review-logic+review-security-code (T76 independent recheck)",
    "severity": "major",
    "file": "src/lib/templates.ts",
    "line": 2063,
    "symbol": "renderSecurityPrePushHook",
    "problem": "The git pre-push hook script this function generates -- written verbatim into every scaffolded project's .git/hooks/pre-push by keryx init/update -- carries two shell comments enumerating which security.config.json modes block a push ('enforced'/'ci' exit non-zero...; # enforced/ci mode blocked on this file.) that omit `gateway`, even though gateway has blocked identically to enforced/ci since T61/T65. This is the same defect class T62/T68/T70/T73/T75 corrected at eighteen other sites, in a nineteenth site (src/lib/templates.ts) none of those five prior rounds' surface sweeps ever included.",
    "impact": "AC8's 'no shipped guidance describes behaviour the code does not have' fails on a surface as durable as the manifest/README the module already ships -- a git hook persists on disk and is not re-read the way a markdown doc is. An operator or agent reading their own .git/hooks/pre-push to understand gateway-mode behaviour is told only enforced/ci matter, the exact 'gateway mode is inert' misreading this phase exists to close.",
    "suggested_fix": "Add gateway to both comments, matching src/security/templates.ts:63's already-corrected wording ('enforced'/'ci'/'gateway' block the push). Add a pinning regression for renderSecurityPrePushHook()'s own output, matching the pattern templates.test.ts already uses for renderSecurityManifest/renderSecurityCoreReadme.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T76-guidance.ts -> .metaproject/data/gdctx/raw/2026-09-06T19-15-08-001Z_T76-guidance.log (sha256 2f5501d6ccb5d721662748d5786fcc4b2bdfd4d2df3089043c2fcb306ae1df78), row 'B pre-push hook script': containsEnforcedCiWithoutGateway:true, omitsGatewayLine present. Corroborated by ctx rg raw .metaproject/data/gdctx/raw/2026-09-06T19-12-52-438Z_rg.log (8 lines, header undercounted to 4 in the compacted summary, read raw directly).",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-pre-push-hook-script/omits-gateway",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/lib/templates.ts:2063-2065 (header comment enumeration) - DEFECT",
        "src/lib/templates.ts:2165 (per-file loop comment) - DEFECT",
        "src/security/templates.ts:63,125 - correct (T68)",
        ".metaproject/modules/security.md:48 - correct (T73)",
        ".metaproject/core/security/README.md:17 - correct (T73)",
        "src/commands/init.ts:497 - correct (T73)",
        "docs/docs/cli-reference.md:330,754,912,993,1058,2095-2099,2137-2148 - correct (T68/T73/T75)",
        "docs/docs/modules.md:766,784-787,865,874,881 - correct (T73/T75)",
        "docs/docs/architecture.md:547,563,634 - correct (T73)",
        "docs/docs/workspace-and-lifecycle.md:339,350 - correct (T73)"
      ],
      "enumeration_method": "Fresh regex sweep (not inheriting any prior round's site list) over the same seven shipped surfaces T70's own probe used PLUS src/lib/templates.ts (never previously swept), for lines naming enforced/ci with a blocking-behaviour verb and no gateway on the same line, executed in T76-guidance.ts section B. 4 raw suspects; 2 pre-classified non-defects (cli-reference.md:1226 unrelated containment prose, :2096 T68's own paragraph with gateway on the preceding line); 2 genuine, both in this file. Cross-confirmed by rendering renderSecurityPrePushHook() directly rather than trusting the regex match alone."
    }
  },
  {
    "id": "F-002",
    "global_id": "T76#F-002",
    "reviewer": "review-logic+review-security-code (T76 independent recheck)",
    "severity": "major",
    "file": "docs/docs/modules.md",
    "line": 774,
    "symbol": "CLI-surface table, scan-mcp row",
    "problem": "modules.md's CLI-surface table marks security scan-mcp's Exit column 'mode-gated', and the paragraph immediately below (:784-787) states that mode-gated commands honor config.mode with the advisory/enforced-ci-gateway fold. handleScanMcp (src/commands/security.ts:384-536) never calls modeOf(cwd) and never reads config.mode; its only exit-affecting line gates on `--strict` and (totalFindings>0 || coverage==='incomplete') alone.",
    "impact": "Reachable 'a check that did not pass looks like a pass' gap: a CI job that sets mode:'ci' believing that alone makes security scan-mcp gate on MCP threats (as the doc implies for every 'mode-gated' row) never fails on any MCP threat in any mode unless --strict is also passed -- silently passing a poisoned MCP manifest through CI.",
    "suggested_fix": "Change the scan-mcp row's Exit column to '1 with --strict, on a threat or incomplete coverage (independent of mode)' and scope the :784-787 paragraph explicitly to the rows it actually describes (scan, check-input, check-output, report).",
    "evidence": "T76-guidance.log claims T3/T3b: scan-mcp|{advisory,enforced,ci,gateway}|no-strict all 0 (threat present, no --strict); scan-mcp|{advisory,enforced,ci,gateway}|strict all 1 (same threat, --strict added) -- driven through the real securityCommand(['scan-mcp', manifestPath, ...], root) against a synthetic MCP manifest confirmed to trip the mcp.poisoning.ignore-instructions detector.",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/modules-cli-table/scan-mcp-mode-gated-mislabel",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "docs/docs/modules.md:774 (scan-mcp Exit cell) - DEFECT",
        "docs/docs/modules.md:773,775,776 (scan/check-input/check-output rows) - correct, confirmed mode-gated by reading handleScan/handleCheck",
        "docs/docs/cli-reference.md:2145-2146 - correct, already describes scan-mcp by --strict, not mode"
      ],
      "enumeration_method": "Read every handle* function in src/commands/security.ts that a CLI-surface table row maps to and noted whether modeOf(cwd)/exitCodeFor/reportExitCode is on the process.exitCode-setting path. Cross-checked every 'mode-gated' table row against its handler this way, then confirmed both mismatches (this finding and F-003) by execution."
    }
  },
  {
    "id": "F-003",
    "global_id": "T76#F-003",
    "reviewer": "review-logic+review-security-code (T76 independent recheck)",
    "severity": "minor",
    "file": "docs/docs/modules.md",
    "line": 782,
    "symbol": "CLI-surface table, hooks install|uninstall row",
    "problem": "Same table's Exit column for security hooks <install|uninstall> is also 'mode-gated'. handleHooks (src/commands/security.ts:764-817) sets process.exitCode=1 only for an invalid action, unknown runtime(s), or a post-install validation error; modeOf(cwd) is read once, only to print an advisory note, never to affect the exit code.",
    "impact": "Lower than F-002: hooks install is a one-time setup command, not typically wired into a repeated CI gate the way scan-mcp/scan/report are, so the 'silently passes' shape does not apply the same way. Still a shipped-guidance/code mismatch under AC8.",
    "suggested_fix": "Change the Exit column to '1 on an unknown runtime or a post-install validation error (independent of mode)'.",
    "evidence": "T76-guidance.log claims T4/T4b: hooks-install|{advisory,enforced,ci,gateway}|unknown-runtime all 1; hooks-install|{advisory,enforced,ci,gateway}|valid-runtime all 0 -- driven through the real securityCommand(['hooks','install','--runtime',...], root).",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/modules-cli-table/hooks-install-mode-gated-mislabel",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T76#F-004",
    "reviewer": "review-logic+review-security-code (T76 independent recheck)",
    "severity": "minor",
    "file": "src/lib/templates.ts",
    "line": 2064,
    "symbol": "the shared \"secret/critical finding\" phrase",
    "problem": "Four shipped sites (.metaproject/modules/security.md:49, src/security/templates.ts:64, src/commands/init.ts:497, src/lib/templates.ts:2064) describe the pre-push block condition as 'a secret/critical finding'. resolve.ts:132-161's computeGate returns 'fail' on any category's block action or severity>=failOn (not specifically secret), and 'needs-approval' (which also exits non-zero in a blocking mode) on any category's require-approval action, e.g. escalated prompt-injection.",
    "impact": "Opposite direction from F-001/F-002: undersells the blocking surface rather than oversells it, so the risk is operator surprise at an unexpected block, not a security bypass. Recorded under AC8's 'either direction' mandate; not blocking.",
    "suggested_fix": "Drop the category/severity qualifier: 'blocks the push (non-zero exit) on a failing or needs-approval gate', or give a non-exhaustive example ('e.g. a secret, PII or escalated prompt-injection finding').",
    "evidence": "ctx rg 'secret/critical' src docs/docs .metaproject/modules .metaproject/core -> .metaproject/data/gdctx/raw/2026-09-06T19-21-03-823Z_rg.log (sha256 f1bf4b024fa6d2610be1a2f06114b46efc858c4ab4e0e4e1810fc2b05b084533), 4 matches, header and rendered list agree. resolve.ts:132-161 read in full.",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/secret-critical-narrowing/computeGate-is-broader",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  }
]
```
