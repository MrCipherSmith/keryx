# Контекст этапа 5
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 1, 2, 4. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

---

# Implementation inventory — phase 5 (AC-27 / AC-28 / AC-29)

Produced 2026-09-07 on `codex/agent-first-core`, read-only. Normative sources read:
`docs/requirements/keryx-agent-first-core/artifact-lifecycle.md` (the real text for all three
norms — "Changeset и optimistic concurrency", "Предлагаемый atomic protocol", "Handoff и
продолжение", "Архивирование, замена и забывание"), `specification.md` §3/§4/§7/§8,
`decision-traceability.md` rows 27–29, `prd.md` AFC-27..29.

Everything labelled **measured** was driven through a live surface or a real composition in
this session. Everything else is read from code without executing it. The two are never mixed.

## 0. Method

`keryx ctx rg` for all code search; `keryx ctx read --mode compact` for large files. Runtime
probes lived in the scratchpad and built `ProposalLifecycleService` with the **real**
`createRealWikiOwnerWriter` — the same composition `createHarnessProposalLifecycleService`
hands to CLI and MCP — driving `review()` from **separate OS processes** against one shared
temp project root. No project file was modified by any probe.

## 1. AC1 / AC-27 — atomic change, concurrency, receipts

### 1.1 Surfaces a real caller uses

Enumerated by `bun src/cli.ts --help`, `bun src/cli.ts workspace`, `keryx ctx rg` for
`name: "` across `src/mcp/tools.ts` and `src/harness/tool/builtin/*.ts`, then
`keryx ctx rg createHarnessProposalLifecycleService` to find which adapters reach the real
owner writers.

There is exactly **one** knowledge-write path in the product, reached from four adapters:

| Surface | Entry | Reaches real owner writers |
|---|---|---|
| CLI | `keryx workspace propose` / `confirm-review` / `review` — `src/commands/workspace.ts:121,182` | yes |
| MCP | `sac.propose`, `sac.review` — `src/mcp/tools.ts:232,263` | yes |
| Agent-native harness tool | `workspace_propose` — `src/harness/tool/builtin/workspace-lifecycle-tool.ts:230` | propose only; **no** `workspace_review` tool exists, deliberately (SLATE-20 requires a shell-minted confirm token) |
| SAC facade | `src/sac/service.ts`, `src/sac/harness-facade.ts` | re-export only |

`keryx serve` exposes only `/v1/status`, `/v1/projects`, `/v1/turns`
(`src/lib/serve-server.ts:393`) — no knowledge write. MCP resources (`src/mcp/resources.ts`)
are read-only `keryx://` file projections.

`createLocalProposalLifecycleService` is **not** on any live path (its own doc comment says
so, `proposal-lifecycle.ts:539-548`) and all its owner adapters return
`owner_writer_unavailable`. Do not measure against it.

### 1.2 Does a concurrency primitive exist? Yes.

`withFileLock` (`src/lib/fs.ts:49-99`) is a real cross-process lock: `mkdir` acquisition,
`owner.json` carrying pid + token, mtime heartbeat, stale reclaim guarded by
`process.kill(pid, 0)`, 5 s default timeout. Call sites: `src/session/slate.ts`,
`src/session/external-slate.ts`, `src/flow/service.ts`, `src/sac/workspace-service.ts`,
`src/sac/proposal-lifecycle.ts`, `src/sac/review-confirm-token.ts`,
`src/lib/serve-credential.ts`, `src/gdskills/learn.ts`, `src/gdskills/project-skills.ts`,
`src/harness/tool/builtin/spawn-subagent-tool.ts`.

It is **not** used by any owner writer (`wiki-owner-writer.ts`, `memory-owner-writer.ts`,
`skill-owner-writer.ts`), nor by `src/wiki/service.ts`, `src/memory/write.ts`, gdgraph build,
or `rules sync`.

A receipt **is** stored, keyed and replayable:

- durable owner receipt at
  `.metaproject/workspaces/<ws>/<owner>-write-receipts/<idempotencyKey>.json`
  (`proposal-evidence.ts:22`), consulted by each writer's `recover()` before `persist()`;
- SAC-side write result at `<proposalId>.<sha256(idempotencyKey)>.write-result.json`,
  consulted by `targetWriteOrStale` via `loadWriteResult` (`proposal-lifecycle.ts:353`);
- terminal transition in `activity.jsonl`, replayed by idempotency key before any gate
  (`proposal-lifecycle.ts:131-143`);
- receipt-to-intent binding verified by `receiptMatchesIntent` / `bindingHash`
  (`guarded-owner-writer.ts:71-88`).

### 1.3 Measured behaviour, clause by clause

| AC-27 clause | Result | Evidence |
|---|---|---|
| two processes from the same base: one applies, the other conflicts | **HOLDS** | Two OS processes, same proposal, different idempotency keys, concurrent: one returned `accepted` with a bound receipt, the other `{"ok":false,"code":"conflict","message":"proposal already has a terminal transition"}` |
| independent targets do not conflict | **HOLDS (2-way)** | `proposal-a` replay and `proposal-b` fresh accept, concurrent, separate processes: both `accepted`. They serialise on the shared per-workspace `activity.jsonl.lock`; at higher fan-in the 5 s `withFileLock` timeout becomes the limit — not measured beyond 2 |
| restart returns the same receipt | **HOLDS for a committed accept; FAILS in one crash window** | A fresh process replaying the winning key returned a byte-identical receipt (same `completedAt`, same `bindingHash`). The failing window is §1.4 |
| a package built on a bad base is not partially applied | **NO SUBJECT** | There is no multi-change package. `expectedVersion` appears nowhere in `src/`; neither does `baseVersion` nor `version-conflict`. One proposal writes exactly one target; `changes[]` from `change-set.schema.json` is unimplemented |
| target-side optimistic concurrency (`expectedVersion`) | **DOES NOT EXIST — measured** | Pre-created `.metaproject/wiki/decisions/sac-proposal-a.md` holding `FOREIGN CONTENT FROM ANOTHER WRITER`, then accepted `proposal-a`. Result: `{"ok":true,"status":"accepted"}` and the foreign bytes were silently replaced. No conflict, no diff reference, no base digest |

The concurrency control that exists is on the **proposal** (one terminal transition per
proposal, under a per-workspace ledger lock), not on the **target content**. AC-27's "два
процесса от v7" is about a target's version. That guarantee is absent.

### 1.4 Measured crash-recovery defect (AC-27, clause 4)

`persist()` in every owner writer orders: write the target (`wiki-owner-writer.ts:132`),
*then* write the receipt (`:142`). Same ordering in `memory-owner-writer.ts:131,145` and in
`skill-owner-writer.ts`. Nothing holds a lock across those two writes and nothing is staged.

I reproduced the resulting on-disk state — removed the owner receipt, the
`.write-result.json` sidecar and the terminal ledger record, keeping the approval /
write-intent / decision sidecars, which is exactly what a crash in that window leaves — and
replayed with the same idempotency key from a new process:

- `persist()` **ran a second time**: the wiki page was rewritten and a new receipt appeared
  with `completedAt` `2026-09-07T12:13:14.148Z` against the first accept's
  `2026-09-07T12:13:12.747Z`. Two mutations, two different receipts, one idempotency key.
- the replay then died with `{"ok":false,"code":"conflict","message":"immutable lifecycle
  record already exists"}` on the pre-existing `.decision.json`.
- `activity.jsonl` was left holding only `proposal-write-intent`. The proposal is now
  **permanently unacceptable**: it reads as pending forever while its target has in fact been
  written twice.

Honest caveat: I recreated the post-crash file state rather than killing a process mid-write.
The window is real by construction (two unsynchronised `writeFileAtomic` calls with no
intervening durability barrier), but the timing was simulated, not raced.

The existing test `src/sac/proposal-lifecycle.test.ts:82` ("crash recovery obtains a durable
owner receipt without a duplicate mutation") does **not** cover this. It uses an in-process
`durableReceipt` variable as the recovery store and crashes *inside* `write` — it asserts the
seam, never the real filesystem ordering.

### 1.5 Defect-class exposure — AC-27

- **Class 1 (capability in a helper nothing calls):** not present on this path.
  `withFileLock`, `receiptMatchesIntent`, `loadWriteResult` and the owner `recover()` hooks
  are all reachable from CLI and MCP; I drove them.
- **Class 2 (failure indistinguishable from legitimate success):** **present.** The blind
  target overwrite in §1.3 returns `status: "accepted"` — a lost external write reported as a
  clean success. The crash-window replay in §1.4 additionally reports a *second* mutation as
  the same operation.

### 1.6 Files that would change

- `src/sac/guarded-owner-writer.ts` — carry `expectedVersion` / base digest on
  `OwnerWriteIntent` and into `bindingHash`
- `src/sac/wiki-owner-writer.ts`, `src/sac/memory-owner-writer.ts`,
  `src/sac/skill-owner-writer.ts` — read the target base under a lock, compare, refuse on
  mismatch, order the receipt durably with respect to the target write
- `src/sac/proposal-evidence.ts` — base-digest helper alongside
  `readVerifiedProposalEvidence`
- `src/sac/proposal-lifecycle.ts` — `version_conflict` in `ProposalLifecycleError`'s code
  union; make `reviewDecision` / `writeImmutable` idempotent on replay instead of `conflict`
- `src/lib/fs.ts` — only if `withFileLock` genuinely needs a new option (contended, see §5)
- tests: `src/sac/proposal-lifecycle.test.ts`, `src/sac/wiki-owner-writer.test.ts`,
  `src/sac/memory-owner-writer.test.ts`, `src/sac/skill-owner-writer.test.ts`, plus a new
  two-process test

## 2. AC2 / AC-28 — changed grounds, unknown, no rights, no stale pass

### 2.1 Surfaces

`context.handoff` / `context.resume` from the spec **do not exist** as any command, tool or
resource. The clauses land on these existing surfaces instead:

| Clause | Live surface | Implementation |
|---|---|---|
| consumer sees changed grounds before acting | `keryx workspace catch-up [--json]`; `keryx gdgraph affected/query`; `keryx wiki *` | `src/sac/catch-up.ts`, `ProposalLifecycleService.isEvidenceFresh` (`proposal-lifecycle.ts:329`), `src/gdgraph/staleness.ts`, `src/wiki/staleness.ts` |
| a check that could not run is unknown, not passed | `keryx health gate/status`, `keryx test analyze/status`, `keryx security *` | `src/health/gate.ts` (`GateStatus = pass/warn/incomplete/fail`), `src/testing/types.ts` (`TestingContext.status: complete/incomplete`), `src/security/service.ts` |
| package grants no rights of its own | `keryx workspace confirm-review` then `review` | `src/sac/review-confirm-token.ts`, `writeApproval` / `ensureWriteIntent` |
| old test pass not reused for new code | `keryx test status`, `keryx health run` | `loadCompatibleTestingReport` (`src/testing/service.ts:346`) vs `loadTestingReport` (`:322`) |
| the handoff package itself | — | **absent.** `CollaborationActivity` has a `handoff-recorded` kind (`src/sac/collaboration-service.ts:9`) but nothing produces it |

### 2.2 Measured behaviour

- `keryx workspace catch-up --json` on this repo returns a schema with an explicit
  **`unknown`** bucket alongside `proposals` / `blocked` / `unboundCandidates`. The tri-state
  posture exists here and is live.
- `keryx health status`: `tests: missing`, `coverage: missing`. `keryx health gate` then
  printed `gate: pass` / `PASS: no gate conditions triggered`, exit 0. Cause read in
  `src/health/config.ts:33-34` — `tests` and `coverage` default to `required: false` — and in
  `computeGate` (`src/health/gate.ts`), which emits a reason line for a *skipped* optional
  source but nothing at all for a *missing* one. `health status` discloses it; the gate does
  not.
- `keryx test status` printed `latest status: pass` dated **2026-09-06** against a working
  tree with roughly fifty modified files, with no staleness qualifier and no `gitRef` shown.
  It uses the ungated `loadTestingReport` (`src/commands/test.ts:197,256,328`).
- `keryx gdgraph affected src/sac/proposal-lifecycle.ts` emitted no staleness note. This is
  **contract-correct, not a defect**: `git status --porcelain` shows only ` M` content edits,
  and `gdgraph/staleness.ts` documents that a pure content edit with an unchanged import set
  does not invalidate a file-level graph.

### 2.3 Which parts already hold

- **Unknown rather than passed** substantially holds where it was actually built:
  `checkGraphStaleness` returns `fresh | stale | unknown` and its doc comment states a git
  failure is *never* allowed to fall through to fresh; `TestingContext.status` distinguishes
  `incomplete` from a clean empty scan; `computeGate` escalates a broken **required** source
  to `incomplete` with `coverage: "incomplete"`, and `src/commands/health.ts:127` maps
  `incomplete` to a blocking exit independent of `--strict`.
- **Old test pass not reused for new code** holds at commit granularity through
  `loadCompatibleTestingReport`, which returns `null` when `report.gitRef !== currentGitRef`.
  It does **not** hold at dirty-tree granularity, which the spec explicitly requires
  ("Revision без dirty/untracked inventory недостаточна", specification.md §4).
- **Package grants no rights**: the confirm token is single-use, TTL-bounded, scoped to
  workspace + proposal + idempotency key, mintable only from a shell command
  (`review-confirm-token.ts`). `interactive: false` denies a fresh accept unconditionally
  (`proposal-lifecycle.ts:171`), and `runRemoteTurn` hardcodes `interactive = false`.

### 2.4 Defect-class exposure — AC-28

**Class 1 — present, three instances:**

1. `checkGraphStaleness` (`src/gdgraph/staleness.ts:121`) — the tri-state result with
   per-trigger reasons, written explicitly for AFC-10/AC3 — has **no caller outside its own
   test and the boolean wrapper in the same file**. Every live path
   (`src/commands/gdgraph.ts:12,423`; `src/wiki/staleness.ts:38`) uses `graphMaybeStale`,
   which collapses `unknown` into `true` and discards the reasons. The honest three-state
   answer never reaches a caller.
2. `CollaborationService.record()` — the only writer of a `handoff-recorded` activity — has
   no live caller. `keryx workspace collaboration` and MCP `sac.collaboration` expose
   `overview()` only, so the activity list is structurally always empty.
3. `loadCompatibleTestingReport` is bypassed by `src/health/sources/tests.ts:198`, which
   falls back to the ungated `loadTestingReport` whenever `ctx.scopeSelector.kind` is neither
   `changed` nor `project` — so `keryx health run --scope <s>` reuses a test pass from any
   commit.

**Class 2 — present, two instances:**

1. `keryx test status` renders a stale pass as a current pass (measured, §2.2).
2. `keryx health gate` renders "two of seven sources produced nothing" as `PASS: no gate
   conditions triggered` (measured, §2.2).

### 2.5 Files that would change

- `src/gdgraph/staleness.ts` + `src/commands/gdgraph.ts` — surface `StalenessCheck` (status
  plus reasons) rather than the boolean; keep `graphMaybeStale` as a shim for
  `src/wiki/staleness.ts`
- `src/testing/service.ts`, `src/testing/types.ts` — add a dirty/untracked fingerprint next
  to `gitRef`
- `src/commands/test.ts` — route `status` through the compatibility check and print freshness
- `src/health/sources/tests.ts` — remove the ungated fallback at `:198`
- `src/health/gate.ts` — emit a reason line for a *missing* optional source
- `src/sac/catch-up.ts` — resume-style drift over a recorded snapshot, not only per-proposal
  evidence hashes
- tests: `src/gdgraph/staleness.test.ts`, `src/testing/service.test.ts`,
  `src/health/health-truthful-gate.test.ts`, `src/health/sources/tests.test.ts`,
  `src/sac/catch-up.test.ts`

## 3. AC3 / AC-29 — forgetting

### 3.1 Surfaces

**There is no knowledge-forget surface at all.** Enumerated by `keryx ctx rg` over `src/**`:

- `tombstone` — **zero occurrences** anywhere in `src/`.
- `forget` — only `keryx projects forget <id>` (`src/commands/projects.ts`,
  `src/lib/project-registry.ts`), which drops a row from the user-global project registry.
  Unrelated to knowledge content.
- Memory lifecycle (`src/memory/lifecycle.ts:15-21`) is `draft | accepted | conflict |
  deprecated | superseded`. Archive and supersede exist; **delete does not**, and
  `superseded` is terminal.
- Ctx handles / continuations from the spec (`handle-invalid`, `handle-expired`) do not exist
  — zero occurrences.

The nearest existing destructive operation is `wikiPruneOrphans`
(`src/wiki/service.ts:325-344`), which removes an *unmodified generated draft* component page
when its module leaves the graph. It touches the file only: no index invalidation, no cache
sweep, no tombstone, no residual verification.

### 3.2 The derivative inventory a forget must reach

Nothing sweeps any of this today:

- `.metaproject/wiki/**` source pages plus the wiki index and reverse-link indexes
- `.metaproject/memory/**` plus `.metaproject/data/memory/index/index.json` and
  `.metaproject/data/memory/embeddings/`
- `.metaproject/data/gdgraph/storage/*.jsonl` and `artifacts/*`
- `.metaproject/data/gdctx/raw/*.log` and `artifacts/*.md` — **measured: 6923 raw log files
  in `.metaproject/data/gdctx/raw` on this checkout, and `keryx ctx rg` over `src/ctx/*.ts`
  finds no retention, prune, maxAge or cleanup logic whatsoever.** Every routed command's raw
  output is retained indefinitely. A forget that does not sweep this has not forgotten.
- session slates and transcripts (`src/session/store.ts`, `src/session/slate.ts`)
- `.metaproject/workspaces/<ws>/proposals/*`, `*.note.txt` sidecars, `activity.jsonl`,
  `<owner>-write-receipts/*`
- MCP `keryx://` resource projections (`src/mcp/resources.ts`) — read-only file passthrough,
  so no tombstone check at resolve

### 3.3 Behaviour, clause by clause

| AC-29 clause | Result |
|---|---|
| deleted content disappears from index / cache / handles / handoff | **NOT IMPLEMENTED** — no operation deletes knowledge content |
| tombstone contains no text | **NO SUBJECT** — no tombstone type exists |
| unreachable store yields incomplete, not success | **NO SUBJECT for forget.** The posture exists elsewhere and is the precedent to copy: `src/security/service.ts` (13 `incomplete` sites), `src/testing/service.ts:113`, `src/health/gate.ts` |
| external copies and git history are not promised erased | **VACUOUSLY HELD** — nothing claims anything yet. Note what this clause forbids: overclaiming. A forget that reports "forgotten everywhere" is the defect; one that reports `incomplete` with a `checked / failed / unreachable / remaining` inventory is correct. Design to that from the first commit, not as a later honesty pass |

### 3.4 Defect-class exposure — AC-29

- **Class 1:** not applicable — there is no helper to be stranded. Everything is absent.
- **Class 2:** the risk is total. AC-29's "unreachable store gives incomplete" **is** defect
  class 2 stated as a requirement. With 6923 unswept gdctx logs and no retention model, the
  default failure mode of any first implementation is a forget that reports success over
  stores it never reached. The deny-epoch ordering the spec mandates — content-free tombstone
  **first**, so a parallel query or cache rebuild cannot resurrect the record, source and
  derivatives **after** — is the only structure that avoids it, and it has to exist in the
  first commit rather than be retrofitted.

### 3.5 Files that would change

Almost all new: `src/knowledge/forget/**` (locator resolution, preview, tombstone store, deny
epoch, residual verification) and `src/commands/forget.ts`, plus a tombstone-check seam in
each resolver — `src/memory/search.ts`, `src/memory/store.ts`, `src/wiki/service.ts`,
`src/ctx/*`, `src/mcp/resources.ts`. Retention/prune for `src/ctx/` is a prerequisite, not a
nicety.

## 4. Proposed parallel lanes

Disjoint file sets. A, B, C, D can start simultaneously.

### Lane A — target-side optimistic concurrency (AC1)

Owns `src/sac/guarded-owner-writer.ts`, `src/sac/wiki-owner-writer.ts`,
`src/sac/memory-owner-writer.ts`, `src/sac/skill-owner-writer.ts`,
`src/sac/proposal-evidence.ts` and their `*.test.ts`.

Done when an accept over a target whose bytes changed since the proposal's base returns a
typed `version_conflict` carrying the current revision and a diff reference rather than a
silent overwrite; a two-process test proves it; `expectedVersion=null` still creates when the
target is absent.

Size: **medium**. The seam exists; the base digest must be captured at preview time, which
means `create()` has to record it.

### Lane B — crash-window idempotency (AC1)

Owns `src/sac/proposal-lifecycle.ts` (the `targetWriteOrStale` / `writeApproval` /
`ensureWriteIntent` / `reviewDecision` / `writeImmutable` block) and
`src/sac/proposal-lifecycle.test.ts`.

Done when the §1.4 reproduction replays to the *original* receipt instead of re-running
`persist()`, and no replay leaves a proposal holding a write-intent with no terminal
transition; covered by a test that reproduces the on-disk state rather than an in-process
seam.

Size: **large**. This is the "reads as one sentence, costs a week" item — it needs staged
bytes and a durable intent ordering (artifact-lifecycle.md steps 3–6), not a patch.

**Ordering: Lane B lands before Lane A's final integration.** Both bear on
`targetWriteOrStale`'s contract. `src/sac/proposal-lifecycle.ts` is contended: give it to B
exclusively; A extends `OwnerWriteIntent` in `guarded-owner-writer.ts` and B threads it.

### Lane C — freshness honesty (AC2)

Owns `src/gdgraph/staleness.ts`, `src/commands/gdgraph.ts`, `src/testing/service.ts`,
`src/testing/types.ts`, `src/commands/test.ts`, `src/health/sources/tests.ts`,
`src/health/gate.ts` and their tests.

Done when `keryx gdgraph` surfaces `unknown` distinctly from `stale` with reasons;
`keryx test status` refuses to render a report from a different `gitRef` or a dirty tree as a
current pass; `health run --scope <s>` no longer reuses an incompatible report; and
`keryx health gate` names a *missing* optional source.

Size: **medium**, mostly plumbing an existing honest primitive out to a surface. Keep
`graphMaybeStale` as a shim so `src/wiki/staleness.ts` does not become contended.

### Lane D — forget: tombstone, deny epoch, residual verification (AC3)

Owns new `src/knowledge/forget/**`, new `src/commands/forget.ts`, retention for `src/ctx/`,
and the tombstone-check seam in `src/memory/search.ts`, `src/wiki/service.ts`,
`src/mcp/resources.ts`.

Done when `forget preview` enumerates every reachable derivative from §3.2; commit writes a
content-free tombstone **before** any deletion; every resolver consults it; the report
distinguishes `checked / failed / unreachable / remaining`; an unreachable store yields
`incomplete`; and nothing claims external copies or git history were erased.

Size: **very large — plausibly larger than the other three combined.** A new module, a new
retention model for a 6923-file store, and a seam in every resolver. "AC-29 is one sentence"
is a trap.

### Lane E — handoff / resume (AC2, optional for this phase)

Owns `src/sac/catch-up.ts`, `src/sac/collaboration-service.ts` and their tests.

Done when a package records a snapshot and `resume` reports `changed / missing / unknown`
against the current checkout; a check that cannot run is `unknown` rather than a silent reuse
of a prior PASS; and `CollaborationService.record` gains a live caller or is removed.

Size: **medium**, and genuinely optional — AC-28's other three clauses can close without it,
but the "different checkout" clause cannot.

## 5. Contended files and ordering

- `src/sac/proposal-lifecycle.ts` — Lane B **exclusively**. Lane A must not edit it.
- `src/lib/fs.ts` — shared by five subsystems. **No lane owns it.** If `withFileLock` needs a
  new option, raise that as a separate, single, reviewed change before the lanes start.
- `src/wiki/service.ts` — Lane D only (tombstone seam). Lane C must not touch it.
- `src/testing/service.ts` — Lane C only.
- Ordering: B before A's integration. C, D and E are independent of everything.

## 6. Honest sizing

- **AC1 is two items, not one.** Target-side CAS (Lane A, medium) and crash-window atomicity
  (Lane B, large) are separate problems that happen to share a sentence.
- **AC2 is mostly plumbing.** The honest primitives already exist and are stranded; this is
  the cheapest real progress in the phase.
- **AC3 has zero implementation** and is the largest single piece of work here. Nothing about
  its one-sentence criterion reflects that.

## 7. Routing audit

- `graph_used: yes` — `keryx gdgraph affected`, also used as an AC-28 measurement.
- `wiki_used: no — not-relevant` — this is a source-behaviour inventory over code the wiki
  does not describe; the normative source is `docs/requirements/keryx-agent-first-core/`, read
  directly.
- `ctx_used: yes` — `keryx ctx rg` for every search, `keryx ctx read --mode compact` for large
  files.
- `raw_rg_used: no`.
