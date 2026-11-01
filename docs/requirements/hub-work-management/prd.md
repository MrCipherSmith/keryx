# PRD: collaborative work and acceptance metadata
Version: 0.1.1

Status: draft for owner review, implementation not started by this package.

## Problem and goal

Keryx0.4.0 can execute local native agent sessions remotely, but it lacks a first-class record of a team's deliverables, competing/retried attempts, declared and observed context and acceptance decisions. Current review is tied to uploaded CodeRevision. A Git-native developer or a document-only contributor cannot provide the same coherent work history without adapting to source-bundle submission.

Goal: anyone with project access can understand what was requested, who attempted it, which context/result was reviewed, what evidence was available and who decided. Reuse existing execution and knowledge services. GitHub remains code transport and integration authority.

Users: product owner defines outcome/accepts work; contributor (human or agent) attempts an Intent; reviewer evaluates exact results; machine owner controls execution; Git-only teammate contributes commits/PRs without enrolling a machine; administrator manages project access.

## Requirements

### R1 — Project work model

Flow owns outcome/specification/criteria; Intent owns a bounded required/optional deliverable; Attempt owns one approach to one Intent. Work records do not require machine enrollment or an agent session. Verification: judged.

### R2 — Versioned requirements

Human-approved immutable Flow/Intent revisions have stable criteria IDs and contextual references. Stale amendments, forks and results cannot silently rewrite frozen requirements. Verification: judged.

### R3 — Exact context

Each started Attempt pins a resolvable ContextSnapshot of declared wiki/spec/rules/skills references and declared Git base refs; absence/unknown stays explicit. Local overlays and actual runtime context are separately attributed. Verification: judged.

### R4 — Collaborative ownership

Record original creator, requested owner and actual actor separately. Authorize all project reads/writes; agents cannot impersonate human reviewers or inherit controller authority as work acceptance authority. Verification: judged.

### R5 — Git-native result subjects

New work can be submitted using immutable commits/trees/documents and a report, with no code snapshot uploaded. PRs/branches are reference observations, not immutable subjects. Multi-repository subjects declare every repository/head. Verification: judged.

### R6 — Attempts and execution

Several Attempts may exist per Intent, one or more runs per Attempt; each bound run maps to at most one Attempt. A session may serve different work over time without changing earlier provenance. Manual/Git-only contributions have no fabricated Run. Verification: judged.

### R7 — Evidence and review

Evidence is immutable, source-attributed, criterion-addressed and exact-subject-bound. Human reviews include pass/fail/inconclusive/missing and explicit waivers only where policy permits. Agent exit0 is not product acceptance. Verification: judged.

### R8 — Human decisions

Selection/requirement approval/Intent acceptance/Flow acceptance and waivers require authenticated authorized humans, exact digests, expected versions and reasons. Rejection/change request does not erase work. Verification: judged.

### R9 — Metadata delivery

UI, CLI/MCP and local agents share domain operations; idempotency, optimistic concurrency, per-project event cursor, durable inbox/outbox and resync tolerate loss/duplicate/reorder without duplicate attempts or lost review. Verification: judged.

### R10 — Mixed teams and Git observations

Manual entry or separately configured read-only Git observer can resolve repository/commit/PR-head observations. External changes mark affected verification freshness; no implicit freeze/acceptance, push, merge or local reset. Verification: judged.

### R11 — Knowledge follow-up

Selected work links a wiki/spec correction proposal or explicit no-update reason. Document proposal review and context verification stay separate from code/work acceptance. Verification: judged.

### R12 — Existing users

Legacy Flows/Evidence/CodeRevisions and frozen machine-v2 remain readable and functional. No automatic historical Intent/Attempt or fabricated decisions; explicit opt-in conversion only on eligible idle unfinished Flows. Verification: judged.

### R13 — Product UI

Overview shows deduplicated authorized actions; Flow pages expose Intents/Attempts/Subjects/Evidence/Decisions. Machine chat remains useful execution UI. RU/EN375px and loading/empty/stale/error/observer states preserve drafts and operation identities. Verification: judged.

### R14 — Storage/security

Keep project metadata bounded, protect credentials locally/server-side, redact outputs and exclude private traces. Snapshot retention preserves every accepted/reviewed subject's meaning. Append history is auditable, not a claim of tamper-proof protection against the OS owner. Verification: judged.

## Success criteria

### Release criteria

- All AC1–AC16 in specification verified with exact candidate evidence and independent review.
- Actual HTTP/storage/restart/concurrent-client tests cover positive and forbidden paths; no v1/v2 regression.
- One Git-only contributor, one local agent and two human principals complete the documented acceptance journey without source upload.
- No deployment, merge or publication occurs as a side effect of metadata review.
- Migration backup/dry-run/rollback gates and UI compatible-mode behavior are documented and tested.

### Outcome criteria

- During the first two-week owner pilot, inspect five completed work items: each should have a reconstructible request/context/result/decision trail. Report gaps; five is a pilot sample, not statistical proof.
- In that pilot, observe whether contributors can hand off one blocked Attempt without reposting context into chat; record the actual intervention needed.
- Reduction of coordination time: not measured — no baseline or instrumentation consent yet; do not claim a percentage improvement.

## Risks and recommendation

Over-modeling small tasks; duplicate GitHub issue status; stale/incomplete context; falsely trusted evidence; ambiguous old data; breaking live parallel UI work. Start with one Intent per small Flow as a UI convenience, but create it explicitly rather than infer historical work. Allow multiple Intents for genuine deliverables. Ship Git commit/document references and manual Evidence first; automated external observers are a separate opt-in phase. Preserve legacy mode until proven conversion.
