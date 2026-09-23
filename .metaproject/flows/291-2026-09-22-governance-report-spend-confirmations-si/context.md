# Context

Collected deterministically by `keryx flow init` at 2026-09-22T23:17:45.979Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.766] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.665] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.585] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.565] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
5. [1.563] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Phase 1 research for flow 291 (`keryx governance` / a governance report unifying
spend, confirmations, signatures and gate outcomes). No source code written;
this is evidence-gathering only. Every claim below is anchored to a
`file:line`.

### 1. Every place spend is recorded today

There are **three independent spend surfaces**, and they do not share a
schema. A governance report has to reconcile all three, not just read one.

**a) Review-round cost, structured, persisted — the primary source.**
`src/review/cost.ts:24-31` defines `ReviewRoundCost = { input_tokens?,
output_tokens?, spent_usd? }`, "every field independent and optional... An
estimate is labelled an estimate; an unreported spend stays `not recorded`
and never becomes `0`" (`src/review/cost.ts:1-21`). It is built by
`costFrom()` (`src/review/cost.ts:78-94`) from `--tokens-in`, `--tokens-out`,
`--spent` on `keryx review ingest` (`src/commands/review.ts:494-498`), and
written onto the review package's `manifest.json` **only when at least one of
those flags was given** (`src/review/managed.ts:953`: `...(args.input.cost
=== undefined ? {} : { cost: args.input.cost })`). Manifests live at
`.metaproject/flows/<id>/reviews/<round>/manifest.json`
(`src/flow/renumber-reviews.e2e.test.ts:121`), and carry a `flow: {id, path}`
back-reference when the round was attached to a flow
(`src/review/managed.ts:958-963`). **This is the only spend record that is
both structured (JSON, schema-validated) and flow-attributed** — enumerate
`.metaproject/flows/<id>/reviews/*/manifest.json` per flow, sum
`cost.spent_usd`/`cost.input_tokens`/`cost.output_tokens` across rounds, and
report "not recorded" for a flow where every round's manifest lacks a `cost`
key (never coerce absence to `0`). A round can carry `input_tokens`/`output_tokens`
without `spent_usd` (tokens known, USD not converted) — the report must keep
these independently "not recorded", not collapse a token-only round into a
USD zero.

**b) Spend-ceiling evaluation — ephemeral, NOT persisted as structured data.**
`--spent`/`--spend-ceiling` also feed `evaluateSpendCap()`
(`src/review/caps.ts:289-316`, ceiling defaults to
`DEFAULT_SPEND_CEILING_USD = 3`, `src/review/caps.ts:247`), producing a
`SpendCapEvaluation` with `status: "under"|"over"|"not-recorded"` — deliberately
never coercing `spent === undefined` to `"under"`
(`src/review/caps.ts:280-288`, "a pipeline that never reported its spend has
not demonstrated it stayed inside the ceiling"). This evaluation is folded
into `ReviewCapsRecord.spend` (`src/review/managed.ts:333-339`) and rendered
as **prose into `scope.md`** via `renderCapsMarkdown()`
(`src/review/managed.ts:2176`) — it is **not** written onto `manifest.json`.
`keryx review budget` (`src/commands/review.ts:688-736`), the pre-dispatch
gate that can actually refuse ("STOP AND ASK", line 732), is **console-only**:
it prints `spend_ceiling`/`spent`/`spend_status` and sets a non-zero exit
code, but writes nothing to disk. A governance report over a completed flow
therefore cannot see a `review budget` refusal after the fact — only whether
a later `ingest` recorded a `cost` that happens to exceed the default ceiling.
This is a real gap the report should state honestly rather than paper over.

**c) Fired-trigger cost — structured, persisted, but project-wide, not
flow-attributed.** `.metaproject/data/trigger/runs.jsonl` (append-only JSONL,
`src/trigger/record.ts:53-59`) holds one `TriggerRunRecord` per fired trigger
(`src/trigger/record.ts:94-108`): `{v, at, trigger, firedBy, action, outcome,
cost}`, where `cost: TriggerRunCost = {recorded:true,usd} | {recorded:false,
reason}` (`src/trigger/record.ts:84-91`) — mirrors the deletion journal's
`Attribution` shape on purpose (comment at `src/trigger/record.ts:76-82`).
**No flow id field exists on this record** — `TriggerAction`
(`src/trigger/config.ts:66-101`) names `reconcile|rebuild|open-flow|flow-next`
but carries no flow reference either, so trigger spend cannot be attributed
to a specific flow, only to the project as a whole. `recordedTriggerSpend()`
(`src/trigger/run.ts:234-240`) sums `cost.usd` over every record whose
`cost.recorded` is `true`; an absent `runs.jsonl` is read as a **demonstrated
`$0`** (nothing has ever fired) while an unreadable one is `known: false`
(never coerced) — see the extensive doc comment at `src/trigger/run.ts:179-192`.
For the governance report: trigger spend can only be reported **per project**,
not per flow, and that must be stated as a scope limit rather than silently
omitted or wrongly attributed to "the current flow".

**d) `keryx metrics`.** Despite the name, `src/commands/metrics.ts` has no
`cost`/`spend`/`usd` anywhere in it (confirmed by search) — it is a benchmark
task-manifest harness (`keryx metrics benchmark init/validate`), unrelated to
$ spend. It is not a spend source and does not need reconciling.

**e) Harness/session-level spend.** No evidence was found of any
Claude-Code/harness-level token or USD tracking persisted into this project's
`.metaproject/` tree (searched `src/commands/metrics.ts`, `src/health`,
`.metaproject/data/`). Nothing here to plug in; if the operator wants it,
that is a separate, unscoped source. Treat as "not recorded" / out of scope
for v1 unless the operator says otherwise.

**Reconciliation rule for AC drafting:** "not recorded" and "`0`" must never
collapse into each other anywhere in the report, at any level (round, flow,
project) — this is a load-bearing convention throughout the codebase
(`evaluateSpendCap`, `TriggerRunCost`, `ReviewRoundCost`, `Attribution` all
independently enforce it) and the report is the one place all three spend
surfaces meet, so it is the one place most likely to accidentally sum
`undefined` as `0`.

### 2. Flow-level accountability: owner/signatures/history, and gate outcomes

**Owner** (flow 289): `FlowState.owner?: Identity` (`src/flow/types.ts:228`,
never inferred — only `--owner` on `flow init`/`flow owner set`, always
`basis: "stated"`, `src/flow/identity.ts:72-82`). Every change also lands a
`history` event (`src/flow/types.ts:224-226`).

**Signatures** (flow 289, AC4): `FlowState.signatures?: FlowSignature[]`
(`src/flow/types.ts:156-181, 229-235`) — append-only, never mutated. Two
kinds: `"ac-confirm"` (pushed by `acConfirm()`, `src/flow/service.ts:532,548`,
carrying `criterion` + the `Identity` resolved by `resolveSignerIdentity()`)
and `"complete"` (pushed only when **all gates passed**,
`src/flow/service.ts:824-843`). **This is the only place "who confirmed AC
`n`" and "who completed the flow" are recorded with an identity** —
`FlowState.acConfirmed: Record<string, {at, note}>` (`src/flow/types.ts:197`)
records *that* an AC was confirmed and *when*, but carries **no identity at
all**; the identity lives only on the matching `signatures` entry
(`kind: "ac-confirm", criterion: <ACn>`). A report answering "who confirmed
ACn" must join `acConfirmed` with `signatures`, and must show
`identity.basis` (`"stated"|"derived"|"unknown"`,
`src/flow/identity.ts:18-26`) next to every name — per the file's own
doctrine, "none of the three [inputs] are proof that a human is behind them...
`basis` records how the value was obtained rather than asserting it is
trustworthy" (`src/flow/identity.ts:11-16`). **The report must never present
a `derived`/`unknown` identity as if it were a verified confirmer** — that is
the exact failure mode this feature exists to prevent.

Pre-existing flows (created before flow 289) have `signatures: undefined`
entirely — not an empty array. The report must distinguish "no signature
recorded because this flow predates signing" from "a signature that was
somehow empty"; `undefined` vs `[]` is the signal, matching the same
additive/backward-compatible pattern `FlowGates` already uses
(`src/flow/types.ts:113-147`, "a version number cannot separate 'was written
under the new rules' from 'was written before them'; a field set at `init`
can").

**Gate outcomes — the central negative finding of this research: they are
NOT durably persisted today, only printed/returned.** `complete()`
(`src/flow/service.ts:652-878`) builds `gates: GateOutcome[]` in memory
(`src/flow/service.ts:672`), where `GateOutcome = {name: "acceptance-criteria"
| "pull-request" | "main-merge" | "tasks" | "health" | "security" | "review" |
"base-branch" | "owner", status: "pass"|"fail"|"skipped", detail: string}`
(`src/flow/types.ts:293-306`). That full array is:
- returned in `FlowCompleteResult.gates` (`src/flow/types.ts:363-369`) to
  whatever CLI/MCP caller invoked `complete()` — printed to stdout, not saved;
- optionally rendered into `issueComment` and posted to a **GitHub issue**
  (`buildIssueComment()`, `src/flow/service.ts:1346`, only when
  `flow.source.type === "github-issue"` and `--comment`,
  `src/flow/service.ts:857-863`) — prose on an external tracker, not queryable
  from the project tree, and absent entirely for `description`-sourced flows;
- folded into `flow.history` **only partially**: on success, one event with
  `detail: "all gates passed"` (or with a health-warn note,
  `src/flow/service.ts:844-856`) — no per-gate breakdown at all. On failure,
  one event whose `detail` is the **failing gates only**, joined by `" | "`
  (`src/flow/service.ts:864-873`) — the passing/skipped gates on that attempt
  are not recorded anywhere.

So: **"which gates fired and with what outcome" cannot be reconstructed
historically for any flow today** — not even for the gates that passed.
Minimal additive persistence needed at `flow complete`: push a `gateOutcomes`-
style append-only record (mirroring `FlowSignature`'s shape: `{at, gates:
GateOutcome[], passed, acChecksum}` or similar) onto `FlowState`, written
unconditionally (pass or fail — a failed attempt's outcome is exactly as much
"what happened" as a passed one, the same principle
`src/review/managed.ts:326-331` states for spend-ceiling: "the package is the
record of what the round did, including the record of it running out of
money"). This must be an **opt-in, additive field** like `gates.owner`/
`gates.review` (`src/flow/types.ts:124-147`) so 197+ pre-existing flow
packages are unaffected and the report legitimately prints "not recorded" for
every completion attempt before this lands — it must not backfill or infer
history for them.

### 3. Policy/security decisions recorded

**Deletion journal** (`src/forgetting/journal.ts:111-141`): `DeletionRecord`
carries `requestedBy: Attribution` and `grounds: Attribution`
(`Attribution = {value, basis: "stated"|"derived"|"unknown", detail}`,
`src/forgetting/journal.ts:80-88`) — same shape/doctrine as
`flow/identity.ts`'s `Identity` (the flow module's own header comment says it
"mirrors `src/forgetting/journal.ts`'s `Attribution`... on purpose",
`src/flow/identity.ts:1-9`). This is a real, project-scoped, append-only
record of who requested and on what grounds a knowledge deletion happened —
a legitimate governance input, independent of flow/review.

**Security artifacts**: `src/security/service.ts:245` — `artifactsDir(cwd)/
latest.json`, same single-latest-snapshot convention as health
(`src/health/service.ts:82-83`). No `.metaproject/data/security/artifacts/`
exists yet in this worktree (only `raw/`), i.e. no security run has happened
here — the report's security section must handle "no security run has ever
been recorded" as a real, distinct state.

**Policy engine allow/ask/deny decisions — no durable record exists.**
Searched for `PolicyDecision`, `allow|ask|deny`, `approvals.jsonl`,
`approvalLog`, `recordApproval`, `decisionLog` across `src/`: the only hits
are the shell's live `permissionMode` ("trust"|"ask"|"auto",
`src/lib/permission-mode-config.ts`, `src/commands/shell.ts:2038-2064`) —
an in-session approval posture with a config file for the *mode setting*
itself, but **no append-only log of individual allow/ask/deny decisions was
found anywhere**. This is a real gap, not an oversight in this research:
today there is nothing to report here beyond "not recorded". Unattended-denial
recording is the subject of **flow 290, in progress on a separate branch** —
per the operator's instruction, this is noted as a **future source only**;
the report must not depend on it and must degrade gracefully (report "not
recorded" for this category) until flow 290 lands and defines its own
persisted shape.

### 4. Existing reporting surfaces to extend, and where a new one would fit

- **`keryx health run`** writes both `.metaproject/data/health/artifacts/
  latest.json` and `latest.md` (`src/health/run.ts:485-496`,
  `writeFileAtomic(runJson, ...)` / `writeFileAtomic(runMarkdown,
  renderReportMarkdown(...))`), read back through a shape-guarded
  `readLatest()` (`src/health/service.ts:61-101`) that treats a malformed
  stored report as "unusable evidence, treated exactly like an absent one" —
  never a crash. **This is the sibling pattern the operator asked about**:
  markdown (human) + json (machine) under `.metaproject/data/<domain>/
  artifacts/latest.{md,json}`, with a shape-checked reader. The governance
  report should follow this exact convention:
  `.metaproject/data/governance/artifacts/latest.md` +
  `.metaproject/data/governance/artifacts/latest.json`.
- **`keryx security ...`** follows the same `latest.json` convention
  (`src/security/service.ts:245`), reinforcing it as the house pattern, not
  a one-off.
- **`keryx metrics`** is a differently-scoped command (benchmark manifests)
  and is not a natural home; a new top-level `keryx governance` command (or
  `keryx flow governance`) is a cleaner fit than overloading `metrics`.
- **`keryx status`** (`src/commands/status.ts`) only reports whether the
  `.metaproject` workspace is initialized and which modules are enabled/
  disabled — no per-flow or per-project data at all. Not a natural
  aggregation point, but a one-line pointer to `keryx governance` could be
  added there later (out of scope for this flow).
- **`keryx flow status`** (`src/commands/flow.ts:221`, case `"status"`) reports
  one flow's current state — a natural place to show that single flow's
  governance slice, but not the cross-flow/cross-project rollup the operator
  is asking for.
- **`keryx dashboard build/open`** (`src/commands/dashboard.ts`) renders a
  static `.metaproject/keryx-dashboard.html` from "existing service/data
  files" (`buildDashboard()` in `src/commands/update.ts`, which already reads
  health/security config renderers). It does not currently aggregate spend or
  flow signatures. Once a governance artifact exists at
  `.metaproject/data/governance/artifacts/latest.json`, the dashboard could
  fold it in as a later, separate task — but flow 291 should not be required
  to touch `update.ts` to satisfy its own criteria.
- **Recommendation**: a new command, `keryx governance report` (or
  `keryx flow governance`), read-only, writing the markdown+json artifact
  pair under `.metaproject/data/governance/artifacts/`, sourcing from (1)
  `.metaproject/flows/*/flow.json` (owner, signatures, acConfirmed, gate
  outcomes once persisted), (2) `.metaproject/flows/*/reviews/*/manifest.json`
  (`cost`), (3) `.metaproject/data/trigger/runs.jsonl` (project-wide spend),
  (4) `.metaproject/data/security/artifacts/latest.json` when present, (5)
  the deletion journal when present. It must not re-run any gate or call any
  provider — pure aggregation over already-recorded artifacts (the operator's
  own constraint, and consistent with every reader function found in this
  research: `readTriggerRuns`, `readLatest`, `readFlow` are all pure readers).

### 5. Scope and time window

**Per project**: trivial — enumerate `.metaproject/flows/*` via
`listFlowDirs(cwd)` (`src/flow/store.ts:11-21`, already the primitive `flow
list`/`flow check` use) and read each `flow.json` + its `reviews/*/manifest.json`.

**Cross-project (`keryx projects`)**: `src/commands/projects.ts:1-16` — a
real, user-global registry (`projectRegistryPath()`, `listProjects()`,
populated by `keryx init`) of local project paths on this machine. Spanning
it is *possible* (iterate registered project roots, run the same per-project
aggregation against each, skip any path that is missing/unreadable rather
than failing the whole report — the same discipline `listProjects()` already
applies via its `warnings` callback, `src/commands/projects.ts:73`) but is a
materially bigger surface (N filesystems, N `.metaproject` trees, some
possibly stale/moved). **Recommendation**: v1 scopes to the current project
by default, with an explicit `--all-projects` (or similar) opt-in flag for
the cross-project rollup, rather than making multi-project the default
behavior of a first cut.

**Filters**: by flow (`--flow <id>`), by owner (`--owner <name>`, matching
`FlowState.owner.value`), by date range (`--since`/`--until` against
`flow.createdAt`/`updatedAt`, or per-record `at` fields) are all
straightforward given the data model — every record involved
(`FlowSignature`, `TriggerRunRecord`, `DeletionRecord`) already carries an
`at` timestamp.

### Contentious points carried into AC drafting (see proposed-acceptance-criteria.md)

1. Gate-outcome persistence is genuinely new schema surface on `FlowState`,
   not just a report over existing data — it needs its own additive,
   backward-compatible field and its own opt-in gate flag, mirroring
   `gates.owner`'s introduction in flow 289. This is arguably a separate
   concern from "build a report", but the operator's brief explicitly asks
   for it as part of flow 291's scope ("if they are not persisted today, the
   minimal additive persistence... needed").
2. Whether a *partial* spend record (some review rounds in a flow recorded
   `cost`, others didn't) should report as "not recorded" (honest but maybe
   too pessimistic) or as "partial: $X across N of M rounds" (more useful,
   more complex). Recommendation: report both a summed figure **and** a
   coverage count (`rounds_with_cost/rounds_total`) rather than collapsing to
   either extreme — this matches the existing house style of never silently
   dropping a count (`filesSeen/filesRetained/filesDropped` etc.).
3. Trigger spend is project-wide, never flow-attributed — the report must
   show it as a separate "project-level spend" line, not fold it into any
   flow's total, and must say why (no flow id on `TriggerRunRecord`).
