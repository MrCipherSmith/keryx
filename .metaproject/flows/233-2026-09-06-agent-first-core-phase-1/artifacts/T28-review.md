STATUS: DONE_WITH_CONCERNS

# T28 — Independent review: recursive security scanner (T20) + runGate truthfulness

Reviewer: review-logic + review-security-code (independent; did not author T20).
Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`).
Stage 1 = specification compliance (executed). Stage 2 = code quality — **not run**, because Stage 1 failed (2 blockers, 2 majors). Per dispatch constraint "Stage1 before Stage2; stop Stage 2 if Stage 1 fails."

Nothing below is taken from the T20 self-report. Every verdict cites a probe I executed on my own synthetic `mkdtemp` fixtures, all of which were removed afterwards.

---

## Scope (hashes)

SHA-256 recorded at review start and again at review end. **One file drifted**: `service.ts`. Every other file is byte-identical start to end.

| File | SHA-256 start | SHA-256 end |
|------|---------------|-------------|
| `/Users/Goodea/goodea/keryx/src/security/path-scan.ts` | `1247042b5237a2c581c788d0063ab69e25be8cb0e1c803a66a46765ed8b7784d` | *unchanged* |
| `/Users/Goodea/goodea/keryx/src/security/service.ts` | `95e7786ec7bec39e8bd85845c010b8631405e4c2640eae1b26dfc754a3ef1a77` | **`5ddf3732602c22706d66b93114c7714981dea30b8a8eebda9fa4134201bea9f4`** |
| `/Users/Goodea/goodea/keryx/src/security/report.ts` | `4bfcecb80107eefd83fc51fb2590538aff7548f7508da522307534eac1bee88b` | *unchanged* |
| `/Users/Goodea/goodea/keryx/src/commands/security.ts` | `f8ac0cf4f4253ae7ad7cd244343f9567dad4a92bbbad9c5d65ab1e660fee656f` | *unchanged* |
| `/Users/Goodea/goodea/keryx/src/security/types.ts` | `c46ec47c1f509e4c1bcc57b975f7dd892fa2315d77b92d7e65796444b34d3b2f` | *unchanged* |
| `/Users/Goodea/goodea/keryx/src/security/schemas.ts` | `8c1455c2f29105c3134f5f2c3df6c6cf6517933d21e5f259b56a72e86fbd919e` | *unchanged* |

### Drift handling for `service.ts`

`service.ts` was edited by a concurrent worker after my probes ran (318 → 320 lines). I re-read the file and confirmed the change is **confined to the region the dispatch told me to exclude**: `validateSerializedOutput` moved from line 36 to line 45, and everything below it shifted. The bodies of `runScanPath`, `readLatestReport`, `runReport`, `runGate` and `createSecurityService.gate` are **textually identical** to the version I probed — verified statement by statement (`readLatestReport` 184→187, its two `return null`s 187/192→190/195, the `as SecurityReport` cast 191→193, `runReport`'s `buildReport([], config, "pass")` 205→210, `runGate` 210→213, the `!latest` pass return 216→219, the `fail || incomplete` fold 220→223, the catch-all pass return 226→229, `runScanPath`'s `recursive?: boolean` 124→127 and its forward 138→141, the `pass -> incomplete` promotion 167→173).

**All line numbers in this review are against the post-drift file** (`5ddf3732…`, 320 lines). My probes executed against `95e7786e…`; since the reviewed statements are unchanged, the observed behaviour carries over. If a later round finds the gate logic itself changed, re-run `T28-gate-probe.ts` — it is self-contained and takes under a second.

**Excluded from this verdict** (concurrently edited by other workers, per dispatch): `src/security/output-validation.ts`, `src/security/detect/exfil.ts`, `src/security/schemas.ts` `$ref` handling, `src/mcp/redact-seam.ts`, `guard.ts`, and the `validateSerializedOutput` helper at `src/security/service.ts:45-52` — which is precisely where the drift landed. I read `validateSerializedOutput` only to confirm it is not on the scan/gate path; it is not, and I make no claim about it. `schemas.ts` was hashed but reviewed only for the `scope`/`coverage`/`files` report shape (`schemas.ts:190-193`), not for `$ref` behaviour.

**Reviewed surface**: `path-scan.ts` (whole file), `service.ts` `runScanPath` / `readLatestReport` / `runReport` / `runGate` / `createSecurityService.gate` (lines 122-230, 317), `report.ts` `buildReport` / `renderScanMetadata` / `writeSecurityArtifacts`, `commands/security.ts` `handleScan` + `scanPathArgument` + `positiveScanLimit` (lines 192-290), `security-recursive-scan.test.ts`.

---

## Summary (counts by severity)

| Severity | Count |
|----------|-------|
| blocker | 2 |
| major | 2 |
| minor | 2 |
| info | 1 |
| **total** | **7** |

Headline: the **traversal engine is sound** — recursion, symlink cycles, external-symlink denial, leak-safety and the fail+incomplete fold all behave as specified under my own probes. The **gate fold is not** — `runGate` answers `pass` for a missing report, an unparseable report, a report with no recognizable `gate`, and a report whose gate is `needs-approval`. Under `policies.md` ("Strict CI принимает только PASS"; a required check that is missing / skipped / unparsed / unfinished ⇒ `INCOMPLETE`) each of those is a false pass.

---

## Stage 1 — specification compliance

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| AC1 | AFC-17 / AC6: nested folder gives no EISDIR; symlink cycle does not loop; inaccessible entries and exhausted limits are reflected; a found violation and incomplete coverage are visible simultaneously. | **MET** | Probe P1/P2/P3/P4/P6, raw `…/raw/2026-09-06T13-13-20-438Z_run.log`. Details below. |
| AC2 | policies.md (security scan): scope/excludes/max size+count/required coverage fixed before the run; internal symlinks and visited canonical identities recognized, external symlink denied; per-file scanned/skipped/failed with reasons and no hidden names for an unauthorized caller; findings preserved independently of coverage. | **NOT MET** | Sub-clauses "per-file scanned/skipped/failed with reasons" and "coverage reflects what was actually traversed" fail: F-003 and F-004. All other sub-clauses verified MET. Probe P1/P2/P5 + gate probe "non-recursive directory scan", raws `…13-13-20-438Z_run.log`, `…13-14-50-693Z_run.log`. |
| AC3 | runGate truthfulness: no report, malformed report and incomplete report each classified without a false pass; verdict backed by an executed probe with a raw log reference. | **NOT MET** | 8 of 13 executed cases return `status: "pass"` where policy requires not-pass. F-001, F-002. Raw `…/raw/2026-09-06T13-14-50-693Z_run.log` (SUMMARY block at line 155) and `…13-14-56-413Z_run.log`. |

### AC1 detail — what I executed and observed

Probes are in `T28-scan-probe.ts` (drives the real CLI entry point `securityCommand([...], root)` with `--json`, so the assertion is about the shipped command, not a private helper).

- **Nested recursion, no EISDIR** — P1 built `corpus/a/b/c/creds.env` (synthetic AWS example key). Result: `corpus/a/b/c/creds.env: scanned`, 1 finding `secret/secrets.aws-access-key`, `stderrHasEISDIR: false`, exit 0 (advisory mode). P6 repeated it with a single-file target: `scanned`, 1 finding. **No EISDIR on any probe.**
- **Internal symlink / canonical duplicate visited once** — P1 added `corpus/dup-creds.env -> corpus/a/b/c/creds.env`. The content was scanned exactly once (one `scanned` row, one `skipped: canonical identity already visited` row); `findingCount: 1`, not 2. Content-level de-duplication is correct. *(The row labelling is wrong — F-004 — but the visit-once behaviour itself is right.)*
- **Symlink cycle terminates** — P1 built a *mutual* directory cycle (`corpus/x/toY -> corpus/y`, `corpus/y/toX -> corpus/x`) plus a self-referential `corpus/self -> corpus`. The whole scan finished in **20 ms** with a `visited`-set skip on each re-entry. No recursion blow-up, no timeout, no depth-limit fallback needed.
- **Inaccessible entries reflected** — P2 (`chmod 000` file): `corpus/locked.txt: failed (unreadable or denied entry)` and `coverage.status: incomplete` with that reason.
- **Exhausted limits reflected** — P3 `--max-files 1`: `coverage.incomplete`, reason `file limit exceeded`, `corpus/01-more.env: skipped (file limit exceeded)`. P3 `--max-bytes 80`: `coverage.incomplete`, reason `byte limit exceeded`.
- **Finding + incomplete simultaneously, gate stays fail** — P2 and P3(max-files) both returned `gate: "fail"` **with** `coverage.status: "incomplete"` **and** `findingCount: 1`. This is the exact fold policies.md requires (`FAIL` может одновременно иметь `coverage=incomplete`); the `runScanPath` upgrade at `service.ts:173-175` only promotes `pass -> incomplete` (line 173) and correctly leaves `fail` alone. P4 (clean tree + one unreadable file, no findings) returned `gate: "incomplete"` — also correct.

### AC2 detail — verified sub-clauses

- **Fixed before traversal** — the `scope` object (path, recursive, exclusions, limits) is constructed at `path-scan.ts:110-118` *before* the first `visit()` at line 237, is echoed verbatim into the report (`report.ts:110-115`) and into `latest.md`. P3 confirmed `scope.limits.maxFiles: 1` was recorded alongside the truncated result; P5 confirmed exclusions are echoed.
- **External symlink denied, with no name or content leak** — P2 planted `corpus/ext-file-link -> <outside>/T28-OUTSIDE-FILENAME.txt` (containing canary `OUTSIDE_CANARY_CONTENT`) and `corpus/ext-dir-link -> <outside>/secretdir`. Both were reported as `skipped (external target refused)` under **their in-scope symlink names**. Canary checks over the full serialized JSON report *and* over the committable `latest.md`: `leaksOutsideFileName: false`, `leaksOutsideNestedName: false`, `leaksOutsideDirName: false`, `leaksTmpAbsolutePath: false`, `leaksOutsideContent: false`. An out-of-project exclusion argument (`--exclude ../../etc`, P5) is echoed as `[external exclusion omitted]` rather than as the path. **Leak-safety is clean.**
- **Findings preserved independently of coverage** — P3(max-files) kept the finding from `00-creds.env` after the limit truncated the run at `01-more.env`.
- **Exclusion narrows rather than incompletes** — P5: excluded dir gets `skipped (excluded by scan scope)` and `coverage` stays `complete`, matching "Пропуск по согласованному exclusion сужает заявленную область".

### AC2 detail — why it is NOT MET

Two clauses fail, both in the "per-file scanned/skipped/failed and reasons" / coverage-truthfulness area:

- **F-003** — a *non-recursive* directory scan reports `coverage: {status: "complete"}`, `gate: "pass"`, zero files scanned, while a detectable synthetic secret sits in the target directory. Executed, not inferred: gate-probe section "non-recursive directory scan".
- **F-004** — `skipped: canonical identity already visited` and `scanned` rows are keyed on the **canonical** path, not the path actually encountered. Executed: P1 emits `corpus/x: skipped` for a directory that was in fact fully traversed (the skipped entry was `corpus/y/toX`), and emits `corpus/a/b/c/creds.env` twice — once `scanned`, once `skipped` — while `corpus/dup-creds.env` gets no row at all.

### AC3 detail — the executed matrix

`T28-gate-probe.ts`, 13 fixtures, each a fresh `mkdtemp` root with `.metaproject/data/security/artifacts/latest.json` written (or deliberately absent). Both `runGate({cwd})` and `createSecurityService(root).gate({cwd})` were called; they agree in every case.

| Case | `latest.json` | `runGate` status | Policy-required | False pass? |
|------|---------------|------------------|-----------------|-------------|
| a | absent | `pass` | `INCOMPLETE` (required check missing) | **yes** |
| b | truncated JSON | `pass` | `INCOMPLETE` (не разобран) | **yes** |
| b2 | empty file | `pass` | `INCOMPLETE` | **yes** |
| b3 | `{"unrelated": true}` | `pass` | `INCOMPLETE` | **yes** |
| b4 | valid report, `gate: "banana"` | `pass` | `INCOMPLETE` | **yes** |
| b5 | valid JSON, `gate` field missing | `pass` | `INCOMPLETE` | **yes** |
| b6 | `[]` | `pass` | `INCOMPLETE` | **yes** |
| c | `gate: "incomplete"` | `incomplete` | `INCOMPLETE` | no |
| d | `gate: "fail"` | `fail` | `FAIL` | no |
| e | `gate: "needs-approval"` | `pass` | not-PASS | **yes** |
| f | `gate: "pass"` | `pass` | `PASS` | no |
| g | `gate: "fail"` + `coverage.incomplete` | `fail` | `FAIL` | no |
| h | `gate: "pass"` + `coverage.incomplete` | `pass` | (artifact `runScanPath` never writes; not counted) | n/a |

End-to-end control (same probe): a real `runScanPath` over a tree with an unreadable file produced `gate: "incomplete"`, and `runGate` on that same cwd correctly returned `incomplete` — so the **recognized-incomplete path (case c) genuinely works**; the failure is confined to the unrecognized/absent/needs-approval branches.

`runReport` shares the defect: with an absent or malformed `latest.json` it returns a freshly built report carrying `gate: "pass"` (`service.ts:206-211`), i.e. an artifact that asserts a clean scan that never happened.

---

## Findings

### [F-001] `runGate` reports `pass` when no report exists or the report cannot be parsed — blocker

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/service.ts` : 219 : `runGate` (with `readLatestReport`, lines 187-200)
- **problem**: `readLatestReport` returns `null` both when `latest.json` is absent (line 190) and when `JSON.parse` throws (line 195) — the two are indistinguishable to the caller. `runGate` then takes the `if (!latest)` branch and returns `{status: "pass", reasons: ["no security report; run \`keryx security scan\` first"]}`. The reason string is honest; the **status is not**, and machines read the status.
- **impact**: `policies.md` §"Health и security gate" fixes the fold as *"если required check отсутствует/пропущен/не разобран/не завершён — `INCOMPLETE`"* and *"Strict CI принимает только PASS"*. Any CI or agent that gates on `SecurityService.gate().status === "pass"` is signed off as clean by **never having run a scan at all**, or by a scan whose artifact was truncated mid-write. That is the single failure mode a security gate exists to prevent — the absence of evidence is returned as evidence of absence.
- **reproduction**: `bun /Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T28-gate-probe.ts` — cases a, b, b2. Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log`, SUMMARY at line 155.
- **suggested_fix**: make `readLatestReport` return a discriminated outcome (`{kind:"absent"} | {kind:"unparsed", reason} | {kind:"report", report}`) instead of `SecurityReport | null`, and map `absent` and `unparsed` to `status: "incomplete"` in `runGate`, keeping the existing human-readable reason. Do not widen the return type of `runGate` — `"incomplete"` is already in it.
- **class_scope**: sites = [`src/security/service.ts:189-191` (absent → null), `src/security/service.ts:193-196` (parse failure → null), `src/security/service.ts:216-221` (null → pass), `src/security/service.ts:206-211` (`runReport` same null → gate "pass" report)]. enumeration_method: `bun src/cli.ts ctx rg "runGate|\.gate\(|readLatestReport" src` — `readLatestReport` has exactly two callers (`runReport`, `runGate`), both in `service.ts`; `runGate` has exactly one wiring site (`service.ts:317`) and, per `grep -rn "\.gate(" src/mcp src/commands src/lib`, **zero in-repo consumers today** (every `.gate(` hit is `createCodeHealthService`, a different service). The class is therefore fully contained in `service.ts`, and the blast radius is the published `SecurityService` contract surface rather than a live CLI path — which lowers the urgency, not the correctness.

### [F-002] `runGate` treats every gate value it does not recognize — including `needs-approval` — as `pass` — blocker

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/service.ts` : 229 : `runGate`
- **problem**: the fold is written as a two-value denylist — `if (latest.gate === "fail" || latest.gate === "incomplete") { … }` then an unconditional `return {status: "pass", …}`. `SecurityGate` is `"pass" | "needs-approval" | "incomplete" | "fail"` (`types.ts:68`), so **`needs-approval` falls into the pass branch**. So does a `gate` field that is missing, a bogus string, or a `latest.json` that parsed as an array. `latest` is cast with `as SecurityReport` at line 193 with no shape validation, so nothing upstream catches it either. The emitted reason literally reads `security gate: undefined` in the missing-field case — the code prints the evidence of its own confusion and returns `pass` anyway.
- **impact**: `needs-approval` is the gate value that exists precisely to stop an unattended write pending a human — `workspace.ts:157` treats it as a hard stop requiring `--acknowledge-security`. Routing it to `pass` through the service contract lets an approval-gated decision be consumed as an approved one. The bogus/missing-field cases mean a corrupted or foreign artifact dropped into `.metaproject/data/security/artifacts/latest.json` is a *clean bill of health*, which makes the artifact an attractive tampering target: the safest write for an attacker is not a forged `pass` report but any malformed byte string.
- **reproduction**: same probe, cases b3, b4, b5, b6 and e. Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log` lines 172-203.
- **suggested_fix**: invert to an allowlist over the validated union: `pass -> pass`, `fail -> fail`, `incomplete -> incomplete`, `needs-approval -> incomplete` (or `fail`, per the project's chosen strictness — but never `pass`), and anything else -> `incomplete` with reason `unrecognized gate value`. Validate the parsed object against the existing report schema in `schemas.ts` before trusting `latest.gate`.
- **class_scope**: sites = [`src/security/service.ts:223-229` (the fold), `src/security/service.ts:193` (unvalidated `as SecurityReport` cast)]. enumeration_method: `bun src/cli.ts ctx rg "SecurityGate" src/security/types.ts` gives the complete four-value union; the fold at 220-226 is the only place in `src/security` that branches on `report.gate` for a gate decision (`grep -n "latest.gate\|\.gate ===" src/security/service.ts`). `computeGate` in `resolve.ts` is the *producer* of the value and is not in this class.

### [F-003] A non-recursive directory scan reports `coverage: complete` and `gate: pass` after scanning nothing — major

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/path-scan.ts` : 194 : `scanContainedPath` / `visit`
- **problem**: when `scope.recursive` is false and the target is a directory, `visit` pushes `{status: "skipped", reason: "recursive traversal disabled"}` and returns — **after** the `readdir`, and **without** scanning the directory's own direct children and **without** calling `incomplete()`. So the traversal declares full coverage of a directory it did not open a single file in. `runScanPath` then sees `coverage.status === "complete"` and leaves `computeGate([])`'s `pass` untouched (`service.ts:173-175`).
- **impact**: `runScanPath(cwd, {recursive: false, targetPath: <dir>})` is a silent, total false pass — the strongest form of the failure AC6 and policies.md are written against. Verified with a live secret in the target: the probe's `corpus/creds.env` held a detectable synthetic AWS key and the result was `gate: "pass"`, `findingCount: 0`, `coverage: complete`, and a subsequent `runGate` on the same cwd returned `pass`. Note the mitigating fact: **no in-repo caller passes `recursive: false` today**, so this is latent rather than live — but it is reachable by any consumer of the exported `runScanPath`, and the option is part of the published option type.
- **reproduction**: `bun …/T28-gate-probe.ts`, final section "non-recursive directory scan". Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log` lines 239-261.
- **suggested_fix**: two defensible repairs, pick one and say which in the code: (a) make non-recursive mean *scan the direct children, do not descend*, and mark `incomplete("recursive traversal disabled")` for each sub-directory not entered; or (b) if policies.md's "file или recursive directory" means non-recursive directories are simply unsupported, remove `recursive` from `SecurityScanOptions` and `runScanPath` entirely rather than leaving a reachable option that returns a false clean. Whichever is chosen, the `recursive: false` directory case must never yield `coverage.complete`.
- **class_scope**: sites = [`src/security/path-scan.ts:194-197` (the skip), `src/security/service.ts:127` + `:138` (the option that reaches it), `src/commands/security.ts:282` (the `--recursive` flag that is parsed and dropped — see F-005)]. enumeration_method: `bun src/cli.ts ctx rg "recursive" src/security` — `scope.recursive` is read at exactly one place (`path-scan.ts:194`); `input.recursive` is forwarded at exactly one place (`service.ts:141`); no production call site in `src`, `src/commands` or `src/mcp` supplies `recursive: false` (only test/`mkdir`/`rm` uses of the unrelated fs `recursive` option match), so the class is these three sites and the set is currently unexercised.

### [F-004] Per-file rows name the canonical target, not the entry that was encountered — major

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/path-scan.ts` : 168 : `scanContainedPath` / `visit` (and the `scanned` row at 227-229)
- **problem**: every other `files.push` in the file keys the row on `displayPath` (the path actually walked). Two do not: line 168 (`canonical identity already visited`) and line 228 (`scanned`, via `safePath`) key on `relativePath(ownerRoot, canonical)`. The row therefore describes a different filesystem entry than the one whose outcome it reports.
- **impact**: the report contradicts what happened, in the one section an operator reads to answer "what was actually covered". Two observed manifestations from a single probe run: (1) `corpus/x` is listed as `skipped (canonical identity already visited)` although `corpus/x` was fully traversed — the entry that was skipped was `corpus/y/toX`; an operator auditing coverage would conclude a directory went unscanned when it did not; (2) `corpus/a/b/c/creds.env` appears **twice**, once `scanned` and once `skipped`, while the symlink that produced the second row, `corpus/dup-creds.env`, appears nowhere — so an in-scope entry has no per-file outcome at all, and the same path carries two contradictory statuses. Gate and coverage are unaffected; this is a truthfulness defect in a committable artifact, not a false pass. It also silently weakens the T20 test at `security-recursive-scan.test.ts:52-54`, whose `secretFiles` filter passes *because* the alias row is folded onto the target's path.
- **reproduction**: `bun …/T28-scan-probe.ts`, section `P1 recursion/cycle`. Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-13-20-438Z_run.log` lines 26-68 (`files` and `credsEnvEntries`).
- **suggested_fix**: report `path: displayPath` on both rows and carry the canonical as a separate optional field (e.g. `resolvedPath`, or fold it into `reason`: `canonical identity already visited (corpus/a/b/c/creds.env)`). The canonical is always proven in-scope before these lines run (`isInside` check at line 147), so exposing it in `reason` leaks nothing. Then tighten the T20 test to assert on the *encountered* names.
- **class_scope**: sites = [`src/security/path-scan.ts:168`, `src/security/path-scan.ts:227-229`]. enumeration_method: `grep -n "files.push" src/security/path-scan.ts` returns 14 push sites; 12 pass `displayPath`, and exactly these 2 substitute `relativePath(ownerRoot, canonical)`. The set is exhaustive because `files` is a local array with no other writer in the module and no writer outside it (`runScanPath` copies rows with `{...file}` and only mutates `status`/`reason`, `service.ts:148-152`).

### [F-005] `--recursive` is parsed and discarded; the flag cannot be negated — minor

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/commands/security.ts` : 282 : `scanPathArgument` / `handleScan`
- **problem**: `scanPathArgument` skips `--recursive` so it is not mistaken for the target path, and `handleScan` (lines 208-219) never reads it and never passes `recursive` to `runScanPath`. `scanContainedPath` defaults to `recursive: true`, so the flag is a no-op: P5 confirmed `--recursive` and no flag give byte-identical `files` and `scope.recursive: true`. This is a change that does nothing, in the review-logic sense.
- **impact**: low and partly self-documented — `security.ts:982` describes it as "(the default for directory targets)". But the CLI advertises a scan-scope control that has no effect, there is no `--no-recursive`, and the flag is silently accepted on single-file targets too. The real cost is that it makes F-003's dead branch look reachable and reviewed when nothing in the CLI can reach it.
- **reproduction**: `bun …/T28-scan-probe.ts`, section `P5 flags` (`withFlagFiles` == `withoutFlagFiles`, both `recursive: true`). Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-13-20-438Z_run.log` lines 209-232.
- **suggested_fix**: resolve together with F-003. If non-recursive is supported, add `--no-recursive` and forward it; if it is not, drop `--recursive` from the usage string and the help table rather than accepting a flag that means nothing.

### [F-006] `runGate` / `SecurityService.gate` has no test at all — minor

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/service.ts` : 213 : `runGate`
- **problem**: `bun src/cli.ts ctx rg "runGate|gate\(\{ cwd" src/security src/commands` returns no test referencing the *security* gate — every hit is `createCodeHealthService().gate` in `health-incomplete.test.ts`. The security gate fold, including all four branches of F-001/F-002, is unexercised.
- **impact**: F-001 and F-002 are exactly the defects a three-line table test would have caught, and the T20 self-report's "53 focused tests pass" is compatible with the gate being wrong in every branch. I did verify the T20 recursive claim independently: `bun test src/commands/security-recursive-scan.test.ts` → **3 pass / 0 fail / 18 expect() calls** (raw `…/raw/2026-09-06T13-15-07-546Z_run.log`), so that part of the claim holds; the untested area is the gate, not the traversal.
- **reproduction**: the `ctx rg` above; raw `.metaproject/data/gdctx/raw/2026-09-06T13-15-22-543Z_rg.log`.
- **suggested_fix**: add a table-driven test over the 13 fixtures in `T28-gate-probe.ts` asserting `runGate` status per artifact state. The probe file is written to be liftable into `src/security/service.gate.test.ts` more or less as-is.

### [F-007] `coverage.required` is hardcoded `true` — info

- **file / line / symbol**: `/Users/Goodea/goodea/keryx/src/security/path-scan.ts` : 124 : `scanContainedPath`
- **problem**: policies.md lists `required coverage` among the things fixed before the run, alongside scope/excludes/limits, and mentions an "optional skip" that shows a warning and is not signed as passed. `required` is a literal `true` here with no configuration path, so the optional-coverage half of the policy has no representation.
- **impact**: none today — hardcoding `true` is the conservative direction and every current scan genuinely is required. Recorded so it is not mistaken for an implemented knob later.
- **reproduction**: `coverage.required: true` in every probe output regardless of flags (raw `…13-13-20-438Z_run.log`).
- **suggested_fix**: either accept `required` in `SecurityScanOptions` and thread it from config, or add a one-line comment stating that all scans are required by policy so the field is a constant on purpose.

---

## Confirmed clean areas

Executed and found correct — recorded so a later round does not re-litigate them:

- **Recursion depth and EISDIR class.** Directories are never handed to `readContainedFile`; `metadata.isDirectory()` is checked first (`path-scan.ts:170`) and `requireRegularFile: true` is a second guard at the read (`:221`). No probe produced EISDIR, including 3-level nesting, a directory symlink, and a single-file target.
- **Cycle termination.** `dev:ino` identity de-duplication (`identityFor`, `path-scan.ts:63-65`) terminates self-links, mutual directory cycles and `..` loops. 20 ms on the cycle fixture.
- **Containment and leak-safety.** `realpath` before the `isInside` check means a symlink cannot smuggle an out-of-root target past containment; refused entries are reported under their in-scope names only. Five canary checks across both the JSON report and the committable `latest.md` came back negative. `toCommittableReport` strips `hash` (`report.ts:62-70`), and no raw content reaches the scan metadata sections.
- **The fail-with-incomplete fold.** `service.ts:173-175` promotes only `pass -> incomplete` and cannot demote a `fail`. Confirmed by two independent fixtures (unreadable file, exhausted `--max-files`), both `gate: fail` + `coverage: incomplete` + findings retained.
- **Findings survive truncation.** Findings collected before a limit trips are kept in the decision and the report.
- **Limit argument validation.** `positiveScanLimit` rejects non-positive and non-safe-integer values, and `limitsFrom` throws on any non-positive limit — a `--max-files 0` cannot silently disable scanning.
- **Exclusion handling.** In-root exclusions are echoed relative; out-of-root exclusions are replaced with `[external exclusion omitted]`; an excluded subtree narrows scope without falsely marking coverage incomplete.
- **T20's own recursive test file.** 3 pass / 0 fail, independently executed.

---

## Evidence

| Probe | Raw log (under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`) | SHA-256 |
|-------|------|---------|
| Scan probe P1-P6 (`T28-scan-probe.ts`) | `2026-09-06T13-13-20-438Z_run.log` | `687f8e8cd335cdcd892640cd375c11fa5f4bad714e31bc5d0e0be69392aefa83` |
| Gate probe, 13 cases + E2E + non-recursive (`T28-gate-probe.ts`) | `2026-09-06T13-14-50-693Z_run.log` | `c9090c265d97178fceca3f070bb1e5d144499448f2cdf298e7c899baf3ef4077` |
| Gate probe SUMMARY extract | `2026-09-06T13-14-56-413Z_run.log` | `ef147b773268d9a2d892bebefed27eb217cfba72c1ee294a70f29ed899cd5576` |
| `bun test src/commands/security-recursive-scan.test.ts` | `2026-09-06T13-15-07-546Z_run.log` | `396272a8f0c0cad7be8a151225a6c21c3211d249329a4d8bc9e23a1ce051457f` |
| `runGate` test-coverage enumeration | `2026-09-06T13-15-22-543Z_rg.log` | (rg summary; see `.metaproject/data/gdctx/artifacts/2026-09-06T13-15-22-543Z_rg.md`) |
| `files.push` / `recursive` enumeration | `2026-09-06T13-16-29-088Z_rg.log` | (rg summary) |

Probe sources (written by this review, read-only w.r.t. production code):
- `/Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T28-scan-probe.ts`
- `/Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T28-gate-probe.ts`

All fixtures were created under `mkdtemp` and removed in `finally` blocks; `chmod 000` fixtures are restored to `0600` before removal. No network, no model calls, no git or flow state changes, no real credentials (synthetic AWS *example* key only).

---

## Routing audit

- `graph_used`: **no** — *not-relevant*. The dispatch pinned the exact file set (`files_to_read`); the question was behavioural verification of named symbols, not discovery of where code lives. No blast-radius question arose that gdgraph would have answered better than the two targeted `ctx rg` enumerations used for `class_scope`.
- `wiki_used`: **no** — *not-relevant*. The normative source for this review is `docs/requirements/keryx-agent-first-core/policies.md` plus the flow's frozen `acceptance-criteria.md`, both supplied as `context_refs` and both read directly. The wiki would be a secondary retelling of the same policy.
- `ctx_used`: **yes** — every file read (`ctx read --mode full`), every search (`ctx rg`) and every command including both probe runs and the test run (`ctx run`). All raw logs are listed above.
- `raw_rg_used`: **no**. No bare `rg`/`grep`/`cat`/`find` was executed; `grep`/`sed` were run only *through* `keryx ctx run`.

---

## Stage 2

**Not performed.** Stage 1 failed (AC2 and AC3 NOT MET; 2 blockers, 2 majors), and the dispatch requires Stage 2 to be skipped in that case. The quality observations that surfaced incidentally during Stage 1 verification (F-005, F-006, F-007) are recorded above but are not a Stage 2 pass — bounds, error handling and test quality across the full changed surface have not been systematically reviewed.

---

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T28#F-001",
    "reviewer": "review-logic+review-security-code",
    "severity": "blocker",
    "file": "src/security/service.ts",
    "line": 219,
    "symbol": "runGate",
    "problem": "readLatestReport returns null for both an absent latest.json (line 190) and a JSON.parse failure (line 195), and runGate maps that null to {status: \"pass\"}. A security gate that was never run, and a gate whose artifact is truncated or unreadable, are both reported as pass.",
    "impact": "policies.md fixes the fold as: a required check that is missing, skipped, unparsed or unfinished yields INCOMPLETE, and strict CI accepts only PASS. Any consumer gating on SecurityService.gate().status === 'pass' is signed off as clean by never having scanned, or by a corrupted artifact. runReport shares the defect, emitting a synthesized report with gate 'pass' for the same inputs (service.ts:206-211).",
    "suggested_fix": "Return a discriminated outcome from readLatestReport ({kind:'absent'} | {kind:'unparsed', reason} | {kind:'report', report}) and map absent and unparsed to status 'incomplete' in runGate, keeping the existing human-readable reason. 'incomplete' is already in runGate's return union, so no signature change is needed.",
    "evidence": "Executed probe .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T28-gate-probe.ts cases a, b, b2 (absent / truncated / empty latest.json) -> runGate status 'pass' in all three. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log, SUMMARY block at line 155 (sha256 c9090c265d97178fceca3f070bb1e5d144499448f2cdf298e7c899baf3ef4077).",
    "confidence": "high",
    "dedupe_key": "security-service-rungate-null-report-pass",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/service.ts:189-191",
        "src/security/service.ts:193-196",
        "src/security/service.ts:216-221",
        "src/security/service.ts:206-211"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg \"runGate|\\.gate\\(|readLatestReport\" src : readLatestReport has exactly two callers (runReport, runGate), both in service.ts; runGate has exactly one wiring site (service.ts:315). grep -rn \"\\.gate(\" src/mcp src/commands src/lib returns only createCodeHealthService hits, so there is currently no in-repo consumer of the security gate and the class is closed inside service.ts."
    }
  },
  {
    "id": "F-002",
    "global_id": "T28#F-002",
    "reviewer": "review-logic+review-security-code",
    "severity": "blocker",
    "file": "src/security/service.ts",
    "line": 229,
    "symbol": "runGate",
    "problem": "The gate fold is a two-value denylist (gate === 'fail' || gate === 'incomplete') followed by an unconditional return of status 'pass'. SecurityGate is a four-value union including 'needs-approval' (types.ts:68), so needs-approval returns pass. So do a missing gate field, an unknown gate string, and a latest.json that parsed as an array, because line 193 casts the parsed value with `as SecurityReport` without validating its shape. The missing-field case emits the reason string 'security gate: undefined' and still returns pass.",
    "impact": "needs-approval is the value that stops an unattended write pending a human (workspace.ts:157 requires --acknowledge-security for it); routing it to pass lets an approval-gated decision be consumed as approved. The unvalidated-shape cases make a corrupted or attacker-planted artifact a clean bill of health, so the cheapest tampering is not forging a pass report but writing any malformed bytes to latest.json.",
    "suggested_fix": "Invert to an allowlist over the validated union: pass->pass, fail->fail, incomplete->incomplete, needs-approval->incomplete (or fail), and any other value -> incomplete with reason 'unrecognized gate value'. Validate the parsed object against the existing report schema in schemas.ts before reading latest.gate.",
    "evidence": "Executed probe T28-gate-probe.ts cases b3 ({\"unrelated\":true}), b4 (gate 'banana'), b5 (gate field missing), b6 ([]) and e (gate 'needs-approval') -> runGate status 'pass' in all five. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log lines 172-203 (sha256 c9090c265d97178fceca3f070bb1e5d144499448f2cdf298e7c899baf3ef4077).",
    "confidence": "high",
    "dedupe_key": "security-service-rungate-unrecognized-gate-pass",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/service.ts:223-229",
        "src/security/service.ts:193"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg \"SecurityGate\" src/security/types.ts gives the complete four-value union at types.ts:68; grep -n \"latest.gate\\|\\.gate ===\" src/security/service.ts shows lines 220-226 are the only place in src/security that branches on a persisted report's gate for a gate decision. computeGate in resolve.ts produces the value and is not part of this class."
    }
  },
  {
    "id": "F-003",
    "global_id": "T28#F-003",
    "reviewer": "review-logic+review-security-code",
    "severity": "major",
    "file": "src/security/path-scan.ts",
    "line": 194,
    "symbol": "scanContainedPath.visit",
    "problem": "With scope.recursive false and a directory target, visit pushes {status:'skipped', reason:'recursive traversal disabled'} and returns without scanning the directory's own direct children and without calling incomplete(). The traversal therefore declares coverage 'complete' for a directory in which it opened no file, and runScanPath leaves computeGate([])'s 'pass' untouched (service.ts:173-175).",
    "impact": "runScanPath(cwd, {recursive:false, targetPath:<dir>}) is a silent total false pass — coverage complete, gate pass, zero findings — with a detectable secret sitting in the target. Latent rather than live: no in-repo caller passes recursive:false today, and the CLI cannot request it (see F-005). It is reachable by any consumer of the exported runScanPath, and `recursive` is part of the published option type.",
    "suggested_fix": "Either (a) make non-recursive mean scan the direct children without descending, and mark incomplete('recursive traversal disabled') for each sub-directory not entered; or (b) if policies.md's 'file or recursive directory' means non-recursive directories are unsupported, remove `recursive` from SecurityScanOptions and runScanPath rather than leaving a reachable option that returns a false clean. Either way, recursive:false on a directory must never yield coverage complete.",
    "evidence": "Executed probe T28-gate-probe.ts, final section 'non-recursive directory scan': gate 'pass', coverage {status:'complete'}, files [{path:'corpus', status:'skipped', reason:'recursive traversal disabled'}], findingCount 0, while corpus/creds.env held a synthetic AWS example key that the same scanner flags in every recursive probe; the subsequent runGate on that cwd returned pass. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-14-50-693Z_run.log lines 239-261.",
    "confidence": "high",
    "dedupe_key": "path-scan-nonrecursive-complete-coverage",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/path-scan.ts:194-197",
        "src/security/service.ts:127",
        "src/security/service.ts:141",
        "src/commands/security.ts:282"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg \"recursive\" src/security : scope.recursive is read at exactly one site (path-scan.ts:194) and input.recursive forwarded at exactly one site (service.ts:138). Every other match is the unrelated fs mkdir/rm `recursive` option or a test helper. No production caller in src, src/commands or src/mcp supplies recursive:false, so the class is these four sites and is currently unexercised."
    }
  },
  {
    "id": "F-004",
    "global_id": "T28#F-004",
    "reviewer": "review-logic+review-security-code",
    "severity": "major",
    "file": "src/security/path-scan.ts",
    "line": 168,
    "symbol": "scanContainedPath.visit",
    "problem": "Twelve of the fourteen files.push sites key the per-file row on displayPath (the path actually walked). Two do not: line 168 ('canonical identity already visited') and line 228 ('scanned', via safePath) key on relativePath(ownerRoot, canonical). The row therefore reports the outcome of one filesystem entry under a different entry's name.",
    "impact": "The Files section of a committable security artifact contradicts what happened, in the one place an operator reads to answer what was covered. Observed in a single probe run: corpus/x is listed as skipped('canonical identity already visited') although corpus/x was fully traversed (the skipped entry was corpus/y/toX), and corpus/a/b/c/creds.env appears twice, once scanned and once skipped, while the symlink that produced the second row (corpus/dup-creds.env) has no row at all. Gate and coverage are unaffected. It also weakens the T20 test at security-recursive-scan.test.ts:52-54, whose secretFiles filter passes because the alias row is folded onto the target's path.",
    "suggested_fix": "Report path: displayPath on both rows and carry the canonical separately — a distinct optional field (resolvedPath) or inside reason, e.g. 'canonical identity already visited (corpus/a/b/c/creds.env)'. The canonical is proven in-scope by the isInside check at line 147 before either line runs, so surfacing it leaks nothing. Then tighten the T20 test to assert on the encountered names.",
    "evidence": "Executed probe T28-scan-probe.ts section 'P1 recursion/cycle': files[] contains two rows for corpus/a/b/c/creds.env (one scanned, one skipped) and none for corpus/dup-creds.env, plus a skipped row for corpus/x which the fixture proves was traversed. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-13-20-438Z_run.log lines 26-68 (sha256 687f8e8cd335cdcd892640cd375c11fa5f4bad714e31bc5d0e0be69392aefa83).",
    "confidence": "high",
    "dedupe_key": "path-scan-file-row-canonical-vs-encountered-path",
    "blocking_merge": true,
    "related_skill": "review-logic",
    "learning_candidate": false,
    "class_scope": {
      "sites": [
        "src/security/path-scan.ts:168",
        "src/security/path-scan.ts:227-229"
      ],
      "enumeration_method": "grep -n \"files.push\" src/security/path-scan.ts (via keryx ctx run) returns 14 push sites; 12 pass displayPath and exactly these 2 substitute relativePath(ownerRoot, canonical). The set is exhaustive because `files` is a module-local array with no other writer, and runScanPath only copies rows with {...file} and mutates status/reason (service.ts:148-152)."
    }
  },
  {
    "id": "F-005",
    "global_id": "T28#F-005",
    "reviewer": "review-logic+review-security-code",
    "severity": "minor",
    "file": "src/commands/security.ts",
    "line": 282,
    "symbol": "scanPathArgument / handleScan",
    "problem": "scanPathArgument skips --recursive so it is not read as the target path, and handleScan never reads it and never forwards `recursive` to runScanPath. scanContainedPath defaults to recursive true, so the flag has no effect and there is no --no-recursive to negate it.",
    "impact": "Low and partly self-documented (security.ts:982 calls it 'the default for directory targets'), but the CLI advertises a scan-scope control that does nothing, accepts it on single-file targets, and makes F-003's dead branch look reachable and reviewed when nothing in the CLI can reach it.",
    "suggested_fix": "Resolve with F-003: if non-recursive scanning is supported, add --no-recursive and forward the value; if it is not, drop --recursive from the usage string (security.ts:197, 963) and the help table (982).",
    "evidence": "Executed probe T28-scan-probe.ts section 'P5 flags': withFlagFiles and withoutFlagFiles are identical and both report scope.recursive true. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-13-20-438Z_run.log lines 209-232.",
    "confidence": "high",
    "dedupe_key": "security-cli-recursive-flag-noop",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-006",
    "global_id": "T28#F-006",
    "reviewer": "review-logic+review-security-code",
    "severity": "minor",
    "file": "src/security/service.ts",
    "line": 213,
    "symbol": "runGate",
    "problem": "No test anywhere in the repository exercises the security gate. Every `.gate({cwd` hit is createCodeHealthService in health-incomplete.test.ts; runGate itself is referenced only by its definition and its wiring at service.ts:315.",
    "impact": "F-001 and F-002 are precisely what a small table test would have caught, and the T20 self-report's '53 focused tests pass' is fully compatible with the gate being wrong in every branch. I independently confirmed the traversal half of that claim (bun test src/commands/security-recursive-scan.test.ts -> 3 pass / 0 fail / 18 expect() calls), so the untested area is the gate, not the scanner.",
    "suggested_fix": "Add a table-driven src/security/service.gate.test.ts over the 13 artifact states in T28-gate-probe.ts, asserting runGate status per state. The probe file is written to be liftable more or less as-is.",
    "evidence": "bun src/cli.ts ctx rg \"runGate|gate\\(\\{ cwd\" src/security src/commands -> raw .metaproject/data/gdctx/raw/2026-09-06T13-15-22-543Z_rg.log; test run raw .metaproject/data/gdctx/raw/2026-09-06T13-15-07-546Z_run.log (sha256 396272a8f0c0cad7be8a151225a6c21c3211d249329a4d8bc9e23a1ce051457f).",
    "confidence": "high",
    "dedupe_key": "security-rungate-untested",
    "blocking_merge": false,
    "related_skill": "testing",
    "learning_candidate": true
  },
  {
    "id": "F-007",
    "global_id": "T28#F-007",
    "reviewer": "review-logic+review-security-code",
    "severity": "info",
    "file": "src/security/path-scan.ts",
    "line": 124,
    "symbol": "scanContainedPath",
    "problem": "coverage.required is a hardcoded true with no configuration path, while policies.md lists 'required coverage' among the things fixed before the run alongside scope/excludes/limits, and describes an optional skip that warns and is not signed as passed.",
    "impact": "None today: hardcoding true is the conservative direction and every current scan is genuinely required. Recorded so the field is not later mistaken for an implemented knob.",
    "suggested_fix": "Either accept `required` in SecurityScanOptions and thread it from config, or add a one-line comment stating that all scans are required by policy so the constant is visibly deliberate.",
    "evidence": "coverage.required is true in every probe output regardless of flags — raw .metaproject/data/gdctx/raw/2026-09-06T13-13-20-438Z_run.log (P1 through P6).",
    "confidence": "high",
    "dedupe_key": "path-scan-coverage-required-hardcoded",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  }
]
```
