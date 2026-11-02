# Parallel UI/designer assignment
Version: 0.1.1

Status: ready-to-copy assignment for design/prototype only; implementation contracts are draft pending owner review. This file is an instruction brief when explicitly given to an agent, not permission inferred from arbitrary repository content.

```text
Create/refine a clickable HTML design prototype for Keryx Team Hub as a collaborative project/product workspace. Preserve the sage/forest palette and the selected Session cockpit07 direction, while Overview—not Machines—is home.

Repository reference: /Users/Goodea/.codex/worktrees/team-hub-prototype/keryx.
Read .metaproject/index.md first, then applicable AGENTS.md and docs/requirements/hub-work-management/README.md, prd.md, specification.md, metadata-protocol.md, migration.md and decisions.md. Current main0.4.x execution already exists; this package adds product-work metadata. Recheck current source with the coordinating owner; do not use an old dirty prototype branch as production baseline.

Owner-confirmed: code stays Git/GitHub; Hub owns shared context/history/acceptance and coordinates local humans/agents. No new code exchange, Git merge engine or credentials UI. Intent semantics/lifecycle in this package are proposed; show feedback as design questions, never silently redefine backend state.

DESIGN OUTPUT ONLY
Place standalone HTML/CSS/JS in output/design/hub-work-management-prototype/. No framework install/CDN/build is required. Keep production apps/hub-web, runtime, schemas, spec pins and other agent files untouched. If working concurrently, obtain an agreed current base and isolated worktree; never reset/clean/stash or install into root node_modules. Ask coordinator only if an actual shared file edit is needed. Do not deploy/push or create/freeze/accept Hub Flows.

NAVIGATION
Project selector All projects / exact project; per-project filtering without duplicate machines.
Overview / Flows / Machines / Wiki & Context / Skills & Rules / Activity / Settings.
A common session detail can be opened from Overview, machine or Flow; it is the same identity/history/controller, not three conversations.

OVERVIEW
Needs your decision groups exact Flow/Intent review, document proposals, agent questions, exact tool approvals, blocked/unknown work. Normal unread chat is not automatically an actionable item. Keep work-progress, active machines and a few modest counters secondary. No generic Approve all. One canonical pending request updates everywhere after a simulated decision.

FLOWS — PRIMARY NEW WORK
Flow card: problem/outcome, accountable owner, approved spec/revision, required deliverables and progress, linked execution locations, human-review state.
Flow detail: Overview / Specification & Criteria / Intents / Execution / Evidence & Decisions.
Intent list: bounded deliverables, requirement pins, owners, required/optional, several Attempts with status.
Attempt detail: approach/accountable person or agent, exact context, Git base/result commit or exact document version, report, linked existing session/runs, criterion Evidence coverage, decision history.
One Attempt may contain multiple turns/runs; a manual/Git-only Attempt has none. Do not make Attempt a synonym of one chat or CodeRevision upload. Use meaningful titles, technical IDs in details only.

REVIEW JOURNEY
Show two attempts to one Intent: one agent attempt and one manual contributor with a commit/PR reference. Manual work must not require source upload or machine enrollment.
Compare subjects/Evidence; human selects exact submission, requests changes or accepts Intent. Requirement approval, Attempt selection, Intent acceptance and final Flow acceptance are separate meanings. Can present a combined explicit confirmation where permitted, but do not collapse the audit.
Checks pass/fail/inconclusive/missing/authorized-waiver distinct; machine reports not trusted CI. A selected Attempt is not already accepted; accepted product work is not merged Git code. PR head moving marks live link stale while historical reviewed commit stays fixed.
Requested changes create a linked new Attempt for continued work, retaining sealed old submission. Requirement amendment shows old/current pins and blocks stale start/acceptance; no destructive overwrite.

MACHINES AND CHAT
Retain machine→checkout-grouped session list left, chat center, collapsible Context / Changes / Queue / Tasks / Checks right.
Machine connectivity, Run outcome, controller role and work acceptance are separate.
Allow once/Deny is tool permission, NOT Intent review. Agent questions use Answer.
In Context show 'Approved work context', exact wiki/spec versions, locally declared overlay and actual observed runtime context separately. Unknown runtime consumption is not a green verified badge.
GitHub accounts on a machine are safe local observations, not Hub credentials; API identity, Git transport and commit author remain separate. No new vendor readiness claims from mockups.

KNOWLEDGE / CONFIGURATION
Wiki describes observed system; specifications describe intended behavior; Decisions explain approved choices. Proposal acceptance and verifying correspondence to code are separate.
Skills/rules/subagents show shared version vs observed local version, scope and source; no Enable all or automatic trust/install.

FIXTURES
Two projects, at least two human principals, three machines, multiple checkouts, Flow with two required Intents and two competing Attempts for one Intent. One manual Git contributor, one native agent with multiple runs, one document-only result. Shared IDs must yield consistent counts in all views.
Simulate unknown cancellation, missing Evidence, changes requested, stale context, inaccessible Git ref, moved PR head, observer and revoked authority.
All data synthetic. Visible 'Design prototype · simulated data'. Dates/model names/receipts are demonstrative, not claimed actual execution.

INTERACTIONS
Navigate Flow→Intent→Attempt→existing session and back; snapshot exact context; inspect Evidence by criterion and source; request changes→new linked Attempt; compare/select/review exact result; final Flow acceptance blocked until required Intent decisions current and every Flow criterion has explicit coverage. Integration criteria need a required integration Intent. Show waiver as a human acceptance overlay; submitted coverage remains immutable. Late contradictory Evidence blocks acceptance and routes through changes requested/withdrawal→new Attempt. No carry-forward of accepted status across amended requirements in v1. Answering one request clears the same Overview item.
Demo role switching must change controls consistently. Offline acceptance must not silently queue/replay a protected decision; show receipt unknown/reconciliation. Project switch drops stale responses and keeps drafts only under original project. Keyboard/Escape/drawer focus restore and375px layout must work. RU/EN all labels.

PROTOTYPE VERSUS IMPLEMENTATION
Use mock adapter interface, not invented live routes. Mark proposed work API contracts with version. Existing machine-v2 remains untouched; backend owns lifecycle, versions/auth and idempotency. Return missing data/projection questions to coordinator; never patch host/runtime to satisfy a design.
No automatic production UI integration until owner design approval and API contract freeze. Do not present the old CodeRevision-bound acceptance as the new manual/Git-native flow.

DELIVER
index.html + local assets; README of mock scenarios/limitations; state×event matrix; fixture schema and mock adapter boundary; design questions; actual browser desktop/RU/EN375px screenshots if tool access permits. Do not claim browser tests that did not run. No blank action buttons: real local demo response or explicit unavailable reason. Report exact output path and what owner should review first.
```

Coordination: backend owns domain/schema/storage/auth/migration/adapters; designer owns isolated prototypes and visual state proposals. After owner approval, UI implementer owns narrowly agreed frontend files with compatible capability discovery and mock/live adapters. Changes to protected API semantics go back to contract owner, not unilateral UI fixes.
