STATUS: DONE_WITH_CONCERNS

## Independent Review: T27 (strict guard / flow-gate incomplete propagation) — security + logic

Reviewer: `review-security-code` + `review-logic` (combined, per dispatch `233-T30`). I did not
write T27. Every Stage 1 line below is backed by a probe I wrote and executed myself, not by
re-reading the implementer's `T27-implementation.md`/`T27-result.json` claims (those were read
only to know what to attack).

### Scope

- Repo root: `/Users/Goodea/goodea/keryx`
- Branch: `codex/agent-first-core`
- T27's change is uncommitted on this branch (`git log -- src/security/guard.ts` shows no T27
  commit); reviewed against the current working tree via `git diff HEAD -- src/security/guard.ts`.
- Files read in full: `src/security/guard.ts`, `src/security/guard.test.ts`,
  `src/security/service.ts`, `src/security/config.ts`, `src/security/types.ts`,
  `src/flow/service.ts` (gate-consumption section), `src/lib/fs.ts`, `src/lib/json.ts`,
  `src/lib/contained-path.ts`.
- SHA-256 (working tree, at review time):
  - `src/security/guard.ts` — `2a609bdc26298e2228de2633f45317dfce3dbb771281d18e755db946ef9f8ef0`
  - `src/security/guard.test.ts` — `314f614bab75b842d3d8383b82e45181a67226a1cde8378b5c46ad8f21b06493`
  - `src/security/service.ts` — `5ddf3732602c22706d66b93114c7714981dea30b8a8eebda9fa4134201bea9f4`
  - `src/security/config.ts` — `19a4cac9c1d6a90a2a228813e589de4a84d3069d45be66cf044c55550eb96862`
  - `src/security/types.ts` — `c46ec47c1f509e4c1bcc57b975f7dd892fa2315d77b92d7e65796444b34d3b2f`
  - `src/flow/service.ts` — `f27affa0bc2282d844265653e9f28c3528e23dfdf0726ce84b5c781fb479407f`

### Summary

- Blockers: 1
- Major: 1
- Minor: 0
- Info: 1

T27's own diff (the four changes described in `T27-implementation.md`) does exactly what it
claims: enforced/ci now block on `incomplete` engine evidence with a masked reason; advisory
keeps truthful `incomplete` diagnostics; `formatGuardWarning` surfaces `incomplete` even with
zero findings while still returning `null` for a genuine zero-finding pass; `securityFlowGate`
maps a stored `incomplete` report to `fail` and its `.gate()`-call catch branch returns a
constant `fail` instead of a leaking `skipped`. All of that is independently verified below with
fresh probes and is **Stage 1: MET on every criterion**.

The `DONE_WITH_CONCERNS` status is not about that diff. It is about the residual fail-open the
dispatch asked me to attack: the implementer disclosed one instance of it in `guardOutput`; I
reproduced that instance and found an undisclosed twin of the identical root cause in
`securityFlowGate`, plus a second, forward-looking gap in how `securityFlowGate` maps gate
statuses. See "Residual fail-open verdict" below — **F-001 is a blocker and T31 must close it
before phase acceptance.**

### Stage 1 table

| Criterion | Status | Evidence |
|---|---|---|
| (1) enforced/ci block on gate `incomplete` with a masked reason leaking no raw error, path or content | MET | `T30-probe-ac6-ac8.ts` Probe C, executed: `bun src/cli.ts ctx run -- bun run .../T30-probe-ac6-ac8.ts` → all 4 assertions pass, incl. `reason` not containing the workspace root and containing `"incomplete"`, not raw error text. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-31-45-118Z_run.log`. |
| (2) advisory keeps `allowed:true` and still carries truthful `incomplete` diagnostics | MET | Same run, Probe D: `allowed === true` and `decision.gate === "incomplete"`, both asserted true. Same raw log. |
| (3) `formatGuardWarning` reports `incomplete` even with zero findings; still `null` for a genuine zero-finding pass; shows a finding together with an `incomplete` gate | MET | `T30-probe-ac6-ac8.ts` Probes A/B — Probe A is a case **not present in the shipped `guard.test.ts` suite** (finding + `incomplete` gate combined, constructed directly rather than via the HMAC-key trick): message is non-null, contains `"incomplete"` and contains the finding's category `"secret"`. Probe B: genuine `{gate:"pass",findings:[]}` still returns `null`. Same raw log. |
| (4) `securityFlowGate` maps a stored `incomplete` report to `fail`; its catch branch returns a constant `fail` (not a leaking `skipped`); confirmed against `src/flow/service.ts` how each status is consumed | MET | Read `src/flow/service.ts` Gate 6 (lines ~646–663) and the pass/fail fold (`gates.every((gate) => gate.status !== "fail")`, line 672; `failed = gates.filter(status==="fail")`, line 689) directly — `pass` and `skipped` are **both** non-blocking, only `fail` blocks. This confirms T27's `skipped→fail` change for the `.gate()`-call catch branch was necessary: a `skipped` there would have silently passed flow completion, exactly the bug T27 exists to close. `guard.test.ts`'s own `"strict flow gate refuses incomplete security evidence"` test (stored `latest.json` with `gate:"incomplete"`) independently re-run below. |
| No security-relevant regression in the previously-passing 13 cases | MET | `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts` executed independently: **17 pass, 0 fail, 49 expect() calls** (13 pre-existing + 4 T27-added). Raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-32-43-492Z_run.log`. Combined selection `bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/security/service.memo.test.ts`: **39 pass, 1 fail** — the failure is `src/security/service.memo.test.ts:162`, confirmed unrelated to `guard.ts` (memo/fresh-service redaction expectation), matches the implementer's disclosed pre-existing failure exactly, owned by T29. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-32-46-815Z_run.log`. |
| Policy fold (policies.md): FAIL/INCOMPLETE/PASS ordering; strict CI accepts only PASS; reasons/details are constant and leak-safe | MET (for T27's own diff) | `policies.md` §"Health и security gate": "если есть установленное нарушение порога — FAIL; иначе если required check отсутствует/пропущен/не разобран/не завершён — INCOMPLETE; иначе PASS. ... Strict CI принимает только PASS." T27's four changes implement exactly this ordering for the engine-evidence-incomplete case. `guardReason`/`formatGuardWarning`'s incomplete branch and `securityFlowGate`'s `.gate()`-catch branch are read verbatim in source — both are string literals with no interpolation of `error`, `cwd`, or file content. See F-001 for why this MET verdict does **not** extend to the config-load failure path, which is a distinct, still-open gap. |

### Findings

#### [F-001] `loadSecurityConfig` failure silently defeats strict enforcement in two places, not one — the disclosed `guardOutput` fail-open has an undisclosed twin in `securityFlowGate`

- **Severity**: blocker
- **File**: `src/security/guard.ts:146` (disclosed) and `src/security/guard.ts:240` (undisclosed twin)
- **Attack vector**: An attacker (or an accidental corruption — a truncated write, a concurrent
  writer, a bad merge) that can write `.metaproject/security.config.json` to any syntactically
  valid but non-object JSON value (the minimal case: the four bytes `null`) causes
  `loadSecurityConfig(cwd)` to throw. That single trigger reaches two independent catch blocks in
  `guard.ts`, both of which resolve it toward the permissive/silent side regardless of the
  workspace's configured mode:
  1. `guardOutput`'s outer `catch` (line 146) returns `{ allowed: true, decision: ALLOW_DECISION }`
     — a secret is written through untouched, in a workspace configured `enforced`.
  2. `securityFlowGate`'s mode-load `catch` (line 240) `return null;` — indistinguishable from the
     *intentional* "security module disabled" `null` (line 233), except the module **is** enabled;
     it just could not determine its mode. `src/flow/service.ts`'s Gate 6
     (`if (deps.securityGate) { const security = await deps.securityGate(cwd); if (security) { gates.push(...) } }`)
     pushes nothing when `securityFlowGate` returns `null`, so the security gate is **entirely
     absent** from `gates` — not `"skipped"` (visible, non-blocking), not `"fail"` (blocking):
     silent non-participation. `gates.every((gate) => gate.status !== "fail")` never sees it.
- **Problem**: The implementer's own report (`T27-implementation.md`, "Concerns") disclosed only
  path (1) and explicitly scoped it out of T27 as a `service.ts`/`config.ts`-level decision. Path
  (2) — the same trigger reaching the same effective outcome one function over — was not
  mentioned and is not covered by any test. Root cause of the *trigger* itself:
  `mergeSecurityConfig(parsed)` in `src/security/config.ts` does `parsed.policies ?? {}` etc.
  without first checking that `parsed` is a non-null object; when `readJsonFileOr` successfully
  parses `null` (or any other non-object JSON — an array, a number, a bare string), the property
  access throws inside `loadSecurityConfig`, which the two `guard.ts` sites then swallow toward
  "everything is fine."
- **Why it matters**: This defeats the entire point of T27 (and of AC8/the policy fold) via a
  different door. AC8 requires "no required failed/incomplete check is relabeled PASS"; a config
  load failure IS a required check that is unparsed, per the policy fold's own wording ("INCOMPLETE
  when a required check is missing/skipped/unparsed/unfinished"), and both current handlers
  relabel it as an unconditional pass (path 1) or as complete non-existence (path 2) instead. The
  mandatory `validateSerializedOutput` floor that runs before this code path is a **format**
  floor only — it does not detect secrets — so it does not mitigate this; the probe below shows a
  planted AWS-shaped key passing straight through in a nominally-enforced workspace.
- **Reproduction**: `T30-probe-failopen.ts`, executed via
  `bun src/cli.ts ctx run -- bun run .../T30-probe-failopen.ts`. Fixture: `.metaproject/metaproject.json`
  with `security.enabled: true`, `.metaproject/security.config.json` containing the 4 bytes
  `null`. Confirmed: `loadSecurityConfig(root)` throws (`TypeError: Cannot read properties of
  null (reading 'policies')` or equivalent); `guardOutput({cwd: root, content: "aws_key =
  AKIAABCDEFGHIJKLMNOP", target: "memory"})` → `allowed: true`, `decision.gate: "pass"`;
  `securityFlowGate(root)` → `null`. All 4 assertions in the script pass (i.e., the fail-open
  reproduces on demand). Raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-32-10-423Z_run.log`.
- **Fix**:
  1. Root-cause hardening, `src/security/config.ts::loadSecurityConfig` — validate the parsed
     value is a non-null plain object before calling `mergeSecurityConfig`; otherwise fall back to
     `mergeSecurityConfig({})`, exactly mirroring the function's own existing contract for
     malformed JSON ("Malformed JSON also falls back to defaults so the module keeps operating").
     This closes the concrete trigger without touching `guard.ts` at all.
  2. Behavioral hardening for the residual "config genuinely cannot be read for some other
     reason" case, `src/security/guard.ts`:
     - `guardOutput`'s catch (~line 144–146) must not return `ALLOW_DECISION` unconditionally —
       it currently applies regardless of the (unknown, because unloadable) mode. At minimum,
       surface `gate: "incomplete"` on the returned decision, consistent with how engine-evidence
       `incomplete` is already handled post-T27, rather than defaulting straight to `pass`.
     - `securityFlowGate`'s mode-load catch (~line 240) must not return the same `null` value
       used for "module disabled" — it should return a `fail`-shaped result (matching the
       `.gate()`-call catch two branches below, which T27 already fixed for exactly this reason)
       so `src/flow/service.ts` Gate 6 actually records a blocking, non-echoing entry instead of
       silent non-participation.
  - Owner file for both: `src/security/config.ts` (part 1) and `src/security/guard.ts` (part 2).
- **class_scope**:
  ```yaml
  class_scope:
    sites: ["src/security/guard.ts:146", "src/security/guard.ts:240"]
    enumeration_method: "grep for loadSecurityConfig( call sites in guard.ts (`bun src/cli.ts ctx rg loadSecurityConfig src/security/guard.ts`) — 2 non-import matches (line 137 inside guardOutput, line 238 inside securityFlowGate) — then traced each to its enclosing catch block. No third call site exists in this file."
  ```

#### [F-002] `securityFlowGate`'s status mapping is a two-value ternary, not exhaustive over `SecurityGate` — it already silently reads a stored `needs-approval` decision as `pass`, and will keep doing so once `runGate` (T33) is fixed to surface that status distinctly

- **Severity**: major
- **File**: `src/security/guard.ts:253`
- **Problem**: `SecurityGate` (`src/security/types.ts:68`) is
  `"pass" | "needs-approval" | "incomplete" | "fail"` — four values. `securityFlowGate` maps the
  result of `createSecurityService(cwd).gate({cwd})` (i.e. `runGate`) with:
  ```ts
  return result.status === "fail" || result.status === "incomplete"
    ? { status: "fail", detail }
    : { status: "pass", detail };
  ```
  This is a two-value allowlist with an implicit "everything else → pass" default — the same
  shape of fold that the dispatch names as T33's finding one layer down in `runGate` itself
  (`runGate` today folds only `fail`/`incomplete` out of the stored report's `gate`; a stored
  `needs-approval`, a missing `gate` field, or an unrecognized string all fall through to its own
  `{status:"pass"}` default). I did not review or touch `runGate` (T33 is out of my scope per the
  dispatch), but `securityFlowGate`'s own mapping has the identical defect, independently of
  `runGate`'s.
- **Why it matters**: `T30-probe-exhaustive-mapping.ts` demonstrates the propagation live, with
  TODAY's `runGate`: a stored `latest.json` with `gate: "needs-approval"` (a real, typed
  `SecurityGate` value, not synthetic) in an `enforced`-mode workspace produces
  `securityFlowGate(cwd) → { status: "pass", detail: "security gate: needs-approval" }` — the
  `detail` string is truthful (it names `needs-approval`), but the `status` used by
  `gates.every((gate) => gate.status !== "fail")` says `pass`. This is currently caused by
  `runGate`'s own fold (T33's finding, not mine to fix). The reason it belongs in **this** review:
  the dispatch specifically asks whether `guard.ts` "would still behave correctly once `runGate`
  starts returning the additional statuses `needs-approval` and `incomplete`" — and the answer is
  **no**. If T33's fix makes `runGate` literally return `status: "needs-approval"` as its own
  distinct value (rather than silently folding it into `fail`/`incomplete` internally), this
  ternary's fallback arm will keep silently coercing it to `"pass"`, because it was never written
  to recognize that value. Landing T33 alone, without a matching change here, would not close the
  gap it is meant to close — it would just move the silent-pass one call frame up, into code T33 does not own.
- **Reproduction**: `T30-probe-exhaustive-mapping.ts`, executed via
  `bun src/cli.ts ctx run -- bun run .../T30-probe-exhaustive-mapping.ts`. Fixture: `enforced`
  mode, `latest.json` with `{"gate":"needs-approval","findings":[]}`. Observed:
  `runGate({cwd}) → status:"pass"`; `securityFlowGate(cwd) → status:"pass",
  detail:"security gate: needs-approval"`. Raw log:
  `.metaproject/data/gdctx/raw/2026-09-06T13-32-33-942Z_run.log`.
- **Fix**: Replace the ternary at `guard.ts:253` with an exhaustive mapping (switch or explicit
  `if`-chain) over every value `runGate`/`SecurityGate` can produce — `pass → pass`,
  `needs-approval → fail` (or a distinct blocking status, per whatever AC/UX T33 defines for
  human-approval flows — at minimum never `pass`), `incomplete → fail`, `fail → fail`, and an
  unrecognized/future value defaulting to `fail`, never `pass`. Land this together with, or
  before, T33's `runGate` fix so the two changes do not reopen the same class of gap in sequence.
  Owner file: `src/security/guard.ts`.
- **class_scope**:
  ```yaml
  class_scope:
    sites: ["src/security/guard.ts:253"]
    enumeration_method: "grep for 'result.status ===' in guard.ts (`bun src/cli.ts ctx rg 'result.status ===' src/security/guard.ts`) — 1 match, the entire status-mapping expression inside securityFlowGate. No other status-fold exists in this file (guardOutput's blocking condition at line ~151 is a 3-value allowlist over the full SecurityGate union and IS exhaustive: fail, needs-approval and incomplete all block, and pass is the only remaining value — verified by reading src/security/types.ts:68 against the condition)."
  ```

#### [F-003] Two comments adjacent to the fail-open mislabel its scope (pre-existing, not introduced by T27)

- **Severity**: info
- **File**: `src/security/guard.ts:145`, `src/security/guard.ts:220`
- **Problem**: `guard.ts:145` reads `// Advisory-safe: an engine error must not break the caller.`
  directly above the catch discussed in F-001, but the catch it labels applies unconditionally —
  including in `enforced`/`ci` mode, since `mode` itself is loaded inside the same `try`. Calling
  it "Advisory-safe" implies the fallback is scoped to advisory (non-blocking-by-design) mode,
  when it actually silently overrides enforced/ci too. Separately, `guard.ts:220`'s doc comment
  for `securityFlowGate` says it "Returns `null` to OMIT the gate entirely when the module is
  disabled" — true for the `isSecurityEnabled` check (line 233) but not for the second `null`-return
  path this review found at line 240 (module enabled, config load failed), which the comment does
  not acknowledge.
  Confirmed via `git diff HEAD -- src/security/guard.ts`: both lines are unchanged context in
  T27's diff, i.e. pre-existing, not something T27 introduced or was asked to fix.
  Raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-27-03-615Z_run.log`.
- **Why it matters**: No independent runtime effect (comments don't execute), but the
  "Advisory-safe" label is plausibly part of why the guardOutput fail-open went unnoticed until
  now — a maintainer scanning the mode-blocking logic below would reasonably assume this catch
  only applies when nothing was going to block anyway.
- **Fix**: When F-001 is addressed, update both comments to describe the actual (fixed) scope —
  no separate task needed; fold into T31.

### Residual fail-open verdict

**T31 must close F-001 before phase acceptance.** It is not a hypothetical: `T30-probe-failopen.ts`
reproduces it on demand with a single 4-byte config file, in a workspace nominally configured for
`enforced` mode, and it defeats *both* the write-time guard and the flow-completion gate — not
degraded diagnostics, complete silent bypass with zero trace. Under the canonical severity rubric
this is shape 3 (an exploitable vulnerability with a named entry point —
`.metaproject/security.config.json` — and a named impact — total, silent disablement of the
secret/PII/prompt-injection floor above the mandatory format-only floor). AC8 says "no required
failed/incomplete check is relabeled PASS"; a config-load failure is exactly the "unparsed
required check" the policy fold assigns to INCOMPLETE, and both current handlers relabel it PASS
(`guardOutput`) or silently omit it (`securityFlowGate`) instead.

The implementer was right to flag this as out of `guard.ts`-only scope for T27 — it does need a
`config.ts` decision (part 1 of the fix above) as well as a `guard.ts` one (part 2) — but the
scope is larger than what was disclosed: it is two call sites in `guard.ts` sharing one root
trigger in `config.ts`, not one call site. **Minimal change, by owner file:**
- `src/security/config.ts` — `loadSecurityConfig` must not throw on non-object-but-valid JSON;
  fall back to defaults exactly as it already does for malformed JSON.
- `src/security/guard.ts` — `guardOutput`'s outer catch (line 146) and `securityFlowGate`'s
  mode-load catch (line 240) must not resolve toward "everything is fine" for a genuine load
  failure; both should read as `incomplete`/`fail`, not `pass`/`null`.

Partial acceptance (T27 alone, `guard.ts`'s specific incomplete-propagation behavior) is correctly
`met` — see the Stage 1 table — but per AC8's own text ("partial acceptance is not full phase
completion"), this residual gap sits squarely inside what AC8 requires closed for the phase.

### `securityFlowGate` and the coming `runGate` statuses

**No — `guard.ts` needs a matching exhaustive mapping, and does not have one today.** See F-002.
`guardOutput`'s own blocking condition (the 3-way `||` over `fail`/`needs-approval`/`incomplete`)
*is* exhaustive against `SecurityGate`'s 4 values and needs no change. `securityFlowGate`'s
status mapping is a 2-value ternary with an implicit default and is not. I verified this live
against today's `runGate` (which does not yet distinguish `needs-approval` — that is T33's
finding, not mine) and confirmed the propagation gap already exists end-to-end for that value; it
will persist for whatever new status shape T33 introduces unless `guard.ts:253` is rewritten as
an exhaustive mapping in the same change or immediately after.

### Confirmed clean areas

- **Import boundary**: `guard.ts` imports only `node:path`, `../lib/fs`, `../lib/json`,
  `./config`, `./service`, `./types` — no import from memory/wiki/testing/gdctx/flow, confirmed
  by `bun src/cli.ts ctx rg "^import" src/security/guard.ts`. Acyclic seam intact.
- **Regression-free**: 17/17 `guard.test.ts` tests pass (independently re-run); combined
  selection with `persistence-sinks.test.ts`/`service.memo.test.ts` is 39/40 with the one failure
  independently confirmed pre-existing and unrelated (T29-owned).
- **Lint/typecheck**: `bunx eslint src/security/guard.ts src/security/guard.test.ts` — clean, no
  output. `bun run typecheck` (`tsc --noEmit`) — clean, exit 0.
- **`formatGuardWarning` label is not attacker-reachable**: all 3 non-test call sites
  (`src/memory/write.ts:99`, `src/testing/coverage-map.ts:242`, `src/testing/service.ts:165`)
  pass a literal string (`"memory"`, `"testing"`), confirmed via
  `bun src/cli.ts ctx rg "formatGuardWarning\(" src`. No finding.
- **T27's four changes, independently probed**: enforced/ci block on incomplete evidence with a
  masked reason (probe C); advisory keeps `allowed:true` with truthful diagnostics (probe D);
  `formatGuardWarning` shows a finding + `incomplete` together, a case the shipped test suite
  does not cover (probe A); genuine zero-finding pass still `null` (probe B). All via freshly
  built fixtures independent of `guard.test.ts`'s own `makeWorkspace` helper.
- **`securityFlowGate`'s stored-`incomplete`→`fail` mapping and the `.gate()`-call catch's
  constant string**: read directly in source, both are literal strings with no interpolation of
  `error`, `cwd`, or file content — matches AC8/policy fold leak-safety requirement for the
  scenarios T27 actually covers (as opposed to the config-load path in F-001).

### Evidence

| Ref | Path |
|---|---|
| Probe 1 script | `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T30-probe-ac6-ac8.ts` |
| Probe 1 raw log | `.metaproject/data/gdctx/raw/2026-09-06T13-31-45-118Z_run.log` |
| Probe 2 script | `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T30-probe-failopen.ts` |
| Probe 2 raw log | `.metaproject/data/gdctx/raw/2026-09-06T13-32-10-423Z_run.log` |
| Probe 3 script | `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T30-probe-exhaustive-mapping.ts` |
| Probe 3 raw log | `.metaproject/data/gdctx/raw/2026-09-06T13-32-33-942Z_run.log` |
| `guard.test.ts` independent re-run (17/17) | `.metaproject/data/gdctx/raw/2026-09-06T13-32-43-492Z_run.log` |
| Combined selection re-run (39/1 pre-existing) | `.metaproject/data/gdctx/raw/2026-09-06T13-32-46-815Z_run.log` |
| `git diff HEAD -- src/security/guard.ts` (T27's actual diff) | `.metaproject/data/gdctx/raw/2026-09-06T13-27-03-615Z_run.log` |
| `git log --oneline -- src/security/guard.ts` | `.metaproject/data/gdctx/raw/2026-09-06T13-26-58-599Z_run.log` |
| `flow/service.ts` Gate 6 + pass/fail fold read | `.metaproject/data/gdctx/raw/2026-09-06T13-27-20-160Z_run.log` and `.metaproject/data/gdctx/raw/2026-09-06T13-27-26-527Z_run.log` |
| `eslint` clean | `.metaproject/data/gdctx/raw/2026-09-06T13-32-58-854Z_run.log` |
| `tsc --noEmit` clean | `.metaproject/data/gdctx/raw/2026-09-06T13-33-11-391Z_run.log` |
| SHA-256 of reviewed files | `.metaproject/data/gdctx/raw/2026-09-06T13-35-22-989Z_run.log` |

### Routing audit

- `graph_used`: not-relevant — single-module targeted review with an explicit dispatch and file
  list (`files_to_read`); no structural/blast-radius question was in scope.
- `wiki_used`: not-relevant — the dispatch supplied the authoritative context directly
  (`T27-spec.md`, `T27-implementation.md`, `policies.md`, `acceptance-criteria.md`); no separate
  wiki concept lookup was needed.
- `ctx_used`: yes — every read via `bun src/cli.ts ctx read`, every search via
  `bun src/cli.ts ctx rg`, every shell command (including the three probe scripts, `bun test`,
  `eslint`, `tsc`, `shasum`, `git diff`, `git log`) via `bun src/cli.ts ctx run --`.
- `raw_rg_used`: no.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T30#F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/guard.ts",
    "line": 146,
    "symbol": "guardOutput",
    "problem": "loadSecurityConfig(cwd) throws on any non-object-but-valid JSON config (e.g. the file containing literally `null`); guardOutput's outer catch (line 146) then unconditionally returns { allowed: true, decision: ALLOW_DECISION } regardless of configured mode, and securityFlowGate's separate mode-load catch (line 240) returns null -- indistinguishable from the intentional 'module disabled' null -- causing src/flow/service.ts Gate 6 to omit the security gate entirely rather than fail or skip it visibly. The implementer disclosed only the guardOutput half of this; the securityFlowGate half is undisclosed and untested.",
    "impact": "A corrupted or foreign-written .metaproject/security.config.json silently disables the entire secret/PII/prompt-injection detection floor for every guardOutput caller (memory, wiki, testing, gdctx, flow writes) in a workspace configured for strict enforcement, AND silently removes the security check from flow-completion gating -- with zero trace in either case. Reproduced live: a planted AWS-shaped secret passes guardOutput with allowed:true, decision.gate:'pass' under this trigger in a nominally-enforced workspace.",
    "suggested_fix": "Root cause in src/security/config.ts::loadSecurityConfig -- validate the parsed JSON is a non-null object before merging; fall back to mergeSecurityConfig({}) exactly as already done for malformed JSON. Additionally, in src/security/guard.ts: guardOutput's catch (~146) must not default to ALLOW_DECISION unconditionally (surface gate:'incomplete' instead), and securityFlowGate's mode-load catch (~240) must not return the same null used for 'module disabled' -- it should return a fail-shaped result like the sibling .gate()-call catch two branches below.",
    "evidence": "T30-probe-failopen.ts, executed via bun src/cli.ts ctx run -- bun run .../T30-probe-failopen.ts; raw log .metaproject/data/gdctx/raw/2026-09-06T13-32-10-423Z_run.log. All assertions pass, confirming the trigger and both fail-open outcomes reproduce on demand.",
    "confidence": "high",
    "dedupe_key": "guard-ts-loadsecurityconfig-failopen",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": ["src/security/guard.ts:146", "src/security/guard.ts:240"],
      "enumeration_method": "grep for loadSecurityConfig( call sites in guard.ts (bun src/cli.ts ctx rg loadSecurityConfig src/security/guard.ts) -- 2 non-import matches (line 137 inside guardOutput, line 238 inside securityFlowGate), each traced to its enclosing catch block. No third call site exists in this file."
    }
  },
  {
    "id": "F-002",
    "global_id": "T30#F-002",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/security/guard.ts",
    "line": 253,
    "symbol": "securityFlowGate",
    "problem": "securityFlowGate maps createSecurityService(cwd).gate({cwd})'s result with a two-value ternary (result.status === \"fail\" || result.status === \"incomplete\" ? fail : pass) that is not exhaustive over SecurityGate (\"pass\"|\"needs-approval\"|\"incomplete\"|\"fail\", src/security/types.ts:68). A stored report with gate:\"needs-approval\" is read as pass end-to-end today (via runGate's own fold, tracked separately as T33), and guard.ts's own mapping provides no distinct branch for it either -- so fixing runGate alone (T33) will not close the gap unless guard.ts is given a matching exhaustive mapping.",
    "impact": "Once T33 makes runGate surface 'needs-approval' (or a broadened 'incomplete') as its own literal status, securityFlowGate's ternary will keep silently coercing it to 'pass' for flow-completion purposes, reproducing the same class of fail-open one call frame up, in code T33 does not own and would not fix.",
    "suggested_fix": "Replace the ternary at guard.ts:253 with an exhaustive switch/if over every runGate/SecurityGate status value, with an unrecognized/future value defaulting to fail (never pass). Land together with or before T33's runGate fix.",
    "evidence": "T30-probe-exhaustive-mapping.ts, executed via bun src/cli.ts ctx run -- bun run .../T30-probe-exhaustive-mapping.ts; raw log .metaproject/data/gdctx/raw/2026-09-06T13-32-33-942Z_run.log. Live demonstration: stored gate:'needs-approval' report in enforced mode -> runGate status:'pass' -> securityFlowGate status:'pass', detail:'security gate: needs-approval' (truthful detail, wrong/non-blocking status).",
    "confidence": "high",
    "dedupe_key": "guard-ts-securityflowgate-nonexhaustive-mapping",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": ["src/security/guard.ts:253"],
      "enumeration_method": "grep for 'result.status ===' in guard.ts (bun src/cli.ts ctx rg 'result.status ===' src/security/guard.ts) -- 1 match. guardOutput's own blocking condition (~line 151) was checked separately and confirmed exhaustive (3-way OR covering fail/needs-approval/incomplete against the 4-value SecurityGate union, with pass as the sole remaining default) -- not part of this class."
    }
  },
  {
    "id": "F-003",
    "global_id": "T30#F-003",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/security/guard.ts",
    "line": 145,
    "symbol": "guardOutput",
    "problem": "The comment '// Advisory-safe: an engine error must not break the caller.' at guard.ts:145 mislabels its catch's scope -- it applies unconditionally (including enforced/ci), not just to advisory mode, since mode itself is loaded inside the same try. guard.ts:220's securityFlowGate doc comment says null is returned 'when the module is disabled' but does not mention the second null-return path (module enabled, config load failed) this review found at line 240.",
    "impact": "No independent runtime effect. Documentation-only, but plausibly contributed to F-001 going unnoticed: a maintainer scanning the blocking logic would reasonably assume this catch is scoped to non-blocking mode only.",
    "suggested_fix": "Update both comments when F-001 is fixed to describe the corrected scope; no separate task needed.",
    "evidence": "git diff HEAD -- src/security/guard.ts, raw log .metaproject/data/gdctx/raw/2026-09-06T13-27-03-615Z_run.log -- both lines are unchanged context, confirming pre-existing scope, not introduced by T27.",
    "confidence": "high",
    "dedupe_key": "guard-ts-stale-advisory-safe-comment",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  }
]
```
