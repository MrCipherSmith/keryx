STATUS: DONE_WITH_CONCERNS

# T39 — independent recheck of the posture-unavailable repair (T37), the exit-code folds (T38/T48/T50), and their consistency

Every repair named in the dispatch reproduces as closed under probes written fresh
for this review, and all three consumer-visible claims hold under execution rather
than under reading. **Stage 1 does not pass.** Three defects of the *same class as
the ones these tasks repaired* are open: a fifth gate fold with a pass fallthrough
on the shared flow-completion path (blocker), a config `mode` value that is not
one of the four the type declares and silently resolves to report-only (major),
and `security report`'s strict-CI decision taken from an unvalidated field of the
artifact it is judging (major). Stage 2 (code quality) was therefore not started,
per the dispatch's ordering.

## Scope

- Root: `/Users/Goodea/goodea/keryx`
- Branch: `codex/agent-first-core`; base / merge-base with `main`:
  `0bc6418fa1a038f8ec909cf949fecba077acf9a4` (identical to HEAD — the branch
  carries uncommitted work only)
- Reviewer wrote none of the code, none of the specs, and none of the earlier
  reviews (T35, T37, T38, T48, T50).
- Read-only on all production and test code. Artifacts written: this file,
  `T39-result.json`, and three probes `T39-{posture,exit,scan}.ts`. Every fixture
  was `mkdtemp` and removed in `finally`.

### File hashes (SHA-256), start and end of this review

| File | Start | End | Same |
|---|---|---|---|
| `src/security/guard.ts` | `2950201165475f32…4894` | `2950201165475f32…4894` | yes |
| `src/security/guard.test.ts` | `90d5b7e3098f65b3…a0a0` | `90d5b7e3098f65b3…a0a0` | yes |
| `src/security/config.ts` | `b70fc2e5250da014…4de0` | `b70fc2e5250da014…4de0` | yes |
| `src/security/service.ts` | `6c71ef1ee2ec5e6b…0064` | `6c71ef1ee2ec5e6b…0064` | yes |
| `src/security/types.ts` | `e306711e6978b5a7…b9af` | `e306711e6978b5a7…b9af` | yes |
| `src/commands/security.ts` | `a0de7f7d4c5da915…c641` | `a0de7f7d4c5da915…c641` | yes |
| `src/commands/security-gate-exit.test.ts` | `c9bf88a3e48e3b81…9745` | `c9bf88a3e48e3b81…9745` | yes |
| `src/commands/health.ts` | `8ce5d2873aab346b…0dcd` | `8ce5d2873aab346b…0dcd` | yes |
| `src/health/service.ts` | `445f0420e1890368…6bd8` | `445f0420e1890368…6bd8` | yes |
| `src/health/gate.ts` | `9c26cc7f36b86d17…d0c0` | `9c26cc7f36b86d17…d0c0` | yes |
| `src/health/types.ts` | `be8edca77296ac56…fcf1` | `be8edca77296ac56…fcf1` | yes |
| `src/lib/json.ts` | `b9558372a23b6985…b486` | `b9558372a23b6985…b486` | yes |
| `src/flow/service.ts` | `7131b2b276dd24be…7729` | `7131b2b276dd24be…7729` | yes |
| `src/flow/review-gate.ts` (excluded — other worker) | `9cee7f72d843ac88…5321` | `9cee7f72d843ac88…5321` | yes |
| `src/security/detect/exfil.ts` (excluded) | `5c020a685e0b3c58…865a` | `5c020a685e0b3c58…865a` | yes |
| `src/security/output-validation.ts` (excluded) | `0f6856a3d7623668…19dd` | `0f6856a3d7623668…19dd` | yes |

Full digests are in `.T39-hashes-start.txt` / `.T39-hashes-end.txt` beside this
file; `diff` between them is empty. **No drift**: the three excluded files the
other two workers own are byte-identical at start and end, so nothing in this
review depends on them, and they are excluded from every verdict regardless.

## Summary

| Severity | Count |
|---|---|
| blocker | 1 |
| major | 2 |
| minor | 2 |
| info | 3 |

Row 1: repairs confirmed, class **not** closed. Row 2: the four named folds
confirmed correct for every recognized value, one further site of the same shape
found, and one of the four still reachable through its other argument. Row 3:
**the implementations disagree**, in two independently reproduced ways. The two
disclosed judgement calls and the shared JSON reader are ruled on below.

## Stage 1

| # | Item | Verdict | My probe and what it showed |
|---|---|---|---|
| 1a | A manifest that parses but is not an object now blocks | **closed** | `T39-posture.ts` A2–A7, A10–A13, A17–A19. `null`, `[]`, `42`, `"x"`, `true`, an unparseable body, a BOM-free empty file, whitespace, a `__proto__` payload, and `modules` as `null`/`[]`/`42`/`"security"` all give `isSecurityEnabled` → no throw, `guardOutput` → `{allowed:false, gate:"incomplete", reason:"security posture unavailable: check could not complete"}`, `securityFlowGate` → `{status:"fail"}` (never `null`, never a throw). `Object.prototype.modules` is still `undefined` afterwards (D1). |
| 1b | An absent manifest keeps its previous non-blocking behaviour | **closed** | A1: no manifest file → `enabled:false`, `guardOutput` allowed, `securityFlowGate` → `null` (gate omitted at completion). A14/A15 pin the two adjacent readable cases — `{"modules":{}}` and `security.enabled:false` — as still non-blocking, so the fix did not buy its truthfulness by blocking everything. |
| 1c | A config that parses but is not an object now blocks | **closed** | B2–B6, B17: `null`, `[]`, `42`, `"advisory"`, an unparseable body and an empty file all give `loadSecurityConfig` → `mode:"enforced"`, `configUnreadable:true`; `guardOutput` blocked; `securityFlowGate` `fail`. Measured with and without prior state in an earlier round; the residual T35 F-003 measured is gone. |
| 1d | An absent config keeps its previous non-blocking behaviour | **closed** | B1 (no file) and B7 (a legitimate `{}`) both → `mode:"advisory"`, `configUnreadable` absent, write allowed, flow gate informational `pass`. The "never configured" and "explicitly minimal" cases are untouched. |
| 1e | The forced-closed mode is a returned flag, not a write to the user's config | **closed** | C1: after `loadSecurityConfig` + `guardOutput` + `securityFlowGate` against a `null` config, the file's bytes are unchanged (still `null`), its `mtimeMs` is unchanged, and `.metaproject/` holds exactly the two files it held before. The forced mode exists only on the returned object (`mode:"enforced"`, `configUnreadable:true`). |
| 1f | The widening beyond the literal trigger is safe | **partly** | The disclosed widening (all non-object manifest *bodies*, not just `null`) is correct and I would keep it — see "Judgement calls". An **undisclosed** second widening is not: a well-formed manifest object with no `modules` key also blocks (F-005). |
| 1g | Boundary: a config whose `mode` is an unrecognized string | **OPEN** | B11–B16: `"bananas"`, `"ENFORCED"`, `"enforced "`, `42`, `true` all load verbatim and resolve to report-only. `guardOutput` **allows** a planted AWS key; `securityFlowGate` returns `{status:"pass", detail:"security ENFORCED: informational (advisory does not block)"}`. → **F-002**. |
| 2a | `exitCodeFor` (`security scan` / `check-*`) | **closed** | `T39-exit.ts` S1. `advisory`/`gateway` → 0 for every gate (unchanged). `ci` and `enforced` are now one rule: `pass` → 0, `fail`/`needs-approval`/`incomplete`/unrecognized → 1. The only recognized value whose answer changed is `ci` + `needs-approval` (0 → 1), exactly as T38 reported. |
| 2b | `reportExitCode` (`security report`) | **partly** | S2: `ci` → `pass` 0, everything else 1 (the fix). Every other mode → 0 for every gate. Recognized values otherwise unchanged. But the `mode` argument is read from the stored artifact rather than the workspace (S3) → **F-003**, and the disclosed asymmetry is broader than disclosed: `enforced` + `fail` exits 0, not only `enforced` + `needs-approval`. |
| 2c | `runExitCode` (`keryx health run`) | **closed** | H1: the full 4×2 truth table is byte-identical to T48's table; only the unrecognized value changed (0 → 1, at both `strict` settings). |
| 2d | `gateExitCode` (`src/health/service.ts`) | **closed** | H2: same 4×2 table, byte-identical; unrecognized 0 → 1. |
| 2e | Is each default arm genuinely reachable? | **1 of 4 — as T50 claimed, and only there** | H3: a `latest.json` written with `gate.status:"banana"` reaches `gate()` through the real `readLatest` parse-and-cast and now yields `exitCode:1` — **T50's reachability claim is confirmed by my own fixture, not taken on trust**. The other three arms are not runtime-reachable: `runExitCode` folds a freshly computed `computeGate` result, `exitCodeFor` folds a live `SecurityDecision`, and `reportExitCode`'s *gate* is filtered by `hasRecognizedGate` first. Those three are defensive, correctly so, and their tests need a cast to reach them — which the implementers stated. |
| 2f | Is there a fifth site of the same shape on a reachable gate/exit path? | **YES** | F1: `src/flow/service.ts:640-644` folds the health gate as `status === "fail" ? fail : pass`. Driven through the **real** `createFlowService().complete()` pipeline: health `incomplete` → gate row `{status:"pass", detail:"health gate: incomplete"}`, `passed: true`; health `warn` → same; an unrecognized value → same. → **F-001**. |
| 3 | Consistency across the five/six implementations | **FAILS on two counts** | (a) health `incomplete` exits 1 at `keryx health gate` and at `keryx health run`, and is recorded **`pass`** at `flow complete` (H2/H1 vs F1). (b) security `fail` blocks at `guardOutput`, maps to `fail` at `securityFlowGate`, exits 1 at `security scan` in `enforced` — and exits **0** at `security report` in `enforced` (S1 vs S2). Vocabularies are **not** mixed: `ctx rg` finds no `GateStatus` reference anywhere under `src/security/` or in `src/commands/security.ts`, and no `SecurityGate` reference in `src/health/` or `src/commands/health.ts` — only the doc comments that say so. |

**Stage 1 result: the six named repairs are closed and every claim about them
holds, but Stage 1 does not pass, because F-001, F-002 and F-003 are open defects
of the same class, found by attacking rather than by confirming.**

## Findings

### [F-001] The flow-completion health gate is a one-value denylist: `incomplete` is recorded as PASS and completion succeeds

- **Severity**: blocker
- **File**: `src/flow/service.ts:640-644`, inside `complete()`'s "Gate 5: code health"
- **Problem**:
  ```ts
  health.status === "fail"
    ? { name: "health", status: "fail", detail: … }
    : { name: "health", status: "pass", detail: `health gate: ${health.status}` }
  ```
  `deps.healthGate` is `createCodeHealthService().gate()` at both real wirings
  (`src/commands/flow.ts:117-119` for the CLI, `src/harness/tool/metaproject-adapter.ts:111-114`
  for the harness), and its `status` is the full `GateStatus` union
  (`pass | warn | incomplete | fail`, `src/health/types.ts:132`). Three of the four
  values reach the permissive arm. `incomplete` is not an exotic value: `computeGate`
  (`src/health/gate.ts:58-63`) sets it precisely when `brokenRequired.length > 0` — a
  required source that is unavailable, failed to execute, or failed to parse, which is
  verbatim policies.md's INCOMPLETE and verbatim AC4/AFC-05's "skipped required check".
  No corruption, no tampering and no unrecognized value is needed to reach it.
- **Impact**: the exact AC8 sentence — "no required failed or incomplete check is
  relabeled PASS at any surface" — fails on the shared completion path, the one
  surface a machine reads to decide a phase is done. The gate row written into
  `flow.json` history says `status: "pass"`, and `buildIssueComment` posts that row to
  the issue tracker, so the false clean bill of health is durable and published. It is
  also the Row-3 consistency violation in its sharpest form: the identical value exits
  `1` at `keryx health gate` and at `keryx health run` (H1/H2) and passes here. This
  is the same shape T33/T38/T48/T50 were dispatched to remove, on the one path none of
  them owned.
- **Reproduction**: `bun .metaproject/flows/233-…/artifacts/T39-exit.ts`, section F1 —
  the real `complete()` pipeline (init → freeze → start → tasks → implemented →
  acConfirm → clean review package → complete), one run per health status:
  ```
  healthGate -> pass        recordedGateStatus "pass"  completionPassed true
  healthGate -> warn        recordedGateStatus "pass"  completionPassed true   detail "health gate: warn"
  healthGate -> incomplete  recordedGateStatus "pass"  completionPassed true   detail "health gate: incomplete"
  healthGate -> fail        recordedGateStatus "fail"  completionPassed false
  healthGate -> banana      recordedGateStatus "pass"  completionPassed true
  ```
  Raw `…T15-33-04-241Z_run.log`. No committed test covers it: `ctx rg -n "incomplete"`
  over `src/flow/service.test.ts` and `src/flow/security-gate.test.ts` returns zero
  matches, so this is an uncovered fallthrough, not a documented decision.
- **Suggested fix**: replace the ternary with the exhaustive switch the four sibling
  folds now use, health's own vocabulary, default arm blocking:
  ```ts
  const healthGateOutcome = (status: string): "pass" | "fail" =>
    status === "pass" ? "pass" : "fail";           // or a switch mirroring gateExitCode
  ```
  `warn` is the one value that needs a decision rather than a mechanical fold: it
  exits 0 at both health commands unless `--strict`/`--strict-warn`, so mapping it to
  `fail` here would be a behaviour change for existing flows. The minimal correct fix
  is `pass → pass`, `warn → pass` (matching the non-strict command default, and
  keeping the reason string visible in `detail`), `fail`/`incomplete`/`default` →
  `fail`. Whichever way `warn` goes, `incomplete` and the default arm must block.
  While the file is open, the security arm at `:656` passes `security.status` through
  verbatim, so a future `skipped` from `securityFlowGate` would be non-blocking under
  `:663`; `securityFlowGate` cannot return `skipped` today, but the type says it can,
  and F2 confirms `skipped` passes.
- **class_scope**:
  - sites: `src/flow/service.ts:641` (health, the defect); `src/flow/service.ts:656`
    (security, pass-through — latent, its type admits `skipped` which `:663` treats as
    non-blocking); `src/flow/service.ts:663` (the master fold
    `gates.every((gate) => gate.status !== "fail")`, the enabler for both)
  - enumeration_method: `bun src/cli.ts ctx rg -n 'status === "fail"|status !== "fail"|status === "pass"|status !== "pass"|gate === "pass"|gate !== "pass"|gate === "fail"|gate !== "fail"' src --glob '!*.test.ts'`
    (raw `…T15-35-00-547Z_rg.log`), then every hit read. The allowlist-shaped hits are
    correct and are not in the class: `src/sac/index.ts:383,399,429`,
    `src/sac/proposal-lifecycle.ts:713`, `src/lib/serve-turn.ts:789`,
    `src/harness/completion/gate.ts:131`, `src/harness/flow/managed-flow-port.ts:53,61`,
    `src/harness/flow/parity.ts:44,66`. `src/commands/security.ts:760` folds the
    detector-eval gate, whose `GateResult.status` is computed in-process as
    `reasons.length > 0 ? "fail" : "pass"` (`src/security/eval/harness.ts:209`) — a
    two-member closed set, so the fold is total and out of class, which confirms T35's
    classification of it. `src/commands/workspace.ts:157` is F-006.
- **Confidence**: high (executed end to end through the real completion pipeline).

### [F-002] A config `mode` that is not one of the four declared values silently resolves to report-only

- **Severity**: major
- **File**: `src/security/config.ts:145-179` (`mergeSecurityConfig`) and `:218-228`
  (`loadSecurityConfig`), consumed at `src/security/guard.ts:181-183` (`isBlockingMode`),
  `:280`, `:387`, and `src/commands/security.ts:853-858` / `:575-577`
- **Attack vector**: an operator typo (`"ENFORCED"`, `"enforcd"`, a trailing space), a
  hand-edited or machine-generated config, a schema drift between versions, or anyone
  with a one-byte write to `.metaproject/security.config.json`. No corruption is
  needed — the file stays perfectly valid JSON and a perfectly good object.
- **Problem**: `SecurityMode` is a closed four-member union
  (`src/security/types.ts:93`) and the shipped schema enumerates it
  (`src/security/schemas.ts:139,261`), but `mergeSecurityConfig` takes
  `parsed.mode ?? base.mode` with no validation and `loadSecurityConfig` never calls
  `validateSecurityConfig` — the file says so itself at `src/commands/security.ts:976`
  ("`loadSecurityConfig` never validates — it merges whatever parses over the defaults,
  and `validateSecurityConfig` is called only by `policy validate`"). The mode is then
  consumed by `isBlockingMode`, a **two-value allowlist for blocking** whose fallthrough
  is the permissive side, and by `exitCodeFor`/`reportExitCode`, whose `ci`/`enforced`
  guards are equality tests. So the mode axis carries exactly the defect the gate axis
  was just repaired for, at four consumers at once. T37 established the governing
  principle — a posture that cannot be established blocks — and applied it to the
  config *file's shape*; a config whose declared *mode* is not a mode this build knows
  is equally an unestablished posture and takes the permissive path.
  §14 self-protection does not compensate: `MODE_RANK[config.mode]` is `undefined` for
  an unrecognized mode, so `MODE_RANK[config.mode] < MODE_RANK[previous.mode]`
  (`src/security/self-protect.ts:88`) is `false` and no downgrade warning or incident is
  raised in either direction. There is no operator-visible signal at any decision point.
- **Impact**: an enforced/CI workspace becomes report-only with the enforcement it
  declared silently absent — the identical outcome T30 F-001 and T35 F-003 describe, and
  which T37 was accepted for closing. The flow-completion gate reports
  `{status:"pass", detail:"security ENFORCED: informational (advisory does not block)"}`
  — a required check with an unestablished posture relabeled PASS on the completion
  path, AC8's own sentence. `keryx security check-input` returns exit 0 on a live AWS
  key with one `fail` finding.
- **Reproduction**: `T39-posture.ts` B11–B16 (raw `…T15-30-49-266Z_run.log`) — for
  `{"mode":"ENFORCED"}` with the module enabled and a planted `AKIAIOSFODNN7EXAMPLE`:
  `guardAllowed: true`, `guardGate: "fail"`, `gate: {"status":"pass","detail":"security ENFORCED: informational (advisory does not block)"}`.
  `T39-scan.ts` C3 (raw `…T15-37-56-202Z_run.log`) drives the CLI check path:
  `loadedMode "ENFORCED"`, `gate "fail"`, `findings 1`, `cliExitCode 0`,
  `persistedStateMode "ENFORCED"`. The controls C2/C4 show `advisory` → 0 and `ci` → 1,
  and C1 shows an *unreadable* config correctly → `enforced` → 1.
  `T39-exit.ts` S1/S2 show both CLI folds return 0 for every gate under
  `"BANANAS"`, `"CI"` and `"ci "`.
- **Suggested fix**: validate the mode where it is loaded, in the function T37 already
  made total, and reuse the machinery T37 built rather than adding a reason string:
  ```ts
  const MODES = new Set(["advisory", "enforced", "ci", "gateway"]);
  // in loadSecurityConfig, after the mergeable-payload check:
  const merged = mergeSecurityConfig(parsed);
  if (!MODES.has(merged.mode)) {
    return { ...merged, mode: "enforced", configUnreadable: true };
  }
  ```
  That is one `Set` and one `if`, reaches the existing `POSTURE_UNAVAILABLE_REASON`
  branches in `guardOutput` and `securityFlowGate` unchanged, keeps
  `loadSecurityConfig` total, and changes nothing for any config whose mode is one of
  the four. Independently, `isBlockingMode` should become an exhaustive switch over
  `SecurityMode` with the default arm on the blocking side, so a fifth mode added later
  cannot inherit "does not block" by omission — the same discipline `isPassGate`,
  `runExitCode`, `gateExitCode`, `runGate` and `securityFlowGate` now carry on the gate
  axis.
- **class_scope**:
  - sites: `src/security/config.ts:150` (`mergeSecurityConfig`, the unvalidated
    assignment), `src/security/config.ts:218` (`loadSecurityConfig`, the only reader of
    `security.config.json`), `src/security/guard.ts:181` (`isBlockingMode`, permissive
    fallthrough), `src/security/guard.ts:280` (`guardOutput`'s consumption),
    `src/security/guard.ts:387` (`securityFlowGate`'s consumption),
    `src/commands/security.ts:854` (`exitCodeFor`'s mode guard),
    `src/commands/security.ts:576` (`reportExitCode`'s mode guard),
    `src/security/self-protect.ts:88` (`MODE_RANK` comparison, blind to an unranked mode)
  - enumeration_method: `bun src/cli.ts ctx rg -n "mode" src/commands/security.ts` and
    `ctx rg -n -A 4 '"advisory"' src/security/schemas.ts src/security/types.ts`
    (raw `…T15-32-02-348Z_rg.log`) to establish the closed union and its schema enum,
    then `ctx rg -n "loadSecurityConfig|isBlockingMode" src --glob '!*.test.ts'`; every
    consumer that branches on a mode value is listed. `modeOf` (`security.ts:793`) is a
    one-line delegate to `loadSecurityConfig` and carries no branch of its own.
- **Confidence**: high (executed at the guard seam, the flow gate and the CLI).

### [F-003] `security report`'s strict-CI decision is taken from the artifact's own `mode` field, which nothing validates

- **Severity**: major
- **File**: `src/commands/security.ts:558` (`process.exitCode = reportExitCode(report.gate, report.mode)`),
  with `src/security/service.ts:216-222` (`hasRecognizedGate`) and `:276-289` (`runReport`)
- **Problem**: T38 correctly made the *gate* argument an allowlist over `pass`. The
  *mode* argument comes from `runReport`, which for a stored artifact returns
  `latest.report` verbatim — and `hasRecognizedGate` validates only that `gate` is one
  of the four; every other field, `mode` included, is whatever is on disk. So the
  question "is this workspace in strict CI?" is answered by the file being judged. A
  workspace configured `ci` whose last scan was recorded under `advisory` — an ordinary
  sequence: scan, then switch the project to CI, then run `security report` in the
  pipeline — exits **0** on a `fail` gate. Every other surface in the module asks
  `loadSecurityConfig` (`exitCodeFor` is called as `exitCodeFor(…, await modeOf(cwd))`
  at `:250` and `:515`); this one site asks the artifact.
  Measured separately: the disclosed `ci`-only scope is **broader in effect than
  disclosed**. T38's Concerns frame the residual as `enforced` + `needs-approval`; S2
  shows `enforced` returns 0 for `fail` and `incomplete` as well. "Strict CI accepts
  only PASS" (policies.md:28) is unmet for `enforced` on this surface for all three
  non-pass values, not for one of them.
- **Impact**: the CLI surface T38 exists to make truthful still exits 0 on an
  established threshold violation, through a field an attacker or a stale artifact
  controls, and through the sibling strict mode. `runGate` is not exposed as a CLI
  command, so these two exit codes are the CLI gate.
- **Reproduction**: `T39-exit.ts` S3 (raw `…T15-33-04-241Z_run.log`): workspace config
  `{"mode":"ci"}`, stored `latest.json` `{"gate":"fail","mode":"advisory",…}` →
  `runGate` `fail`, `runReport` gate `fail`, **`cliExitCode: 0`**, and
  `exitCodeIfWorkspaceModeWereUsed: 1`. S2 rows: `reportExitCode(gate, "enforced")` is
  0 for `fail`, `needs-approval`, `incomplete` and an unrecognized value.
- **Suggested fix**: two independent one-liners. (a) take the mode from the workspace,
  not the artifact — `process.exitCode = reportExitCode(report.gate, await modeOf(cwd))`
  — matching the two `exitCodeFor` call sites in the same file; keep printing
  `report.mode` as the *reported* mode so the operator still sees the artifact's
  provenance. (b) close the asymmetry (see "Judgement calls"): make `reportExitCode`
  `(mode === "ci" || mode === "enforced") && !isPassGate(gate) ? 1 : 0`, so the two
  strict modes agree here as they already do at `exitCodeFor`, at `isBlockingMode` and
  at `securityFlowGate`.
- **class_scope**:
  - sites: `src/commands/security.ts:558` (the call, unvalidated mode),
    `src/commands/security.ts:575` (`reportExitCode`, the `ci`-only scope),
    `src/security/service.ts:286` (`runReport` returning the stored artifact verbatim),
    `src/security/service.ts:216` (`hasRecognizedGate`, which validates `gate` and
    nothing else). Correct by contrast: `src/commands/security.ts:250` and `:515`, which
    both pass `await modeOf(cwd)`.
  - enumeration_method: `ctx rg -n "isPassGate|exitCodeFor|reportExitCode" src/commands/security.ts`
    for the folds, `ctx rg -n 'exitCode' src/commands/health.ts src/commands/security.ts src/commands/flow.ts src/health src/security --glob '!*.test.ts'`
    (raw `…T15-35-49-953Z_rg.log`) for every exit-code assignment in the two modules;
    each hit read. Exactly four sites fold a gate/status vocabulary into an exit code in
    these two modules (`security.ts:250`, `:515`, `:558`, `health.ts:69`/`:87`/`:170`),
    and only `:558` sources its mode from the payload.
- **Confidence**: high (executed).

### [F-004] T50 guarded the value of the on-disk gate status but not its shape, so the same unvalidated cast still throws

- **Severity**: minor
- **File**: `src/health/service.ts:196` (`const status = latest.gate.status;`) with
  `readLatest` at `:36` (`JSON.parse(...) as HealthReport & { record?: string }`)
- **Problem**: T50's reachability argument — that `readLatest` is an unchecked type
  assertion over a file on disk — is correct and I reproduced it (H3). But the repair
  guarded only the *value* that assertion produces. The same assertion also lets the
  *shape* through: `latest.gate` may be absent or not an object. `latest.gate.status`
  then throws a `TypeError` outside `readLatest`'s `try`, and `latest.gate.reasons` can
  be `undefined` on the return, which `src/commands/health.ts:167`'s
  `for (const reason of result.reasons)` then throws on.
- **Impact**: not a false pass. `flow complete` catches it into `unevaluableGate("health")`
  → `status: "fail"` since T45, so that path fails closed; `keryx health gate` and the
  `health.gate` MCP tool (`src/mcp/tools.ts:641`, which returns the result directly)
  raise an unhandled `TypeError` at an agent-visible seam instead of the module's own
  "no report; run `keryx health run` first" refusal. Recorded because the sentence T50
  used to justify its own fix ("nothing validates the parsed JSON against the union at
  runtime") is still true of every other field of the same payload.
- **Reproduction**: `T39-exit.ts` H6/H7/H8 (raw `…T15-33-04-241Z_run.log`):
  a `latest.json` with no `gate` key, and a bare `[]`, both →
  `threw: "undefined is not an object (evaluating 'latest.gate.status')"`;
  `{"gate":"incomplete"}` (a string) → `{exitCode: 1}` with `status` and `reasons`
  `undefined`. H3/H4/H5 are the controls: `banana` → `exitCode 1`, `incomplete` →
  `exitCode 1`, `warn` → `exitCode 0` with `status` still `"warn"`.
- **Suggested fix**: validate the shape where the value is already validated — in
  `readLatest`, treat a parsed payload that is not an object, or whose `gate` is not an
  object carrying a string `status` and an array `reasons`, as `null`, which the
  existing `if (!latest)` branch already turns into the module's constant `fail` +
  `exitCode 1` + "no report" reason. That is the same narrow-predicate shape
  `hasRecognizedGate` uses in `src/security/service.ts:216` for the identical problem.

### [F-005] The manifest widening is broader than disclosed: a readable manifest with no `modules` key now blocks every write seam

- **Severity**: minor
- **File**: `src/security/guard.ts:157-160`, in `resolveManifestSecurityState`
- **Problem**: `T37-implementation.md`'s Concerns 3 discloses widening the blocking
  treatment from the `null` literal to all non-object manifest *bodies* (`[]`, `42`,
  `"x"`, `true`). The code goes further than the disclosure: after the body check it
  requires `.modules` to be a non-null, non-array object and returns
  `manifestUnreadable: true` when it is merely **absent**. A manifest that is a
  perfectly well-formed object — `{}`, or `{"name":"demo"}` — is therefore classified
  "present but not readable as the object it must be" and blocks. Every other manifest
  reader in the repository treats an absent `modules` as "module disabled"
  (`manifest.modules?.<name>` at `src/capability/seam.ts:70`, `src/commands/ctx.ts:131`,
  `src/testing/capability.ts:26`, `src/gdskills/project-skills.ts:664,681`,
  `src/gdskills/export.ts:199`), so `guard.ts` is now alone in reading it as a fault.
- **Impact**: fail-closed, so no security is lost, and the failure is loud rather than
  silent — but it converts a readable manifest into "security posture unavailable",
  refusing every guarded write (memory, wiki, testing, gdskills, metrics, sac,
  workspace, harness) and failing `flow complete`, with a message that says the manifest
  could not be read when it was read fine. Reachability is low: `keryx init`'s manifest
  type makes `modules` required (`src/commands/init.ts:228`), so a keryx-written manifest
  always has it. Rated `minor` on that basis, and reported because it is an undisclosed
  behaviour change in the file this recheck was sent to audit.
- **Reproduction**: `T39-posture.ts` A8 (`{}`) and A9 (`{"name":"demo"}`) → `guardAllowed: false`,
  `gate: {"status":"fail", detail:"security posture unavailable…"}`. Contrast A14
  (`{"modules":{}}`) → allowed, gate `null`. Raw `…T15-30-49-266Z_run.log`.
- **Suggested fix**: separate "absent" from "present and unusable" one level down, the
  same distinction `loadSecurityConfig` draws for the config file: `modules === undefined`
  → `{enabled:false, manifestUnreadable:false}` (module never configured, unchanged from
  before the repair); `modules` present but not a plain object → `manifestUnreadable: true`.
  One extra `if`. Note that this also removes the current conflation with a genuine I/O
  fault, which reaches the same branch today only because `readJsonFileOr`'s `{}`
  fallback happens to have no `modules` key — an accident of the fallback value, not a
  guard (see the shared-JSON-reader ruling).

### [F-006] `workspace confirm-review` halts only on `needs-approval`, so a `fail` or `incomplete` proposal mints a token unacknowledged

- **Severity**: info
- **File**: `src/commands/workspace.ts:157` and `:168`
- **Problem**: the same permissive-fallthrough reasoning on a security-relevant branch:
  `if (security.gate === "needs-approval" && !acknowledgeSecurity) throw`. A proposal
  whose gate is `fail` (an established violation) or `incomplete` (no evidence) mints a
  confirm token with `securityAcknowledged: false` and no message at all, while the
  weaker `needs-approval` is stopped. `:155` correctly refuses an unreadable gate, so
  the author clearly held the right principle one line earlier.
- **Impact**: none reachable today — `src/sac/index.ts:383,399,429` and
  `src/sac/proposal-lifecycle.ts:713` are allowlists (`gate !== "pass"` → error), so an
  accepted write intent still refuses a non-`pass` proposal downstream. Recorded so the
  next round does not rediscover it, and because the compensating control is in another
  module and could move. T38 classified this out of the exit-code class; I agree on that
  axis and disagree that it is a different *shape*.
- **Suggested fix**: require acknowledgement (or refuse outright) for any gate that is
  not `pass`, and say which of the three it was.

### [F-007] Test-coverage and doc drift around the repairs

- **Severity**: info
- **File**: `src/security/guard.test.ts:484`; also the absence of coverage for F-001/F-002
- **Problem**: (a) the committed test title still reads "T33 root trigger: a non-object
  `security.config.json` **falls back instead of throwing**" while the behaviour it now
  asserts is "blocks"; the body's comment explains the change, the title contradicts it.
  (b) No committed test covers an unrecognized `mode` (F-002) or the flow health fold
  (F-001), so both fallthroughs are untested rather than deliberately pinned. (c) The
  `guard.ts` header amendment claims "every mode blocks when the posture cannot be
  established" — true for an unreadable manifest/config, false for an unrecognized mode,
  which is the same unestablished posture.
- **Suggested fix**: retitle the test; add the two regressions with the fixes for F-001
  and F-002.

### [F-008] A forced-`enforced` posture is persisted into `state.json`, so restoring a valid advisory config raises a spurious downgrade incident

- **Severity**: info
- **File**: `src/security/service.ts:95` (`await writeState(cwd, currentState(config))`)
  with `src/security/config.ts:225`
- **Problem**: `loadSecurityConfig` forces `mode: "enforced"` for an unusable config
  (correct, F-003's repair), and every `check` persists `currentState(config).mode`.
  A `keryx security check-input` run while the config is corrupt therefore records
  `mode: "enforced"` in `.metaproject/data/security/raw/state.json`; after the operator
  repairs the file back to a legitimate `advisory`, `evaluateSelfProtection` compares
  ranks and raises "security mode downgraded: enforced -> advisory (enforcement
  weakened)" plus a `mode-downgrade` incident for a downgrade that never happened.
- **Impact**: fail-loud noise, not a bypass; recorded because it is a measured
  second-order effect of a repair this recheck is auditing, and because a false
  downgrade incident erodes the signal the real one carries.
- **Reproduction**: `T39-scan.ts` C1 (raw `…T15-37-56-202Z_run.log`):
  `configUnreadable: true`, `loadedMode: "enforced"`, `persistedStateMode: "enforced"`.
- **Suggested fix**: do not persist a synthesized posture — skip the `writeState` when
  `config.configUnreadable`, or record the forced mode as a distinct state so the rank
  comparison does not treat it as an operator choice.

## Judgement calls

### 1. The widening beyond the literal trigger (T37): safe?

**Ruling: the disclosed widening is safe and should be kept; the undisclosed part of it
should be narrowed (F-005).**

The disclosed half — treating `[]`, `42`, `"x"` and `true` the same as the `null`
literal that happened to crash — is right for three reasons I checked rather than
assumed. First, it is not a widening of *behaviour* so much as a removal of an accident:
those four shapes were non-blocking only because `manifest.modules` on them evaluates to
`undefined` instead of throwing, which is a property of JavaScript's member access, not
a decision anybody made. Second, it makes `guard.ts` agree with `config.ts`'s
`isMergeableConfigPayload`, which already treats every non-object payload uniformly, so
the module now answers "is this file the object it must be" the same way in both readers
— and the divergence between two sibling readers of two sibling files is precisely what
produced T35 F-001. Third, the cost is bounded and loud: all four shapes are
malformed-by-construction (no writer in this repository emits them), the outcome is a
refusal with a constant reason, and A14/A15 confirm the adjacent legitimate shapes are
untouched.

What is not safe is the part that was not disclosed: the same code path also blocks a
**well-formed manifest object with no `modules` key**. That is not a payload "not
readable as the object it must be" — it is a readable manifest that says nothing about
modules, which every other reader in the repository reads as "module disabled". The
implementer's own framing ("all non-object shapes") does not cover it, so this was
widened by omission rather than by decision. Narrow it with one `if` (F-005) and the
widening as a whole becomes defensible.

### 2. The asymmetric fold — `reportExitCode` `ci`-only while `exitCodeFor` covers both

**Ruling: the asymmetry is wrong and should be closed. The implementer's *process* was
right and its *result* is not.**

Reproducing the reviewer's literal suggested fix rather than making an unrequested scope
decision is the correct instinct for a worker, and disclosing it was correct. But three
things settle the substance against keeping it.

1. **Measured, it is bigger than disclosed.** T38's Concerns describe the residual as
   `enforced` + `needs-approval`. S2 shows `reportExitCode(gate, "enforced")` returns 0
   for `fail` and `incomplete` too. So the surface is not "slightly more permissive for
   the approval case" — `keryx security report` in `enforced` exits 0 on an established
   threshold violation. Nobody argued for that, and I do not believe anyone intended it.
2. **The stated rationale does not distinguish the two modes.** The justification is
   that `security report` aggregates the last stored scan rather than a live decision.
   That is a true statement about the *surface*, and it applies identically to `ci` —
   which does refuse. The distinction drawn is between modes, but the reason given is
   about surfaces, so it does not support the line it draws.
3. **Every other fold in both modules treats the two modes as one.** `isBlockingMode`
   (`guard.ts:181`), `exitCodeFor` after T38, `guardOutput`'s blocking branch, and
   `securityFlowGate` all pair `enforced` with `ci`. `reportExitCode` is now the only
   place in the codebase where `enforced` is *more permissive* than `ci` — which is the
   same inversion F-002 called "backwards", surviving in the sibling function.

The fix is the one condition already written in F-003's suggested fix. Close it together
with the `report.mode` source, since both are one line in the same function and either
alone leaves the surface untruthful.

### 3. The changed test expectations

**Ruling: all three restore intent; none weakens coverage. I checked what each assertion
had been protecting, not only what it now says.**

- **`guard.test.ts:484`, "T33 root trigger"** — `findings.length > 0` replaced by
  `expect(result.allowed).toBe(false)`. The old assertion protected "the write is still
  analysed and the planted secret is found under the fallback config". Under the
  corrected semantics the guard blocks *before* analysis, so that property is not merely
  unasserted, it is no longer true — the assertion could not be kept in any form. The
  replacement is strictly stronger (it asserts the outcome the phase exists to produce),
  the loop over four payload shapes is intact, the two sibling assertions
  (`gate !== "pass"`, `securityFlowGate` non-null) are intact, and the property the old
  assertion protected — that a *readable* config still analyses content and finds
  secrets — is still covered by the unchanged advisory/enforced tests and by
  `T37 D2c`. Verdict: restores intent. (Its title is now stale — F-007.)
- **`security.check-input.test.ts:140-154`, "an operator who lowers the injection floor
  DOES get a refusal"** — `ci` expectation 0 → 1. The old assertion literally asserted
  F-002's defect under a comment calling it "the documented split rather than a gap". The
  test's own title says a refusal is expected; the new expectation is the one that agrees
  with the title. Verdict: restores intent.
- **`security.check-input.test.ts:483-503`, formerly "ci + needs-approval emits
  NOTHING"** — `{exit:0, out:""}` replaced by `exit 0` + a `permission:"deny"` document
  + the retained `NEEDS-APPROVAL` assertion + a **new** leak assertion
  (`err).not.toContain(INJECTION)`). The one thing worth checking here is whether the
  `silent` branch of `decideHookOutcome` lost its only test when this case stopped being
  silent. It did not: `:470-481` (advisory + AWS key, `cursor`/`antigravity`) still
  asserts `{exit: 0, out: ""}` and is the silent-branch control. Coverage strictly
  increased. Verdict: restores intent.

### 4. The shared JSON reader (`src/lib/json.ts`) — is per-site guarding sufficient?

**Ruling: no, and also not the right question. Do not change `readJsonFileOr`'s
semantics; add a shape-aware sibling and migrate the gate-relevant readers to it. My
evidence points at a defect class strictly larger than this function.**

Four things I established rather than assumed:

1. **Changing the fallback semantics would not have prevented the health hole.**
   `src/health/service.ts:36` does not use `readJsonFileOr` at all — it is a bare
   `JSON.parse(...) as HealthReport`. F-004 and T50's own reachability argument both
   live there. So the real class is "parse a file on disk and assert a type over it
   without validating the shape", of which `readJsonFileOr` is one instrument among
   several. A fix confined to `json.ts` would close a fraction of it and would read as
   though it had closed the whole.
2. **The current API forces a workaround, which is the actual defect in `json.ts`.**
   `readJsonFileOr` collapses "did not parse" into "here is your fallback value", so a
   caller that needs to tell a parse failure from a legitimate `{}` cannot. `config.ts`
   had to invent a module-local `Symbol` sentinel (`CONFIG_UNREADABLE`, `:201`) to
   recover the information the API discarded. One workaround is a workaround; a second
   caller needing the same one means the return type is wrong. That is what should
   change: a result-returning sibling (`{ok:true, value} | {ok:false}` or
   `readJsonObjectOr`, which returns the fallback for any payload that is not a plain
   object) makes the distinction expressible without a sentinel per module.
3. **Silently changing `readJsonFileOr` would be wrong for its honest callers.** 24
   files call it (`ctx rg -c "readJsonFileOr" src --glob '!*.test.ts'`, raw
   `…T15-33-52-765Z_rg.log`). Some legitimately read non-object JSON, and a reader that
   started returning the fallback for arrays would break them quietly — trading a known
   class of bug for an unknown one. A new function is opt-in; a changed contract is not.
4. **Per-site guarding has demonstrably missed sites, twice, in two rounds.** T35 found
   `guard.ts:104` unguarded next to a guarded `config.ts`; this round found the same
   payload's *shape* unguarded next to a guarded *value* in `health/service.ts`, plus
   `report.mode` unguarded next to a guarded `report.gate` (F-003). Per-site guarding is
   necessary — each site knows its own shape — but as a *policy* it has a measured
   failure rate on exactly the files these tasks were auditing.

Concretely, for the task that must decide: add `readJsonObjectOr` (or a result union) to
`src/lib/json.ts` without touching `readJsonFileOr`; migrate the readers whose payload
feeds a gate, an exit code or a security decision — `src/security/config.ts` (which can
then drop its Symbol), `src/security/guard.ts`, `src/health/service.ts`'s `readLatest`,
and `src/security/service.ts`'s `readLatestReport` (already correct, as the reference
shape) — and leave the remaining call sites alone until one of them is shown to feed a
decision. The eight `manifest.modules` readers T35 enumerated stay fail-closed and are
not urgent; `src/gdgraph/symbols-capability.ts:24` and `src/capability/wiring.ts:107`
already carry the guard and are the pattern.

## Confirmed clean areas

Checked, with no finding:

- **Leak safety on every repaired path.** Across 36 posture cases and 4 CLI check cases,
  no `reason`, `detail` or serialized result contained the workspace root, the planted
  `AKIAIOSFODNN7EXAMPLE`, the string `JSON`, or `ENOENT` (`leaky: false` on every row of
  `T39-posture.ts`). The forced-mode flag carries no error text, path or source bytes.
- **No disk mutation from the forced-closed posture.** C1: config bytes, `mtimeMs` and
  the `.metaproject/` directory listing are identical before and after
  `loadSecurityConfig` + `guardOutput` + `securityFlowGate`.
- **Prototype hygiene.** `{"__proto__":{"modules":{"security":{"enabled":true}}}}` is
  rejected as unreadable and `Object.prototype.modules` / `.mode` are still `undefined`
  after all 36 payloads (A17, D1).
- **No relabeling in the safe direction.** A16/B8/B9/B10 confirm an enabled module with
  a readable config still behaves exactly as before: `enforced`/`ci` block on findings
  with the truthful `[security] fail: 1 finding(s) (secret:1)` reason, `advisory` allows
  with the finding still on the decision. The repairs did not buy truthfulness by
  blocking everything.
- **The two health folds are behaviour-preserving.** Both 4×2 truth tables (H1, H2)
  reproduce T48's and T50's tables cell for cell; only the unrecognized value changed,
  and it changed at both `strict` settings, as documented.
- **`exitCodeFor` did not over-refuse.** S1: `advisory` and `gateway` still return 0 for
  every gate, so §11's report-only invariant is intact; `enforced`'s four recognized
  answers are unchanged.
- **The throwing-gate arm is closed.** `unevaluableGate` (`src/flow/service.ts:941-949`)
  returns `status: "fail"` with a constant, non-interpolated detail for all four gates,
  so T35 F-005's first half is fixed (T45/T47) and a gate that throws no longer reads as
  `skipped`. F-001 is the surviving half, and it needs no throw at all.
- **No vocabulary mixing.** `GateStatus` appears nowhere under `src/security/` or in
  `src/commands/security.ts`; `SecurityGate`/`SecurityGateStatus` appear nowhere under
  `src/health/` or in `src/commands/health.ts` (raw `…T15-33-54-433Z_rg.log`,
  `…T15-33-54-559Z_rg.log`). The five folds share a shape and no imports, as claimed.
- **Regression suite.** `bun test src/security/guard.test.ts
  src/commands/security-gate-exit.test.ts src/commands/health-gate-exit.test.ts
  src/health/service-gate-exit.test.ts src/flow/security-gate.test.ts` →
  **63 pass / 0 fail / 298 expect()**.
- **Excluded areas.** `src/flow/review-gate.ts`, `src/security/detect/exfil.ts` and
  `src/security/output-validation.ts` are byte-identical at start and end and are
  excluded from every verdict above regardless.

## Evidence

Raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

| # | What ran | Raw log | SHA-256 |
|---|---|---|---|
| 1 | `T39-posture.ts` (36 manifest/config cases + the no-disk-write check) | `2026-09-06T15-30-49-266Z_run.log` | `64faf88e70d0adb589b2c1ffc93221e145dd4c09aa3dcc9d4cdd08eb56019298` |
| 2 | `T39-exit.ts` (S1–S3, H1–H8, F1–F2 through the real `complete()` pipeline) | `2026-09-06T15-33-04-241Z_run.log` | `003b0d72071135b7347741eaccaaf2256acaf1a5cb482892af019ec827cdb01e` |
| 3 | `T39-scan.ts` (CLI check path + persisted §14 state, 4 configs) | `2026-09-06T15-37-56-202Z_run.log` | `ecb697b83da28e6ef2faf03c6d33e82128b98ea07d760f6299524d69906207e7` |
| 4 | focused regression selection (63 pass / 0 fail) | `2026-09-06T15-34-37-397Z_run.log` | `9d8ff2006fcccfd4447ea0e8eaa70d60022552a962e99be7e88db4129553604d` |
| 5 | enumeration: gate/status folds across `src` (F-001 class) | `2026-09-06T15-35-00-547Z_rg.log` | `d8e37d7a0043df823893b70ec6e71a1b27d81c12e9451e91370bb0ccd71a3d3a` |
| 6 | enumeration: every `exitCode` assignment in the two modules (F-003 class) | `2026-09-06T15-35-49-953Z_rg.log` | `adb220b16f451dba671b73f0758120c04e354bc5fabc13f5af074312eed701e5` |
| 7 | enumeration: `readJsonFileOr` call sites (24 files) | `2026-09-06T15-33-52-765Z_rg.log` | `abb8d1e97ca464a9d575441971ec6123002dd590bc3032b5e2d9baa3b1e3b8ea` |
| 8 | vocabulary check: `GateStatus` in the security module | `2026-09-06T15-33-54-433Z_rg.log` | `518d92c803692b21b734c0ae5e256fd9e9f89dce16e7e4a3553c65cc4b74f697` |
| 9 | vocabulary check: `SecurityGate` in the health module | `2026-09-06T15-33-54-559Z_rg.log` | `aedc46b3c5c9c047bf877dc3ee4d724b5aa712b1c00e25777ba02db00e819577` |

File digests, start and end of review (identical for every file): see
`.T39-hashes-start.txt` and `.T39-hashes-end.txt` in this directory.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set, symbols and line
ranges; the one genuine discovery question, the class scope of F-001/F-002/F-003, is a
text-shape question `ctx rg` answers and the graph does not); wiki_used: no
(not-relevant — the normative sources are `docs/requirements/keryx-agent-first-core/policies.md`
and the frozen `acceptance-criteria.md`, both named in the dispatch and read directly);
ctx_used: yes (every code search via `bun src/cli.ts ctx rg`, every probe, test run and
diff via `bun src/cli.ts ctx run` / `ctx diff`; nine raw logs cited above);
raw_rg_used: no — no bare `rg`/`grep`/`cat`/`find`/`sed` was run over project code or
anything else. Bounded source excerpts were taken with the `Read` tool, as the routing
hook requires. `bun src/cli.ts ctx diff` compacted the two changed test hunks past
usefulness, so the changed regions were read with `Read` at the line ranges the diff
summary reported, rather than with a raw-escape `git diff`.`

## Constraint compliance

No git state changed; no flow CLI or flow state touched; no dependency or lockfile
change; no network; no model calls; no `bun test` without file arguments; production and
test code read-only (hashes above); every fixture synthetic, under `mkdtemp`, removed in
`finally`; no real credential used — the only key-shaped string is the documented
synthetic `AKIAIOSFODNN7EXAMPLE` the committed tests already use; no earlier artifact
modified; the three files owned by concurrent workers are byte-identical at start and end.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T39#F-001",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "blocker",
    "file": "src/flow/service.ts",
    "line": 641,
    "symbol": "complete (Gate 5: code health)",
    "problem": "The flow-completion health gate folds a four-member GateStatus with a one-value denylist: `health.status === \"fail\" ? {status:\"fail\"} : {status:\"pass\", detail: `health gate: ${health.status}`}`. `deps.healthGate` is `createCodeHealthService().gate()` at both real wirings (src/commands/flow.ts:117-119, src/harness/tool/metaproject-adapter.ts:111-114), whose status is `pass | warn | incomplete | fail`. `incomplete` -- which computeGate (src/health/gate.ts:58-63) emits whenever a REQUIRED source is unavailable, failed to execute, or failed to parse, i.e. verbatim policies.md's INCOMPLETE and AC4/AFC-05's skipped-required-check -- is recorded as a gate row with status \"pass\" and completion succeeds. So does `warn`, and so does any unrecognized value. This is the fifth site of the exact shape T33/T38/T48/T50 were dispatched to remove, on the one path none of them owned, and it needs no corruption or tampering to reach.",
    "impact": "AC8's own sentence -- 'no required failed or incomplete check is relabeled PASS at any surface' -- fails on the shared completion path, the surface a machine reads to decide a phase is done. The false pass is durable and published: the gate row is written into flow.json history and buildIssueComment posts it to the issue tracker. It is also the sharpest Row-3 consistency violation: the identical value exits 1 at `keryx health gate` (src/health/service.ts gateExitCode) and at `keryx health run` (src/commands/health.ts runExitCode) and passes here. The harness wiring means an agent-driven `flow complete` accepts it too.",
    "suggested_fix": "Replace the ternary with the exhaustive switch the four sibling folds use, over health's own vocabulary, default arm blocking. `warn` is the one value needing a decision rather than a mechanical fold (it exits 0 at both health commands unless --strict/--strict-warn), so the minimal correct fix is pass->pass, warn->pass (matching the non-strict command default, reason string still visible in detail), fail/incomplete/default->fail. While the file is open, note that the security arm at :656 passes security.status through verbatim, so a future `skipped` from securityFlowGate would be non-blocking under :663.",
    "evidence": "T39-exit.ts section F1, raw .metaproject/data/gdctx/raw/2026-09-06T15-33-04-241Z_run.log: the real createFlowService().complete() pipeline, one run per health status. incomplete -> recordedGateStatus \"pass\", detail \"health gate: incomplete\", completionPassed true; warn -> same; an unrecognized value -> same; fail -> recordedGateStatus \"fail\", completionPassed false. No committed test covers it: `ctx rg -n \"incomplete\" src/flow/service.test.ts src/flow/security-gate.test.ts` returns zero matches.",
    "confidence": "high",
    "dedupe_key": "flow-complete-health-gate-incomplete-relabeled-pass",
    "blocking_merge": true,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/flow/service.ts:641",
        "src/flow/service.ts:656",
        "src/flow/service.ts:663"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg -n 'status === \"fail\"|status !== \"fail\"|status === \"pass\"|status !== \"pass\"|gate === \"pass\"|gate !== \"pass\"|gate === \"fail\"|gate !== \"fail\"' src --glob '!*.test.ts' (raw 2026-09-06T15-35-00-547Z_rg.log), then every hit read. Allowlist-shaped hits are correct and out of class: src/sac/index.ts:383,399,429; src/sac/proposal-lifecycle.ts:713; src/lib/serve-turn.ts:789; src/harness/completion/gate.ts:131; src/harness/flow/managed-flow-port.ts:53,61; src/harness/flow/parity.ts:44,66. src/commands/security.ts:760 folds the detector-eval gate whose status is computed in-process as a two-member set (src/security/eval/harness.ts:209), so it is total and out of class -- confirming T35's classification. src/commands/workspace.ts:157 is reported separately as F-006."
    }
  },
  {
    "id": "F-002",
    "global_id": "T39#F-002",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "major",
    "file": "src/security/config.ts",
    "line": 150,
    "symbol": "mergeSecurityConfig / loadSecurityConfig / isBlockingMode",
    "problem": "SecurityMode is a closed four-member union (src/security/types.ts:93) with a schema enum (src/security/schemas.ts:139,261), but mergeSecurityConfig takes `parsed.mode ?? base.mode` unvalidated and loadSecurityConfig never calls validateSecurityConfig -- the codebase states this itself at src/commands/security.ts:976. The mode is then consumed by isBlockingMode (src/security/guard.ts:181), a two-value allowlist for BLOCKING whose fallthrough is the permissive side, and by exitCodeFor/reportExitCode, whose ci/enforced guards are equality tests. A readable, well-formed config declaring `{\"mode\":\"ENFORCED\"}` (or \"enforcd\", \"enforced \", 42, true) silently resolves to report-only: guardOutput ALLOWS a planted AWS key, securityFlowGate returns {status:\"pass\", detail:\"security ENFORCED: informational (advisory does not block)\"}, and both CLI folds return 0. Section 14 self-protection does not compensate: MODE_RANK[unrecognized] is undefined, so the downgrade comparison at src/security/self-protect.ts:88 is false and no warning or incident is raised. T37 established that a posture which cannot be established must block and applied it to the config FILE's shape; a config whose declared MODE is not one this build knows is equally an unestablished posture and takes the permissive path.",
    "impact": "An enforced/CI workspace becomes report-only with the enforcement it declared silently absent -- the identical outcome T30 F-001 and T35 F-003 describe and T37 was accepted for closing, surviving on the mode axis. The flow-completion gate reports a required check with an unestablished posture as PASS (AC8). `keryx security check-input` returns exit 0 on a live AWS key with one `fail` finding. The trigger is an operator typo or a one-byte write, with no operator-visible signal at any decision point.",
    "suggested_fix": "Validate the mode where T37 already made the function total: after the mergeable-payload check in loadSecurityConfig, `const merged = mergeSecurityConfig(parsed); if (!MODES.has(merged.mode)) return { ...merged, mode: \"enforced\", configUnreadable: true };` with MODES = new Set([\"advisory\",\"enforced\",\"ci\",\"gateway\"]). One Set and one if; it reaches the existing POSTURE_UNAVAILABLE_REASON branches unchanged, keeps loadSecurityConfig total, and changes nothing for a config whose mode is one of the four. Independently, make isBlockingMode an exhaustive switch over SecurityMode with the default arm on the blocking side, so a fifth mode cannot inherit 'does not block' by omission.",
    "evidence": "T39-posture.ts B11-B16, raw .metaproject/data/gdctx/raw/2026-09-06T15-30-49-266Z_run.log: for {\"mode\":\"ENFORCED\"} with the module enabled and a planted AKIAIOSFODNN7EXAMPLE -- guardAllowed true, guardGate \"fail\", gate {\"status\":\"pass\",\"detail\":\"security ENFORCED: informational (advisory does not block)\"}. T39-scan.ts C3, raw 2026-09-06T15-37-56-202Z_run.log: loadedMode \"ENFORCED\", gate \"fail\", findings 1, cliExitCode 0, persistedStateMode \"ENFORCED\"; controls C2 (advisory -> 0), C4 (ci -> 1), C1 (unreadable config -> enforced -> 1). T39-exit.ts S1/S2: both CLI folds return 0 for every gate under \"BANANAS\", \"CI\" and \"ci \".",
    "confidence": "high",
    "dedupe_key": "security-config-unrecognized-mode-silent-advisory-downgrade",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/config.ts:150",
        "src/security/config.ts:218",
        "src/security/guard.ts:181",
        "src/security/guard.ts:280",
        "src/security/guard.ts:387",
        "src/commands/security.ts:854",
        "src/commands/security.ts:576",
        "src/security/self-protect.ts:88"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg -n -A 4 '\"advisory\"' src/security/schemas.ts src/security/types.ts (raw 2026-09-06T15-32-02-348Z_rg.log) established the closed union and its schema enum; then ctx rg -n \"loadSecurityConfig|isBlockingMode\" src --glob '!*.test.ts' and ctx rg -n \"mode\" src/commands/security.ts enumerated every consumer that branches on a mode value. All eight are listed. modeOf (src/commands/security.ts:793) is a one-line delegate to loadSecurityConfig and carries no branch of its own."
    }
  },
  {
    "id": "F-003",
    "global_id": "T39#F-003",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "major",
    "file": "src/commands/security.ts",
    "line": 558,
    "symbol": "handleReport / reportExitCode",
    "problem": "T38 made reportExitCode's GATE argument an allowlist over `pass`, but its MODE argument is `report.mode` -- a field of the stored artifact being judged. runReport returns latest.report verbatim (src/security/service.ts:286) and hasRecognizedGate (:216) validates only that `gate` is one of the four values; every other field, mode included, is whatever is on disk. So the question 'is this workspace in strict CI?' is answered by the file under judgement. A workspace configured `ci` whose last scan was recorded under `advisory` -- scan, switch the project to CI, run `security report` in the pipeline -- exits 0 on a `fail` gate. Every other exit-code site in the module asks loadSecurityConfig instead (exitCodeFor is called as exitCodeFor(..., await modeOf(cwd)) at :250 and :515). Separately, the disclosed ci-only scope is broader in effect than disclosed: reportExitCode(gate, \"enforced\") returns 0 for fail and incomplete as well as needs-approval.",
    "impact": "The CLI surface T38 exists to make truthful still exits 0 on an established threshold violation, through a field a stale or tampered artifact controls, and through the sibling strict mode. runGate is not exposed as a CLI command, so these two exit codes are the CLI gate, and policies.md's 'strict CI accepts only PASS' is unmet for `enforced` on all three non-pass values.",
    "suggested_fix": "Two one-liners in the same function. (a) Source the mode from the workspace, not the artifact: `process.exitCode = reportExitCode(report.gate, await modeOf(cwd));`, matching the two exitCodeFor call sites in the same file; keep printing report.mode so the artifact's provenance stays visible. (b) Close the asymmetry: `return (mode === \"ci\" || mode === \"enforced\") && !isPassGate(gate) ? 1 : 0;`, so the two strict modes agree here as they already do at exitCodeFor, isBlockingMode and securityFlowGate. Either fix alone leaves the surface untruthful.",
    "evidence": "T39-exit.ts S3, raw .metaproject/data/gdctx/raw/2026-09-06T15-33-04-241Z_run.log: workspace config {\"mode\":\"ci\"}, stored latest.json {\"gate\":\"fail\",\"mode\":\"advisory\",...} -> runGate \"fail\", runReport gate \"fail\", cliExitCode 0, exitCodeIfWorkspaceModeWereUsed 1. S2 rows: reportExitCode(gate, \"enforced\") is 0 for fail, needs-approval, incomplete and an unrecognized value.",
    "confidence": "high",
    "dedupe_key": "security-report-exit-code-uses-artifact-mode-and-skips-enforced",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/commands/security.ts:558",
        "src/commands/security.ts:575",
        "src/security/service.ts:286",
        "src/security/service.ts:216",
        "src/commands/security.ts:250",
        "src/commands/security.ts:515"
      ],
      "enumeration_method": "ctx rg -n \"isPassGate|exitCodeFor|reportExitCode\" src/commands/security.ts for the folds, then ctx rg -n 'exitCode' src/commands/health.ts src/commands/security.ts src/commands/flow.ts src/health src/security --glob '!*.test.ts' (raw 2026-09-06T15-35-49-953Z_rg.log) for every exit-code assignment in the two modules, each hit read. Exactly four sites fold a gate/status vocabulary into an exit code in these modules (security.ts:250, :515, :558; health.ts:69/:87/:170), and only :558 sources its mode from the payload; the last two entries are the correct-by-contrast sites."
    }
  },
  {
    "id": "F-004",
    "global_id": "T39#F-004",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "minor",
    "file": "src/health/service.ts",
    "line": 196,
    "symbol": "gate / readLatest",
    "problem": "T50's reachability argument -- that readLatest (:36) is an unchecked `as HealthReport` assertion over a file on disk -- is correct and reproduces. But the repair guarded only the VALUE that assertion produces (gateExitCode's default arm). The same assertion also admits a wrong SHAPE: `latest.gate` may be absent or not an object, and `latest.gate.status` at :196 then throws a TypeError outside readLatest's try; `latest.gate.reasons` can come back undefined, which src/commands/health.ts:167's `for (const reason of result.reasons)` throws on.",
    "impact": "Not a false pass. flow complete catches it into unevaluableGate(\"health\") -> status \"fail\" since T45, so that path fails closed; `keryx health gate` and the health.gate MCP tool (src/mcp/tools.ts:641, which returns the result directly) raise an unhandled TypeError at an agent-visible seam instead of the module's own 'no report; run `keryx health run` first' refusal. Recorded because the sentence T50 used to justify its own fix is still true of every other field of the same payload.",
    "suggested_fix": "Validate the shape where the value is already validated: in readLatest, treat a parsed payload that is not an object, or whose `gate` is not an object carrying a string `status` and an array `reasons`, as null -- the existing `if (!latest)` branch already turns that into the constant fail + exitCode 1 + 'no report' reason. Same narrow-predicate shape as hasRecognizedGate in src/security/service.ts:216.",
    "evidence": "T39-exit.ts H6/H7/H8, raw .metaproject/data/gdctx/raw/2026-09-06T15-33-04-241Z_run.log: a latest.json with no `gate` key and a bare [] both threw \"undefined is not an object (evaluating 'latest.gate.status')\"; {\"gate\":\"incomplete\"} (a string) returned {exitCode: 1} with status and reasons undefined. Controls H3 (banana -> exitCode 1, confirming T50's reachability claim independently), H4 (incomplete -> 1), H5 (warn -> 0 with status still \"warn\").",
    "confidence": "high",
    "dedupe_key": "health-readlatest-shape-unvalidated-gate-dereference",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true
  },
  {
    "id": "F-005",
    "global_id": "T39#F-005",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "minor",
    "file": "src/security/guard.ts",
    "line": 158,
    "symbol": "resolveManifestSecurityState",
    "problem": "T37-implementation.md's Concerns 3 discloses widening the blocking treatment from the `null` literal to all non-object manifest BODIES. The code goes further: after the body check it requires `.modules` to be a non-null non-array object and returns manifestUnreadable:true when it is merely ABSENT. A well-formed manifest object -- `{}` or `{\"name\":\"demo\"}` -- is therefore classified 'present but not readable as the object it must be' and blocks. Every other manifest reader in the repository reads an absent `modules` as 'module disabled' (src/capability/seam.ts:70, src/commands/ctx.ts:131, src/testing/capability.ts:26, src/gdskills/project-skills.ts:664,681, src/gdskills/export.ts:199), so guard.ts is now alone in reading it as a fault. It also conflates a genuine I/O fault with this case only by accident: readJsonFileOr's {} fallback happens to have no `modules` key.",
    "impact": "Fail-closed, so no security is lost and the failure is loud -- but it converts a readable manifest into 'security posture unavailable', refusing every guarded write (memory, wiki, testing, gdskills, metrics, sac, workspace, harness) and failing flow complete, with a message saying the manifest could not be read when it read fine. Reachability is low: keryx init's manifest type makes `modules` required (src/commands/init.ts:228), so a keryx-written manifest always has it. Reported because it is an undisclosed behaviour change in the file this recheck audits.",
    "suggested_fix": "Separate 'absent' from 'present and unusable' one level down, the same distinction loadSecurityConfig draws for the config file: modules === undefined -> {enabled:false, manifestUnreadable:false} (module never configured, unchanged from before the repair); modules present but not a plain object -> manifestUnreadable:true. One extra if.",
    "evidence": "T39-posture.ts A8 ({}) and A9 ({\"name\":\"demo\"}), raw .metaproject/data/gdctx/raw/2026-09-06T15-30-49-266Z_run.log: guardAllowed false, gate {\"status\":\"fail\",\"detail\":\"security posture unavailable: check could not complete\"}. Contrast A14 ({\"modules\":{}}) -> allowed, gate null; A1 (absent manifest) -> allowed, gate null.",
    "confidence": "high",
    "dedupe_key": "guard-manifest-missing-modules-key-treated-as-unreadable",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-006",
    "global_id": "T39#F-006",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "info",
    "file": "src/commands/workspace.ts",
    "line": 157,
    "symbol": "workspace confirm-review",
    "problem": "The same permissive-fallthrough reasoning on a security-relevant branch: `if (security.gate === \"needs-approval\" && !acknowledgeSecurity) throw`. A proposal whose gate is `fail` (an established violation) or `incomplete` (no evidence) mints a confirm token with securityAcknowledged:false and no message, while the weaker needs-approval is stopped. Line :155 correctly refuses an unreadable gate, so the right principle is held one line earlier.",
    "impact": "None reachable today: src/sac/index.ts:383,399,429 and src/sac/proposal-lifecycle.ts:713 are allowlists (gate !== \"pass\" -> error), so an accepted write intent still refuses a non-pass proposal downstream. Recorded so the next round does not rediscover it, and because the compensating control lives in another module and could move.",
    "suggested_fix": "Require acknowledgement (or refuse outright) for any gate that is not `pass`, and name which of the three outcomes it was.",
    "evidence": "Read of src/commands/workspace.ts:138-169 and the compensating allowlists at src/sac/index.ts:383,399,429 found via ctx rg (raw 2026-09-06T15-35-00-547Z_rg.log). Not executed; classified info on that basis.",
    "confidence": "medium",
    "dedupe_key": "workspace-confirm-review-only-halts-on-needs-approval",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-007",
    "global_id": "T39#F-007",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "info",
    "file": "src/security/guard.test.ts",
    "line": 484,
    "symbol": "T33 root trigger test / coverage gaps",
    "problem": "(a) The committed test title still reads 'a non-object security.config.json falls back instead of throwing' while the behaviour it now asserts is 'blocks'; the body comment explains the change, the title contradicts it. (b) No committed test covers an unrecognized config mode (F-002) or the flow health fold (F-001), so both fallthroughs are untested rather than deliberately pinned. (c) The guard.ts header amendment claims every mode blocks when the posture cannot be established -- true for an unreadable manifest/config, false for an unrecognized mode, which is the same unestablished posture.",
    "impact": "Documentation and coverage drift only. Recorded because a title that describes the pre-fix behaviour is what let the two corrected expectations in security.check-input.test.ts encode a defect as intentional in the first place.",
    "suggested_fix": "Retitle the test; add the two regressions alongside the fixes for F-001 and F-002; amend the guard.ts header once F-002 is closed.",
    "evidence": "Read of src/security/guard.test.ts:484-519 and src/security/guard.ts:5-18; `ctx rg -n \"incomplete\" src/flow/service.test.ts src/flow/security-gate.test.ts` returned zero matches (raw 2026-09-06T15-34-38-962Z_rg.log).",
    "confidence": "high",
    "dedupe_key": "t33-root-trigger-test-title-stale-and-uncovered-fallthroughs",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-008",
    "global_id": "T39#F-008",
    "reviewer": "review-security-code+review-logic (T39 independent recheck)",
    "severity": "info",
    "file": "src/security/service.ts",
    "line": 95,
    "symbol": "check / writeState",
    "problem": "loadSecurityConfig forces mode \"enforced\" for an unusable config (correct, T37's repair), and every `check` persists currentState(config).mode. A `keryx security check-input` run while the config is corrupt therefore records mode \"enforced\" in .metaproject/data/security/raw/state.json; after the operator repairs the file back to a legitimate `advisory`, evaluateSelfProtection compares ranks and raises 'security mode downgraded: enforced -> advisory (enforcement weakened)' plus a mode-downgrade incident for a downgrade that never happened.",
    "impact": "Fail-loud noise, not a bypass. Recorded because it is a measured second-order effect of a repair under audit, and because a false downgrade incident erodes the signal a real one carries.",
    "suggested_fix": "Do not persist a synthesized posture: skip writeState when config.configUnreadable, or record the forced mode distinctly so the rank comparison does not treat it as an operator choice.",
    "evidence": "T39-scan.ts C1, raw .metaproject/data/gdctx/raw/2026-09-06T15-37-56-202Z_run.log: configUnreadable true, loadedMode \"enforced\", persistedStateMode \"enforced\". Rank comparison read at src/security/self-protect.ts:88.",
    "confidence": "high",
    "dedupe_key": "forced-enforced-posture-persisted-into-selfprotect-state",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  }
]
```
