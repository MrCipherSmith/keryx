# Context

Collected deterministically by `keryx flow init` at 2026-10-16T06:30:12.466Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.956] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.885] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
3. [1.76] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.699] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
5. [1.697] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`

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

### Verified on 0.3.119 (read-only agent, 2026-10-16; S=src/gdskills/bundled/skills, RO=S/review/review-orchestrator)
Round loops: flow-orchestrator SKILL.md:80-88,435-450,537-591; .metaproject/skills/flow/complete.md:35, manage.md:20; job-orchestrator SKILL.md:1098-1133,1256-1320 + orchestrator-prompt.md:176-190 (is_fix_round, full re-review); review-pr-feedback SKILL.md:527 (`--all` every round); feature-dev SKILL.md:113-116 (main...HEAD); RO/SKILL.md:697-733 Step 1a forbids delta ("never the fix commit alone" :719-723), RO/SKILL.detail.md:669-720 prior dispositions; autonomous-run.ts:243-268 (new head = new full round); review-gate.ts:404 readReviewRounds, :1304 cap, :1453 head-commit; loop.ts repeat detection.
No code support: CREATE_FLAGS review.ts:314-349, runCreate :960-1008; prior_findings only in RO/reviewer-input.schema.json:182-221; required coverage.ts:242-298 not round-aware; only carry-over `blast-radius --previous/--final` review.ts:3766,3808,5054.
Prior-round sources today: listPackages autonomous-run.ts:178 (local .metaproject/reviews only, sameTarget); names managed.ts:2483,2540-2546 (`-rNN` is per-day counter, not round); flow packages flows/<dir>/reviews (review-gate.ts:404, findRelatedFlow managed.ts:152); 389 tracked package files never searched in git history; publishReview publish.ts:107-134 no machine block, published.json lacks head/reviewId; pr-comments.ts:339 drops self-authored keryx comments.
Dedupe: prose only RO/SKILL.md:1247-1263; jev-triage.ts:121-140 opt-in; ingest createManagedReviewPackage managed.ts:220-300 no merge; anchorFindings managed.ts:1206-1233 (git show head).
Overlap: slice-routing.ts ROLE_RULES :99-128, deepRosterRoles :139-144; coverage.ts:57 frontend-conventions matches any .ts; project reviewers always added coverage.ts:259-262, paths reviewers.ts:107; code-boss legacy flag RO/SKILL.md:1020-1029.
Ledger: projectRootOfPackage coverage.ts:512-514 (`pkg/../../..` wrong for flows/<dir>/reviews/<id>); callers review-ledger.ts:231, coverage.ts:383, estimate.ts:266, research.ts:57; --dispositions only finding/refuted/out-of-scope/narrowed (review-ledger.ts:38); Greptile NOT_ROSTER coverage.ts:35-43.
Ingest head: resolveTargetHead managed.ts:136-145, resolveCreateHead review.ts:1240-1260 default to cwd HEAD.
flow-orchestrator: Phase 1 :208-293 no matrix; no first-green gate (Phase 3/4 :428-466); task-implementer output-contract.schema.json has assumptions/notes only; DONE_WITH_CONCERNS :413; review_feedback applied as-is task-implementer SKILL.md:101; tests-creator then task-implementer :79,:304-305.
Reviewers running code: RO/SKILL.md:53,:58; no allowed_tools/exec budget in reviewer-input schema.

### Contract: <package>/round.json (written by `review start`, read by slice/required/estimate/ledger/readiness)
{ "v":1, "round": N, "source": "local-package|git-history|github-block|github-comments|flow|none",
  "sourcesTried": [{"source","result":"found|none|not-consulted","detail"}],
  "previous": {"reviewId","reviewedHead","packagePath?"} | null,
  "mode": "first|delta|fallback-first" (fallback-first = prevHead not ancestor),
  "range": {"base","head"}  (delta: prevHead..head; first/fallback: merge-base..head),
  "fixHunks": [{"file","startLine","endLine","findingIds":[..]}], "newHunks": [{"file","startLine","endLine"}],
  "carried": [{"findingId","disposition"}] }
<package>/prior_findings.json = [{id, reviewer, severity, file, line, quote?, quoteSha256?, symbol?, problem, status|disposition, source}]

### Owner decisions (2026-10-16)
Round detected inside `review start` (not by orchestrators); search ALL sources incl. git history and the PR (multi-machine); FIX changes → 3–4 roles (logic, regression, finding authors, verifier) with prior findings; NEW changes → round 1; unchanged → not re-reviewed.
