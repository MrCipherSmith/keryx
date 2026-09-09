STATUS: DONE_WITH_CONCERNS

# T57 — independent recheck of the four repairs that close the T39 defect class (T54, T55, T56, T58)

Four of the five rows reproduce as **closed** under probes written fresh for this
review, attacked rather than confirmed. **Stage 1 does not pass**, on row 3: the
`incomplete`/unrecognized half of the completion fold is genuinely closed, but
the other half of the same repair — "a warning still lets completion succeed but
must stay distinguishable from a genuine pass" — is **not implemented in the
durable record**. A `warn` health gate produces a stored `flow.json` that is
**byte-identical** to a genuine pass, and an issue comment that reads
`health: pass`, with the word `warn` appearing nowhere in either. The `detail`
string the implementer and the code comment both cite as the distinguishing
signal exists only on the in-memory `GateOutcome` and on the terminal line;
neither is the stored flow record. Stage 2 (code quality) was therefore not
started, per the dispatch's ordering.

Two smaller residuals are recorded (both `minor`), one of which refutes the
fourth disclosed judgement call.

## Scope

- Root: `/Users/Goodea/goodea/keryx` (the main checkout only; no worktree under
  `.claude/worktrees/` was entered).
- Branch: `codex/agent-first-core`; base / merge-base with `main`:
  `0bc6418fa1a038f8ec909cf949fecba077acf9a4` (identical to HEAD — the branch
  carries uncommitted work only).
- Reviewer wrote none of the code, none of the specs, and none of the earlier
  reviews (T39, T54, T55, T56, T58).
- Read-only on all production and test code. Artifacts written: this file,
  `T57-result.json`, and five probes `T57-{mode,report,flow,state,health}.ts`.
  Every fixture was `mkdtemp` and removed in `finally`; the only key-shaped
  string is the synthetic `AKIAIOSFODNN7EXAMPLE` the repository's own tests
  already use. No git state, flow state, dependency, network or model call.

### File hashes (SHA-256), start and end of this review

Full digests: `.metaproject/data/gdctx/raw/T57-hashes-start.txt` /
`T57-hashes-end.txt`.

| File | Start | End | Same |
|---|---|---|---|
| `src/security/config.ts` | `267285d5…8c5640` | `cde9fd7f…6b1c10` | **NO — drift** |
| `src/security/guard.ts` | `32a98b9f…a931201` | `2b25a417…c6516e` | **NO — drift** |
| `src/security/guard.test.ts` | `664c73bc…382b05` | same | yes |
| `src/security/service.ts` | `e08be640…8db1e6632` | same | yes |
| `src/security/self-protect.ts` | `afad4f94…9992c0e1` | same | yes |
| `src/security/security.test.ts` | `e31881ee…6fbd481e` | same | yes |
| `src/security/types.ts` | `e306711e…4b19fc1b9af` | same | yes |
| `src/commands/security.ts` | `e37b1f8a…91dd7067b` | `73d557be…700e7fca` | **NO — drift** |
| `src/health/service.ts` | `23075627…6abc8a7f1` | `37ae5422…6cb2aa4f8d0` | **NO — drift** |
| `src/flow/service.ts` | `26d870d4…c00666a18` | same | yes |
| `src/lib/json.ts` | `b9558372…3ae25b486` | `b1ab9a5b…6975f8ec93f0` | **NO — drift** |
| `src/commands/health.ts` | `8ce5d287…237570dcd` | same | yes |
| `src/security/detect/exfil.ts` (excluded — other worker) | `6750d80c…3c62ccf9dd` | same | yes |

(Abbreviations are the first 8 and last hex characters; the two files named above
carry the full 64-character digests and are the authority.)

**Drift did occur, and it is disclosed rather than glossed.** Mid-review, the
concurrent worker landed the T43 `readJsonObjectFile` migration in
`src/lib/json.ts` and switched five readers to it (`src/security/config.ts`,
`src/security/guard.ts`, `src/commands/security.ts`, `src/health/service.ts`;
`src/commands/health.ts` untouched). I re-read every changed region and re-ran
**all nine probes** — my five plus `T39-posture.ts`, `T39-exit.ts`,
`T39-scan.ts`, `T55-verify-real-cli.ts` — against the post-drift tree.

**Every one of the nine logs is byte-identical before and after** (identical
SHA-256 in the Evidence table below), the focused suites are 133 pass / 0 fail
both times, and `tsc --noEmit` is clean after. The migration is
behaviour-preserving for everything this review measures: `loadSecurityConfig`'s
mode-validation branch, `resolveManifestSecurityState`'s three-way verdict and
`readLatest`'s shape guard all read the same way through the new reader (the
`Symbol` sentinels were replaced by `read.state !== "object"`, which answers the
same two questions in one result). **No conclusion in this review is affected.**
The one thing I cannot certify is anything the other worker changed *after* my
final hash: `src/security/detect/exfil.ts` was byte-identical throughout and is
excluded from every verdict regardless.

## Summary

| Severity | Count |
|---|---|
| blocker | 1 |
| major | 0 |
| minor | 2 |
| info | 1 |

## Stage 1

| # | Item | Verdict | My probe and what it showed |
|---|---|---|---|
| 1 | Mode validation fails closed; an absent mode still resolves permissively; the DECLARED value is what is validated | **closed** | `T57-mode.ts`, 36 payloads driven through `loadSecurityConfig` → `guardOutput` (planted `AKIA…`) → `securityFlowGate` → the **real** `securityCommand(["check-input", …])`. 29 unrecognized shapes all give `mode:"enforced"`, `configUnreadable:true`, `guardAllowed:false`, gate `{"status":"fail", detail:"security posture unavailable…"}`, **CLI exit 1**, `credentialLetThrough:false`. Boundary rows: case (M08–M11), whitespace incl. tab/newline/NBSP/NUL (M12–M17), non-strings incl. falsy `0`/`false` (M18–M21, M23), and a recognized value nested one level deeper — `["advisory"]`, `["enforced"]`, `{"mode":"advisory"}`, `{"value":"advisory"}` (M24–M27). Permissive default intact: absent key (M05/M06) and absent file (M07) stay `advisory`, exit 0. **Declared-not-merged proven by M22**: `{"mode":null}` would arrive as `advisory` after `??`, and blocks. `mode` nested under another key (M30/M31) and via `__proto__` (M32) are the *absent* case and correctly stay permissive; M33 shows a real `ci` alongside a `__proto__` decoy still resolves `ci`. `leaky:false` on all 36; `Object.prototype.mode`/`.modules` still `undefined` (M99). |
| 2 | `security report` no longer takes strictness from the artifact; both strict modes accept only a pass — **at the real entry point** | **closed** | `T57-report.ts` drives `securityCommand(["report","--json"], root)`, never `reportExitCode` alone. R1: `ci` and `enforced` are now one rule — `pass`→0, `fail`/`needs-approval`/`incomplete`/unrecognized→1 — while the stored artifact always claims the most permissive `mode:"advisory"` it can. `advisory`/`gateway`/absent-config stay 0 for every gate (§11 intact); an unreadable config and an unrecognized mode both resolve to the forced `enforced` and refuse. R2 pins the trust boundary in **both** directions (a: `ci`+stored `advisory`+`fail` → 1; c/d: `advisory`/`gateway` workspace + stored `ci` + `fail` → **0**). **The blind spot is controlled for, not inherited:** every R2 row prints `pureFunctionWithArtifactMode` beside `realCliExit`, and the two disagree on 6 of 8 rows — which is exactly why `T39-exit.ts` S3 still reads `cliExitCode: 0` (re-run, unchanged) and why S3 can never observe this fix. R3: a self-contradicting artifact (`pass` over incomplete coverage), an absent, unparseable or array artifact all → 1 in both strict modes. |
| 3 | The completion fold: no `incomplete`/unrecognized row recorded as passing; a `warn` stays distinguishable from a genuine pass **in the stored flow record** | **PARTLY — first half closed, second half NOT met** | `T57-flow.ts`, 18 health payloads through the real `complete()` pipeline, then reading `flow.json` back off disk. First half closed: `incomplete` → `fail`, completion refused, flow stays `in-progress` (C03/C16); every unrecognized value — `banana`, `""`, `PASS`, `Pass`, `pass ` (trailing space), `skipped`, `null`, `undefined`, `true`, `["pass"]`, an object — reaches `unevaluableGate("health")` → `fail` with the constant detail and no echo of the planted string (C05–C15); a non-array `reasons` under `incomplete` throws inside the fold and is caught into the same blocking constant (C18). Second half **fails**: C99 shows the stored `flow.json` for a `warn` completion is **byte-identical** to a genuine `pass` (`storedRecordsIdentical: true`), the issue comment is identical (`health: pass` in both), and `warn` appears nowhere in the stored record (`storedRecordContainsWarnWord: false`). → **F-001**. |
| 4 | A forced-closed posture never becomes the recorded configured mode; repair raises no incident that did not happen; a genuine downgrade across a broken window is still detected | **closed, with one residual** | `T57-state.ts`, both broken shapes (unusable payload and unrecognized mode) × six scenarios, driven through the real `createSecurityService().check()` (the only `writeState` caller) and read back from `state.json` + `incidents.jsonl`. S1: real `advisory` → broken → repair to `advisory` → `state.json` still `advisory` throughout, **zero incidents ever**. S2: the implementer's masking argument holds under four shapes I chose, not the one they tested — `gateway→ci`, `enforced→advisory`, `ci→advisory`, `gateway→advisory` across a broken window are **all** still detected, because `previous` was never overwritten. S3: an upgrade raises nothing. S4: first run already broken with no prior state → `NO STATE FILE` after one and after three broken runs, no incidents, and the first readable config establishes real state — exactly as if the broken runs never happened. S5 (mine, untested by T58): a policy the operator disables *across* the broken window is still caught. S7: config bytes unchanged, `.metaproject/data/security/raw/` holds only `hmac.key`. Residual: S6 → **F-002**. |
| 5 | Nothing the earlier repairs closed reopens | **closed** | `T39-posture.ts` re-run (raw `T57-r1-T39posture.log`): every protected verdict byte-identical — non-object manifest bodies A2–A6, non-object `modules` A10–A13, unparseable/empty/whitespace manifest A7/A18/A19, absent manifest A1, non-object and unparseable config B2–B6/B17, absent config B1, legitimate empty config B7, and the four recognized modes B8–B10/A16. `T39-exit.ts` re-run: the four gate/exit-code folds (`exitCodeFor` S1, `reportExitCode` S2, `runExitCode` H1, `gateExitCode` H2) reproduce cell for cell, and H6/H7/H8 (no `gate` key, bare array, `gate` a string) all give the constant `{"status":"fail","exitCode":1,"reasons":["no report…"]}` instead of the former `TypeError`. `T57-health.ts` extends that to 19 shapes at both `readLatest` callers: every malformed shape fails closed at `gate()` with a constant reason, prototype hygiene intact. Leak safety: `leaky:false` on all 36 mode rows and all 19 health rows; no planted reason text reached any stored flow record or issue comment (18/18 rows). `T39-scan.ts` re-run confirms the CLI check path. Focused suites 133 pass / 0 fail; `tsc --noEmit` clean. One pre-existing residual is narrowed but not eliminated → **F-003**. |

**Stage 1 result: rows 1, 2, 4 and 5 are closed and every claim about them holds
under my own execution; row 3 is half-closed, and F-001 is a defect of the same
class — a non-passing check signed as PASS in durable, published evidence.**

## Findings

### [F-001] A `warn` health gate is signed as PASS in the stored flow record and in the published issue comment, indistinguishably from a genuine pass

- **Severity**: blocker
- **File**: `src/flow/service.ts:996` (`healthGateOutcome`'s `warn` arm), with
  `:667` (the pass-path `transition` note) and `:1091` (`buildIssueComment`)
- **Symbol**: `healthGateOutcome`
- **Problem**: the repair folds `warn` to `GateOutcome.status: "pass"` and relies
  on `detail` to keep the row honest. The code comment states it as a property:
  *"so a reader of `flow.json` can tell a warned gate from a clean one although
  both share `status: "pass"`"*, and `T56-implementation.md`'s acceptance table
  claims the same. **`flow.json` does not carry the gate rows at all on the
  passing path.** `complete()` returns `gates` in memory; the only durable writes
  are `transition(…, "done", "done", "all gates passed")` — a fixed string, no
  gate detail — and `buildIssueComment`, which renders
  `` `${gate.name}: ${gate.status}` `` and drops `detail` entirely. So the two
  surfaces that persist and publish the verdict both say `health: pass`, and the
  distinguishing bytes exist only on the returned object and on the terminal line
  `src/commands/flow.ts:589` prints (with a green check mark), neither of which
  is the stored flow record. `detail` *is* persisted on the failing path
  (`:683`), which is why the property looks true when read from the code.
- **Impact**: the exact policies.md sentence — «Optional skip показывает warning
  и не подписывается как passed» ("an optional skip shows a warning and is not
  signed as passed") — fails on the completion path. `computeGate`
  (`src/health/gate.ts`) produces `warn` precisely for an *optional* source that
  was configured and then failed or was skipped, and for coverage below the soft
  floor; that state is now written into the durable flow record and posted to the
  issue tracker as an unqualified `health: pass`. A machine reading `flow.json`
  or the tracker comment to decide the phase was verified cannot tell a clean
  gate from a warned one — which is the same false-pass-in-durable-evidence shape
  this whole phase exists to remove, arriving through the half of the repair
  nobody measured. It is a `blocker` under shape 4 of the canonical rubric (an
  unimplemented acceptance criterion: the change claims a distinguishability
  property the diff does not contain), not under 1–3.
- **Reproduction**: `bun .metaproject/flows/233-…/artifacts/T57-flow.ts`, row
  C99, raw `…/T57-flow.log` — two full `complete()` runs, identical except for
  the health status, each read back from `flow.json` on disk:
  ```
  {"label":"C99 stored flow record: genuine pass vs warn",
   "storedRecordsIdentical":true,
   "issueCommentsIdentical":true,
   "issueCommentHealthLinePass":"- Gates: … health: pass",
   "issueCommentHealthLineWarn":"- Gates: … health: pass",
   "storedRecordContainsWarnWord":false}
  ```
  Rows C01/C02 show the same from the other side: `returnedDetail` is
  `"health gate: pass"` vs `"health gate: warn"` in memory, while
  `storedRecordMentionsHealth` is `false` for both.
- **Suggested fix**: the fold's `warn → pass` decision is sound and I would keep
  it (see "Judgement calls"); what is missing is the record. Two small options,
  either sufficient:
  (a) persist the gate rows on the passing path — give `transition` the same
  `` `${gate.name}: ${gate.detail}` `` join the failing path already builds at
  `:683`, so `flow.json` history carries `health: health gate: warn`; and/or
  (b) make the published row self-describing — introduce the warned state in
  `GateOutcome` (`"pass" | "warn" | "fail" | "skipped"`, with the master fold at
  `:659` unchanged so `warn` still does not block) and let `buildIssueComment`
  render `health: warn`. (b) is the more faithful reading of "not signed as
  passed"; (a) is the one-line change. Whichever is chosen, the code comment at
  `:980-983` and `T56-implementation.md`'s acceptance row must be corrected — as
  written they assert a property of `flow.json` that is false.
- **class_scope**:
  - sites: `src/flow/service.ts:996` (the `warn → pass` arm, the defect);
    `src/flow/service.ts:667` (the pass-path `transition` note — the constant
    `"all gates passed"`, the reason no gate row is persisted);
    `src/flow/service.ts:1091` (`buildIssueComment` — renders `status`, drops
    `detail`); `src/flow/service.ts:683` (the failing path, **correct by
    contrast**: it joins `name: detail` into the persisted note);
    `src/commands/flow.ts:589` (the terminal render — the only surface where the
    distinction currently survives, and it is ephemeral)
  - enumeration_method: `bun src/cli.ts ctx rg -n "buildIssueComment|gate.status|gate.detail|gates" src/flow/service.ts`
    (raw `…2026-09-06T16-13-51-868Z_rg.log`) enumerated every use of the `gates`
    array in `complete()` — 29 hits, each read. Exactly two of them leave the
    function's memory (`:667`/`:683` via `transition`'s `history.push` at `:106`,
    and `:668`→`:1091`), and the probe then confirmed the resulting bytes on disk
    rather than inferring them from the code.
- **Confidence**: high (executed end to end through the real completion pipeline,
  verdict read from the persisted file, not from the return value).

### [F-002] A broken-config window writes a durable, false `mode-downgrade` incident when the prior real mode is `gateway`, and it survives the repair

- **Severity**: minor
- **File**: `src/security/service.ts:91-93` (`appendIncidents` for the live
  comparison) with `src/security/self-protect.ts:88` (`MODE_RANK[config.mode] <
  MODE_RANK[previous.mode]`)
- **Symbol**: `analyze` / `evaluateSelfProtection`
- **Problem**: T58 correctly stops the *forced* posture becoming `previous`, and
  discloses that the *live* comparison can still warn while a config is broken,
  arguing it is "a true statement about the current run rather than a fabricated
  one". Measured, two things are not as disclosed. First, it is not only a
  warning: `analyze` calls `appendIncidents` before the state-write guard, so the
  broken run appends a `mode-downgrade` entry to the append-only
  `incidents.jsonl` trail, and that entry is **still there after the operator
  repairs the config back to the same `gateway`** — a durable record of a
  downgrade the operator never made, in exactly the file whose value is that it
  is auditable. Second, the statement itself is not true of the run: while
  `configUnreadable` is set, `guardOutput` and `securityFlowGate` refuse
  *everything* through their posture-unavailable branches, so effective
  enforcement during that window is stricter than `gateway`, not "weakened"; and
  `isBlockingMode` (`guard.ts:229`) puts `gateway` on the **non-blocking** side
  while `MODE_RANK` ranks it strictest, so the two axes disagree about what
  `gateway → enforced` even is.
- **Impact**: fail-loud noise, not a bypass — no check is relabeled and nothing
  is let through. Reachability is low: `gateway` is the only rank above the
  forced `enforced`, and it is a Phase-4 mode. Recorded because a false entry in
  the incident trail erodes the signal the real one carries, and because the
  argument the dispatch asked me to test does not survive execution.
- **Reproduction**: `bun .metaproject/flows/233-…/artifacts/T57-state.ts`, row S6
  (both broken shapes), raw `…/T57-state.log`:
  ```
  {"label":"S6 [...] LIVE in-window comparison, prior real mode gateway",
   "incidentsBeforeBreak":[], "incidentsDuringBrokenWindow":["mode-downgrade"],
   "incidentsAfterRepairToSameMode":["mode-downgrade"],
   "durableIncidentWrittenByTheBrokenRun":true, "stateAfterRepair":"gateway"}
  ```
  Controls in the same run: S1 (`advisory` prior) raises nothing at all, and S2
  shows genuine downgrades still fire, so the fix under review is not what
  produces this.
- **Suggested fix**: skip the *comparison* on the same condition the state write
  already skips on — `if (!config.configUnreadable)` around the mode-downgrade
  and policy-disabled arms of `evaluateSelfProtection`'s result, or pass the flag
  in and let those two arms return early. A forced posture is not an operator
  choice on the way in either. If the phase would rather keep an operator-visible
  signal during a broken window, emit it as a `warning` only and not as an
  `IncidentEntry`, so the durable trail keeps meaning "the operator changed
  something". Separately worth a look, out of this task's scope: `MODE_RANK`
  ranking `gateway` strictest while `isBlockingMode` treats it as report-only.
- **Confidence**: high (executed; the incident file was read back after the
  repair).

### [F-003] `hasGateShape` guards the gate field only, so `status()` still throws a raw `TypeError` on a stored report whose `metrics` is absent or not an array

- **Severity**: minor
- **File**: `src/health/service.ts:48` (`hasGateShape`), consumed at `:198`/`:210`
  (`status()`'s `latest.metrics.find` / `latest.sources.map`)
- **Symbol**: `hasGateShape` / `CodeHealthService.status`
- **Problem**: T55 fixed the shape hole around `gate` and `T55-implementation.md`
  states that `status()` "also benefits from this fix (a malformed report no
  longer throws there either)". That is true for the payloads it tested and false
  one field over: `hasGateShape` validates the payload is an object and that
  `gate` carries a string `status` and an array `reasons`, and validates nothing
  else. A stored `latest.json` whose `gate` is perfectly well-formed but which
  has no `metrics` key — or `metrics` as a string — passes the guard and then
  throws out of `status()` on `latest?.metrics.find`. It is the same
  value-vs-shape gap the repair was dispatched to close, moved one field along.
- **Impact**: not a false pass, and `gate()` is unaffected (the surface that
  decides). `keryx health status` and the `health.status` MCP tool raise an
  unhandled `TypeError` at an agent-visible seam instead of the module's own
  "no report" answer. A hand-written, truncated or older artifact reaches it; no
  tampering is needed.
- **Reproduction**: `bun .metaproject/flows/233-…/artifacts/T57-health.ts`, rows
  E18/E19, raw `…/T57-health.log`:
  ```
  E18 gate shape sound, metrics/sources ABSENT
     gateThrew: null, gateResult {"status":"pass","exitCode":0,…}
     statusThrew: "undefined is not an object (evaluating 'latest?.metrics.find')"
  E19 gate shape sound, metrics is a string
     statusThrew: "latest?.metrics.find is not a function…"
  ```
  E01–E17 are the controls: every malformed *gate* shape is the constant
  `{"status":"fail","exitCode":1,"reasons":["no report; run `keryx health run`
  first"]}` at `gate()` and `null` at `status()`, with no throw.
- **Suggested fix**: extend `hasGateShape` to the two fields its callers actually
  dereference — `Array.isArray(value.metrics) && Array.isArray(value.sources)` —
  which folds a truncated artifact into the same "no report" outcome the guard
  already produces, at both callers, for one extra clause. Or guard at the two
  reads in `status()` (`latest?.metrics ?? []`). The first is the shape T55 chose
  and should be finished in that shape.
- **Confidence**: high (executed).

### [F-004] The security arm of `complete()` still passes its status through verbatim, and `skipped` is non-blocking

- **Severity**: info
- **File**: `src/flow/service.ts:652`, with the master fold at `:659`
- **Problem**: unchanged from T39 F-001's `class_scope`, and correctly out of
  T56's ownership. `gates.push({ name: "security", status: security.status, … })`
  passes the value through, and `gates.every((gate) => gate.status !== "fail")`
  treats `skipped` as non-blocking. `securityFlowGate`'s return type admits
  `"skipped"`; the function cannot produce it today (probe F2 in `T39-exit.ts`
  reaches it only with a hand-built dependency, and it does complete the flow).
- **Impact**: none reachable today. Recorded so the next round does not
  rediscover it, and because the type keeps the door open while every sibling
  fold has been closed.
- **Suggested fix**: either narrow `securityFlowGate`'s return type to the two
  values it can return, or fold the security arm through the same exhaustive
  helper shape `healthGateOutcome` now uses.

## Judgement calls

### 1. `{"mode": null}` now forcing the strict posture, beyond what T39 measured

**Ruling: correct, keep it.** T39 measured `null` as resolving to `advisory` and
did not class it with F-002, because `mergeSecurityConfig`'s `??` reads `null` as
"not specified". That is a property of the operator chosen for the merge, not a
statement anybody made about the file. The file says `"mode": null` — the key is
present and its value is not a mode — which is the same fact as `42` or `true`,
and the loader's own principle ("a declared posture this build cannot recognize
is an unestablished posture") covers it exactly. Against keeping it: a four-byte
edit, `"enforced"` → `null`, would otherwise walk straight past the check this
task exists to add, on the one axis where §14's downgrade detection is also blind
(`MODE_RANK[undefined]` is `undefined`). I verified the move is strict-direction
only and does not touch the protected set: M22 blocks, while M05 (`{}`), M06
(other keys, no `mode`) and M07 (no file) all stay `advisory` and exit 0, so the
ordinary "no mode configured" case is byte-identical. It is disclosed in both the
spec and the report, which is how a widening of a measured verdict should arrive.

### 2. Narrowing the manifest guard so a readable manifest without `modules` means "disabled"

**Ruling: correct, keep it — and I checked the repository claim rather than
taking it.** `bun src/cli.ts ctx rg -n "modules\?\.|\.modules\b"` over the five
named readers (raw `…2026-09-06T16-25-00-631Z_rg.log`) returns
`manifest.modules ?? {}` (`capability/seam.ts:71`), `manifest.modules?.testing`
(`testing/capability.ts:27`), `manifest.modules?.gdctx?.enabled`
(`commands/ctx.ts:134`), `manifest.modules?.gdskills?.…`
(`gdskills/project-skills.ts:682`, `gdskills/export.ts:200`) and
`existingManifest?.modules?.security` (`commands/init.ts:617`) — six sibling
readers, every one of which reads an absent `modules` as "not configured". The
security guard was alone in reading a readable statement as a fault, and a
divergence between two sibling readers of the same file is what produced T35
F-001 in the first place. Three further reasons hold up under execution. The
ordering was inverted: an *absent* manifest was non-blocking (A1) while a
*present, well-formed, empty* one blocked (A8) — strictly more information
producing a strictly harsher verdict. Nothing is lost: `{"modules":{}}` (A14) and
an explicit `enabled:false` (A15) already reach the same non-blocking verdict, so
the narrowing grants an attacker no capability a two-byte edit did not. And the
narrowing did **not** buy itself by loosening the neighbours — the `MANIFEST_UNREADABLE`
sentinel added alongside it keeps A7 (unparseable), A18 (empty) and A19
(whitespace) blocking, byte-identical in my re-run, which is precisely the
accident-of-the-fallback-value the sentinel replaces.

On the three cases that moved (A8, A9, A17): all three are the same shape, and
the `__proto__` payload is the one worth naming. `JSON.parse` gives it an *own*
`__proto__` data property and does not touch the prototype chain, so its own
`modules` is absent — it is the F-005 shape and the narrowing necessarily covers
it. The property that actually mattered is preserved and I re-verified it
independently on the config axis too: no enablement is inherited (A17 →
`enabled:false`, gate `null`; M32 → the `__proto__` mode is ignored and the
declared mode governs, M33), and `Object.prototype.modules`/`.mode` are still
`undefined` after all 36 config payloads and all 38 posture payloads (M99, D1).
Reachability of the widened surface is low in practice: `keryx init`'s manifest
type makes `modules` required.

### 3. The duplicate attribute and the unterminated tag over-approximated toward flagging in `src/security/detect/exfil.ts`

**Ruling: acknowledged, not re-raised, and no verdict of mine rests on it.**
That module belongs to another worker and is outside this dispatch's file set. I
record only what I can certify: `src/security/detect/exfil.ts` is byte-identical
at the start and the end of this review (`6750d80c…cf9dd` both times), so nothing
here was measured against a moving file, and over-approximating toward flagging
is the fail-closed direction in any case — the opposite of the defect class this
recheck is about.

### 4. The live self-protection comparison left able to warn during a broken-config window

**Ruling: the argument is not sustained — see F-002.** Two things break it, both
executed rather than reasoned. It is not a warning: the broken run appends a
`mode-downgrade` entry to the append-only `incidents.jsonl`, and that entry is
still on disk after the operator repairs the config back to the *same* mode
(S6). The dispatch's own criterion is "repairing the config afterwards must
produce no incident that did not happen"; `state.json` now satisfies it, and the
incident trail does not. And the statement is not true of the current run: while
`configUnreadable` is set, every guarded write is refused and the flow gate
fails, so effective enforcement is *stricter* than `gateway`, not weakened —
while `isBlockingMode` puts `gateway` on the non-blocking side, so the sign of
`gateway → enforced` is not even agreed within the module. The severity stays
`minor` because the reachability is one prior mode and the failure is loud, not a
bypass; the ruling is that the reason given does not justify leaving it, not that
it is urgent.

## Confirmed clean areas

Checked, with no finding:

- **The credential actually stops.** Across 36 mode payloads with a planted
  `AKIAIOSFODNN7EXAMPLE`, every unrecognized mode gives `guardAllowed:false` and
  a real-CLI exit 1; the only rows where the write proceeds are the four
  recognized report-only postures (`advisory`, `gateway`, absent config, absent
  `mode` key), which is §11's stated invariant, not a leak.
- **Leak safety on every repaired path.** No `reason`, `detail` or serialized
  result contained the workspace root, the planted key, `JSON`, `ENOENT`,
  `SyntaxError` or `Unexpected` — `leaky:false` on all 36 mode rows and all 19
  health rows. No stored flow record or issue comment contained the planted
  reason text on any of the 18 completion rows, including the unrecognized-status
  rows, which use the shared constant rather than interpolating the value.
- **Constant reasons.** Every posture-unavailable path returns the single
  `"security posture unavailable: check could not complete"` string; every
  unusable-health-report path returns the single ``"no report; run `keryx health
  run` first"``; every unrecognized completion status returns the single
  `"health gate could not be evaluated; treated as failed, not skipped"`.
- **No disk mutation from a forced posture.** `T57-state.ts` S7: after a run
  against a `null` config, the config file's bytes are still `null`,
  `.metaproject/` holds only what the fixture wrote, and
  `.metaproject/data/security/raw/` holds only `hmac.key` — no synthesized
  `state.json`. `T39-posture.ts` C1 (mtime and directory listing) re-run
  unchanged.
- **The recognized-value truth tables did not move.** `exitCodeFor`,
  `runExitCode` and `gateExitCode` reproduce T48/T50's tables cell for cell;
  `reportExitCode`'s only changed cells are the four `enforced` rows T55 states.
- **`security report`'s report-only invariant.** `advisory`, `gateway` and an
  absent config still exit 0 for every stored gate, including a `fail`.
- **The earlier probes still run and still say the same thing.**
  `T39-posture.ts`, `T39-exit.ts`, `T39-scan.ts` and `T55-verify-real-cli.ts` were
  re-run twice each (before and after the mid-review drift) with byte-identical
  output both times.
- **Committed suites.** `bun test src/security/guard.test.ts
  src/security/security.test.ts src/commands/security-gate-exit.test.ts
  src/commands/security.check-input.test.ts src/health/service-gate-exit.test.ts
  src/commands/health-gate-exit.test.ts src/flow/service.test.ts
  src/flow/security-gate.test.ts` → **133 pass / 0 fail / 692 expect()**, before
  and after the drift. `bun run typecheck` clean.
- **Excluded areas.** `src/security/detect/exfil.ts` is byte-identical at start
  and end and is excluded from every verdict regardless.

### One evidence caveat, stated rather than hidden

`T57-health.ts` also prints a `cliHealthGateExit` column. It is **not**
load-bearing and I do not rely on it: `runGate` in `src/commands/health.ts:163`
reads `process.cwd()` and ignores any root passed to `healthCommand`, so that
column measured this repository, not the fixture — which is why it reads `1` even
on the `pass` rows. The CLI's only contribution is `process.exitCode =
result.exitCode` (`:170`), and `result` is the service-level value the same probe
measures directly, so the service rows carry the verdict.

## Evidence

Raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.
Every probe was run **directly** rather than through `bun src/cli.ts ctx run`,
because gdctx compaction drops the per-case rows that are the evidence itself —
the same escape T39/T54/T55 recorded, and the reason is stated here rather than
left implicit. Test and typecheck runs were routed through `ctx run`.

| # | What ran | Raw log | SHA-256 |
|---|---|---|---|
| 1 | `T57-mode.ts` (row 1, 36 payloads × 4 surfaces) | `T57-mode.log` | `07cd1864ffad48f3ff5853f7090bf736766ca912bdd9ef05a6d5959b61c95931` |
| 2 | `T57-report.ts` (row 2, real `securityCommand(["report"])`) | `T57-report.log` | `3d6e8a32867bee3a1584fd8cfcd895f30e19c8e85cb11ad4d89034879c038dac` |
| 3 | `T57-flow.ts` (row 3, real `complete()` + stored `flow.json`) | `T57-flow.log` | `350056681cd5b3c06657b433a3b74871a061ccbc7f7d75a412b87483dfea0f1b` |
| 4 | `T57-state.ts` (row 4, real `check()` + `state.json` + `incidents.jsonl`) | `T57-state.log` | `19c80bad05bbe3201d62bd652b1d3db30c26734b52c09745205a6ea8f9f99e31` |
| 5 | `T57-health.ts` (row 5, 19 shapes at both `readLatest` callers) | `T57-health.log` | `23b107f3a524605de973f0d645411101d8cd54ed5cf737df8cf9c8e4239e867d` |
| 6 | `T39-posture.ts` re-run | `T57-r1-T39posture.log` | `3d69814d44952dae23b6459a79a0cb115b583fa1a1c6f2bf5fcd1b296a11d2c1` |
| 7 | `T39-exit.ts` re-run | `T57-r1-T39exit.log` | `b4ff2ef51907b10ad5ba00bea92eefeec06934ea5c670bcedbe678ab16a7e57d` |
| 8 | `T39-scan.ts` re-run | `T57-r1-T39scan.log` | `d94dd7f558a304170190d4159d1bf18d1fc223974711d9a3cfca463fbfb99594` |
| 9 | `T55-verify-real-cli.ts` re-run | `T57-r1-T55cli.log` | `8bb696700a59b285c7509466949b8538b7f60e9f2a9673da69f430be63b35500` |
| 10 | All nine of the above, re-run **after** the mid-review drift | `T57-mode-postdrift.log`, `T57-report-postdrift.log`, `T57-flow-postdrift.log`, `T57-state-postdrift.log`, `T57-health-postdrift.log`, `T57-postdrift-T39-{posture,exit,scan}.log`, `T57-postdrift-T55-verify-real-cli.log` | digests **identical to rows 1–9 respectively** — that identity is the drift evidence |
| 11 | Focused suites (8 files) | `2026-09-06T16-23-41-894Z_run.log` | `5b8f16c531746fb3dc887cd9e540464e8cff63ce900ba321d4fe2968e228bb70` |
| 12 | `bun run typecheck` | `2026-09-06T16-23-59-532Z_run.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| 13 | File hashes, start / end | `T57-hashes-start.txt` / `T57-hashes-end.txt` | `252e7c07bc3480f1b4aeab35156fd3a4635a38a8b3321671a08540f955bb6934` / `3bc81e1c85a0a98ec90606ad7871f760bfcea5d620d0ccb037a69e9a67abfae4` |
| 14 | Class enumeration for F-001 (`gates` uses in `complete()`) | `2026-09-06T16-13-51-868Z_rg.log` | (gdctx-recorded) |
| 15 | Sibling manifest readers, for judgement call 2 | `2026-09-06T16-25-00-631Z_rg.log` | (gdctx-recorded) |
| 16 | Config readers / `mergeSecurityConfig` callers | `2026-09-06T16-14-56-591Z_rg.log` | (gdctx-recorded) |

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set, the exact
symbols and the exact prior findings; the only enumeration questions were
text-shape ones, which `ctx rg` answers directly, and the graph's own manifest
warns it answers from the last build rather than the working tree, which is
uncommitted here). wiki_used: no (not-relevant — the normative sources are
`docs/requirements/keryx-agent-first-core/policies.md` and the frozen
`acceptance-criteria.md`, both read directly, plus the two review SKILL.md files
and the canonical severity rubric in `review-orchestrator/SKILL.md`). ctx_used:
yes — every project-code search through `bun src/cli.ts ctx rg`, every test and
typecheck through `bun src/cli.ts ctx run`, one large file read through
`keryx ctx read --mode compact`, all raw logs cited above by path.
raw_rg_used: no — no bare `rg`/`grep`/`cat`/`find`/`sed` was run over project
code. Two `diff` invocations carried the documented `# keryx:raw` escape and both
were over gdctx **raw probe logs**, never project code, with the stated reason
that the comparison of probe output byte-for-byte is the drift evidence itself.
Every project-code excerpt was read with the `Read` tool at bounded offsets. The
five probes were executed directly rather than through `ctx run`, for the reason
given at the head of the Evidence section.`

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T57#F-001",
    "reviewer": "review-security-code+review-logic (T57)",
    "severity": "blocker",
    "file": "src/flow/service.ts",
    "line": 996,
    "symbol": "healthGateOutcome",
    "problem": "The completion fold records a `warn` health gate as GateOutcome.status \"pass\" and relies on `detail` to keep the row distinguishable, but `detail` never reaches the durable record. On the passing path `complete()` writes only `transition(..., \"all gates passed\")` (src/flow/service.ts:667) and `buildIssueComment` renders `${gate.name}: ${gate.status}` with `detail` dropped (:1091), so the stored flow.json for a warned completion is byte-identical to a genuine pass and the published issue comment reads `health: pass`. The code comment at :980-983 and T56-implementation.md's acceptance table both assert the opposite as a property of flow.json.",
    "impact": "policies.md's «Optional skip показывает warning и не подписывается как passed» fails on the completion path. computeGate produces `warn` precisely for an optional source that was configured and then failed or was skipped, and for coverage below the soft floor; that state is now persisted in flow.json and posted to the issue tracker as an unqualified pass. A machine reading either surface to decide the phase was verified cannot tell a clean gate from a warned one. The distinction survives only on the ephemeral terminal line (src/commands/flow.ts:589), beside a green check mark.",
    "suggested_fix": "Keep the warn -> non-blocking decision; fix the record. Either (a) give the pass-path `transition` the same `${gate.name}: ${gate.detail}` join the failing path already builds at :683, so flow.json history carries `health: health gate: warn`; or (b) add a `warn` member to GateOutcome.status (leaving the master fold at :659 unchanged so it still does not block) and let buildIssueComment render `health: warn`. (b) is the more faithful reading of \"not signed as passed\". Correct the code comment at :980-983 and T56's acceptance row either way: as written they assert a false property of flow.json.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T57-flow.ts, raw .metaproject/data/gdctx/raw/T57-flow.log (sha256 350056681cd5b3c06657b433a3b74871a061ccbc7f7d75a412b87483dfea0f1b), row C99: {\"storedRecordsIdentical\":true,\"issueCommentsIdentical\":true,\"issueCommentHealthLinePass\":\"- Gates: ... health: pass\",\"issueCommentHealthLineWarn\":\"- Gates: ... health: pass\",\"storedRecordContainsWarnWord\":false}. Rows C01/C02 show returnedDetail differing in memory (\"health gate: pass\" vs \"health gate: warn\") while storedRecordMentionsHealth is false for both. Two full real complete() pipelines, verdict read back off disk.",
    "confidence": "high",
    "dedupe_key": "flow-complete-warn-signed-as-pass-in-stored-record",
    "blocking_merge": true,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/flow/service.ts:996",
        "src/flow/service.ts:667",
        "src/flow/service.ts:1091",
        "src/flow/service.ts:683",
        "src/commands/flow.ts:589"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg -n \"buildIssueComment|gate.status|gate.detail|gates\" src/flow/service.ts (raw 2026-09-06T16-13-51-868Z_rg.log) enumerated all 29 uses of the gates array in complete(); each was read. Exactly two leave the function's memory (:667/:683 through transition's history.push at :106, and :668 -> :1091). The resulting bytes on disk were then confirmed by probe rather than inferred."
    }
  },
  {
    "id": "F-002",
    "global_id": "T57#F-002",
    "reviewer": "review-security-code+review-logic (T57)",
    "severity": "minor",
    "file": "src/security/service.ts",
    "line": 92,
    "symbol": "analyze / evaluateSelfProtection",
    "problem": "T58 stops a forced posture becoming `previous`, but `appendIncidents` runs before the state-write guard, so a run against a broken config whose prior real mode is `gateway` appends a durable `mode-downgrade` entry to the append-only incidents.jsonl, and that entry survives the operator repairing the config back to the same `gateway`. The disclosed justification (\"a true statement about the current run\") does not hold: while configUnreadable is set, guardOutput and securityFlowGate refuse everything through their posture-unavailable branches, so effective enforcement during the window is stricter, not weakened; and isBlockingMode (guard.ts:229) puts `gateway` on the non-blocking side while MODE_RANK (self-protect.ts:32-37) ranks it strictest, so the two axes disagree about the sign of gateway -> enforced.",
    "impact": "Fail-loud noise, not a bypass: no check is relabeled and nothing is let through. But the acceptance criterion is 'repairing the config afterwards must produce no incident that did not happen', and state.json now satisfies it while the incident trail does not. A false entry in the append-only audit trail erodes the signal a real mode-downgrade carries. Reachability is one prior mode (`gateway` is the only rank above the forced `enforced`, and is a Phase-4 mode).",
    "suggested_fix": "Guard the comparison on the same condition the state write already uses: skip the mode-downgrade and policy-disabled arms of evaluateSelfProtection when config.configUnreadable, since a forced posture is not an operator choice on the way in either. If an operator-visible signal is wanted during a broken window, emit it as a `warning` only and never as an IncidentEntry, so the durable trail keeps meaning 'the operator changed something'. Separately (out of scope): MODE_RANK ranks `gateway` strictest while isBlockingMode treats it as report-only.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T57-state.ts, raw .metaproject/data/gdctx/raw/T57-state.log (sha256 19c80bad05bbe3201d62bd652b1d3db30c26734b52c09745205a6ea8f9f99e31), row S6 for both broken shapes: incidentsBeforeBreak [], incidentsDuringBrokenWindow [\"mode-downgrade\"], incidentsAfterRepairToSameMode [\"mode-downgrade\"], durableIncidentWrittenByTheBrokenRun true, stateAfterRepair \"gateway\". Controls in the same run: S1 (advisory prior) raises nothing; S2 shows four genuine downgrade shapes across a broken window still fire.",
    "confidence": "high",
    "dedupe_key": "self-protect-live-comparison-false-incident-during-broken-config",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  },
  {
    "id": "F-003",
    "global_id": "T57#F-003",
    "reviewer": "review-security-code+review-logic (T57)",
    "severity": "minor",
    "file": "src/health/service.ts",
    "line": 48,
    "symbol": "hasGateShape",
    "problem": "hasGateShape validates that the payload is an object and that `gate` carries a string `status` and an array `reasons`, and nothing else. A stored latest.json whose gate is well-formed but which has no `metrics` key, or `metrics` as a string, passes the guard and then throws a raw TypeError out of status() at `latest?.metrics.find` (:198) — the same value-vs-shape gap T55 was dispatched to close, one field further along. T55-implementation.md states that status() 'also benefits from this fix (a malformed report no longer throws there either)', which is true only for the payloads it tested.",
    "impact": "Not a false pass, and gate() — the deciding surface — is unaffected. `keryx health status` and the health.status MCP tool raise an unhandled TypeError at an agent-visible seam instead of the module's own 'no report' answer. A truncated, hand-written or older artifact reaches it; no tampering is needed.",
    "suggested_fix": "Extend hasGateShape to the fields its callers dereference — Array.isArray(value.metrics) && Array.isArray(value.sources) — which folds a truncated artifact into the same 'no report' outcome the guard already produces, for both callers, in one extra clause. Guarding at status()'s two reads instead would work but abandons the single-point shape the repair chose.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T57-health.ts, raw .metaproject/data/gdctx/raw/T57-health.log (sha256 23b107f3a524605de973f0d645411101d8cd54ed5cf737df8cf9c8e4239e867d), rows E18 (statusThrew \"undefined is not an object (evaluating 'latest?.metrics.find')\", gateResult still a clean {status:pass,exitCode:0}) and E19 (statusThrew \"latest?.metrics.find is not a function\"). Controls E01-E17: every malformed gate shape is the constant no-report refusal at gate() and null at status(), no throw.",
    "confidence": "high",
    "dedupe_key": "health-hasGateShape-metrics-sources-unvalidated",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T57#F-004",
    "reviewer": "review-security-code+review-logic (T57)",
    "severity": "info",
    "file": "src/flow/service.ts",
    "line": 652,
    "symbol": "complete (Gate 6: security)",
    "problem": "The security arm still pushes `status: security.status` verbatim, and the master fold at :659 (`gates.every((gate) => gate.status !== \"fail\")`) treats `skipped` as non-blocking. securityFlowGate's declared return type admits \"skipped\"; the function cannot produce it today. Unchanged from T39 F-001's class_scope and correctly outside T56's ownership.",
    "impact": "None reachable today: securityFlowGate returns only pass/fail, or null for a disabled module. Recorded so the next round does not rediscover it, and because the type keeps the door open on the one arm where every sibling fold has now been closed.",
    "suggested_fix": "Either narrow securityFlowGate's return type to the two values it can actually return, or fold the security arm through the same exhaustive-helper shape healthGateOutcome now uses.",
    "evidence": "Read of src/flow/service.ts:645-659 and src/security/guard.ts:417-476 (securityFlowGate returns only pass/fail/null on every path). T39-exit.ts F2 re-run, raw .metaproject/data/gdctx/raw/T57-r1-T39exit.log: a hand-built securityGate dependency returning \"skipped\" completes the flow (recordedGateStatus \"skipped\", completionPassed true).",
    "confidence": "high",
    "dedupe_key": "flow-complete-security-arm-skipped-passthrough",
    "blocking_merge": false,
    "related_skill": "gdskills/orchestration/task-implementer",
    "learning_candidate": false
  }
]
```
