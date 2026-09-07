STATUS: DONE_WITH_CONCERNS

# T10 — Phase 0 aggregate acceptance review (flow 232)

## Scope

Aggregate acceptance verdict for flow 232 (agent-first-core phase 0), covering norm
M01 (routing entrypoint lifecycle) and norm M10 (benchmark/budget correctness),
against the six frozen criteria in
`/Users/Goodea/goodea/keryx/.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/acceptance-criteria.md`.

- Project root: `/Users/Goodea/goodea/keryx`, branch `codex/agent-first-core`, entirely uncommitted.
- Reviewer implemented none of this work and reviewed no task of it before now.
- Prior artifacts (`T9`, `T15`, `T16-final`, `T20`, `T21`) were read as **claims**. Every
  criterion below carries a check this reviewer executed on the current tree.
- Read-only on all production, test and documentation files. Writes limited to
  `T10-review.md`, `T10-result.json`, `T10-budget-probe.ts`, `T10-scripts-typecheck-probe.ts`.
- No git state change, no flow state change, no dependency change, no `bun test` without
  file arguments, no network, no provider call. The two probes use deterministic
  in-memory providers only.
- Out of scope by construction: `src/security/detect/exfil.ts` (another reviewer holds it,
  read-only, and it belongs to phase 1), and the full-suite `bun test` number, which the
  dispatch forbids me from reproducing.

## Summary by severity

| Severity | Count |
|---|---|
| blocker | 0 |
| major | 0 |
| minor | 2 |
| info | 1 |

Both minors are **evidence-quality** defects under AC6, not code defects. No code finding
was raised: the M01 writer and the M10 budget work are correct on the tree as it stands, and
I could not construct a failing case against either. Five of the six criteria are MET on my
own executed evidence. AC6 is NOT MET, for two recorded reasons and one sequencing reason,
all of which are documentation-only work.

## Criterion table

| # | Criterion (abridged) | Verdict | Evidence I executed |
|---|---|---|---|
| AC1 | M01: init / rules sync / rules distill / update and repeated sequences preserve a short index plus full routing document through a shared writer; module/security flags and user-owned entrypoint blocks preserved | **MET** | `src/lib/routing-entrypoint.ts:18` `writeRoutingEntrypointPair` is the **only** writer of `.metaproject/index.md` — enumerated with `keryx ctx rg '"index\.md"'` over `src/**/*.ts` excluding tests: 7 files match, and the six non-writer matches are `wiki/service.ts`, `rules/distill.ts` (a different path, `rules/entrypoints/index.md`), `ctx/orient.ts` (read), `update.ts:655`/`:955` (dashboard doc collection, read-only), `standard/validate.ts`+`standard/profiles.ts` (required-file lists), `harness/tool/metaproject-adapter.ts` (wiki read), `templates.ts:685` (a label). All three consumers call it: `init.ts:730`, `update.ts:299`, `rules.ts:150`. I ran `src/commands/routing-entrypoint-lifecycle.test.ts` + `rules.test.ts` + `update.test.ts` + `templates.test.ts`: **29 pass / 0 fail**, and in the wider set below. The lifecycle fixtures assert `firstSync === initialized`, `secondSync === firstSync`, `secondDistill === firstDistill`, `updated === secondDistill` (idempotence across all four writers and repeats), `<!-- user-owned:begin -->` occurring exactly once, the user sentence surviving, and flag fidelity (`gdctx`/`security` present in `routing.md`, `gdgraph` absent) driven by `metaproject.json` |
| AC2 | M01: orient/catalog and related consumers resolve the split entrypoint; regression fixtures assert ownership of both documents; failed pair publication is observable and recoverable on rerun without a false success | **MET** | Same run. `routing-entrypoint-lifecycle.test.ts:114` asserts `metaprojectIndexContext(root)` contains `routing.md`; `:115` asserts the bundled `metaproject-router` skill workflow points at `.metaproject/routing.md`; `src/ctx/orient.ts:41` gates on `compactIndex.includes("routing.md")`. `assertRoutingOwnership` (`:188`) is a real two-document ownership assertion: index < 2000 bytes, contains the pointer and the two routed-tool lines, and **must not** contain `## Enabled Modules` or `## Intent Router`, which must appear in `routing.md`. The recovery case (`:127`) makes `routing.md` a directory so `writeFileAtomic` fails, asserts `rulesCommand` **throws** (no false success), then reruns cleanly after the obstruction is removed and re-asserts full ownership. I also confirmed the lock is not a recovery trap: `withFileLock` (`src/lib/fs.ts:49`) has `removeStaleLock` plus a heartbeat, so a crash mid-publication does not wedge the rerun |
| AC3 | M10: offline stub proves the actual configured round/call budget stops execution with a truthful terminal reason; `maxToolCalls` never silently ignored or represented by `maxRounds` | **MET** | **My own probe**, `T10-budget-probe.ts`, written from scratch (not a rerun of `T16-final-core-budget-probe.ts` or `T21-terminal-reason-probe.ts`): **10/10 cases pass**. C1 `maxRounds:3` against an endlessly tool-calling model → exactly **3** provider requests, `finishReason: budget`, reason `budget_exhausted`. C2 `maxRounds:0` → **0** provider requests. C3 attended, no picker → 2 requests at `maxRounds:2`, no extra request. C4 the no-progress wrap-up **is inside** the ceiling: 5 requests under `maxRounds:6`. C5 two tool calls in ONE round with `maxToolCalls:1`, `maxRounds:10` → **1** invocation, 1 provider request, 9 rounds still unspent, reason `tool_call_budget_exhausted` — the call cap is not the round cap wearing a different name. C6 cap 3 across rounds → 3 invocations, 3 requests, 17 rounds unspent. C7 `maxToolCalls:0` → 0 invocations, and the cap is not silently dropped. C8 no cap configured → the tool budget never fires. C9 a stop with **16 rounds and 47 calls remaining** reports `no_progress`, not `budget_exhausted`. C10 `maxToolCalls:-1` throws `RangeError: maxToolCalls must be a non-negative safe integer` rather than being dropped. Child side: `spawn-subagent-tool.ts:841` passes `maxToolCalls` **separately** from `maxRounds` into `AgentDeps`, `:485` clamps `max_rounds` with `Math.min(MAX_SUBAGENT_MAX_ROUNDS=24, …)`, and `:1216-1218` reports the clamped `rounds≤` and the real `calls≤` back to the parent |
| AC4 | M10: stress JSON creation uses an existing resolver and writes a report in the offline fixture; optional containment port handled with no unsafe default | **MET** | I ran the stress harness myself, offline: `KERYX_AGENT_MAX_ROUNDS=9 bun scripts/stress/keryx-shell-stress.ts --only M4 --out <scratch>` → exit 0, one `stress-*.json` written, `"maxRounds": 9` (the env-driven `resolveAgentMaxRounds()` value, not a literal), **no `maxToolCalls` key**, `"allowEgress": false`. `resolveAgentMaxToolCalls` does not exist anywhere in the repo (`keryx ctx rg`: 0 matches); `resolveAgentMaxRounds` is exported at `src/commands/agent.ts:388` and consumed at `keryx-shell-stress.ts:33,998,1030`. Containment: `scripts/benchmark/run-containment.ts:114` `resolveContainmentPort` **throws** `RangeError` on `undefined`/non-integer/out-of-range and has no `?? 0` fallback; `:375` is the single call site, replacing the bare `canaryServer.port`. `scripts/benchmark/run-containment.test.ts` + `scripts/stress/keryx-shell-stress.test.ts` + `scripts/typecheck.test.ts`: **5 pass / 0 fail** |
| AC5 | M10: a scripts TypeScript check covers the benchmark/stress scripts and fails on an injected type error; root and scripts checks pass without external model calls | **MET** | The committed `scripts/typecheck.test.ts` proves coverage and the injected error **separately** (the injected `TS2322` lands in a *new* file under a config that merely `extends` the scripts target), so I closed the gap with **my own probe**, `T10-scripts-typecheck-probe.ts`: it resolves `tsconfig.scripts.json` through the TypeScript API (26 files), confirms all four entrypoints are in the resolved set, compiles clean (0 diagnostics), then injects `const t10InjectedTypeError: number = "M10";` into the **real** `scripts/stress/keryx-shell-stress.ts` and `scripts/benchmark/run-containment.ts` **through an in-memory compiler host overlay** — the working tree is never modified — and each yields exactly one `TS2322` **attributed to that script**. 4/4 pass. `bun run typecheck` exit 0 and `bun run typecheck:scripts` exit 0, both run by me just now. No provider or network call in any of it |
| AC6 | Focused regressions and integration checks have current immutable evidence; independent code-verifier/review report no unresolved blocker/major/minor findings; phase delivery accurately records remaining AFC-16/21 scope | **NOT MET** | Three separate reasons, none of them a code defect. (a) **[F-001]** the T9 integration record misattributes the health gate's blocking findings to one package when they span seven — my own read of the artifact contradicts the recorded prose. (b) **[F-002]** the load-bearing full-suite result (7100 pass / 18 skip / 0 fail across 579 files) exists **only as prose in `journal.md`**: no gdctx raw log in the 20:00–20:14Z window belongs to it, the testing module's `latest.json` is from 15:13, and the health artifact's own `tests` source is `missing / not-run`. The lint and typecheck halves of that table **do** have immutable logs (`.metaproject/data/health/raw/{eslint,typescript}/2026-09-06T20-11-30-148Z.log`) and I re-ran both to exit 0; the suite number has neither a log nor, under this dispatch, a permitted rerun. (c) the delivery record of remaining AFC-16/21 scope is task **T11**, which is `pending` and depends on this review — by design, so the criterion cannot yet be satisfied. The **findings** half of AC6 is otherwise clean: T15 = 0/0/0, T21 = 0 findings, T16-final's 1 major + 3 minor are all closed and verified by me below, and the two T9 blockers are fixed on the current tree |

## Findings

### [F-001] The T9 integration record attributes all blocking health advisories to one package; they span seven

- **Severity**: minor
- **File**: `.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/journal.md` (entry `2026-09-06T20:12:54Z`)
- **Problem**: The record states that all 14 P0 findings are dependency advisories on the
  transitive package `fast-uri`, and that a further 13 P1 and 1 P2 come "from the same
  source". Reading the artifact the record describes
  (`.metaproject/data/health/artifacts/latest.json`, `generated_at 2026-09-06T20:11:46.622Z`,
  the same run the record cites), the counts are right — 14 P0, 13 P1, 244 P2 — but the
  attribution is not. The 27 blocking-priority findings carry **seven distinct** package
  symbols: `fast-uri` (6× P0), `protobufjs` (6× P0 + 5× P1), `sharp` (1× P0),
  `ip-address` (1× P0 + 2× P1), `hono` (3× P1), `@hono/node-server` (1× P1), `qs` (2× P1).
  The single P2 dependency advisory is `hono`, not `fast-uri`.
- **Why it matters**: The record does not stop at the number — it builds an argument on the
  attribution ("the vulnerability classes in `fast-uri` are literally the ones phase 1 closed
  in its own detector") and uses it to justify the phase-8 priority. A reader planning the
  phase-8 dependency refresh from this record would scope one package and find seven, six of
  the fourteen P0 advisories being in a package the record never names. The material claim
  the acceptance actually rests on is unaffected and I confirmed it independently: **every one
  of the 27 blocking findings has `source: "dependencyAudit"` and `file: "package.json"`, and
  the count of blocking-priority product-code findings is exactly 0**.
- **Fix**: Append a correction to the flow journal naming the seven packages and their
  counts, and carry the corrected inventory into the T11 delivery record and the phase-8
  hand-off. No code change.
- **Evidence**: `keryx ctx run -- bun -e '<group latest.json findings by priority/source/file/symbol>'` →
  `{"gate":"fail","p0":14,"p1":13,"p2":244,"blocking_sources":["dependencyAudit"],"blocking_files":["package.json"],"blocking_by_symbol":{"P0:fast-uri":6,"P0:protobufjs":6,"P0:sharp":1,"P0:ip-address":1,"P1:protobufjs":5,"P1:hono":3,"P1:ip-address":2,"P1:qs":2,"P1:@hono/node-server":1},"product_code_blocking":0}`.
  Raw: `.metaproject/data/gdctx/raw/2026-09-06T20-28-19-864Z_run.log`.

### [F-002] The full-suite integration result has no immutable evidence, only journal prose

- **Severity**: minor
- **File**: `.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/journal.md` (entry `2026-09-06T20:12:54Z`, row `bun test`)
- **Problem**: AC6 requires the integration checks to have *current immutable evidence*, and
  this flow's own `context.md:13` set the rule: "immutable per-worker report paths so latest
  report races do not replace evidence". The `bun test` row — **7100 pass / 18 skip / 0 fail,
  54038 assertions, 7118 tests in 579 files, 199 s** — has no artifact behind it. There is no
  gdctx raw log for it (`.metaproject/data/gdctx/raw/` holds five `run` logs between 20:00 and
  20:12Z and all five belong to flow 233's T76); `.metaproject/data/testing/artifacts/latest.json`
  is dated 15:13, before the run; and the health artifact cannot stand in for it because its
  own `tests` source is recorded `status: missing, execution: not-run`. T9's attempt-3 wrote no
  result artifact at all — `T9-result.json` in this directory is from attempt 1/2 at 15:33.
- **Why it matters**: This is the single most load-bearing claim in the phase, and it is the
  one an auditor cannot check. The rest of the same table is fine — `eslint` and `typescript`
  have immutable timestamped raws from the 20:11:30Z health run and I re-executed both to
  exit 0 — so the gap is specific, not general. It is also the class of gap this phase's own
  history argues about: three times an implementer's claim about an artifact was false while
  the returned value was right, and prose is exactly the form in which that happens.
- **Fix**: Rerun the full suite once through `keryx ctx run` (or `keryx test`) so an immutable
  raw log exists, and cite that path in the journal and in T11 beside the numbers. If a rerun
  is not wanted before delivery, T11 should say plainly that the suite figure rests on an
  unlogged run. No code change.
- **Evidence**: `ls .metaproject/data/gdctx/raw/ | grep -E "^2026-09-06T20-(0|1[0-2])"` returns five
  files, each read and identified as flow 233 T76 output (manifest-pin JSON probes, a 58-test
  single-file run, an eslint ignore-warning capture). `find .metaproject -newermt '2026-09-07 00:05' ! -newermt '2026-09-07 00:14'`
  lists only the two flow journals/flow.json, the health artifacts/history/raws, and flow 233
  artifacts — no test report. `.metaproject/data/health/artifacts/latest.json` sources array:
  `{"s":"tests","req":false,"st":"missing","ex":"not-run","p":"not-run"}`.

### [F-003] The phase 0 diff carries work outside M01/M10 that no criterion names

- **Severity**: info
- **File**: `.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/plan.md`
- **Problem**: The frozen criteria describe M01 and M10 only, but the phase actually shipped
  four more strands: T12/T13 (description-based worker dispatch — the
  `task-implementer-input-contract` schema plus ten worker prose builds, mirrored across
  `.metaproject/core/`, `.metaproject/skills/` and `src/gdskills/bundled/`), T17 (introducing
  ESLint: `eslint.config.mjs`, `package.json` scripts and devDependencies, `check` now gating
  on lint and both typecheck targets), T18 (legacy lint remediation across many files), and
  T19/T20 (round-ceiling and terminal-reason corrections, which *are* M10 but arrived after
  the criteria were frozen). None of this is wrong or unrecorded in the journal; it is simply
  not in the criteria, so a delivery record written to the criteria alone would under-describe
  what the phase changed.
- **Why it matters**: Nothing at runtime. It is a note for T11: the delivery record should
  enumerate the actual shipped surface, not only M01/M10, so the next phase inherits an
  accurate picture of what already landed on this branch.
- **Fix**: Have T11 list these strands alongside the M01/M10 outcomes.
- **Evidence**: `git status --porcelain` over the branch; the three
  `input-contract.schema.json` mirrors verified identical
  (`shasum -a 256` → `279cff73f746f05a9c1bcb961a8cca25d7ff0fcaabbf82acad45a20ba07f25a6` for all three),
  which also closes the "unsynchronized installed core task-input schema" defect the journal
  recorded at 11:20Z.

## Acceptance recommendation

**Do not accept yet — but nothing that blocks acceptance is in the code.**

AC1–AC5 are MET on evidence I executed against the current tree. The M01 writer, the
inclusive round ceiling, the independent tool-call cap, the truthful terminal reasons, the
offline stress report and the scripts typecheck target all do what the criteria say, and I
could not build a case that falsifies any of them — including cases the committed tests do
not cover (a real script file carrying an injected type error; two tool calls inside one
round against a cap of one; a zero-valued cap of each kind).

AC6 is not met. Three things must happen first, all documentation:

1. **Correct the health attribution** (F-001): name the seven packages and their counts in
   the journal, and carry the corrected inventory into T11 and the phase-8 hand-off. The
   conclusion the acceptance depends on — no product-code finding at a blocking priority —
   is independently confirmed and does not change.
2. **Give the full-suite result immutable evidence** (F-002): one routed rerun and a cited
   raw path, or an explicit statement in T11 that the figure rests on an unlogged run.
3. **Run T11** and have it record the remaining AFC-16/21 scope accurately. Phase 0 delivers
   part of AFC-21 — one shared writer for `index.md` + `routing.md` across init/update/rules,
   idempotent repeats, observable-and-recoverable failed publication, user-owned blocks
   preserved — and **none** of AFC-21's preview, conflict-report and resumable-partial
   surface, and **none** of AFC-16's CLI/MCP/SDK parity, operation-specific help or common
   envelope. `plan.md:13` and `description.md:6` already say the contributions stay partial
   until the phase 3/6 gates, and that framing is accurate; T11 needs to state which parts,
   not only that some parts. T11 should also name the out-of-criteria strands in F-003, and
   should carry forward the two limitations the phase deliberately accepted: the pair writer
   is atomic per file and ordered (router before pointer), **not** multi-file transactional,
   and `BudgetExhausted` on the child status deliberately collapses both budget reasons while
   the `MAE reservation:` line still reports both caps.

Once 1–3 are done, AC6 is satisfiable and the phase can be accepted. The health gate's own
`fail` is **not** an obstacle: I verified the attribution myself and all 27 blocking-priority
findings are `bun audit` advisories against `package.json`, with zero product-code findings at
a blocking priority, and dependency refresh is out of scope for phase 0 by norm AFC-04.

## Evidence that no longer describes the tree

I looked for stale evidence deliberately, since the programme is uncommitted and has moved a
long way since some tasks ran. What I found:

- **Nothing has changed under `src/`, `scripts/` or `fixtures/` since the integration
  snapshot.** `find src scripts fixtures package.json tsconfig.scripts.json -type f -newer .metaproject/data/health/artifacts/latest.json`
  returns **0 files**. The 20:11–20:12Z integration evidence therefore still describes the
  tree, and my own reruns of both typecheck targets, lint and 320 focused tests agree with it.
- **The T16-final and T21 raw logs still exist and still match their claims.** I opened the
  five cited by the AC3/AC4/AC5 rows: `2026-09-06T13-23-29-634Z_run.log` = 3 pass / 0 fail /
  10 assertions, `…13-23-39-457Z` = 2 pass / 0 fail / 8 assertions, `…13-23-53-162Z` and
  `…13-24-00-402Z` = both `tsc` invocations clean, `…13-26-54-764Z` = the budget capture. My
  independent rerun of the same three script test files today returns 5 pass / 0 fail, which
  is the same 3 + 2.
- **T9-result.json is stale as a verdict, and that is not a defect.** It carries two
  `blocker` findings and `DONE_WITH_CONCERNS`, but it is attempt 1/2 from 15:33; attempt 3 at
  20:12Z superseded it and wrote no artifact of its own. I checked both blockers on the
  current tree rather than trusting the journal's "fixed elsewhere": **T9-F-001** (MCP HTTP
  host rebinding) is fixed — `src/mcp/transport/http-sse.ts:67` now passes
  `[host, "localhost"]`, the arbitrary configured `options.host` is gone, and
  `http-sse.loopback.test.ts` is green in my run. **T9-F-002** (strict health reporting PASS
  while a required source was skipped) is fixed at the logic level, not merely masked by
  ESLint now being installed: `src/health/gate.ts:68-81` escalates any required source with
  `status !== "available"` to `incomplete`, and `health-truthful-gate.test.ts:117` pins
  exactly the `eslint required, status skipped` case. Anyone reading `T9-result.json` alone
  would conclude phase 0 still carries two blockers; it does not.
- **The T9 journal's health attribution is stale-by-inaccuracy rather than by age** — see
  F-001. It described the right artifact and got the packages wrong.
- **`src/session/slate-terminal-state.test.ts:8`** still documents the original pinned union
  (`"ask_user_unanswerable" | "budget_exhausted" | "other"`) in its flow-161 RED header. It is
  a historical record of what that flow pinned, not a claim about today's union, and it is
  outside this diff — noted so the next reader does not mistake it for a contradiction.
- **The project's own tooling obstructed evidence again**, consistent with the dispatch's
  warning, and I ran commands directly where it did. `keryx ctx rg` under-reports: the
  `renderRoutingEntrypointPair|ROUTING_FILENAME|routing.md` search declared `Matches: 34` and
  printed 30, silently dropping 2 of 6 rows for `rules.test.ts` and 1 of 5 for
  `routing-entrypoint-lifecycle.test.ts`; the budget search compacted 65% and printed 4 of
  `agent.ts`'s rows, so I read the routed raw log to recover the other 27. `keryx ctx run`
  mangled a quoted `-newermt '2026-09-07 00:11:00'` argument into two argv entries and
  returned **exit 0 with empty output** — a false negative on a freshness question — so the
  two `find` freshness checks above were run directly with a `# keryx:raw` marker and a stated
  reason. `keryx ctx read` also redacted a `4002.xxx` millisecond value in the stress report
  as `[REDACTED:phone]`.

## Confirmed clean areas

- **The M01 shared writer.** One writer of `.metaproject/index.md`, enumerated rather than
  asserted; ordered publication (full router before compact pointer) so a partial failure
  leaves a stale pointer to an existing router rather than the reverse; `writeTextIfChanged`
  makes reruns no-ops; the lock has stale removal and a heartbeat.
- **The M10 budget semantics.** Inclusive round ceiling including the wrap-up request;
  tool-call cap counted in actual invocations after lookup and schema validation but before
  approval, so malformed and unknown calls never consume budget and a call that cannot run
  never prompts the user; the four `emitTerminalState` call sites each report the cause that
  applies (`budget_exhausted`, `tool_call_budget_exhausted`, `ask_user_unanswerable`,
  `no_progress`); invalid budgets throw rather than being dropped.
- **T16-final's four findings are genuinely closed on the tree**, not merely marked closed.
  F-001: my C9 reproduces the exact scenario and gets `no_progress` with 16 rounds and 47
  calls unspent. F-002: `offerRoundLimitReset`'s doc comment (`agent.ts:1707-1720`) now
  describes the post-T19 behaviour, and `finishWithBudgetSummary` is reachable only from the
  no-progress branch, which matches the code at `:1689`. F-003: the `BudgetExhausted`
  double-mapping is documented at `spawn-subagent-tool.ts:68-77` and the reservation line
  still reports both caps. F-004: the duplicated tail guard is gone and the entry guard at
  `:1257` catches the case — my C1 and C3 confirm the ceiling still binds exactly.
- **The union extension is safe for its readers.** `TerminalStateReason` gained
  `tool_call_budget_exhausted` and `no_progress`; the readers are `agent.ts` (producer),
  `src/sac/catch-up.ts:680` (untyped `readTerminalState` parse, so a value written by an older
  build reads back) and `src/tui/foreground-operation.ts:191` (pass-through). No exhaustive
  switch exists over it.
- **The three `task-implementer` input-contract mirrors are byte-identical**, closing the
  schema-mirror defect the journal recorded during integration.
- **Repository-wide quality on the current tree**: `bun run typecheck` exit 0,
  `bun run typecheck:scripts` exit 0, `eslint .` exit 0 — all three executed by me.

## Evidence

All paths absolute under `/Users/Goodea/goodea/keryx`. Everything below was executed by this
reviewer during this review, on the current tree.

| Check | Result | Raw log / artifact |
|---|---|---|
| `T10-budget-probe.ts` (AC3, my own, 10 cases) | 10 pass / 0 fail, `allPassed: true` | `.metaproject/data/gdctx/raw/2026-09-06T20-25-40-617Z_run.log`; script: `.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T10-budget-probe.ts` |
| `T10-scripts-typecheck-probe.ts` (AC5, my own, 4 cases) | 4 pass / 0 fail, 26 files in project, TS2322 attributed to each real script | `.metaproject/data/gdctx/raw/2026-09-06T20-26-02-750Z_run.log`; script: `…/artifacts/T10-scripts-typecheck-probe.ts` |
| M01 + terminal-state + regression-fix set (16 files: routing lifecycle, rules, update, templates, init ×3, orient, agent ×3, slate ×3, health truthful gate, MCP loopback) | **246 pass / 0 fail**, 1041 assertions | `.metaproject/data/gdctx/raw/2026-09-06T20-26-19-109Z_run.log` |
| spawn-subagent + child ledger set (7 files) | **69 pass / 0 fail**, 26587 assertions | `.metaproject/data/gdctx/raw/2026-09-06T20-26-43-358Z_run.log` |
| scripts set (`typecheck.test.ts`, `keryx-shell-stress.test.ts`, `run-containment.test.ts`) | **5 pass / 0 fail** | `.metaproject/data/gdctx/raw/2026-09-06T20-27-03-699Z_run.log` |
| `bun run typecheck` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T20-27-39-076Z_run.log` |
| `bun run typecheck:scripts` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T20-27-44-483Z_run.log` |
| `bun run lint` (`eslint .`) | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T20-28-08-498Z_run.log` |
| Health gate attribution (AC6, verified not accepted) | gate `fail`; 14 P0 + 13 P1 all `dependencyAudit` / `package.json`; **0 product-code blocking findings**; seven distinct packages | `.metaproject/data/gdctx/raw/2026-09-06T20-28-19-864Z_run.log`; artifact `.metaproject/data/health/artifacts/latest.json` (`2026-09-06T20:11:46.622Z`), history `.metaproject/data/health/history/2026-09-06T20-11-30-148Z.json` |
| Offline stress harness, run directly | exit 0; report written; `maxRounds: 9` from the resolver; no `maxToolCalls` key; `allowEgress: false` | `<scratchpad>/t10-stress/stress-2026-09-06T20-19-00-272Z.json`, read via `.metaproject/data/gdctx/raw/2026-09-06T20-19-04-837Z_read.log` |
| Tree freshness vs the integration snapshot | 0 files under `src/`, `scripts/`, `fixtures/`, `package.json`, `tsconfig.scripts.json` newer than the 20:11:46Z health artifact | direct `find` with `# keryx:raw` marker (routed form returned a false empty result) |
| Enumeration of `.metaproject/index.md` writers | 1 writer (`routing-entrypoint.ts:25`), 3 consumers, 6 read-only matches | `.metaproject/data/gdctx/raw/2026-09-06T20-14-48-104Z_run.log` |
| `task-implementer` schema mirror sync | 3 files, identical sha256 `279cff73…f25a6` | `shasum -a 256` (direct) |

Prior evidence read as claims and re-checked rather than accepted: `T16-final-review.md`,
`T21-review.md`, `T19-spec.md`, `T20-implementation.md`, `T9-verification.md`,
`T15-review.md`, and the result JSONs for T9/T15/T16-final/T21.

## Routing audit

- `graph_used`: no — **not-relevant**, and deliberately. The navigation questions here were
  "who writes this file" and "who reads this union", which are exact-text questions;
  `.metaproject/data/gdgraph/` is modified in the working tree and its provenance predates
  this uncommitted programme, so a graph answer would have needed a rebuild I am not
  permitted to run (no repository state change). I enumerated with `keryx ctx rg` and read
  the call sites instead, and said so in each finding's `enumeration_method`.
- `wiki_used`: no — **not-relevant**. This is an acceptance review against six frozen
  criteria and executed evidence, not a conceptual question; the flow's own `context.md:10`
  additionally records the wiki as carrying `symbol-layer-unavailable` edges and known prose
  inaccuracies at an old `d0a2a01` history point.
- `ctx_used`: yes — `keryx ctx rg` for every code search, `keryx ctx read` for large files
  and artifacts, `keryx ctx run` for every command whose output is cited. Two documented
  failures of the routed layer are recorded above (silent row-dropping in the `rg` summary;
  a false empty result from a mangled quoted argument in `ctx run`).
- `raw_rg_used`: **no**. No bare `rg` or `grep` over project code. Two direct `find`
  invocations carry a `# keryx:raw` marker with a stated reason (the routed wrapper mangled
  the quoted `-newermt` argument and returned a false negative on a freshness question, which
  is precisely the kind of answer that must not be wrong in this review).
- `memory_used`: no — not-relevant to a criterion-by-criterion acceptance check.
- `health_used`: yes — `.metaproject/data/health/artifacts/latest.json` and its history entry,
  read rather than regenerated, since regenerating would overwrite the integration evidence.
- `testing_used`: partial — `.metaproject/data/testing/artifacts/latest.json` inspected for
  provenance (15:13Z, pre-integration) and found not to cover the 20:12Z run, which is F-002.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "232-T10#F-001",
    "reviewer": "T10-aggregate-acceptance-review",
    "severity": "minor",
    "file": ".metaproject/flows/232-2026-09-06-agent-first-core-phase-0/journal.md",
    "line": null,
    "symbol": null,
    "problem": "The 2026-09-06T20:12:54Z integration record states that all 14 P0 health findings are dependency advisories on the transitive package fast-uri, with 13 P1 and 1 P2 from the same source. The counts match the artifact but the attribution does not: the 27 blocking-priority findings span seven packages (fast-uri 6xP0, protobufjs 6xP0+5xP1, sharp 1xP0, ip-address 1xP0+2xP1, hono 3xP1, @hono/node-server 1xP1, qs 2xP1), and the single P2 dependency advisory is hono, not fast-uri.",
    "impact": "The record builds a phase-8 prioritisation argument on the fast-uri attribution, so a reader scoping the dependency refresh from it would plan for one package and meet seven, with six of the fourteen P0 advisories in a package the record never names. The material claim the acceptance rests on is unaffected: every blocking finding is source dependencyAudit on package.json and the count of blocking-priority product-code findings is 0, independently verified.",
    "suggested_fix": "Append a journal correction naming the seven packages and their per-priority counts, and carry the corrected inventory into the T11 delivery record and the phase-8 hand-off. No code change.",
    "evidence": "Grouped .metaproject/data/health/artifacts/latest.json (generated_at 2026-09-06T20:11:46.622Z, the run the record cites) by priority, source, file and symbol: {\"p0\":14,\"p1\":13,\"p2\":244,\"blocking_sources\":[\"dependencyAudit\"],\"blocking_files\":[\"package.json\"],\"blocking_by_symbol\":{\"P0:fast-uri\":6,\"P0:protobufjs\":6,\"P0:sharp\":1,\"P0:ip-address\":1,\"P1:protobufjs\":5,\"P1:hono\":3,\"P1:ip-address\":2,\"P1:qs\":2,\"P1:@hono/node-server\":1},\"product_code_blocking\":0}. Raw: .metaproject/data/gdctx/raw/2026-09-06T20-28-19-864Z_run.log",
    "confidence": "high",
    "dedupe_key": "phase0-health-attribution-single-package",
    "blocking_merge": false,
    "related_skill": "health",
    "learning_candidate": true
  },
  {
    "id": "F-002",
    "global_id": "232-T10#F-002",
    "reviewer": "T10-aggregate-acceptance-review",
    "severity": "minor",
    "file": ".metaproject/flows/232-2026-09-06-agent-first-core-phase-0/journal.md",
    "line": null,
    "symbol": null,
    "problem": "AC6 requires current immutable evidence for the integration checks, and this flow's context.md:13 required immutable per-worker report paths, but the full-suite result (7100 pass / 18 skip / 0 fail, 54038 assertions, 7118 tests in 579 files, 199s) exists only as prose in the journal. No gdctx raw log in the 20:00-20:14Z window belongs to it (all five are flow 233 T76 output), .metaproject/data/testing/artifacts/latest.json predates the run at 15:13Z, the health artifact's own tests source is status missing / execution not-run, and T9 attempt 3 wrote no result artifact (T9-result.json is attempt 1/2 from 15:33Z).",
    "impact": "The most load-bearing claim in the phase is the one an auditor cannot check, in a phase whose own history records three cases of an implementer's artifact claim being false while the returned value was right. The lint and typecheck halves of the same table do have immutable raws (.metaproject/data/health/raw/{eslint,typescript}/2026-09-06T20-11-30-148Z.log) and were re-executed to exit 0 during this review, so the gap is specific to the suite figure.",
    "suggested_fix": "Rerun the full suite once through keryx ctx run (or keryx test) so an immutable raw log exists, and cite that path beside the numbers in the journal and in T11; or, if no rerun is wanted before delivery, have T11 state plainly that the suite figure rests on an unlogged run. No code change.",
    "evidence": "ls .metaproject/data/gdctx/raw/ | grep -E '^2026-09-06T20-(0|1[0-2])' returns exactly five run logs, each read and identified as flow 233 T76 output. find .metaproject -newermt '2026-09-07 00:05' ! -newermt '2026-09-07 00:14' lists only the two flow journals/flow.json, the health artifacts/history/raws and flow 233 artifacts - no test report. latest.json sources array contains {\"s\":\"tests\",\"req\":false,\"st\":\"missing\",\"ex\":\"not-run\",\"p\":\"not-run\"}.",
    "confidence": "high",
    "dedupe_key": "phase0-full-suite-no-immutable-log",
    "blocking_merge": false,
    "related_skill": "testing",
    "learning_candidate": true
  },
  {
    "id": "F-003",
    "global_id": "232-T10#F-003",
    "reviewer": "T10-aggregate-acceptance-review",
    "severity": "info",
    "file": ".metaproject/flows/232-2026-09-06-agent-first-core-phase-0/plan.md",
    "line": null,
    "symbol": null,
    "problem": "The frozen criteria describe M01 and M10 only, but the phase shipped four further strands: T12/T13 (description-based worker dispatch: the task-implementer input contract plus ten worker prose builds, mirrored across .metaproject/core/, .metaproject/skills/ and src/gdskills/bundled/), T17 (introducing ESLint - eslint.config.mjs, package.json scripts and devDependencies, check now gating on lint and both typecheck targets), T18 (legacy lint remediation), and T19/T20 (M10 corrections that arrived after the criteria were frozen).",
    "impact": "None at runtime. A delivery record written to the criteria alone would under-describe what landed on this branch, leaving the next phase with an incomplete picture of the inherited surface.",
    "suggested_fix": "Have T11 enumerate these strands alongside the M01/M10 outcomes.",
    "evidence": "git status --porcelain over the branch; the three task-implementer input-contract.schema.json mirrors verified byte-identical via shasum -a 256 (279cff73f746f05a9c1bcb961a8cca25d7ff0fcaabbf82acad45a20ba07f25a6), which also closes the unsynchronized-installed-schema defect recorded in the journal at 11:20Z.",
    "confidence": "high",
    "dedupe_key": "phase0-out-of-criteria-scope-unrecorded",
    "blocking_merge": false,
    "related_skill": null,
    "learning_candidate": false
  }
]
```
