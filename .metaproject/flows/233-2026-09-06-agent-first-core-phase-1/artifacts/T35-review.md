STATUS: DONE_WITH_CONCERNS

# T35 — independent recheck of the T33 gate-path repair and the T34 coverage fixes

All seven closed defects reproduce as closed under probes written fresh for this
review. Both consumer-facing claims are confirmed by execution, not by reading.
Stage 1 does **not** pass: one undisclosed defect of the **same class as the one
T33 repaired** is open in the sibling reader of the same file, and it removes the
security gate from `flow complete` exactly as T30 F-001 did. Stage 2 (code
quality) was therefore not performed.

## Scope

- Root: `/Users/Goodea/goodea/keryx`
- Branch: `codex/agent-first-core`
- HEAD / merge-base with `main`: `0bc6418fa1a038f8ec909cf949fecba077acf9a4` (identical; the branch carries uncommitted work only)
- Scope mode: default-with-uncommitted, restricted to the T33/T34 surface named in the dispatch
- Reviewer wrote neither repair nor either review that prompted them.

### File hashes (SHA-256), start and end of this review

| File | Start | End | Same |
|---|---|---|---|
| `src/security/service.ts` | `f8bde851…78f` | `f8bde851…78f` | yes |
| `src/security/guard.ts` | `eb8275b1…8db` | `eb8275b1…8db` | yes |
| `src/security/config.ts` | `713e880c…294` | `713e880c…294` | yes |
| `src/security/path-scan.ts` | `94f82ce5…cc8` | `94f82ce5…cc8` | yes |
| `src/commands/security.ts` | `27896f5c…661` | `27896f5c…661` | yes |
| `src/flow/service.ts` | `f27affa0…07f` | `f27affa0…07f` | yes |
| `src/mcp/structural-redaction.test.ts` (excluded area) | `53faabb2…aca` | `53faabb2…aca` | yes |
| `src/security/persistence-sinks.test.ts` (excluded area) | `bfdccd5d…d34` | `bfdccd5d…d34` | yes |

Full digests are in the Evidence section. The two files the other worker owns
are byte-identical at start and end, so nothing in this review depends on them;
they are excluded from every verdict regardless.

Nothing under `src/` was written. Artifacts written: `T35-review.md`,
`T35-result.json`, and six probes `T35-probe-{gate,scan,flowfold,residual,cli,cli2,mock}.ts`.
All fixtures were `mkdtemp` and removed in `finally`.

## Summary

| Severity | Count |
|---|---|
| blocker | 1 |
| major | 2 |
| minor | 1 |
| info | 3 |

The seven reported defects: **7 of 7 closed**. The two consumer-facing claims:
**both confirmed by execution**. The three judgement calls are ruled on below;
one of them (T37) is **required before phase acceptance**.

## Stage 1 — one row per defect, plus the two consumer claims

Every row cites a probe I executed. Raw log paths and digests are in Evidence.

| # | Defect | Verdict | My probe and what it showed |
|---|---|---|---|
| 1 | A missing latest report is `incomplete`, not `pass` | **closed** | `T35-probe-gate.ts` A30 (no artifacts dir at all) and A29 (dangling symlink): `runGate` → `incomplete`, reason `no security report; run \`keryx security scan\` first`; `runReport` → `incomplete`; `securityFlowGate` → `fail`. Raw `…T14-14-13-134Z_run.log`. Re-run of `T28-gate-probe.ts` case (a) agrees (`…T14-10-13-420Z_run.log`). |
| 2 | An unparseable report is `incomplete`, including through the report-building path that shares the reader | **closed** | `T35-probe-gate.ts` A13 (whitespace only), A15 (trailing comma), A16 (two reports concatenated), A27 (`latest.json` is a **directory**), A28 (mode `000`), A14 (BOM-prefixed): every one → `runGate` `incomplete` **and** `runReport` `incomplete`, constant reason `security report unusable; re-run \`keryx security scan\``, no path/error text/`JSON` substring in any reason. The three filesystem-level cases (A27–A29) are shapes neither earlier probe tried. |
| 3 | The fold is exhaustive over the four gate values; unrecognized value / missing field / non-object / array all `incomplete` | **closed** | `T35-probe-gate.ts` A1–A12 attack `hasRecognizedGate` with 12 shapes T28 did not use: JSON string, number, boolean, `gate: null`, `gate: true`, `gate: {}`, `gate: []`, `"PASS"`, `"pass "`, `""`, `{"__proto__":{"gate":"pass"}}`, `{"constructor":{"prototype":{"gate":"pass"}}}`. All 12 → `incomplete`; `Object.prototype.gate` is still `undefined` afterwards (`prototypePolluted: false`). A17–A20 confirm the narrow validation still admits legitimate minimal artifacts (`{"gate":"fail"}` → `fail`, `{"gate":"needs-approval"}` → `needs-approval`, `{"gate":"incomplete"}` → `incomplete`, `{"gate":"pass"}` → `pass`). |
| 4 | An enabled module that cannot read its own posture blocks in `enforced` and `ci` | **closed** | `T35-probe-residual.ts` D2 breaks the config module in all three modes: `enforced` and `ci` → `guardOutput` `{allowed:false, gate:"incomplete", reason:"security posture unavailable: check could not complete"}`; the sentinel, the workspace root and the planted key appear nowhere in the serialized result. `advisory` **also** refuses (see F-006 — correct, but it contradicts the file header's stated rule). Raw `…T14-18-21-503Z_run.log`. |
| 5 | The flow gate's mode-load failure returns a blocking result, not the `null` reserved for a disabled module; and its mapping is exhaustive so a stored `needs-approval` no longer reads as `pass` | **closed** | Same probe D2: `securityFlowGate` returns `{status:"fail", detail:"security posture unavailable: check could not complete"}` in all three modes — never `null`. `T35-probe-flowfold.ts` C2 drives the **real** `securityFlowGate` through `createFlowService().complete()`: `ci`+`needs-approval` → `passed:false`; `enforced`+`needs-approval` → `passed:false`; `ci`+`fail` → `passed:false`; `ci`+no report → `passed:false`; `ci`+`pass` → `passed:true`; module disabled → gate omitted, `passed:true`; `advisory`+`fail` → informational pass, `passed:true`. Raw `…T14-16-56-663Z_run.log`. |
| 6 | Per-file rows key on the encountered entry; no contradictory duplicates; no missing row for a symlink; cycles and duplicates still suppressed by canonical identity | **closed** | `T35-probe-scan.ts` B1–B5, all fixtures built so `displayPath` and the canonical path disagree. B1 (symlink sorted **before** its target — the reverse of T34's fixture): rows `corpus/a-link.env=scanned`, `corpus/z-real/creds.env=skipped: canonical identity already visited`, zero duplicate paths, the `contents` row matches the `scanned` row. B2 (hard link, two real names one inode): both names get a row, scanned once. B3 (mutual `x↔y` symlink cycle plus a self-link to the scan root): terminates in **2 ms**, four rows, no duplicates, the secret scanned exactly once, the self-link reported rather than silently dropped. B4 (symlinked directory): no duplicate rows. B5 (symlink to a file outside the owner root): `skipped: external target refused`, coverage `incomplete`, the outside path is **not** exposed, zero content read. Raw `…T14-15-56-305Z_run.log`. |
| 7 | A directory scanned without recursion never reports a clean pass | **closed** | `T35-probe-scan.ts` B6 across three shapes: directory-with-secret, **empty** directory, and a single-file target. Directory shapes → `coverage.status: "incomplete"`, reason `recursive traversal disabled`, `scan.decision.gate: "incomplete"`, and `runGate` on the same workspace afterwards → `incomplete`. The empty-directory case matters: there is no content to find, and it still is not a pass. B7 pins the converse — a genuinely clean recursive scan is still `pass` / `coverage: complete` / `runGate: pass`, so the fix did not simply make everything incomplete. |
| **Claim A** | `src/flow/service.ts` blocks completion only on a failing status, so any other status is non-blocking | **confirmed** | Not accepted from the report: `T35-probe-flowfold.ts` C1 drives the real `complete()` with an injected gate returning each value. `null` → gate omitted, `passed:true`. `pass` → `passed:true`. **`skipped` → `passed:true`.** `fail` → `passed:false`. **A gate that THROWS → recorded as `skipped`, `passed:true`.** No `securityGate` dep at all → `passed:true`. Source confirmation: `src/flow/service.ts:672` `const passed = gates.every((gate) => gate.status !== "fail");`, and `:657-670` pushes nothing for `null`. |
| **Claim B** | The `pass → incomplete` fold inside the scan path survived the gate rewrite, so the non-recursive outcome is truthful end to end and the false pass did not move one level up | **confirmed** | `src/security/service.ts:174-177` is unchanged and still folds `computed.gate === "pass" && coverage.status === "incomplete"` to `incomplete`. Executed end to end in `T35-probe-scan.ts` B6: `runScanPath` returns `incomplete`, `writeSecurityArtifacts` persists it, and a **subsequent** `runGate` on the same workspace reads `incomplete` — the false pass is absent at both frames, not relocated. B8 pins AC6's simultaneity: a planted secret plus a `chmod 000` sibling yields `gate: "fail"`, `findings: 1` **and** `coverage: incomplete` at once, with a per-file row for each entry. |

**Stage 1 result: the seven reported defects are closed and the two claims hold —
but Stage 1 does not pass, because F-001 below is an open defect of the same
class in the same file, found by attacking rather than confirming.** Stage 2 was
not started, per the dispatch's ordering.

## Findings

### [F-001] `isSecurityEnabled` dereferences the manifest without an object guard — the same four-byte defect T33 repaired, in the sibling reader

- **Severity**: blocker
- **File**: `src/security/guard.ts:104-107`, symbol `isSecurityEnabled`
- **Attack vector**: an attacker with write access to the repository (a malicious
  dependency's postinstall, a compromised CI step, a crafted PR, or an ordinary
  truncated write) puts the four bytes `null` into
  `.metaproject/metaproject.json`. `readJsonFileOr` guards only JSON that does
  not *parse*; `null` parses, is returned as-is, and `manifest.modules` throws
  `TypeError: null is not an object`. `securityFlowGate` awaits
  `isSecurityEnabled` **outside** its `try`, so it throws — contradicting its own
  documented contract (`guard.ts:261`, "Never throws"). `src/flow/service.ts:663-669`
  catches that and records the gate as **`skipped`**, which
  `:672 gates.every((gate) => gate.status !== "fail")` treats as non-blocking. The
  security gate disappears from `flow complete` with a row nobody reads as a
  failure. This is byte-for-byte the shape T30 F-001 described for
  `security.config.json`, in the file T33 owned, in the reader T33 did not touch.
- **Problem**: `const manifest = await readJsonFileOr<{modules?: …}>(manifestPath, {}); return manifest.modules?.security?.enabled === true;` — the fallback covers a
  parse failure, not a payload that parses to `null`. `T33`'s own fix
  (`isMergeableConfigPayload` in `config.ts:192`) is the guard this call site
  needs and does not have. The repo already knows the correct pattern:
  `src/gdgraph/symbols-capability.ts:24` writes
  `typeof manifest.modules === "object" && manifest.modules !== null`.
- **Impact**: (a) the flow-completion security gate is removed silently — the
  exact AC8 failure ("no required failed or incomplete check is relabeled PASS");
  (b) `guardOutput` also throws (its own doc says it never does), so every write
  seam that calls it — memory, wiki, testing, gdskills project-skills, metrics,
  sac, workspace notes, harness — raises an unhandled `TypeError` instead of
  guarding. (b) fails closed and is a crash, not a bypass; (a) fails **open** and
  is the blocker.
- **Reproduction**: `bun .metaproject/flows/233-…/artifacts/T35-probe-residual.ts`,
  section D3. Observed: `isSecurityEnabledThrew`, `guardOutputThrew` and
  `securityFlowGateThrew` all equal
  `"null is not an object (evaluating '(await readJsonFileOr(manifestPath, {})).modules')"`,
  then the real `createFlowService().complete()` pipeline returns
  `passed: true` with
  `{name:"security", status:"skipped", detail:"security unavailable: null is not an object (evaluating …)"}`.
  Raw `…T14-18-21-503Z_run.log`, lines 44-78.
- **Suggested fix**: in `guard.ts`, guard the payload the way `config.ts` already
  does — read it as `unknown` and require a non-null, non-array object before
  reaching `.modules` (and require the same of `.modules` itself). Three lines,
  and it makes `securityFlowGate`'s "Never throws" true again:
  ```ts
  const manifest = await readJsonFileOr<unknown>(manifestPath, {});
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
  const modules = (manifest as { modules?: unknown }).modules;
  if (typeof modules !== "object" || modules === null) return false;
  return (modules as Record<string, { enabled?: boolean }>).security?.enabled === true;
  ```
  Returning `false` (module disabled) is the pre-existing semantics for "no
  manifest", so this changes no behaviour for any workspace whose manifest reads.
  Pair it with F-004's fix so a future throw cannot fail open again.
- **class_scope**:
  - sites: `src/security/guard.ts:104` (the security seam, fail-open, executed
    above); `src/testing/capability.ts:26`; `src/capability/seam.ts:70`;
    `src/mcp/discovery.ts:123`; `src/gdskills/project-skills.ts:664`;
    `src/gdskills/project-skills.ts:681`; `src/gdskills/export.ts:199`;
    `src/gdskills/export-plugin.ts:189`; `src/commands/ctx.ts:131`
  - enumeration_method: `keryx ctx rg -n "readJsonFileOr" src --glob '!*.test.ts'`
    (raw `…T14-18-44-363Z_rg.log`) intersected with
    `keryx ctx rg -n "manifest\.modules" src --glob '!*.test.ts'`
    (raw `…T14-18-56-684Z_rg.log`); 9 call sites read a `metaproject.json`-shaped
    payload through `readJsonFileOr` and dereference the result without an
    object guard. `src/gdgraph/symbols-capability.ts:24` and
    `src/capability/wiring.ts:107` are the two that DO guard, which is what
    establishes the shape rather than a preference. Only `guard.ts:104` has a
    consumer that converts the throw into a non-blocking gate; the others crash
    their caller (fail-closed), so this finding blocks on the first and reports
    the rest as the class.
- **Confidence**: high (executed, end to end through the real flow pipeline).

### [F-002] The security CLI's strict-CI exit code is a two-value denylist, so `ci` accepts `needs-approval`

- **Severity**: major
- **File**: `src/commands/security.ts:798-806` (`exitCodeFor`) and `:559` (`handleReport`)
- **Attack vector**: an attacker submits content whose only policy hit is one the
  project has declared `require-approval` (the shipped default for
  `promptInjection`; reachable whenever `minConfidence` is set under the detector
  band, which the same file documents at `:790-796` as the supported operator
  mechanism). The scan resolves `gate: "needs-approval"` — the value that exists
  precisely to stop an unattended write pending a human. A CI job whose gate is
  `keryx security scan` or `keryx security report` **exits 0**, and the change
  ships without the approval.
- **Problem**: `exitCodeFor` in `ci` mode returns 1 only for `fail`/`incomplete`;
  `enforced` additionally refuses `needs-approval`. `handleReport:559` is the same
  denylist and never refuses `needs-approval` in any mode. `policies.md:28` states
  «Strict CI принимает только PASS» — strict CI accepts only PASS — and the two
  folds T33 just made exhaustive agree with the policy: `guardOutput` refuses
  `fail`/`needs-approval`/`incomplete` in **both** `enforced` and `ci`
  (`guard.ts:190-196`), and `securityFlowGate` maps `needs-approval` → `fail` in
  both. So the same stored value is now refused at the write seam and at flow
  completion, and accepted at the CLI — and `ci` is *more permissive than
  `enforced`* at the CLI, which is backwards. This is pre-existing rather than
  introduced by T33, but T33 is what widened `SecurityGateStatus` to carry
  `needs-approval` and made the divergence load-bearing.
- **Impact**: the phase's own criterion — "strict CI accepts only PASS", AC8's
  "no required failed or incomplete check is relabeled PASS" — is not met on the
  only surface a CI job actually invokes. `runGate` is not exposed as a CLI
  command at all (`keryx ctx rg -n "runGate" src/commands/security.ts` → no
  match), so these two exit codes *are* the CLI gate.
- **Reproduction**: `T35-probe-cli2.ts` (raw `…T14-23-05-816Z_run.log`) plants an
  injection string with `policies.promptInjection.minConfidence: 0.1`:
  `ci` → `scanGate: "needs-approval"`, `scanExitCode: 0`; `enforced` → same gate,
  `scanExitCode: 1`; `security report --json` → exit 0 in every mode.
  `T35-probe-cli.ts` case E4 (raw `…T14-19-26-982Z_run.log`) reaches the same
  place from a stored artifact: `ci` mode, `latest.json` gate `needs-approval`,
  `keryx security report --json` exit **0** while `runGate` says
  `needs-approval`.
- **Suggested fix**: make both folds allowlists over the one acceptable value.
  `exitCodeFor`: `if (mode === "ci" || mode === "enforced") return decision.gate === "pass" ? 0 : 1;`
  `handleReport:559`: `process.exitCode = mode === "ci" && report.gate !== "pass" ? 1 : 0;`
  (with F-003 folded in, `report.gate` should come from the same read-time
  consistency check `runGate` applies).
- **class_scope**:
  - sites: `src/commands/security.ts:800` (`ci` arm of `exitCodeFor`, reached from
    `:250 handleScan` and `:513 applyRuntimeDecision`), `src/commands/security.ts:803`
    (`enforced` arm — correct today, listed because the fix should make both one
    rule), `src/commands/security.ts:559` (`handleReport`)
  - enumeration_method: `keryx ctx rg -n "process.exitCode" src/commands/security.ts`
    (16 sites, raw `…T14-22-16-448Z_rg.log`) then
    `keryx ctx rg -n "exitCode = .*gate|gate === \"fail\"|gate !== \"pass\"|decision.gate ===" src/commands/security.ts`
    (raw `…T14-22-22-784Z_rg.log`); exactly 3 of the 16 fold a gate value into an
    exit code, and all 3 are listed. `:719` folds an `eval` gate, not a security
    gate, and is out of the class.
- **Confidence**: high (both sites executed through the real CLI).

### [F-003] The disclosed residual: a security config that parses but is not an object silently downgrades enforcement, and §14 does not catch it at any decision point

- **Severity**: major
- **File**: `src/security/config.ts:196-207` (`loadSecurityConfig`), with the
  consequence at `src/security/guard.ts:183` and `:279`
- **Attack vector**: an attacker (or a truncated write, or a bad merge) replaces
  `.metaproject/security.config.json` with `null`. The T33 repair correctly stops
  this from throwing — and routes it to `mergeSecurityConfig({})`, whose `mode`
  is `advisory`. An `enforced`/`ci` workspace silently becomes report-only: the
  planted secret is still **detected** (`decision.gate: "fail"`, one finding) and
  the write is still **allowed**, and flow completion is not blocked.
- **Problem**: the fallback is the pre-existing malformed-JSON behaviour, and
  T33 was explicitly not scoped to change it — that part of the disclosure is
  accurate and I do not fault the task. What is **not** accurate is the stated
  mitigation. The T33 report says §14 self-protection "catches it as a mode
  downgrade in any workspace that has run before". It does not catch it in any
  sense that changes an outcome: `evaluateSelfProtection` pushes a mode-downgrade
  **warning** and an **incident**, and no `finding`; `analyze` folds only
  `findings` into the gate; and `guardOutput` discards `warnings` entirely (it
  destructures `decision` only). So the downgrade is invisible at every decision
  point, with or without prior state.
- **Impact**: four bytes convert an enforced workspace into an advisory one with
  no refusal, no blocking gate, and no operator-visible signal on the guarded
  path. This is the same outcome T30 F-001 described; only the mechanism moved
  from a throw to a default.
- **Reproduction**: `T35-probe-residual.ts` D1 (raw `…T14-18-21-503Z_run.log`,
  lines 4-42), run twice — once in a fresh workspace and once in a workspace
  that has run before, with `state.json` recording `mode: "ci"`. **Both rows are
  identical**: `guardAllowed: true`, `decisionGate: "fail"`, `findingCount: 1`,
  `flowGateStatus: "pass"`, detail `security advisory: informational (advisory
  does not block)`, `flowGateBlocksCompletion: false`. Prior state changes
  nothing.
- **Suggested fix**: the minimal change is in `loadSecurityConfig`: distinguish
  "no config file" (defaults, correct) from "a config file exists and could not
  be read as one" (do not silently take a permissive default). Concretely — keep
  the total, non-throwing contract T33 established, and add one field:
  ```ts
  const parsed = await readJsonFileOr<unknown>(file, undefined);
  if (!isMergeableConfigPayload(parsed)) {
    return { ...mergeSecurityConfig({}), mode: "enforced", configUnreadable: true };
  }
  ```
  i.e. a present-but-unusable config resolves to the strictest mode rather than
  the most permissive one, and carries a flag `guardOutput`/`securityFlowGate`
  can turn into the existing constant reason `security posture unavailable:
  check could not complete`. That reuses machinery T33 already built (F-004/D3's
  branches) and adds no new leak surface. See the T37 ruling below.
- **class_scope**:
  - sites: `src/security/config.ts:200` (`loadSecurityConfig`, the only reader of
    `security.config.json`), `src/security/guard.ts:183` (`isBlockingMode(mode)`
    consumes the downgraded mode), `src/security/guard.ts:279` (same, flow gate)
  - enumeration_method: `keryx ctx rg -n "loadSecurityConfig" src --glob '!*.test.ts'`
    and `keryx ctx rg -n "readJsonFileOr" src/security` — `security.config.json`
    has exactly one reader, and `mode` has exactly two blocking consumers, both
    listed.
- **Confidence**: high (executed, both prior-state variants).

### [F-004] The read-time coverage consistency fold is neither shared with the report path nor exhaustive

- **Severity**: minor
- **File**: `src/security/service.ts:286-288` (`runGate`, `pass` arm) and `:254-257` (`runReport`)
- **Attack vector**: none that buys the attacker anything — anyone who can write
  `latest.json` writes `{"gate":"pass"}` with no `coverage` key and passes by
  design (see the judgement-call ruling). Reported as `minor` on that basis, not
  as a security control.
- **Problem**: two inconsistencies in one fold. (a) It is an equality against the
  single literal `"incomplete"`, so `coverage: {status: "partial"}` and
  `coverage: "incomplete"` (a string) both read as covered — while its sibling,
  the gate `switch` two lines above, was deliberately made exhaustive with the
  `default:` arm on the blocking side for exactly this reason. (b) `runReport`
  shares `readLatestReport` but not the fold, so the same artifact is
  `incomplete` at `runGate` and `pass` at `runReport` — and, via F-002, exits 0
  in strict CI.
- **Impact**: `keryx security report` and the flow gate give opposite answers
  about one artifact. For a self-consistency check whose whole purpose is to
  notice a contradictory artifact, being written non-exhaustively while the
  neighbouring fold is exhaustive is an inconsistency worth closing on the same
  pass.
- **Reproduction**: `T35-probe-gate.ts` A21 (`coverage.status: "incomplete"` →
  `runGate: incomplete`, **`runReport: pass`**), A22 (`"partial"` → `pass`), A23
  (string `coverage` → `pass`), A24/A25 (`null` and `"complete"` → `pass`,
  correct). Raw `…T14-14-13-134Z_run.log` lines 208-262. `T35-probe-cli.ts` E7
  shows the CLI consequence: exit 0, printed gate `pass`, `runGate` `incomplete`.
- **Suggested fix**: extract the check to one helper used by both `runGate` and
  `runReport`, written exhaustively — a present `coverage` object whose `status`
  is anything other than `"complete"` (including a `coverage` value that is not
  an object at all) reads as `incomplete`, with the existing constant reason.

### [F-005] `flow/service.ts` turns a throwing gate into a non-blocking `skipped` and interpolates raw error text into a persisted detail

- **Severity**: info
- **File**: `src/flow/service.ts:663-669` (security), `:646-651` (health), `:627-636` (review)
- **Problem**: two things at one site. (a) A gate whose implementation throws is
  recorded `skipped`, which `:672` treats as non-blocking — so an unexpected
  error in a gate is indistinguishable from a pass. The review gate at `:631`
  gets this right (`status: "fail"`, with the comment "A gate that cannot run has
  not passed"); the security and health arms do not. (b) The detail
  interpolates `error.message` verbatim into a string that is written into flow
  state and into `buildIssueComment`, against policies.md's requirement that
  reasons and details stay constant and leak-safe — the property `guard.ts` is
  scrupulous about one frame down.
- **Impact**: `info` and not higher, because with F-001 fixed `securityFlowGate`
  is total — `pathExists` and `readJsonFileOr` swallow every filesystem fault and
  `resolveProjectRoot` uses `existsSync` — so I can name no remaining trigger.
  Today it is the mechanism that converts F-001 into a silent pass, and the leak
  is observable: `T35-probe-flowfold.ts` C1 shows
  `detail: "security unavailable: T35-THROW-SENTINEL"` and
  `T35-probe-residual.ts` D3 shows the internal `TypeError` text landing in the
  persisted gate row.
- **Suggested fix**: make the security and health catch arms `status: "fail"`
  with a constant detail, matching the review arm; keep the error out of the
  persisted string.

### [F-006] `guardOutput`'s posture-unavailable branch blocks in advisory too, contradicting the module header's stated rule

- **Severity**: info
- **File**: `src/security/guard.ts:1-16` (header) vs `:156-163`
- **Problem**: the header states the "#1 rule": "advisory mode ONLY reports — it
  never blocks". The T33 mode-load catch returns `allowed: false` before
  `isBlockingMode(mode)` is ever consulted, so an advisory workspace whose config
  read fails is now refused. The behaviour is right — the mode is unknown, and
  the inline comment at `:151-155` argues the case correctly — but the header
  still asserts an invariant the code no longer holds unconditionally.
- **Impact**: documentation only; unreachable today because `loadSecurityConfig`
  is total. `T35-probe-mock.ts` F1 shows it: with the loader broken, the
  advisory workspace returns `allowed: false`, reason `security posture
  unavailable: check could not complete`.
- **Suggested fix**: amend the header to say advisory never blocks on a *known*
  posture, and name the posture-unknown exception.

### [F-007] Per-file attribution follows the first encounter, so a finding in a real file is reported at a symlink's path

- **Severity**: info
- **File**: `src/security/path-scan.ts:241-242`
- **Problem**: the T34 repair (rows key on `displayPath`) means that when a
  symlink is walked before its target, the symlink's name carries `scanned` and
  the real file's row reads `skipped: canonical identity already visited` — and
  the finding's `path` is the symlink. This is the intended direction of the fix
  and is truthful (the reason states why), but an operator grepping the report
  for the real path sees "skipped" for a file whose content was scanned.
- **Impact**: none on the gate; the content is scanned exactly once and every
  encountered entry has a row. Recorded so the next round does not rediscover it
  as a defect. Evidence: `T35-probe-scan.ts` B1, raw `…T14-15-56-305Z_run.log`
  lines 41-55. No path outside the owner root is exposed in any fixture (B5).
- **Suggested fix**: none required. If reports grow a field, an optional
  `canonicalOf` on a duplicate-skip row would close the loop without changing the
  key.

## Judgement calls

### 1. A stored `pass` carrying `coverage.status: "incomplete"` now reads as `incomplete`

**Ruling: accept the verdict change.** T28 scored it `n/a` on the correct
observation that `runScanPath` never writes such an artifact — but "our writer
cannot produce it" is an argument about the writer, and `runGate`'s input is a
file on disk, not our writer's output. An artifact that claims a pass over
coverage it itself calls incomplete is internally contradictory, and the two
readings available are "trust the `gate` field" and "trust the `coverage` field";
the phase's whole premise is that the reading which cannot have been checked must
not be the clean one. It is also the identical fold `runScanPath` applies before
it writes (`service.ts:174-177`), so the read-time and write-time answers now
agree, which is a property worth having on its own.

Two qualifications. First, it is **not** a tamper control and should not be
described as one: F-002/F-004's evidence shows a forger writes `{"gate":"pass"}`
with no `coverage` key and passes (A20). Its value is catching a *legitimate*
artifact that has become inconsistent — a partial write, a merge, an older writer
— not an adversary. Second, the change is incomplete as shipped: `runReport` does
not apply it (F-004), so the two consumer surfaces disagree about the artifact the
fold exists to judge, and the CLI exit code follows the permissive one. Accept
the verdict change; close F-004 in the same pass so it means the same thing
everywhere.

### 2. Gate validation is deliberately narrower than the full report schema

**Ruling: the argument holds, and my probes support it rather than merely not
refuting it.** The claim has two halves and both are testable.

*Full-schema rejection buys nothing against a forged pass.* Confirmed:
`T35-probe-gate.ts` A20 — `{"gate":"pass"}`, twelve bytes, reads `pass` end to
end. An attacker who can write that file can equally write the full committable
shape; the two cost the same. Validation strictness on this path is not a
security boundary in either direction, so tightening it purchases no protection.

*Full-schema rejection would relabel legitimate narrower artifacts.* Confirmed:
A17–A19 — `{"gate":"fail"}`, `{"gate":"needs-approval"}` and `{"gate":"incomplete"}`
read as themselves today and would all become `incomplete` under full-schema
rejection. That is the specific harm: it would collapse a **violation**, an
**approval requirement** and **unavailable evidence** into one value, which is the
distinction this entire phase exists to preserve, and it would do so for exactly
the artifacts that already say something bad. Two such fixtures are pinned in the
committed test suite.

What the narrow predicate must therefore carry alone is *exhaustiveness*, and
that is where I did press: twelve non-conforming shapes (A1–A12), including two
prototype-pollution payloads, all resolve to `incomplete` with
`Object.prototype` untouched. The predicate is sound. The one place the same
discipline was not applied is the coverage fold two lines below it (F-004) —
that is the fix this judgement call implies, not a wider schema.

### 3. The residual — must T37 close before phase acceptance?

**Ruling: yes, T37 must close before phase acceptance.**

Three reasons, in order of weight.

1. **The stated mitigation does not exist.** The disclosure rests on §14
   self-protection catching the downgrade "in any workspace that has run
   before". I ran it both ways (F-003, probe D1): with `state.json` recording
   `mode: "ci"`, the outcome is byte-identical to the fresh workspace —
   `guardAllowed: true`, flow gate `pass`, completion unblocked. The downgrade
   produces a warning and an incident, never a `finding`, so it never reaches
   the gate; and `guardOutput` discards warnings. The residual is therefore
   strictly worse than disclosed: it is undetected at every decision point, not
   merely undetected in fresh workspaces.
2. **It is the same failure the phase is closing.** T30 F-001 was "four bytes in
   `security.config.json` disable the write guard and remove the security gate
   from flow completion". After T33 the four bytes no longer throw — and still
   disable the write guard and still leave flow completion unblocked, now by
   taking a permissive default instead of by crashing. Accepting the phase with
   this open would accept a phase whose headline criterion ("a check which did
   not run must never read as a clean one") is violated by its own most-cited
   reproducer.
3. **AC8 names it.** "No required failed or incomplete check is relabeled PASS;
   strict guards and the strict flow gate refuse incomplete evidence." A config
   that cannot be read is incomplete evidence about the workspace's posture —
   `guard.ts:151-155` argues precisely this for the *throwing* case and refuses.
   The non-throwing case reaches the opposite conclusion from the same premise.

**Minimal change (T37).** One function, `loadSecurityConfig` in
`src/security/config.ts:200-207`, plus the two-line consumption already built:

- Distinguish *absent* from *present-and-unusable*. `pathExists(file) === false`
  keeps today's behaviour exactly (defaults, advisory) — that is the documented,
  desirable path for a project that has never configured security.
- When the file **exists** and `isMergeableConfigPayload(parsed)` is false,
  return the defaults with `mode` forced to `"enforced"` and an additive
  `configUnreadable: true`.
- In `guard.ts`, treat `config.configUnreadable` on the two paths that already
  have a posture-unavailable branch (`guardOutput:156-163`,
  `securityFlowGate:269-277`) so the refusal carries the existing constant
  `POSTURE_UNAVAILABLE_REASON` rather than a findings summary.

That keeps `loadSecurityConfig` total (T33's invariant), reuses the constant,
leak-safe strings T33 introduced, changes nothing for a workspace with no config
file or a readable one, and needs no new policy decision — it applies the rule
`guard.ts` already states, to the one input that currently escapes it. Scope: one
predicate branch, one additive field, two `if`s. The malformed-*JSON* fallback
(a file that does not parse) should move with it for the same reason; splitting
them would leave the cheaper corruption open.

If the phase decides otherwise, the fallback position is that T37 may be
deferred **only** if `security.config.json` gains an integrity check that fails
closed, which is a strictly larger change — so deferral costs more than closing.

## The test technique: `mock.module` restored from an eagerly snapshotted namespace

**Sound, and the eager snapshot is load-bearing rather than decorative.** I did
not take this from the tests passing; `T35-probe-mock.ts` reproduces the
technique and both its failure modes outside the test suite (raw
`…T14-20-55-210Z_run.log`).

- **F0 baseline** — with the real loader, `enforced` blocks with
  `[security] fail: 1 finding(s) (secret:1)` and `advisory` allows. Those two
  reasons are what distinguishes "real loader" from "broken loader" observably.
- **F1** — the break reaches `guard.ts`'s **already-bound** import (Bun's
  `mock.module` updates live bindings), so the regression genuinely exercises the
  posture-unavailable branch and is not asserting against a fresh import nothing
  else uses.
- **F2a** — restoring from a **live** namespace reference reproduces the leak the
  code comment describes: after the "restore", the advisory workspace still
  refuses with `security posture unavailable`. The mistake is real and the
  comment is not folklore.
- **F2b** — restoring from the **eager** snapshot restores the real loader for
  the already-bound consumer: advisory allows again, enforced blocks on findings
  again.
- **F3** — a fresh `import` after restore also sees the real
  `loadSecurityConfig` (`mode: "enforced"` read from the real file).
- **F4** — a body that throws still leaves the real loader in place, so a failing
  assertion inside `T33 D3`/`D4` cannot poison the rest of the run.
- **F5** — the sentinel never reaches any reason string.

Cross-test contamination: none observed and none reachable. `mock.module("./config")`
resolves relative to `guard.test.ts`, i.e. `src/security/config.ts`; the snapshot
is taken at that file's module evaluation and `keryx ctx rg -n "mock.module" src`
shows the only other user in the repository is
`src/gdgraph/treesitter/adapter.test.ts`, over `web-tree-sitter` — a different
specifier, so no file that runs earlier can have replaced `./config` before the
snapshot is taken. Executed both orderings:
`bun test src/security/guard.test.ts` alone → 24 pass / 0 fail; and
`bun test src/security/security.test.ts src/security/guard.test.ts src/commands/security.check-input.test.ts src/security/persistence-sinks.test.ts`
(guard second, three config-dependent files around it) → 90 pass / 0 fail.

One residual note, not a finding: `restoreConfigLoad` leaves `./config`
registered as a mock whose members happen to be the real functions, rather than
un-registering it. That is functionally identical for every consumer in this
repository (all of them call the exported functions and none depends on module
identity), and `mock.restore()` does not undo `mock.module` in Bun, so the
snapshot-respread is the correct idiom here.

## Confirmed clean areas

Checked, with no finding:

- **Leak safety of every reason and detail on the repaired paths.** Across 30
  gate cases, 3 posture-unavailable modes and 8 flow-gate cases, no reason or
  detail contains the workspace root, the thrown error's text, the string `JSON`,
  an `ENOENT`, or the planted synthetic key. The four constants
  (`NO_REPORT_REASON`, `UNUSABLE_REPORT_REASON`, `INCOMPLETE_COVERAGE_REASON`,
  `POSTURE_UNAVAILABLE_REASON`) are string literals with no interpolation.
- **Path containment in the scanner.** A symlink to a file outside the owner root
  is refused, coverage goes `incomplete`, no content is read, and the outside
  absolute path appears nowhere in the traversal result (probe B5). `isInside`
  is applied to the *canonical* path, so the check cannot be walked around with
  `..`.
- **Prototype pollution via the stored artifact.** Both payload shapes are
  rejected and `Object.prototype` is unmodified afterwards (probe A11/A12).
- **No relabeling in the safe direction.** A genuine `pass` artifact still reads
  `pass` at `runGate`, `runReport`, `securityFlowGate` and through
  `flow complete` (A20, C2 `ci + stored pass`), and a genuinely clean recursive
  scan is still `pass` with `coverage: complete` (B7). The repairs did not buy
  their truthfulness by making everything incomplete.
- **Advisory is still report-only for every workspace whose config reads.**
  `advisory` + stored `fail` → informational pass, completion unblocked (C2),
  and the guard allows with truthful `incomplete`/`fail` diagnostics on the
  decision.
- **Cycle and duplicate suppression.** Mutual symlink cycle plus a self-link to
  the scan root completes in 2 ms with no duplicate rows (B3).
- **Regression suite.** `bun test src/security/guard.test.ts src/commands/security-recursive-scan.test.ts src/flow/security-gate.test.ts src/security/security.test.ts src/security/service.memo.test.ts` → 51 pass / 0 fail / 271 expect().
- **Excluded area.** `src/mcp/structural-redaction.test.ts` and
  `src/security/persistence-sinks.test.ts` are byte-identical at start and end of
  this review and are excluded from every verdict above regardless.

## Evidence

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

| # | What ran | Raw log | SHA-256 |
|---|---|---|---|
| 1 | `T28-gate-probe.ts` re-run (unchanged, as required) | `2026-09-06T14-10-13-420Z_run.log` | `7d7ff920c437f3c0c98a3ad56a6c43133ab260e4792ccd2c7fb279d4a4f2816a` |
| 2 | `T30-probe-failopen.ts` re-run (unchanged; **exit 1 is the pass condition**) | `2026-09-06T14-10-32-577Z_run.log` | `43556ed8c45c4215197c4edbe05df149e5c678b8aeb292e2109275447156c2b4` |
| 3 | `T35-probe-gate.ts` (30 read-time gate cases) | `2026-09-06T14-14-13-134Z_run.log` | `0e12bdce8677927dd92ce75afc9d5f0aa0c2c52f87aab5a8a4ad71dbd8c6a7d8` |
| 4 | `T35-probe-scan.ts` (coverage rows, cycles, non-recursive, end to end) | `2026-09-06T14-15-56-305Z_run.log` | `27e8aab9d71b74560c18f7beae8865777856052b0ca502683c07f95b625830d0` |
| 5 | `T35-probe-flowfold.ts` (real `complete()` pipeline, 14 cases) | `2026-09-06T14-16-56-663Z_run.log` | `fe4871bfef2983d57e1dff195a87d1969ff19666b3f43ad1414d9cfa651ca41e` |
| 6 | `T35-probe-residual.ts` (residual, posture-unavailable, F-001) | `2026-09-06T14-18-21-503Z_run.log` | `1d68db33317667d341ca6ebdb4750f0ec4c2ad6406b2ef600b39c7b2ee523060` |
| 7 | `T35-probe-cli.ts` (`security report` exit codes, 7 artifacts) | `2026-09-06T14-19-26-982Z_run.log` | `c8b81e8bff6f3560b8007118fdb2ff99f7b4518863b0b92465ea74ececef147e` |
| 8 | focused security + flow test selection (51 pass / 0 fail) | `2026-09-06T14-19-50-869Z_run.log` | `b169f68fc8c75b6d092f0416923d9c0cb9d087dc7125219618790b468b6134c2` |
| 9 | `guard.test.ts` alone (24 pass / 0 fail) | `2026-09-06T14-20-02-372Z_run.log` | `c379556737347da4d409a0324cb0630f8d1b207628b0b7857729972ac46a45a3` |
| 10 | interleaved order, guard second (90 pass / 0 fail) | `2026-09-06T14-20-11-701Z_run.log` | `059ba96a010b0f9fd87dc9ffca12f9602508024042d76dbd5bdd5413eed711af` |
| 11 | `T35-probe-mock.ts` (mock restoration technique) | `2026-09-06T14-20-55-210Z_run.log` | `44a0ef7317d4b39704ac7f1d71e7753622067b8bf8d9191067f9eddc540d8254` |
| 12 | `T35-probe-cli2.ts` (`exitCodeFor` over `needs-approval`) | `2026-09-06T14-23-05-816Z_run.log` | `a0b0254efc387b60d8186c9e99643ab33525da049762964227a06cff0ba792cd` |
| 13 | enumeration: `.gate(` / `securityFlowGate` consumers | `2026-09-06T14-15-04-773Z_rg.log` | `83281ef21147e353b5c0f0b0570829906df0ed5b64e7278b330a0dd297c73ccc` |
| 14 | enumeration: `guardOutput(` callers | `2026-09-06T14-17-29-156Z_rg.log` | `3a5a3a8c99ac10a834bc532984272e3ab289bffd23dec5f3815d5f4697901774` |
| 15 | enumeration: `readJsonFileOr` call sites (F-001 class) | `2026-09-06T14-18-44-363Z_rg.log` | `4dc9ba672a709765ed420f7f1ce268fd9fd0ef84951e9d0818f4bf10ae953ea7` |
| 16 | enumeration: `manifest.modules` dereferences (F-001 class) | `2026-09-06T14-18-56-684Z_rg.log` | `59544ecac10bc00c934417afe15e68f518feb1d962051c6f54e6fddcad9774a8` |
| 17 | enumeration: `process.exitCode` in the security CLI (F-002 class) | `2026-09-06T14-22-16-448Z_rg.log` | `d3fbd4b7e157b52bca0f312005a592d59dc97aee6d450c2274c745e94d547b52` |
| 18 | enumeration: gate-valued exit codes (F-002 class) | `2026-09-06T14-22-22-784Z_rg.log` | `5b41cdb60a7b5d07f924ff229f836135bfe279a16f0a1fd86406ffc9f31b3fb2` |

Full file digests, start and end of review (identical for every file):

```
f8bde8514cac4c4aa1c1ea55f2257fe73cc2387a6ed81995313ff0699fee378f  src/security/service.ts
eb8275b198811be98d03d88ea13d8d1fd6be156e83344d11fbd06f56873138db  src/security/guard.ts
713e880cdc643edceaed5f85c70ef5311e310e9953f8a55401df9b20e3f00294  src/security/config.ts
94f82ce5a5c33857aef52df6f2c1a124880553901354cb25451b1298d4fd3cc8  src/security/path-scan.ts
27896f5c3ad57eeae4ea300ec9313f75fb82db440fd0096146ecf02779350661  src/commands/security.ts
f27affa0bc2282d844265653e9f28c3528e23dfdf0726ce84b5c781fb479407f  src/flow/service.ts
d502bcbd630cd055246f4b7f5607c0bdf4fc273ac93a34c71ee515e61dec71e5  src/security/guard.test.ts
d502f8dee13bcdf8204d9d793b07ef72d45af93d619a1e735c5579d251852bc2  src/commands/security-recursive-scan.test.ts
53faabb2d160271a372718294b161fc65482c2b0fe3d6f976b2d740849ca6aca  src/mcp/structural-redaction.test.ts   (excluded area)
bfdccd5d7583535d2388a55ee0d37daeb537e4d52ce45554de4120c7a0a63d34  src/security/persistence-sinks.test.ts (excluded area)
```

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set and
symbol names; the one discovery question that arose, the class scope of F-001
and F-002, is a text-shape question the graph does not answer and `ctx rg`
does); wiki_used: no (not-relevant — the normative sources are policies.md and
the frozen acceptance-criteria.md, both supplied as context_refs and read
directly); ctx_used: yes (every code search via `bun src/cli.ts ctx rg`, every
command and probe via `bun src/cli.ts ctx run`; 18 raw logs cited above);
raw_rg_used: no — seven bounded `sed -n`/`grep -n` reads of gdctx **raw logs**
(never of project code) carried the documented `# keryx:raw` escape, with the
stated reason that ctx compaction drops the per-case statuses and per-file
coverage rows that are the evidence itself, exactly as the previous reviewers
recorded. No search over project code bypassed ctx.`

## Constraint compliance

No git state changed; no flow CLI or flow state touched; no network; no model
calls; no dependency or lockfile change (`bun.lock` and `package.json` were
already modified at session start and are byte-identical to their session-start
digests); no `bun test` without file arguments; production and test code
read-only; every fixture synthetic, under `mkdtemp`, removed in `finally`; no
real credential used — the only key-shaped strings are the documented synthetic
`AKIA…` examples.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T35#F-001",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "blocker",
    "file": "src/security/guard.ts",
    "line": 104,
    "symbol": "isSecurityEnabled",
    "problem": "isSecurityEnabled dereferences the result of readJsonFileOr without an object guard: `.metaproject/metaproject.json` containing the four bytes `null` parses successfully, is returned as-is, and `manifest.modules` throws TypeError. securityFlowGate awaits isSecurityEnabled outside its try, so it throws despite its documented 'Never throws' contract; src/flow/service.ts:663-669 catches that and records the gate as `skipped`, which :672 `gates.every(g => g.status !== \"fail\")` treats as non-blocking. This is the same shape T30 F-001 reported for security.config.json, in the same file, in the sibling reader T33 did not repair. The correct guard already exists two modules away (config.ts:192 isMergeableConfigPayload) and at src/gdgraph/symbols-capability.ts:24.",
    "impact": "The flow-completion security gate is removed silently -- the exact AC8 failure the phase exists to close. Secondarily, guardOutput throws on the same trigger (also contrary to its documented contract), so every write seam that calls it (memory, wiki, testing, gdskills, metrics, sac, workspace, harness) raises an unhandled TypeError; that half fails closed, the flow-gate half fails open.",
    "suggested_fix": "In guard.ts, read the manifest as `unknown` and require a non-null, non-array object before reaching `.modules`, and require `.modules` itself to be a non-null object; return false (module disabled) otherwise, which is the pre-existing semantics for a missing manifest and so changes nothing for any workspace whose manifest reads. Pair with F-005 so a future throw cannot fail open again.",
    "evidence": "T35-probe-residual.ts section D3, raw .metaproject/data/gdctx/raw/2026-09-06T14-18-21-503Z_run.log lines 44-78: isSecurityEnabledThrew / guardOutputThrew / securityFlowGateThrew all equal \"null is not an object (evaluating '(await readJsonFileOr(manifestPath, {})).modules')\"; the real createFlowService().complete() pipeline then returns passed:true with {name:\"security\", status:\"skipped\", detail:\"security unavailable: null is not an object (...)\"}. Non-null non-object manifests ([], 42, \"enabled\", true) do NOT throw and return enabled:false, which bounds the trigger to the JSON literal null.",
    "confidence": "high",
    "dedupe_key": "security-guard-manifest-null-dereference-failopen",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/guard.ts:104",
        "src/testing/capability.ts:26",
        "src/capability/seam.ts:70",
        "src/mcp/discovery.ts:123",
        "src/gdskills/project-skills.ts:664",
        "src/gdskills/project-skills.ts:681",
        "src/gdskills/export.ts:199",
        "src/gdskills/export-plugin.ts:189",
        "src/commands/ctx.ts:131"
      ],
      "enumeration_method": "keryx ctx rg -n \"readJsonFileOr\" src --glob '!*.test.ts' (raw 2026-09-06T14-18-44-363Z_rg.log) intersected with keryx ctx rg -n \"manifest\\.modules\" src --glob '!*.test.ts' (raw 2026-09-06T14-18-56-684Z_rg.log): 9 call sites read a metaproject.json-shaped payload through readJsonFileOr and dereference it without an object guard; src/gdgraph/symbols-capability.ts:24 and src/capability/wiring.ts:107 are the two that do guard, which establishes the shape. Only guard.ts:104 has a consumer that converts the throw into a non-blocking gate; the other eight crash their caller (fail-closed) and are listed as the class, not as blockers."
    }
  },
  {
    "id": "F-002",
    "global_id": "T35#F-002",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "major",
    "file": "src/commands/security.ts",
    "line": 800,
    "symbol": "exitCodeFor",
    "problem": "The two CLI folds that turn a security gate into an exit code are two-value denylists rather than an allowlist over `pass`. exitCodeFor refuses only fail/incomplete in `ci` mode (enforced additionally refuses needs-approval), and handleReport:559 refuses only fail/incomplete and only when the stored report's mode is `ci`. policies.md:28 states that strict CI accepts only PASS, and the two folds T33 just made exhaustive agree with it: guardOutput refuses fail/needs-approval/incomplete in BOTH enforced and ci (guard.ts:190-196) and securityFlowGate maps needs-approval to fail in both. The same stored value is therefore refused at the write seam and at flow completion and accepted at the CLI, and `ci` is more permissive than `enforced` at the CLI, which inverts the intended ordering. runGate is not exposed as a CLI command at all, so these exit codes are the CLI gate.",
    "impact": "A CI job whose security gate is `keryx security scan` or `keryx security report` exits 0 on a needs-approval verdict -- the value that exists specifically to stop an unattended write pending a human -- so an approval-requiring finding ships without the approval. Directly contradicts AC8 and the policies.md fold.",
    "suggested_fix": "Make both folds allowlists over the one acceptable value: in exitCodeFor, `if (mode === \"ci\" || mode === \"enforced\") return decision.gate === \"pass\" ? 0 : 1;`, and in handleReport, `process.exitCode = mode === \"ci\" && report.gate !== \"pass\" ? 1 : 0;` (taking report.gate through the same read-time consistency check runGate applies, per F-004).",
    "evidence": "T35-probe-cli2.ts, raw .metaproject/data/gdctx/raw/2026-09-06T14-23-05-816Z_run.log: with policies.promptInjection.minConfidence lowered to 0.1 (the mechanism documented at security.ts:790-796), `keryx security scan corpus/note.md --json` yields gate needs-approval with exit 0 in ci mode and exit 1 in enforced mode, and `keryx security report --json` exits 0 in every mode. T35-probe-cli.ts case E4, raw 2026-09-06T14-19-26-982Z_run.log: ci mode, stored latest.json gate needs-approval, `security report --json` exit 0 while runGate returns needs-approval.",
    "confidence": "high",
    "dedupe_key": "security-cli-exitcode-denylist-accepts-needs-approval",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/commands/security.ts:800",
        "src/commands/security.ts:803",
        "src/commands/security.ts:559"
      ],
      "enumeration_method": "keryx ctx rg -n \"process.exitCode\" src/commands/security.ts (16 sites, raw 2026-09-06T14-22-16-448Z_rg.log) then keryx ctx rg -n \"exitCode = .*gate|gate === \\\"fail\\\"|gate !== \\\"pass\\\"|decision.gate ===\" src/commands/security.ts (raw 2026-09-06T14-22-22-784Z_rg.log): exactly 3 of the 16 fold a security gate value into an exit code and all 3 are listed. security.ts:719 folds an eval-suite gate, not a security gate, and is out of the class. exitCodeFor is reached from :250 (handleScan) and :513 (applyRuntimeDecision, both check paths)."
    }
  },
  {
    "id": "F-003",
    "global_id": "T35#F-003",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "major",
    "file": "src/security/config.ts",
    "line": 200,
    "symbol": "loadSecurityConfig",
    "problem": "The disclosed residual, with its stated mitigation refuted. A security.config.json that parses but is not an object now takes mergeSecurityConfig({}), whose mode is `advisory`, so an enforced/ci workspace silently becomes report-only: the planted secret is still detected (decision.gate `fail`, one finding) and the write is still allowed, and securityFlowGate returns an informational `pass` so flow completion is not blocked. The T33 report states that §14 self-protection catches this as a mode downgrade in any workspace that has run before; it does not. evaluateSelfProtection pushes a mode-downgrade warning and an incident but never a finding, analyze folds only findings into the gate, and guardOutput discards warnings entirely -- so the downgrade changes no outcome at any decision point, with or without prior state.",
    "impact": "Four bytes convert an enforced workspace into an advisory one with no refusal, no blocking gate and no operator-visible signal on the guarded path. This is the same outcome T30 F-001 described; only the mechanism moved from a throw to a permissive default. Under AC8, a config that cannot be read is incomplete evidence about the workspace's own posture -- guard.ts:151-155 argues exactly that for the throwing case and refuses, while the non-throwing case reaches the opposite conclusion from the same premise.",
    "suggested_fix": "In loadSecurityConfig, distinguish an ABSENT config (keep today's defaults/advisory behaviour exactly) from a PRESENT-but-unusable one: when pathExists is true and isMergeableConfigPayload(parsed) is false, return the defaults with mode forced to \"enforced\" plus an additive `configUnreadable: true`, and have guardOutput:156-163 and securityFlowGate:269-277 treat that flag through their existing posture-unavailable branches so the refusal carries the existing constant POSTURE_UNAVAILABLE_REASON. Keeps loadSecurityConfig total (T33's invariant), reuses T33's leak-safe constants, and changes nothing for a workspace with no config file or a readable one. The malformed-JSON (non-parsing) fallback should move with it; splitting them leaves the cheaper corruption open.",
    "evidence": "T35-probe-residual.ts section D1, raw .metaproject/data/gdctx/raw/2026-09-06T14-18-21-503Z_run.log lines 4-42, run twice -- once in a fresh workspace and once in a workspace with .metaproject/data/security/raw/state.json recording mode \"ci\". Both rows are identical: guardAllowed true, decisionGate \"fail\", findingCount 1, flowGateStatus \"pass\", detail \"security advisory: informational (advisory does not block)\", flowGateBlocksCompletion false. Prior state changes nothing.",
    "confidence": "high",
    "dedupe_key": "security-config-nonobject-downgrades-mode-to-advisory",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/config.ts:200",
        "src/security/guard.ts:183",
        "src/security/guard.ts:279"
      ],
      "enumeration_method": "keryx ctx rg -n \"loadSecurityConfig\" src --glob '!*.test.ts' and keryx ctx rg -n \"readJsonFileOr\" src/security: security.config.json has exactly one reader (config.ts:200), and the resulting `mode` has exactly two blocking consumers, both isBlockingMode call sites in guard.ts; both are listed."
    }
  },
  {
    "id": "F-004",
    "global_id": "T35#F-004",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "minor",
    "file": "src/security/service.ts",
    "line": 286,
    "symbol": "runGate",
    "problem": "The read-time coverage consistency fold added by T33 is neither shared nor exhaustive. (a) It is an equality against the single literal \"incomplete\", so coverage {status: \"partial\"} and a coverage value that is the string \"incomplete\" both read as covered -- while the gate switch two lines above was deliberately made exhaustive with the default arm on the blocking side for exactly this reason. (b) runReport shares readLatestReport but not the fold, so one artifact is `incomplete` at runGate and `pass` at runReport, and via F-002 exits 0 in strict CI.",
    "impact": "keryx security report and the flow gate give opposite answers about the same artifact. Kept at minor rather than higher because this fold is not a tamper control: probe A20 shows a forger writes {\"gate\":\"pass\"} with no coverage key and passes by design, so its value is catching a legitimate artifact that has become inconsistent, not an adversary.",
    "suggested_fix": "Extract one helper used by both runGate and runReport: a present `coverage` whose status is anything other than \"complete\" -- including a coverage value that is not an object -- reads as incomplete, with the existing INCOMPLETE_COVERAGE_REASON constant.",
    "evidence": "T35-probe-gate.ts, raw .metaproject/data/gdctx/raw/2026-09-06T14-14-13-134Z_run.log lines 208-262: A21 (coverage.status \"incomplete\") runGate incomplete but runReport pass; A22 (\"partial\") runGate pass; A23 (coverage is the string \"incomplete\") runGate pass; A24 (coverage null) and A25 (\"complete\") pass, correctly. T35-probe-cli.ts case E7, raw 2026-09-06T14-19-26-982Z_run.log: the CLI prints gate pass and exits 0 for the artifact runGate calls incomplete.",
    "confidence": "high",
    "dedupe_key": "security-gate-coverage-fold-not-shared-not-exhaustive",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-005",
    "global_id": "T35#F-005",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "info",
    "file": "src/flow/service.ts",
    "line": 663,
    "symbol": "complete (Gate 6 catch arm)",
    "problem": "Two things at one site. (a) A gate whose implementation throws is recorded as `skipped`, which :672 treats as non-blocking, so an unexpected error in a gate is indistinguishable from a pass; the review gate at :631 gets this right (`status: \"fail\"`, 'A gate that cannot run has not passed') and the security and health arms do not. (b) The detail interpolates error.message verbatim into a string persisted into flow state and into buildIssueComment, against policies.md's requirement that reasons and details stay constant and leak-safe -- the property guard.ts is scrupulous about one frame down.",
    "impact": "Info rather than higher because with F-001 fixed securityFlowGate is total (pathExists and readJsonFileOr swallow every filesystem fault, resolveProjectRoot uses existsSync), so no remaining trigger can be named. Today it is the mechanism that converts F-001 into a silent pass, and the leak is observable.",
    "suggested_fix": "Make the security and health catch arms `status: \"fail\"` with a constant detail, matching the review arm, and keep the error text out of the persisted string.",
    "evidence": "T35-probe-flowfold.ts C1, raw .metaproject/data/gdctx/raw/2026-09-06T14-16-56-663Z_run.log: an injected gate that throws yields {name:\"security\", status:\"skipped\", detail:\"security unavailable: T35-THROW-SENTINEL\"} with passed:true and leaksSentinel:true. T35-probe-residual.ts D3, raw 2026-09-06T14-18-21-503Z_run.log: the internal TypeError text lands in the persisted gate row.",
    "confidence": "high",
    "dedupe_key": "flow-gate-catch-arm-skipped-and-leaky",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true
  },
  {
    "id": "F-006",
    "global_id": "T35#F-006",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "info",
    "file": "src/security/guard.ts",
    "line": 1,
    "symbol": "module header",
    "problem": "The file header states the module's '#1 rule': advisory mode ONLY reports, it never blocks. The T33 mode-load catch at :156-163 returns allowed:false before isBlockingMode(mode) is consulted, so an advisory workspace whose config read fails is now refused. The behaviour is correct -- the posture is unknown and the inline comment at :151-155 argues the case -- but the header asserts an invariant the code no longer holds unconditionally.",
    "impact": "Documentation only, and unreachable today because loadSecurityConfig is total. Recorded so a later reader does not resolve the contradiction in the wrong direction.",
    "suggested_fix": "Amend the header to say advisory never blocks on a KNOWN posture, and name the posture-unknown exception.",
    "evidence": "T35-probe-mock.ts F1, raw .metaproject/data/gdctx/raw/2026-09-06T14-20-55-210Z_run.log: with the config loader broken, the advisory workspace returns allowed:false with reason \"security posture unavailable: check could not complete\".",
    "confidence": "high",
    "dedupe_key": "guard-header-advisory-never-blocks-stale",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-007",
    "global_id": "T35#F-007",
    "reviewer": "review-security-code+review-logic (T35 independent recheck)",
    "severity": "info",
    "file": "src/security/path-scan.ts",
    "line": 241,
    "symbol": "scanContainedPath (visit, scanned branch)",
    "problem": "Because rows now key on displayPath (the T34 repair), a symlink walked before its target carries the `scanned` row and the finding's path, while the real file's row reads `skipped: canonical identity already visited`. This is the intended direction of the fix and is truthful -- the reason states why -- but an operator grepping the report for the real path sees `skipped` for a file whose content was scanned.",
    "impact": "None on the gate: content is scanned exactly once, every encountered entry has a row, no duplicate or contradictory rows appear, and no path outside the owner root is exposed. Recorded so the next round does not rediscover the attribution as a defect.",
    "suggested_fix": "None required. If the report shape grows, an optional canonicalOf field on a duplicate-skip row would close the loop without changing the key.",
    "evidence": "T35-probe-scan.ts B1, raw .metaproject/data/gdctx/raw/2026-09-06T14-15-56-305Z_run.log lines 41-55: with the symlink sorted before its target, rows are corpus/a-link.env=scanned and corpus/z-real/creds.env=skipped (canonical identity already visited), zero duplicate paths, contents row matching the scanned row.",
    "confidence": "high",
    "dedupe_key": "path-scan-symlink-first-attribution",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  }
]
```
