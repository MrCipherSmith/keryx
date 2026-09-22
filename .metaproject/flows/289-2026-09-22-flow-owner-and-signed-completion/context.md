# Context

Collected deterministically by `keryx flow init` at 2026-09-22T22:30:55.138Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.966] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.865] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.861] SAC: Anchors: root: /Users/tsaitler.aleksandr/goodea/keryx tre… (task-note/accepted) - task-notes/sac-proposal-b051e66aebd74f37.md
   Flow 188 (count .ts files in src/harness/provider, read-only) completed. Direct child .ts files excluding .test.ts and subfolders: fake-provider.ts, make-provider.ts, provider-port.ts, single-turn.ts, tool-call-linking.ts, types.ts = 6 files. Subfolders (openai/, ollama/, gemini/, anthropic/, compat/, fixtures/) and their contents excluded per the no-subfolders constraint. Task required read-only; rounds T1-T4 (plan/test/PR) are generic placeholders not applicable to this read-only counting task.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-5c74a3f7b3c7414b/session-evidence/4f3b7eb5-a514-476e-8732-6087df8710d6.wrap-up.md (sha256 a12235fc2638f84f9fc1305cc5fff51a0563003ee785b92a1c81a02c961927a3) author=unknown confirmedBy=unknown
4. [1.785] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
5. [1.763] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-22T20:37:55.124Z)
- refresh: `keryx health run`

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

Research for flow OWNER + SIGNED COMPLETION (phase 1, research/draft only). Every
path below is relative to the worktree root (`/home/altsay/keryx-owner`).

### 1. How flow.json is created and mutated

- Schema/types: `src/flow/types.ts:138-175` (`FlowState`), `:64-98` (`FlowTask`),
  `:122-136` (`FlowGates` — the existing "opt-in flag written at creation"
  pattern). JSON Schema mirror: `src/flow/schema.ts:40-222`
  (`flowStateSchema()`), kept byte-consistent with a docpack copy at
  `docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json`
  (asserted by `src/flow/schema.test.ts`).
- `flow.json` is written only by `src/flow/store.ts:205-213` (`writeFlow`) and
  read only by `:124-134` (`readFlow`), which migrates in-memory on every read
  via `migrateFlow` (`:136-203`). D-02 invariant (stated in
  `src/flow/schema.ts:46`): "WRITES go only through FlowService (D-02:
  flow.json is never hand-edited)".
- `flow init` (`src/flow/service.ts:149-229`) sets `schemaVersion: 1` and
  `gates: { tasks: true, review: true }` (service.ts:189-194) — the precedent
  for "a field only `flow init` can set, because that's the only moment that
  distinguishes 'created under new rules' from 'created before them'"
  (comment at types.ts:115-120 explains why this can't be schemaVersion-keyed:
  migration makes every on-disk flow v2 on read, so a version number can't
  separate old from new). `--base` is the closest existing precedent for an
  optional, additive, CLI-settable field surfaced at `flow init`: wired at
  `src/commands/flow.ts:226-256` (`runInit`, `--base` flag → `baseBranch`),
  stored optionally (`FlowState.baseBranch?`, types.ts:171) with an explicit
  comment on why it's spread-not-assigned under `exactOptionalPropertyTypes`
  (service.ts:208-212).
- `flow ac confirm` — `src/flow/service.ts:478-489` (`acConfirm`). Writes
  `flow.acConfirmed[target] = { at: now(), ...(note ? { note } : {}) }`. **No
  identity is recorded today** — only a timestamp and an optional free-text
  note. Shape: `FlowState.acConfirmed: Record<string, { at: string; note?:
  string }>` (types.ts:152), schema at schema.ts:93-105.
- `flow implemented` — `src/flow/service.ts:547-581`. Sets `flow.pr.url` and
  status; no identity recorded.
- `flow complete` — `src/flow/service.ts:583-761`. Runs the gate list (below),
  transitions to `done` or back to `in-progress`; no identity recorded on the
  terminal transition either. The only "who" available anywhere in a
  completed flow.json today is `flow.history[].event/detail`
  (`FlowHistoryEvent`, types.ts:105-109) and those entries carry no actor
  field — they're written by `save()`/`transition()` (service.ts ~119-146)
  purely as `{ at, event, detail }`.
- **Schema version + migration**: yes, both exist and are exactly the
  precedent to reuse. `FlowState.schemaVersion: 1 | 2` (types.ts:139).
  `migrateFlow` (`store.ts:138-152`) upgrades v1→v2 **in memory only, never
  rewriting the file on read** ("Never call writeFlow from a read path",
  store.ts:132); the next mutation persists the upgraded shape. Every v2 field
  is optional/additive (comment block schema.ts:1-23, "TM-01" —
  `docs/decisions/keryx-harness/TM-01-task-manager-evolution.md` is the
  decision doc for that precedent). `migrateFlow` throws on any
  `schemaVersion` other than 1 or 2 (store.ts:142-146) and `service.ts:872-873`
  (`check()`) flags an unknown schemaVersion as a `schema` issue. Owner/
  signature fields should follow the *same* additive-v2 pattern (no new
  schemaVersion needed) — they are optional, so old flow.json files keep
  validating and loading unchanged; only a genuinely new *shape* (not an
  optional field) would justify a v3.

### 2. Completion gate list

- Gate names are a closed union: `GateOutcome.name` = `"acceptance-criteria" |
  "pull-request" | "main-merge" | "tasks" | "health" | "security" | "review" |
  "base-branch"` (types.ts:230-242). A new gate (e.g. "owner" or "signature")
  is added by (a) extending this union and (b) pushing a `GateOutcome` into
  the `gates: GateOutcome[]` array built inside `complete()`
  (service.ts:595-717) — each existing gate is a self-contained `try {
  gates.push(...) } catch { gates.push(unevaluableGate(name)) }` block, e.g.
  the AC gate at service.ts:597-618, the opt-in task gate at service.ts:671
  (`gates.push(taskGate(flow))`), the opt-in review gate at
  service.ts:673-695. `passed = gates.every(g => g.status !== "fail")`
  (service.ts:719) gates the `done` transition.
- The **opt-in-at-creation** pattern (`FlowGates.tasks` / `FlowGates.review`,
  types.ts:122-136, set only by `flow init`) is the existing, load-bearing
  precedent for "a gate that must never retroactively fail packages created
  before it existed": absence ⇒ gate reports `skipped`, never `fail`. An
  owner/signature gate should very likely follow the same shape
  (`FlowGates.owner?` / `FlowGates.signature?`) rather than being
  unconditionally enforced, given 197 existing flow.json packages in this
  repo have no owner field at all.
- `unevaluableGate(name)` — the shared helper used when a gate throws, so an
  unexpected error is recorded as `fail` without leaking the caught error's
  message (comment at service.ts:611-618, "caught-value-free helper").

### 3. Identity sources keryx already reads

- **git `user.name`/`user.email`**: read in exactly one production path,
  `src/commands/sync.ts:482-493` (`gitUserEmail`, `git config user.email`),
  feeding `src/forgetting/journal.ts` and `src/forgetting/service.ts`'s
  attribution logic (see below). No production code reads `git config
  user.name`; `src/lib/git-env.ts:10` and `src/testing/templates.ts:212` only
  mention it in comments about *rewriting* identity for test fixtures.
- **`gh api user`**: used for GitHub PR-comment self-identification, not for
  any flow/AC concept. `src/commands/review.ts:1157` ("Could not resolve the
  acting GitHub login (`gh api user --jq .login`). Pass `--self <login>`.")
  and `src/review/pr-comments.ts:429` (same rationale: without a resolved
  self-identity, "our own replies are indistinguishable from a reviewer's").
  This is a real, GitHub-authenticated identity — stronger than a local git
  config value — but currently scoped to the review/PR-comment collector only.
- **Existing "who confirmed this" precedent — `Attribution` type**
  (`src/forgetting/journal.ts:80-88`): `{ value: string | null; basis:
  "stated" | "derived" | "unknown"; detail: string }`, with `resolveRequestedBy`
  (`journal.ts:143-187`) applying a strict priority: `--actor` CLI flag
  (`stated`) → `KERYX_ACTOR` env var (`stated`) → `git config user.email`
  (`derived`, **never promoted to stated**) → `unknown` (never fabricated).
  The doc comment is exactly the honesty framing this flow needs to copy:
  *"The git identity is deliberately the weakest input and is never promoted:
  it answers 'whose checkout is this', and a deletion made by an autonomous
  agent in someone's working copy would be attributed to that person as
  though they had asked for it. That is the fabrication this function
  refuses to commit."* (journal.ts:155-159). Wired end-to-end in
  `src/commands/sync.ts:302-303` (`envActor: process.env["KERYX_ACTOR"]`,
  `gitIdentity: await gitUserEmail(cwd)`) and `src/forgetting/service.ts:191-194`.
  This `Attribution`/`resolveRequestedBy` shape is the strongest, most
  directly reusable precedent in the codebase for "record which SOURCE an
  identity claim came from, and never overclaim" — it should very likely be
  mirrored (not necessarily imported cross-module) for flow owner/signature.
- **SAC workspace roles**: `src/sac/workspace-service.ts:20`
  (`WorkspaceMember = { subject: string; role: "owner" | "editor" | "viewer" }`)
  and `src/sac/index.ts:548-552` (`SacRole`, `TrustedActorContext = { subject:
  string; authenticationMethod: "local-os" | "trusted-harness";
  issuedRoleRevision: string; requestCorrelationId: string }`,
  `SacVerifiedPrincipal`). **Important terminology collision**: SAC's "owner"
  role is a workspace-membership permission level (can write), not an
  accountable human identity for a piece of work — do not conflate the two in
  naming. The genuinely relevant part is `authenticationMethod: "local-os" |
  "trusted-harness"` — SAC already models the distinction between a locally
  OS-authenticated caller and a harness-issued (agent) identity, which is the
  closest existing analogue to "a human confirmed this" vs "an agent ran
  this" at the type level.
- **Strongest existing "a human, not an agent, did this" mechanism — SAC
  confirm token** (`src/sac/review-confirm-token.ts:1-135`): `keryx workspace
  confirm-review` mints a short-lived (2 min, `CONFIRM_TOKEN_TTL_MS`,
  review-confirm-token.ts:16), single-use, hashed token
  (`mintConfirmToken`, :58-83) that is only reachable via a **risk:"shell",
  approval-gated** CLI command — never exposed as an MCP/agent-native tool
  (comment at :1-10: "so a caller that only has MCP/tool access cannot mint
  one on its own, and a caller that also has shell_exec still needs a human
  to approve that one command"). `consumeConfirmToken` (:98-135) verifies and
  burns it. This is real, structural proof of human presence — not a claim —
  but it is heavyweight machinery (TTL store, idempotency-keyed receipts,
  approval gate wiring) built for one specific high-stakes SAC accept path.
  Reusing the *same* token-minting infrastructure for flow AC-confirm/
  complete would be the strong option; reusing only the *pattern*
  (shell-only, approval-gated verb that a bare agent/MCP caller can't
  self-invoke) at lower cost is the cheap option. See "Design choices" in the
  final report — this is the main contentious call for the implementation
  phase.
- **Trivially forgeable**: `git config user.name`/`user.email` (any process
  can rewrite the repo's local config, and journal.ts already treats it as
  weak/`derived`), `--actor`/`--owner`-style CLI flags and `KERYX_ACTOR` (an
  agent can set these itself — journal.ts still calls them `stated`, because
  "stated" only means "explicitly claimed", not "verified"), and a
  `sacReviewConfirmation: true` flag an agent sets on itself
  (`src/commands/permission-mode.ts:61,76,95`) — explicitly called out in
  `src/sac/review-confirm-token.ts:1-4` as "proves nothing about a human
  actually being present", which is exactly why the token exists.
  **Not trivially forgeable**: the SAC confirm token (shell-only,
  approval-gated, TTL'd, single-use) and a `gh api user` login IF it is
  resolved through an interactively-authenticated `gh` session rather than a
  caller-supplied value.

### 4. Dashboard / `flow status` rendering

- `keryx flow status <id>` — `src/commands/flow.ts:342-394` (`runStatus`).
  Prints `status`, `source`, `AC: frozen/not frozen, N confirmed`
  (:350-351), `PR` (:352), then a `Tasks (done/total)` section and a
  `Recent history` section (last 5 `flow.history` entries, :388-393). This is
  exactly where `owner:` and `signed:` lines belong — same line style as the
  existing `AC:`/`PR:` rows. No owner/signature concept exists today.
- `keryx dashboard` (`src/commands/dashboard.ts:1-82`) is a thin wrapper that
  calls `buildDashboard()` from `src/commands/update.ts` and opens the
  resulting static HTML — not read for this pass (out of scope: it consumes
  whatever `update.ts` renders from flow state; adding owner/signature to
  that HTML is a downstream, mechanical follow-on once the field exists on
  `FlowState`, not something this research needs to trace further for the AC
  draft).
- `flow list`/`FlowSummary` (types.ts:177-193) currently carries
  id/slug/title/status/dir/tasksDone/tasksTotal/duplicateId — no owner field;
  whether the summary line should show the owner is an implementation-phase
  call, not required by the operator's ask (which named `flow status`
  explicitly).

### 5. Existing docs/wiki discussion of ownership or accountability

- No existing doc or wiki page discusses a **human, accountable flow owner**.
  `keryx wiki ask "flow owner accountability signature human confirmation"`
  returned only: (a) the SAC review-confirm-token interactive-boundary
  description (`wiki/components/src-sac.md`, matches finding above), (b) a
  "what each layer owns" table in `wiki/architecture/wiki-graph-sac.md`
  meaning *module* ownership (which subsystem is authoritative for which
  data), not human accountability, (c) generic `src/flow`/`src/commands`
  component reference pages with no owner/signature content.
  `docs/requirements/**` and `docs/decisions/**` use the word "owner" ~837
  times but essentially always in the **module/subsystem** sense (e.g. "Flow
  follow-up | Flow owner | Renders, validates, guards, writes, receipts." in
  `docs/requirements/shared-agent-context-promotion-integrity/specification.md:15`)
  — i.e. "which code module owns writing this artifact type", not "which
  human is accountable for this unit of work". **Do not reuse the word
  "owner" assuming existing docs already define it the way this flow means
  it** — it will need its own definition, and naming may want to consider
  something less overloaded (e.g. `accountable`/`responsible`) though
  `owner` is what the operator asked for by name.
- `TM-01-task-manager-evolution.md` (`docs/decisions/keryx-harness/`) is the
  decision doc that already establishes the "additive v2 field, absence ≠
  invalid, migration is in-memory-only" contract this flow's fields should
  follow; a new decision doc (or an addendum to TM-01) is the natural place
  to record the owner/signature contract, following the same numbering
  convention (`docs/decisions/keryx-harness/TM-02-...md` or similar) — an
  implementation-phase call.
