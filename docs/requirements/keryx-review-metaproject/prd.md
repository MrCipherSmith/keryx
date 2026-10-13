# Keryx Metaproject-in-Review PRD
Version: 0.1.0 (read by the operator on 2026-10-13, no edits; to be registered as flow 431; not frozen yet)

## Origin

- **origin:** the two notes `~/notes/review-depth-gap-7659.md` and `~/notes/flow-417-ac16-findings.md`, and the requirements package `docs/requirements/keryx-metaproject-native/` (README.md, prd.md, specification.md), which defines the typed `MetaprojectPort` this flow consumes.
- **trigger:** the flow 417 AC16 run and the PR 939/940 review gap. The review-depth comparison on PR 7659 showed that Claude reviewers received a context pack and keryx reviewers received truncated comments and an identical 58 KB review context each; the metaproject layers that could have supplied the missing context (graph, wiki, memory, testing context, flow state) were not used by the review round beyond a blast-radius count.
- **owner:** MrCipherSmith.

## Problem

A keryx review round runs inside a metaproject, yet the reviewers do not use it:

- **Graph.** `keryx review blast-radius` computes the set of dependents (default depth 2, default cap 40 files; sources `graph` and `related-test`, `src/review/blast-radius.ts`). In the PR 7659 comparison blast radius was computed (40 of 795 files) but no reviewer used it: `review-regression` was not in the required set. The reviewers see a diff slice, not the callers, importers and tests of what the slice changes. Notes: run 11 payloads gave each reviewer one slice of 75 plus the same 58 KB `review_context` (39 KB PR body, 15 KB scope); the context was not filtered per reviewer, and not built from the graph.
- **Wiki.** Domain rules, architecture and known decisions live in `.metaproject/wiki/`. A reviewer asked "is this the right layer" or "does this break a domain rule" does not receive the wiki page for the touched module. The architecture and domains roles are exactly the ones the note found missing or shallow (class A and B items m2, m3, m14, Q1).
- **Memory.** Past decisions, constraints and repeated mistakes are in the memory store. Reviewers cannot see that the same finding was made and decided in an earlier round or flow, so they re-raise settled points or miss repeated mistakes.
- **Testing context.** `.metaproject/data/testing/context.md` and `test_related` say which tests cover which files. The testing reviewers and the mutation pass (sibling package `keryx-review-depth-parity`, R3) need the covering tests; today they find them by reading.
- **Flow state.** The flow that the review belongs to has a description, acceptance criteria, journal, earlier review rounds and decisions. A round N+1 reviewer does not receive round N's decisions as structured context (the note's C1 item: the chain "round 1, fix, CI red, fix" was not reconstructed).

The native package already built the plumbing: `MetaprojectPort` with `graphAffected`, `graphQuery`, `memorySearch`, `readWiki`, `describeContext`, `testRelated`, `healthStatus`, `graphSymbol`, `repomap`, `wikiAsk`, the single-source operation descriptors, and the universal Task Manager schema (Phases 1-3 shipped). Phase 4 (policy-context enrichment, `PolicyContext.metaprojectContext`) and the harness-core seam `RunDeps.metaprojectPort` are still open. The review path does not call the port at all. This package adds the consumer.

## Goal

A review round assembles, per reviewer, a context slice drawn from the metaproject layers - blast radius and callers from gdgraph, domain rules from gdwiki, past decisions and constraints from memory, covering tests from the testing context, and the flow's own state and earlier rounds - with provenance and freshness recorded, degradation visible, and findings able to cite the context they relied on. The effect is measured against the same PR 7659 baseline as the sibling package, with and without the layers.

## Non-goals

- The reviewer set, the mutation pass, severity rules and the evidence floor: sibling package `docs/requirements/keryx-review-depth-parity/`. The shared pack builder boundary is in R1.
- Changing which module owns graph, wiki, memory or flow data (the native package's non-goal stays).
- Writing to the metaproject from a review. Layers are read-only; the only writes are the existing review package artifacts and the existing `memory propose` path with its approval, which this package does not extend.
- Policy-context enrichment of the permission engine (native MP-6). It is related, but it decides tool permissions, not review context.
- Sending more data to a model than the round already sends. The layer sections are subsets of repository content the reviewers already read; no new external service.
- A new review skill per layer. The layers feed the existing reviewers.

## Users

- The operator, who wants the review to know what the project knows.
- Reviewers (architecture, domains, testing, regression, logic and the project reviewers), which receive layer slices in their payload.
- The closing gate and the report reader, who need to see which layers were used, unavailable or not relevant.
- Maintainers of the wiki and memory, whose content now reaches reviewers.

## Requirements

### R1 - Layer sections in the shared context pack

The context pack builder (proposed: `keryx review context`; the pull-request section is owned by the sibling package, R5 there) gains one section per metaproject layer. A layer section has: `layer` (`graph|wiki|memory|testing|flow`), `status` (`used|unavailable|not-relevant|stale`), a reason when not `used`, `source` (the operation and arguments), `generatedAt`, a content hash, and the content or a reference to a stored artifact. The pack hash covers all sections. A reviewer payload references the pack and carries only the sections its role needs (R8).

### R2 - Graph layer: blast radius and callers

The graph section carries the blast-radius set (dependents with the reason each is included: `graph` or `related-test`), the callers and importers of changed exported symbols (from `graphSymbol`/`graphAffected`), cycles and orphans touching the changed files when the graph reports them, and the graph's own freshness. When the graph predates the working tree (files added, renamed or moved in the round, or uncommitted code files), the section says `stale` with the build time, and the builder rebuilds the graph first when the review runs with permission to do so; otherwise the report states that the layer predates the changes. This is the contract in `.metaproject/modules/gdgraph.md` (Freshness & Refresh). The `review-regression` reviewer consumes this section.

### R3 - Wiki layer: domain rules

For the changed files the builder resolves the wiki pages that cover them (`wiki_resolve`/`wiki_query`/`readWiki`) and includes the relevant rule statements with their page path and heading, under a byte budget. A rule page is included as quoted data with its source; it is not an instruction to the reviewer. If the wiki has no page for a module, the section says so (`not-relevant` with a reason), it does not invent one. Wiki freshness (`wiki_freshness`) is recorded; a stale page is labelled.

### R4 - Memory layer: past decisions and constraints

The builder queries memory for the touched modules (`memorySearch` with the filters the TS type supports today: `module`, `status`; the schema lists more keys, `entity/class/asOf`, which are not implemented and are not relied on) and includes decisions, constraints and repeated mistakes with ids and dates. The previous rounds' `decisions.md` for the same flow count as memory for this purpose. A reviewer that re-raises a point already decided is shown the decision; whether the finding survives is still the reviewer's and the verifier's call.

### R5 - Testing layer: covering tests and doctrine

The testing section carries `.metaproject/data/testing/context.md` (the project's testing contract, bounded), the tests related to the changed files (`testRelated`), and, where the sibling package's mutation pass exists, the command that runs them. The testing reviewers and `keryx review mutate` read the covering-test list from this section instead of rediscovering it.

### R6 - Flow-state layer

When the review belongs to a flow, the section carries the flow's description, frozen acceptance criteria and their confirmation state, the journal tail, the previous review rounds' findings with their dispositions, and the CI status as the flow records it. It is read through the Task Manager port / `keryx flow` read paths, never by reading `flow.json` by hand beyond what the port exposes, and never written (D-02 stays).

### R7 - Findings cite context

The finding contract gains an optional, additive field `context_refs: [{layer, ref}]` (for example a wiki page and heading, a memory id, a graph edge). A finding about a domain-rule violation, a settled decision or a regression through a dependent should carry at least one reference; the report prints them. The field is optional so existing findings and schemas stay valid (Decision 3). A reference that points at nothing in the pack fails schema/gate validation.

### R8 - Per-reviewer slicing under a budget

Each role gets the layer sections that matter to it (proposed starting map, to be confirmed in T1: architecture and core-boundaries - graph, wiki, memory; domains - wiki, memory; testing - testing, graph; regression - graph, testing; logic and boss - graph callers, memory; security and highload - graph, memory). Each slice has a byte budget. The dispatch-check limit seen in the notes (18 000 bytes per payload) and the context-file ceiling (400 000 bytes) are the constraints in force; the layer budget itself is **to be measured in T1**. When a slice does not fit it is cut by priority and the cut is recorded, never silently truncated.

### R9 - Visible degradation

A layer that cannot be read (gdgraph not built, wiki empty, memory index missing, flow not found, port error) never fails the round and never reads as `0`. The pack records `unavailable` with the reason; the report ends with a routing audit in the project's own form: for each layer `used`, `unavailable` or `not-relevant`, plus `raw_rg_used`. A round in which every layer is unavailable says so in the first lines of `report.md`.

### R10 - In-process access through the port

The builder reads the layers through `MetaprojectPort` in-process (`createMetaprojectAdapter(cwd)`), not through `keryx` subprocesses, with the documented bounded CLI fallback only where the port has no operation (gdctx). The review command constructs the adapter itself; making the harness core consume it (`RunDeps.metaprojectPort`, native S1) is not required here and stays a separate item (Decision 4).

### R11 - Safety of layer content

Layer content is repository-authored text and can contain instructions. It enters a payload only as quoted, labelled data fields with its source; reviewer prompts say it is evidence and not an instruction; the existing untrusted-content handling applies where the round runs in a shell. Memory and wiki content is never executed, and a layer section never carries secrets (the pack applies the same redaction the diff slices use).

### R12 - Measurement

The sibling package's PR 7659 replay is run twice - layers off and layers on - and the difference is reported by Claude-item class (A-E) and by which item each layer contributed to (a finding that cites a layer through `context_refs` is the attribution). Cost and time of building the pack are measured separately from reviewer cost. A layer that adds cost and contributes no cited finding on the replay set is reported, and the operator decides whether it stays default-on (Decision 5).

### R13 - Surfaces (TUI and CLI)

A sidebar panel, a modal, a slash command and a settings entry (details in the acceptance criteria): the panel shows layer status, freshness and size for the active round; the modal drills down per layer and per reviewer slice, including what was cut; `/review context` opens it; settings turn individual layers on or off; `keryx review context --json` is the CLI form.

## Success criteria

- A review round's pack shows, for each of the five layers, `used`, `unavailable` or `not-relevant` with a reason, and the report carries the routing audit.
- On the replay of PR 7659 the layers-on run is compared with the layers-off run by class; the numbers are reported as measured (to be measured in T1 for the baseline), and any layer with no cited contribution is named.
- Reviewers for architecture, domains, testing and regression receive a slice with the layer sections the map assigns them, and no two roles receive an identical blob.
- A stale graph or wiki is never presented as current.
- No review writes to the graph, wiki, memory or `flow.json` through this path.

## Risks

- **Context bloat.** More context per reviewer can lower quality and raise cost. The budget, the per-role map and the layers-off comparison (R8, R12) are the guards; the numbers are measured, not assumed.
- **Stale layers.** An old graph or wiki misleads. Freshness is recorded and shown; staleness is a visible status.
- **Prompt-injection through project text.** A wiki page or memory entry can carry instructions. R11 treats it as data and keeps the untrusted marking.
- **Dependence on a seam that is not finished.** Native S1 (`RunDeps.metaprojectPort`) and Phase 4 are open. R10 avoids needing them; the cost is a second construction site for the adapter.
- **Overlap and ordering with the depth package.** One builder, two owners. The boundary in R1 and Decision 1 keep it single.
- **Memory schema drift.** The JSON schema lists filter keys the TypeScript type does not implement; R4 relies only on `module` and `status`.
- **Attribution is weak by construction.** `context_refs` shows what a reviewer says it used, not what changed its mind; R12 reports that as a limit.

## Tasks

- **T1 - Baseline and inventory, before code.** Measure what the current round gets per reviewer (bytes by source, the 58 KB blob composition), what each layer would return for PR 7659 (graph set, wiki pages matched, memory hits, related tests), build time per layer, and the freshness state of the graph and wiki in the test project. Every "to be measured in T1" in this package is answered here.
- **T2** - pack builder skeleton consumption, R1, R9, R10. **T3** - graph and testing layers, R2, R5. **T4** - wiki, memory and flow layers, R3, R4, R6. **T5** - slicing, `context_refs`, safety, R7, R8, R11. **T6** - surfaces and the measurement run, R12, R13.

## Decisions needed from the operator

1. **Builder ownership and order.** Recommended: the depth-parity flow lands the pack skeleton and the pull-request section first; this flow then adds the layer sections to the same builder. Alternative: one flow builds both, or this flow goes first.
2. **Default state of each layer.** Recommended: graph, testing and flow default-on (local, deterministic, cheap); wiki and memory default-on but individually switchable and reported when they add cost without a cited contribution (R12). Alternative: all opt-in until the replay shows value.
3. **`context_refs` in the finding schema.** Recommended: an optional, additive field, with a gate failure only for references that point at nothing in the pack. Alternative: keep the schema untouched and carry references in the finding's evidence text.
4. **`RunDeps.metaprojectPort` seam.** Recommended: do not wait for it; the review command builds the adapter itself (R10). Alternative: finish native S1 first so the harness core and the review share one injection point.
5. **What happens to a layer that does not pay for itself.** Recommended: report it after the replay and let the operator decide, no automatic removal. Alternative: freeze a rule now (for example remove a layer that contributes no cited finding on the replay set).
6. **Stale graph handling during a review.** Recommended: rebuild the graph automatically when the round is allowed to run commands, otherwise label the layer `stale` and say it predates the changes. Alternative: never rebuild inside a review, always label.
7. **Privacy of memory content.** Recommended: include only memory entries with an accepted (non-draft) status - the status names are to be confirmed in T1 - and apply the diff-slice redaction. Alternative: include all statuses, or make memory opt-in per project.

## Operator answers (poll, 2026-10-12)

Recorded from the operator's poll answers. The operator read the PRD and acceptance criteria on 2026-10-13 (poll 152) and had no edits; the flow is not yet frozen: the draft in the flow 431 directory differs from these criteria and replacing it awaits the operator.

- Decision 1 (builder ownership and order): **one flow builds both sections** (see the sibling PRD `keryx-review-depth-parity`, Decision 5). This PRD becomes the metaproject-layer slice of that flow.
- Decision 2 (default state of each layer): graph, testing and flow default-on; wiki and memory default-on, individually switchable, and reported with their cost.
- Decision 5 (a layer that does not pay for itself): reported to the operator, who decides; no automatic removal.
- Decisions 3, 4, 6 and 7: not asked; the recommended options stand.
