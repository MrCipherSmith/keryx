# Managed review — PR #441 (flow 222), prompt-audit narration and tool contracts

Target: branch `flow/222-prompt-audit-narration-and-tool-contracts`, head 427dd83 (merged as 8700156).
Scope: 65 files — bundled skill and rule texts (feature-analyzer, feature-dev, job-orchestrator,
task-implementer, review-orchestrator, interview/interviewer, model-selection.mdc,
api-contracts.mdc) plus their harness builds and the `.metaproject` mirror, and the tool
descriptions in `src/mcp/tools.ts` and `src/gdskills/catalog.ts`.

## Method

Two lenses, dispatched as read-only reviewers, because the change has two independent risks:
a description can be factually wrong about the code it documents, and a deletion can remove
something load-bearing.

1. **mcp-contract-accuracy** — checked each of the nine rewritten MCP descriptions and the two
   catalog entries against the implementation they document, claim by claim. Read-only.
2. **skill-deletion-loss** — attempted to falsify the premise that each deleted block's rule
   survives elsewhere in the same file. Read-only. A first dispatch of this lens hung with no
   output and was killed after producing nothing; it was re-dispatched with a narrower brief.

Every finding below names the file and how the claim was checked. The author independently
re-verified all five major findings against the source before accepting them, rather than
taking the reviewer's word.

## Findings

## F-001 — health.status claims null where the code returns 0

severity: major

- **Location**: src/mcp/tools.ts (health.status description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description states that with no report the numeric fields come back `null`
  rather than zero, and that `null` means unknown rather than healthy.
- **Impact**: `regressions`, `decliningScopes` and `regressedScopes` are typed `number` and
  computed `latest ? … : 0`, so they return `0`. An agent reads `0` as "no regressions" when it
  means "no report" — the exact absent-vs-clean trap this PR named for `health.gate` and then
  reintroduced one tool down.
- **Evidence**: src/health/types.ts:220-222; src/health/service.ts:112-117,126-128. Re-verified
  by the author reading types.ts directly.
- **Class scope**: sites — src/mcp/tools.ts health.status description (the defect);
  src/mcp/tools.ts health.gate description (same absent-report family, states the
  `status: "fail"` shape and is correct); src/mcp/tools.ts gdgraph.cycles and gdgraph.orphans
  descriptions (same absent-source family, silent on it — raised separately as F-006).
  Enumeration method: for every one of the 23 registered tools, read the service method its
  `invoke` calls and compared the description's stated absent-source return shape against the
  declared return type in that module's types.ts. Only the four tools above read a stored or
  built artifact that can be absent; the rest compute live and have no absent-source shape.
- **Suggested fix**: state that `lastRunAt`, `gate` and `projectScore` are null while the three
  counts are `0`, and that the guard is `lastRunAt !== null`.

## F-002 — health.gate points at an MCP tool that does not exist

severity: major

- **Location**: src/mcp/tools.ts (health.gate description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description directs the caller to `health.explain` for per-file findings.
- **Impact**: The registry exposes only `health.gate` and `health.status`; `explain` is a CLI
  subcommand. Written in the same dotted naming as the real tools, it reads as a sibling tool
  and resolves to nothing, so an agent calls something that is not there.
- **Evidence**: src/commands/health.ts:37,143; grep over src/mcp/tools.ts shows `health.explain`
  occurring only inside the description text itself.
- **Class scope**: sites — every cross-reference of the form `<module>.<name>` appearing inside a
  tool description: sac.collaboration→{sac.overview, sac.read, sac.workspaceList},
  sac.overview→sac.read, sac.propose→sac.review, sac.workspaceList→sac.workspaceCreate,
  sac.workspaceShow→sac.workspaceList, sac.workspaceCreate→sac.workspaceList,
  health.gate→{health.status, health.explain}, standard.validate→{health.gate, health.status}.
  Enumeration method: script over src/mcp/tools.ts extracting the registered tool names (23) and
  every dotted identifier inside each description string, then set-membership against the
  registry. Twelve references, one non-member — `health.explain`. Re-run after the fix reports
  zero non-members (the single remaining hit, `receipt.contextAssembly`, is a field path, not a
  tool reference).
- **Suggested fix**: name the `keryx health explain <file-or-module>` CLI command and say
  explicitly that no MCP tool exposes per-file findings.

## F-003 — sac.overview describes truncation where the code refuses

severity: major

- **Location**: src/mcp/tools.ts (sac.overview description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description says a large workspace comes back truncated, to be treated as a
  page rather than an inventory.
- **Impact**: The tool passes no `optional` ids, so every candidate is required and `resolve`
  returns the assembly error whole — `context_overflow`, no manifest, no receipt. An agent
  expecting a partial page gets nothing, and may read the empty result as an empty workspace.
- **Evidence**: src/sac/fwk-service.ts:560-561,590,599-601,604; src/ctx/assembly.ts:11;
  src/sac/fwk-service.test.ts:118-122. Re-verified by the author reading resolve().
- **Class scope**: sites — src/mcp/tools.ts sac.overview description and src/mcp/tools.ts
  sac.read description. Both, and only these two, pass a `budget: { maxItems, maxTokens }` into
  the FWK read service (tools.ts:198 and tools.ts:211) and therefore reach the required-candidate
  overflow path in ctx/assembly.ts:11. Enumeration method: grep for `budget: { maxItems` across
  src/mcp/tools.ts returns exactly those two call sites; sac.collaboration was checked and takes
  no budget (collaboration-service.ts:14 `overview` has no budget parameter), so it is not a
  member of the class. Both members held the defect; both are fixed.
- **Suggested fix**: state that the budget is all-or-nothing, give the failure shape
  `{ code: "context_overflow", requiredId }`, and tell the caller to branch on `code`.

## F-004 — sac.read describes truncation where the code refuses

severity: major

- **Location**: src/mcp/tools.ts (sac.read description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description says a long item is truncated rather than refused, and tells the
  caller to check the returned content before treating it as complete.
- **Impact**: `read()` resolves with `required=[itemId]`, so an oversized item hits the same
  required-overflow path and is refused. Nothing truncates item text anywhere, so the caller is
  told to look for partial content that never exists.
- **Evidence**: src/sac/fwk-service.ts:566,599; src/ctx/assembly.ts:11.
- **Class scope**: sites — src/mcp/tools.ts sac.overview description and src/mcp/tools.ts
  sac.read description. Both, and only these two, pass a `budget: { maxItems, maxTokens }` into
  the FWK read service (tools.ts:198 and tools.ts:211) and therefore reach the required-candidate
  overflow path in ctx/assembly.ts:11. Enumeration method: grep for `budget: { maxItems` across
  src/mcp/tools.ts returns exactly those two call sites; sac.collaboration was checked and takes
  no budget (collaboration-service.ts:14 `overview` has no budget parameter), so it is not a
  member of the class. Both members held the defect; both are fixed.
- **Suggested fix**: state that content is never returned partially and an oversized item is
  refused with `context_overflow`; raise `maxTokens` and retry.

## F-005 — sac.overview invents a summary projection

severity: minor

- **Location**: src/mcp/tools.ts (sac.overview description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description claims overview returns references and summaries, never full item
  bodies, and that `sac.read` is where content comes from.
- **Impact**: overview and read share one resolve/success path and build the identical manifest,
  carrying each fact's full `statement`; `normalizeFwkResult` is a deep clone and strips nothing.
  `sac.read` narrows to one id, it does not reveal content overview withheld.
- **Evidence**: src/sac/fwk-service.ts:597,613,766.
- **Suggested fix**: say overview returns the same full `statement` content as `sac.read` for
  every item that fits the budget.

## F-006 — both gdgraph tools omit the absent-graph case

severity: minor

- **Location**: src/mcp/tools.ts (gdgraph.cycles and gdgraph.orphans descriptions)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: Both say results are as old as the last build, but neither says what comes back
  when no graph was ever built.
- **Impact**: `loadGraphSafe` degrades to an empty graph, so both return `[]`. An empty result is
  indistinguishable from "no cycles" / "no orphans" — the same absent-vs-clean confusion this
  flow set out to fix, left unnamed in the two tools where it also exists.
- **Evidence**: src/mcp/tools.ts:49-55; src/gdgraph/query.ts:115-118.
- **Suggested fix**: state on both that with no graph built the result is an empty list rather
  than an error, and a build must be confirmed before reporting a clean result.

## F-007 — gdgraph.orphans promises entry points it never returns

severity: minor

- **Location**: src/mcp/tools.ts (gdgraph.orphans description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description says entry points, config and scripts legitimately appear here.
- **Impact**: `getOrphans` requires absence from both inbound and outbound sets, so a real entry
  point that imports anything never appears. An agent told to expect them will discount a genuine
  orphan as "probably an entry point", or mis-triage their absence.
- **Evidence**: src/gdgraph/query.ts:24-34.
- **Suggested fix**: say zero-degree only, and that absence from the list is no evidence a file
  is reachable.

## F-008 — sac.read sends the caller to a manifest that carries no ids

severity: minor

- **Location**: src/mcp/tools.ts (sac.read description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description says item ids are discovered through `sac.overview`.
- **Impact**: Facts are projected without `id` and knowHow is destructured to drop it; ids survive
  only in `receipt.contextAssembly.selected`, behind a `./ids/` prefix. An agent searches the
  manifest, finds nothing, and cannot construct an `itemId` — the instruction is not followable.
- **Evidence**: src/sac/fwk-service.ts:613,636.
- **Suggested fix**: name the receipt field and the prefix that must be stripped.

## F-009 — health.gate misquotes the reason literal

severity: minor

- **Location**: src/mcp/tools.ts (health.gate description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The no-report reason is quoted without the backticks the code emits.
- **Impact**: The emitted value contains backticks around the command, so anything matching on the
  documented literal misses.
- **Evidence**: src/health/service.ts:138.
- **Suggested fix**: quote the literal verbatim and say the backticks are part of it.

## F-010 — gdgraph.cycles measures staleness against commits

severity: info

- **Location**: src/mcp/tools.ts (gdgraph.cycles description)
- **Reviewer**: mcp-contract-accuracy
- **Problem**: The description says results "will not reflect uncommitted edits".
- **Impact**: Staleness is defined by the last `keryx gdgraph build`, not by git state — a build
  run after editing does include uncommitted edits, and a graph built before a commit does not
  reflect that commit either. The phrasing points at the wrong boundary.
- **Evidence**: src/mcp/tools.ts (cycles description) against the build-driven staleness model.
- **Suggested fix**: say the result reflects no edit made since that build.

## Second lens — no loss found

skill-deletion-loss returned NOTHING_LOST across all four deletions, each with the surviving text
quoted:

- feature-analyzer: the PRE-STEP VALIDATE CONTEXT checklist (:97-103) requires source path, target
  path, branch and explicit user confirmation before Step 0 begins; reinforced by the frontmatter
  description (:3) and the Input section (:48-51).
- feature-dev: tests-before-implementation survives at :37 and :79; spec-confirmed-before-
  implementation at :51 and :70, both gates preceding Phases 4 and 5.
- job-orchestrator: the deleted ordering survives at :322 ("always — mandatory TDD step before
  every task-implementer wave") and structurally in the plan template's `depends` chain
  (:298-299, executed in order per :458). The reviewer flagged this as the closest call, since
  one imperative sentence became a table row plus an execution-order dependency.
- api-contracts.mdc: all three constraints present and specific in the rewritten paragraph
  (:129-136).

## Disposition

All ten findings are `acted-on`, fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc on `fix/222-mcp-description-accuracy`.
No finding was dismissed, so no human dismissal decision is recorded or required.
`tsc` clean; `bun test src/mcp` 161 pass / 0 fail after the fix.

## Structured findings

```keryx:findings
[
  {
    "id": "F-001",
    "global_id": "2026-09-03-pr-441#F-001",
    "reviewer": "mcp-contract-accuracy",
    "severity": "major",
    "problem": "health.status claimed that with no report the numeric fields come back `null` rather than zero.",
    "impact": "regressions, decliningScopes and regressedScopes are typed `number` (health/types.ts:220-222) and computed `latest ? … : 0` (health/service.ts:112-117), so they return 0. An agent following the description reads 0 as \"no regressions\" when it actually means \"no report\" — the exact absent-vs-clean trap PR #441 named for health.gate, reintroduced one tool down.",
    "suggested_fix": "State that lastRunAt, gate and projectScore are null while the three counts are 0, and that the guard is `lastRunAt !== null` before reading any count.",
    "evidence": "src/health/types.ts:220-222; src/health/service.ts:112-117,126-128",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc (src/mcp/tools.ts, health.status description). Verified independently against health/types.ts before accepting the finding."
    },
    "class_scope": {
      "sites": [
        "src/mcp/tools.ts health.status description (held the defect)",
        "src/mcp/tools.ts health.gate description (same absent-report family; states the status:\"fail\" shape and is correct)",
        "src/mcp/tools.ts gdgraph.cycles description (same absent-source family; was silent — raised as F-006)",
        "src/mcp/tools.ts gdgraph.orphans description (same absent-source family; was silent — raised as F-006)"
      ],
      "enumeration_method": "For each of the 23 registered tools in src/mcp/tools.ts, read the service method its invoke() calls and compared the description's stated absent-source return shape against the declared return type in that module's types.ts. Only these four read a stored or built artifact that can be absent; every other tool computes live and has no absent-source shape, so the class has exactly four members."
    }
  },
  {
    "id": "F-002",
    "global_id": "2026-09-03-pr-441#F-002",
    "reviewer": "mcp-contract-accuracy",
    "severity": "major",
    "problem": "health.gate directed the caller to `health.explain` for per-file findings. No such MCP tool exists.",
    "impact": "The MCP registry exposes only health.gate and health.status; `explain` is a CLI subcommand (src/commands/health.ts:37). The reference is written in the same dotted naming as the real tools, so it reads as a sibling tool and resolves to nothing — an agent calls a tool that is not there.",
    "suggested_fix": "Name the `keryx health explain <file-or-module>` CLI command and say explicitly that there is no MCP tool for per-file findings.",
    "evidence": "src/mcp/tools.ts:624 (the claim); src/commands/health.ts:37,143; registry has only health.gate/health.status",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc. Verified independently: grep over src/mcp/tools.ts shows health.explain occurring only inside the description text itself."
    },
    "class_scope": {
      "sites": [
        "sac.collaboration -> sac.overview, sac.read, sac.workspaceList",
        "sac.overview -> sac.read",
        "sac.propose -> sac.review",
        "sac.workspaceList -> sac.workspaceCreate",
        "sac.workspaceShow -> sac.workspaceList",
        "sac.workspaceCreate -> sac.workspaceList",
        "health.gate -> health.status, health.explain (the defect)",
        "standard.validate -> health.gate, health.status"
      ],
      "enumeration_method": "Script over src/mcp/tools.ts extracting the 23 registered tool names and every dotted <module>.<name> identifier appearing inside a description string, then set-membership against the registry. Twelve references, exactly one non-member: health.explain. Re-run after the fix reports zero non-members (the one remaining hit, receipt.contextAssembly, is a field path rather than a tool reference)."
    }
  },
  {
    "id": "F-003",
    "global_id": "2026-09-03-pr-441#F-003",
    "reviewer": "mcp-contract-accuracy",
    "severity": "major",
    "problem": "sac.overview claimed an over-budget workspace comes back truncated, as a page.",
    "impact": "The tool passes no `optional` ids, so every candidate is required (fwk-service.ts:599-601) and resolve returns the assembly error whole (`if (\"code\" in assembly) return assembly`): context_overflow, no manifest, no receipt. An agent expecting a partial page gets nothing and may read the empty result as an empty workspace.",
    "suggested_fix": "State that the budget is all-or-nothing, that the failure shape is { code: \"context_overflow\", requiredId }, and that the caller must branch on `code` before reading the manifest.",
    "evidence": "src/sac/fwk-service.ts:560-561,590,599-601,604; src/ctx/assembly.ts:11; src/sac/fwk-service.test.ts:118-122",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc. Verified independently by reading fwk-service.ts resolve/overview: optional is empty, so required is true for every candidate."
    },
    "class_scope": {
      "sites": [
        "src/mcp/tools.ts:198 sac.overview (held the defect)",
        "src/mcp/tools.ts:211 sac.read (held the defect)"
      ],
      "enumeration_method": "grep for 'budget: { maxItems' across src/mcp/tools.ts returns exactly these two call sites into the FWK read service, which are therefore the only tools reaching the required-candidate overflow path at src/ctx/assembly.ts:11. sac.collaboration was checked and excluded: collaboration-service.ts:14 overview() takes no budget parameter. Both members of the class held the defect; both are fixed."
    }
  },
  {
    "id": "F-004",
    "global_id": "2026-09-03-pr-441#F-004",
    "reviewer": "mcp-contract-accuracy",
    "severity": "major",
    "problem": "sac.read claimed a long item is truncated rather than refused.",
    "impact": "read() resolves with required=[itemId] (fwk-service.ts:566), so an item over maxTokens hits the same required-overflow path and is refused with context_overflow. Nothing truncates item text anywhere. An agent told to \"check the returned content before treating it as complete\" would look for partial content that never exists.",
    "suggested_fix": "State that content is never returned partially and that an oversized item is refused with context_overflow; tell the caller to raise maxTokens and retry.",
    "evidence": "src/sac/fwk-service.ts:566,599; src/ctx/assembly.ts:11",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc, same verification as F-003."
    },
    "class_scope": {
      "sites": [
        "src/mcp/tools.ts:198 sac.overview (held the defect)",
        "src/mcp/tools.ts:211 sac.read (held the defect)"
      ],
      "enumeration_method": "grep for 'budget: { maxItems' across src/mcp/tools.ts returns exactly these two call sites into the FWK read service, which are therefore the only tools reaching the required-candidate overflow path at src/ctx/assembly.ts:11. sac.collaboration was checked and excluded: collaboration-service.ts:14 overview() takes no budget parameter. Both members of the class held the defect; both are fixed."
    }
  },
  {
    "id": "F-005",
    "global_id": "2026-09-03-pr-441#F-005",
    "reviewer": "mcp-contract-accuracy",
    "severity": "minor",
    "problem": "sac.overview claimed it returns references and summaries, never full item bodies, and that sac.read is where content comes from.",
    "impact": "overview and read share one resolve/success path and build the identical manifest, which carries each fact's full `statement` (fwk-service.ts:613). normalizeFwkResult is a deep clone and strips nothing. sac.read narrows to one id; it does not reveal content overview withheld. The description invents a projection that does not exist.",
    "suggested_fix": "Say overview returns the same full statement content as sac.read for every item that fits the budget.",
    "evidence": "src/sac/fwk-service.ts:597,613,766",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc. Verified independently by reading the manifest construction in fwk-service.ts success()."
    }
  },
  {
    "id": "F-006",
    "global_id": "2026-09-03-pr-441#F-006",
    "reviewer": "mcp-contract-accuracy",
    "severity": "minor",
    "problem": "gdgraph.cycles and gdgraph.orphans did not say what comes back when no graph was ever built.",
    "impact": "loadGraphSafe degrades to an empty graph (src/mcp/tools.ts:49-55), so both return []. An empty result is indistinguishable from \"no cycles\" / \"no orphans\" — the same absent-vs-clean confusion the flow set out to fix in health.gate, left unnamed in the two tools where it also exists.",
    "suggested_fix": "State on both that with no graph built the result is an empty list rather than an error, and that a build must be confirmed before reporting a clean result.",
    "evidence": "src/mcp/tools.ts:49-55; src/gdgraph/query.ts:115-118",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc on both descriptions."
    }
  },
  {
    "id": "F-007",
    "global_id": "2026-09-03-pr-441#F-007",
    "reviewer": "mcp-contract-accuracy",
    "severity": "minor",
    "problem": "gdgraph.orphans claimed entry points, config and scripts legitimately appear in the list.",
    "impact": "getOrphans requires absence from both inbound and outbound sets (src/gdgraph/query.ts:31-33), so a real entry point that imports anything never appears. An agent is told to expect entry points and will either discount a genuine orphan as \"probably an entry point\" or mis-triage their absence.",
    "suggested_fix": "Say zero-degree only, and that a real entry point with outbound edges will not appear — so absence from the list is no evidence of reachability.",
    "evidence": "src/gdgraph/query.ts:24-34",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc."
    }
  },
  {
    "id": "F-008",
    "global_id": "2026-09-03-pr-441#F-008",
    "reviewer": "mcp-contract-accuracy",
    "severity": "minor",
    "problem": "sac.read said item ids come from sac.overview, but the overview manifest contains no ids.",
    "impact": "Facts are projected to { statement, evidence, observedAt, expiresAt, freshness } and knowHow is destructured to drop `id` (fwk-service.ts:613). Ids survive only in receipt.contextAssembly.selected, prefixed `./ids/`. An agent following the description searches the manifest, finds nothing, and cannot construct an itemId.",
    "suggested_fix": "Name the receipt field and the `./ids/` prefix that must be stripped.",
    "evidence": "src/sac/fwk-service.ts:613,636",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc."
    }
  },
  {
    "id": "F-009",
    "global_id": "2026-09-03-pr-441#F-009",
    "reviewer": "mcp-contract-accuracy",
    "severity": "minor",
    "problem": "health.gate quoted the no-report reason without the backticks the code actually emits.",
    "impact": "The emitted value is \"no report; run `keryx health run` first\" (health/service.ts:138). Anything matching on the documented literal misses.",
    "suggested_fix": "Quote the literal verbatim, backticks included, and say so.",
    "evidence": "src/health/service.ts:138",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc."
    }
  },
  {
    "id": "F-010",
    "global_id": "2026-09-03-pr-441#F-010",
    "reviewer": "mcp-contract-accuracy",
    "severity": "info",
    "problem": "gdgraph.cycles measured staleness against commits (\"will not reflect uncommitted edits\") rather than against the last build.",
    "impact": "A build run after editing does include uncommitted edits, and a graph built before a commit does not reflect that commit either. The phrasing points at the wrong boundary.",
    "suggested_fix": "Say the result reflects no edit made since that build.",
    "evidence": "src/mcp/tools.ts (cycles description); staleness is defined by `keryx gdgraph build`, not by git state",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 0d341e3e2ab5f20ae2e8eba65dad1544ab0fedbc."
    }
  }
]
```
