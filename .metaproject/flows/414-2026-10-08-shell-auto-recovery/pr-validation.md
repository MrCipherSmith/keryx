# Flow 414 PR validation

Validated on 2026-10-08 in `/Users/tsaitler.aleksandr/goodea/keryx/.worktrees/shell-auto-recovery`, branch `feat/shell-auto-recovery`.
PR: https://github.com/MrCipherSmith/keryx/pull/926
Reviewed HEAD: `e90ae7d41249a7b3cbb44bc7c9e216cf01544fee`.
Local comparison ref: `origin/main` at `13dda292684bac008b01841928c25fce238e4896`.
The comparison uses the available local ref; it was not fetched. GitHub API access failed (`error connecting to api.github.com`), so remote head, base, CI, mergeability and human review are unverified. Authentication was not changed.

**Earlier scoped review (before the failed CI log was available): no new blocking regression was identified in that selection.** The historical results below do not establish a green PR. Subsequent CI exposed source-audit failures and a pause-notice timeout; the CI repair continuation records the actual corrections and checks separately. This is not full AC certification, a managed-review ingestion, permission to merge, or flow completion.

## Independent verification

Commands ran through `rtk proxy keryx ctx run --`. Evidence ids below refer to local gdctx raw logs and summaries; generated artifacts are excluded from the handoff changes.

| Check | Actual result | Evidence id |
|---|---|---|
| Focused recovery/provider/readline/TUI/agent/context/budget sweep | 1,016 pass, 0 fail; 3,905 assertions; 44 files | `2026-10-08T11-02-05-242Z-a74a5f_run` |
| Broader sweep including all `src/tui/` | 2,720 pass, 3 fail; 11,372 assertions; 181 files | `2026-10-08T11-01-20-307Z-f0ac35_run` |
| Isolated schedule failures | 1 pass, 3 fail; 1 file | `2026-10-08T11-01-55-777Z-01ecfe_run` |
| Main typecheck | Pass, exit 0 | `2026-10-08T10-59-27-619Z-8ce46b_run` |
| Scripts typecheck | Pass, exit 0 | `2026-10-08T10-59-08-462Z-d1f199_run` |
| ESLint, all 19 changed TypeScript paths | Pass, exit 0 | `2026-10-08T11-00-36-080Z-b567e6_run` |
| `git diff --check` | Pass, exit 0 | `2026-10-08T11-02-38-156Z-18a16f_run` |

The focused command was:

```bash
rtk proxy keryx ctx run -- bun test --timeout 30000 src/harness/provider/ src/commands/agent.recovery.test.ts src/commands/agent.test.ts src/commands/agent.overflow-retry.test.ts src/commands/agent.error-hint.test.ts src/commands/agent-tool-call-budget.test.ts src/commands/agent.context-guard.test.ts src/commands/shell-agent-repl.test.ts src/commands/shell.test.ts src/commands/shell-bus.test.ts src/tui/tui-shell.test.ts src/tui/foreground-operation.test.ts src/tui/turn-guard-shell-wiring.test.ts src/tui/task-cost-shell-wiring.test.ts src/tui/routing-classifier-shell-wiring.test.ts
```

The broader command used the same agent/shell/provider selection and replaced the five named TUI files with `src/tui/`. All three failures are in `src/tui/schedule-command.test.ts`. The isolated run reports the precise reason: `/schedule` refuses a process started by an agent (`KERYX_TOOL_CALL=1`) before usage/card/confirmation. The handler and test are unchanged versus `origin/main`; the test does not inject `deps.env`, and the handler calls `nestedAgentScheduleRefusal(deps.env)` before parsing. This is a pre-existing environment-sensitive fixture failure, still a failed check, not a skipped or passing test. No guard was bypassed and no schedule was created. Evidence: `2026-10-08T11-01-54-801Z-8d0bc8_run` (empty baseline diff), isolated log above.

The consecutive auto-wake test passed in both sweeps. Per requested scope, its fixture was not investigated or altered. Totals from separate sweeps overlap and must not be added as unique coverage.

## Source review and frozen criteria

Read the complete frozen acceptance criteria, implementation evidence, continuation report, flow record, context, plan, description and journal. Inspected the actual `git diff origin/main` for agent, both interactive hosts, foreground owner and all changed provider files, and followed relevant sinks in current source. The frozen checksum and `acConfirmed` remain unchanged.

| Criteria | Reviewed evidence and exact boundary |
|---|---|
| AC1–AC2 | Scripted real readline and headless OpenTUI IO recover one original prompt; 19 attempts survive a long outage with one model-round budget. Backoff is interruptible, jittered and capped; Retry-After date/seconds and bounded delay tests pass. This is deterministic fault injection, not a live outage. |
| AC3–AC4 | Failed attempts clear provisional text/reasoning/replay/calls before retry and never checkpoint them. Calls execute only after completed attempts; a completed prior tool batch and its approval/result survive the next failed round without another invocation. Native body-reset fixture receives complete tool arguments but executes no tool. Unknown already-started external effects are not retried by the recovery loop; exactly-once external effects are not promised. |
| AC5 | Abort checks precede each request and follow waits/events. Owner retains exclusivity until settlement; session invalidation revokes callbacks and settlement handoffs by generation. Production `/new` and `/resume` wiring resets preview/checkpoint/Force state; finalization rejects the old token before persistence and queue effects. Lease loss aborts stream/backoff; existing lease guard refuses persistence. Rewind remains refused while foreground work is active. Tests use real agent execution with production owner/facade helpers and source wiring audits, not a fully launched interactive session-switch race. |
| AC6 | Recovery attempts remain inside one round; tool counters/approvals/subagent budget are outside the attempt reset. Failed usage reaches host accounting; readline sums reported attempts and resets totals on the next operator turn. Missing usage is explicitly unknown. `canRequest` admission is tested, but neither interactive host installs a new default monetary ceiling. Context-overflow retry remains bounded across transport recovery; provider credential refresh retains its existing bounded owner. Real billing and unreported spend are not measured. |
| AC7 | Generic auth/invalid-request/403 errors stop; structured unavailable fixture can retry. Body read failures preserve abort/permanent/transport classification across four adapters; error-body failures retain HTTP classification. Supported auth tests pass. The temporary 403 fixture is a normalized scripted error, not proof that every provider supports a temporary-403 wire code. |
| AC8–AC9 | No readline success-looking turn_end during backoff; stopped/budget/error paths emit explicit markers. Headless renderer shows recovering/interrupted/final output and discards failed reasoning. Both focused suites and broader recovery tests pass. Delay is shown as next-probe text, not a continuously repainting countdown. No live PTY responsiveness, live TCP/provider outage or fully mounted TUI switch/rewind/lease race was run. Earlier sandbox-hook failure and opt-in PTY skips were not independently rerun in this selection. Full repository regression success is not claimed. |
| AC10 | README and recovery documentation describe defaults, permanent errors, partial output/effects, unknown usage and lifetime. Print/unattended/subagent opt-out tests pass; side-worker call site is unchanged. |

## Advisory security baseline triage

Rescanned `src/tui/tui-shell.ts` and `src/harness/provider` in advisory mode. Policy reports remain FAIL/advisory; a scan exit 0 is not a security-clean verdict. TUI: 13 matches (2 critical, 10 high, 1 medium). Provider directory: 147 matches (43 critical, 33 high, 54 medium, 17 low). Exact flagged source lines for **all 160 matches** exist in `origin/main`; none is a new flagged line. This establishes provenance only, not exploitability. Evidence: `2026-10-08T11-01-03-381Z-78d27e_run`, `2026-10-08T11-02-15-269Z-2952cd_run`.

| Advisory group | Source → sink reasoning | Classification |
|---|---|---|
| TUI loopback URL examples, lines 900–901; phone match on line 900 | One URL is help text, the other is a wizard input default. Help text alone makes no request and the numeric host is not a person's phone. Operator-entered URL becomes `created.baseUrl`, is saved as a custom provider, and can reach `modelsForPicker` → `resolveModelsForPicker` → `fetchOpenAiCompatModelsDetailed` → `fetchFn(url, init)`. Wizard validation accepts plain HTTP(S), rejects URL credentials, but discovery has no private-host guard. | Pre-existing literal matches; **real baseline network trust risk**, not blanket false positives. Local endpoints are an intended capability, but a hostile/misconfigured custom endpoint can receive an explicitly selected Bearer credential and discovery can reach private/link-local destinations. No new recovery hunk changes this path. |
| TUI environment matches, lines 708, 2723, 2963, 3158, 3190, 3309, 4083 | Reads and dependency forwarding are not private-file publication. Provider lookup selects `envKey`/saved API key and sends that selected credential in authorization to the chosen provider; `envWithSavedApiKeys` merges locally and does not itself publish the entire environment. No raw-memory/config upload sink was found at these matches. The custom endpoint trust risk above still applies to selected credentials. | Pre-existing; scan's whole-environment/private-file exfiltration claim is unsupported by these sinks. Authorized provider authentication is a real egress operation. |
| Provider production loopback matches | Compat line 15 is a comment. `make-provider.ts:37` and `ollama-provider.ts:48` specify the intended local Ollama endpoint, passed through a network grant with explicit loopback opt-in. Compat checks private egress before stream fetch and permits loopback/private LAN only under explicit grants; metadata/link-local remain denied. Native adapters retain their pre-fetch private-host guards. | Pre-existing; deliberate local-provider capability, not evidence of metadata exfiltration. Host checks alone do not certify DNS/redirect safety; discovery's weaker path above is not dismissed. |
| Provider `make-provider.ts:126` secret match; `single-turn.ts:41` phone match | The former reads a named credential from env into a granted Gemini adapter, rather than embedding a credential literal; the latter is a model revision identifier. | Pre-existing heuristic mismatches, no secret literal/person-phone disclosure established. |
| Remaining 142 provider matches in tests/SSE fixtures | Existing injected-fetch negatives, synthetic credential-redaction tests, private-host refusal inputs, and recorded stream numeric identifiers. The focused provider suite executes these offline; test inputs are not automatically a production request sink. All flagged lines are unchanged. | Pre-existing fixture matches. No new production source-to-sink issue established by them; this review does not attest that any historical recorded fixture was scrubbed by its original author or that any historical credential was live. |
| New recovery/provider/TUI hunks | Recovery reuses the already-granted request/provider, does not switch endpoints/auth/accounts, discards unsuccessful tool batches and preserves approvals. Changed native body-error messages still pass credential redaction; compat `errorEvent` retains its existing sanitizer. Retry classification adds no new command/network destination or publication sink. | No new security regression identified. Repeated paid attempts increase charge exposure during outages as documented; unknown usage cannot be enforced as known spend. |

The model-discovery URL/credential risk is recorded for separate baseline follow-up, not repaired as part of this recovery validation. No blanket assertion that all advisory findings are false positives is made. Dependency/CVE audit and live exploitation were outside this requested validation.

## State and completion gates

After scoped review passes, the requested operations are `keryx flow task done 414 T4` and `keryx flow implemented 414 --pr https://github.com/MrCipherSmith/keryx/pull/926`. They record review-task progress and implementation handoff only. No AC confirmation, owner assignment, review ingestion, confirmation token or `flow complete` is fabricated.

Both requested CLI operations succeeded: T4 is done (7/7 tasks), flow is `implemented`, and PR #926 is recorded. These are existing CLI state writes, not proof of a reviewed merge. The recorded draft-PR transition did not establish the merged-PR requirement in the local flow skill; no merge, human confirmation or managed review evidence is inferred from that label. The subsequent `flow check-complete 414 --json` still returns exit 1 and `passed: false`. Pending gates are AC1–AC10 unconfirmed; PR base unobserved against recorded `fix/tui-input-latency`; owner missing; managed review round/dispositions/head/verifier evidence absent; external PR comments never collected; health report missing. PR check is skipped because the tracker is unavailable, and merge state is unknown. Tasks, folder-committed and advisory-security gates pass. Confirmation is skipped because it is **not enabled**, so no token is required. Folder-committed refers to the existing committed flow package, not these uncommitted validation changes. No completion was attempted.

No merge, release, push, commit, auth switch or other-worktree action occurred. Generated graph/testing/security/wiki artifacts and the two existing dot reports are excluded from changes; their local copies are preserved outside the worktree before cleanup. The only intended handoff changes are this report and CLI-owned flow/journal updates.

Preserved generated outputs and the two dot reports at `/private/tmp/flow414-validation-zwa6n4l1`. `git restore` could not create the worktree index lock under the read-only parent `.git`; cleanup instead restored the seven generated working-tree files from `git show HEAD:<path>` bytes, without changing the index. Security outputs remain ignored local artifacts.

## Routing audit

- graph_used: `gdgraph affected src/commands/agent.ts` (initial stale warning; navigation only), then successful `gdgraph build` (2,888 nodes, 10,117 edges). Current source verified every behavioral claim. Generated tracked graph outputs excluded afterward.
- wiki_used: complete wiki index for orientation; flow evidence supplied the task-specific behavior/decisions.
- memory_used: `memory search 'shell recovery'`.
- testing_used: testing skill/context and `test related src/commands/agent.ts`; explicit focused runs matched the requested verification scope.
- ctx_used: diff, searches, long reads, tests, typechecks, lint and CLI output routed through ctx; raw evidence retained locally. Provider scan output was format-unsafe in ctx, so only sanitized policy/path/line metadata was read directly as fallback.
- raw_rg_used: no.

## CI repair continuation — 2026-10-08

All work stayed in this worktree. Input evidence was `/tmp/recovery926-ci-failed.log`;
bounded failure contexts were read rather than the whole log. The CI artifact records
the inventory's TUI site count changing 12 → 13, the task-notification pruning regex
failing, and the holder-killed pause case timing out waiting for B's pause-request
notice before any operator/model turn. Local reproduction also exposed the operator
pruning regex's fixed window failing. The initial focused run had 10 pass / 3 fail.

### Repair and source safety

The inventory guard itself is unchanged. Its manifest now records the thirteenth
TUI reader, with the protected behaviour documented: `/new` and `/resume` invalidate
foreground callbacks before session replacement, clear Force/persistence state, and
reject stale settlement before remote-queue/checkpoint effects. Those production
paths were inspected, including `invalidateForegroundSession`, both replacement
sites, and the settlement acceptance check.

The two readline pruning assertions now parse the exact `runAgentTurn` calls and
their options instead of using 120/200-character windows. Both actual call sites
still pair `slateSession` with literal `pruneArchive: true` only when the archive
exists. The task-notification call still requires its exact origin. The archive
spread must be last, so a later override cannot silently disable pruning. TUI,
goal's three calls and ACP's no-pruning requirements remain intact. A negative
guard case accepts 1,000 characters of unrelated recovery options but rejects
missing/false pruning, a flag in recovery or the no-archive branch, and a late
false override. No production source or pause timeout was changed.

### Verified checks

Raw outputs and JSON summaries are saved under `/tmp/recovery926-*.log` and
`/tmp/recovery926-*.json`; each command was run through `rtk proxy keryx ctx run --`.
Counts overlap and must not be summed as distinct coverage. Local Bun is 1.3.14 on
macOS; the CI artifact reports Bun 1.4.2 on Linux. Broad gates ran concurrently with
focused repetitions, which is a measured difference in test scheduling; it does
not prove that load caused every failure.

| Check | Actual result | Saved raw evidence |
|---|---|---|
| Final inventory + pruning checks | 9 pass, 0 fail | `/tmp/recovery926-pruning-final.log` |
| Final affected sweep: inventory, pruning, pause processes, TUI shell | 183 pass, 0 fail; 4 files | `/tmp/recovery926-affected-final.log` |
| Earlier affected sweep during concurrent gates | 180 pass, 1 fail: inventory scan setup hook timed out at 5s | `/tmp/recovery926-affected.log` |
| Holder-killed case, 50 fresh focused executions | 50/50 pass, 0 failures, 352.16s total | `/tmp/recovery926-pause-01.log` … `-50.log`, `/tmp/recovery926-pause-repeat.json` |
| Final changed-test ESLint | Pass, exit 0 | `/tmp/recovery926-focused-lint-final.log` |
| Final main typecheck | Pass, exit 0 | `/tmp/recovery926-final-typecheck.log` |
| Full terminal gate | 2,230 pass, 3 skip, 9 fail; exit 1; 162 files | `/tmp/recovery926-terminal.log` |
| Terminal failure-file recheck (five TUI files) | 66 pass, 3 fail; only `/schedule` failures persist | `/tmp/recovery926-terminal-failures-recheck.log` |
| Isolated shell web-search wiring recheck | 1 pass, 0 fail | `/tmp/recovery926-web-search-recheck.log` |

Terminal failure-only summary: five 5s timeouts (fallback, two inspector-source
cases, digest sidebar, shell web-search wiring); three `/schedule` failures under
the inherited agent-origin environment; one decisions arm-row `clickNode: no such
renderable` failure. The fallback/inspector/digest/decisions cases pass in the
smaller recheck. The shell web-search case also passes its separate isolated run.
The schedule test and handler are unchanged versus available local `origin/main`;
the guard was not bypassed. All nine failures remain part of the broad gate result.

### Pause investigation: not reproduced, no repair claimed

The holder-killed case passes in the initial focused file, both affected sweeps,
the terminal gate and all 50 fresh focused runs, including runs overlapping the
broad gates. That does not invalidate the original CI timeout. Both the pause
process test and bus client are byte-unchanged versus local `origin/main`.

The strongest failure evidence remains the original CI artifact. A surviving
hypothesis is an existing startup readiness race: the fixture waits for two
presence records, but `joinBus` writes presence before initializing its cursor
with `cursorAtEnd`. If A emits the pause before B's cursor is initialized, B can
start beyond that notice. The CI timeout precedes a model turn, so no recovery
attempt was active at the reported wait. This hypothesis is not experimentally
established as the CI cause. A future controlled probe should timestamp presence,
cursor initialization and pause append; observing the cursor initialized before
the append would falsify this ordering for that run. An explicit post-join
readiness barrier in a diagnostic fixture would test the alternative without
inflating the timeout. No such speculative change was landed. Linux/Bun 1.4.2
reproduction was unavailable in this macOS workspace.

### Flow metadata and boundaries

The requested actual PR base is `main`; `flow.json` still records the original
worktree branch `fix/tui-input-latency`. Both `keryx flow --help` and the current
CLI dispatcher were inspected: `--base` exists only for initialization, with no
supported command for changing an existing flow's base. The metadata is therefore
left unchanged, rather than editing CLI-owned state by hand or adding an unrelated
CLI feature. `flow.json` is identical to its pre-repair bytes. Its existing
implemented/T4 state is historical, not new merge or review evidence.

No AC confirmation, owner, signature, review ingestion, flow completion, commit,
push, merge, tag, release or authentication switch was performed. The pre-existing
dot report is preserved. The intended repair changes are this validation report,
the journal continuation, the pruning test and the source-audit inventory.
Generated tracked graph outputs were preserved at `/tmp/recovery926-generated-graph`
and restored to their initial HEAD bytes without touching the index. Pre-repair
flow/journal/report copies are at `/tmp/recovery926-before-ci-repair`.

Routing: graph_used: `gdgraph affected` and successful build (2,888 nodes,
10,117 edges); subsequent test/doc edits postdate the graph and source was checked
directly. wiki_used: wiki index; memory_used: `memory search 'shell recovery pause'`;
testing_used: local skill/context and `test related src/commands/shell.ts`;
ctx_used: searches, reads, bounded logs, diffs and executions; raw_rg_used: no.
