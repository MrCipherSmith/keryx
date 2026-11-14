Partial review: pr-files waived by the operator: Раунд 1 проверял PR на e9ac9253 (69 файлов); 10 файлов фикс-раунда, merge main и правки зависимостей проверит раунд 2

Reviewed `e9ac9253fde7` — the PR has since moved on to `274174521` (a one-line lint fix in a test helper).
**Changes requested — 1 Major, 13 Minor.** The report-text escapes are gone and waivers are item-scoped, but `review publish` still skips the research-error gate that `review complete` runs, so AC5's "one gate" does not hold yet.
Reviewed `e9ac9253fde7` against `66ee001` · round 1 · 69 files · CI red at review time: typecheck-and-tests (lint `no-explicit-any`, fixed in `274174521` after the round).
Evidence level: ran — `keryx review verify-run` probes for ARCH-1 and SEC-1 (both confirmed), `keryx review mutate` over 32 mutants on 11 test files (19 killed, 13 survived)
Plan estimate vs actual: plan 12-30 min (24 dispatches); actual 13 min from first to last raw reply (27 replies); pauses over 10 min: 0
опциональные роли не запускались: review-clean-code, review-style (включить: --style или --with-role <роль> у `keryx review start|required`, либо reviewRoles в routing.config.json)

### Major

**review-architecture-w3:ARCH-1. `review publish` does not run the research-error gate.** `src/review/close-gates.ts`, in the diff.
`evaluateCloseGates` runs the research gate only through the `beforeReadiness` callback that `completeManagedReview` passes; `publishReview` passes none and has no closed-status precondition. Probe (`research-evidence/verify-ARCH-1-1.txt`): a ready package with `artifacts.research = "elsewhere.json"`, or with the dispatch declaration deleted, is refused by `complete` and then posted by `publish` without `--partial` (posted=true, READY).
Fix: move the tagged research evaluation into `evaluateCloseGates`; untagged errors always refuse, `relaxReadiness` skips only tagged ones; add publish cases to the parity test.

### Minor

<details open><summary><b>Minor (13)</b></summary>

- **review-architecture-w1:F-001. Readiness item 7 still says "the report's head is the PR head".** `SKILL.detail.md` (both copies) and the item title in `src/review/readiness.ts`, in the diff — item 4 was reworded, item 7 was not. Also raised as review-logic-w2:F-001. Fix: reword to the recorded head vs the PR head; operator waives `head` otherwise.
- **review-degradation-w2:F-001. `--help` and the `CompleteManagedReviewOptions.head` JSDoc still describe the removed first-line escape.** `src/commands/review.ts`, `src/review/managed.ts`, in the diff. Also raised as review-logic-w3:F-002. Fix: say a non-PR head fails item `head`, which only the operator waives, and name `--head-reason`.
- **review-logic-w3:F-001. `--head-reason` is accepted and silently dropped.** `src/commands/review.ts`, in the diff — without `--head`, or with the recorded head, the quote is stored nowhere. Also raised as review-logic-w4:F-002. Fix: refuse `--head-reason` that does not relabel a recorded head.
- **review-architecture-w2:F-002. `SPAWN_SUBAGENT_IGNORED_FIELDS` is a list but the tool reads only `[0]`.** `src/harness/tool/builtin/spawn-subagent-tool.ts`, in the diff. Fix: notice every ignored field present.
- **review-degradation-w2:F-002. `createSpawnSubagentTool` lost its JSDoc** to the new constant, in the diff. Also raised as review-architecture-w2:F-004. Fix: move the constant above the factory's doc block.
- **review-architecture-w3:ARCH-2. Research-error tags are untyped strings.** `src/review/research.ts`, in the diff. Fix: type them as readiness item ids.
- **review-degradation-w3:DEG-1. `withoutPartialHeader` is a dead export.** `src/review/readiness.ts`, in the diff. Fix: delete it.
- **review-degradation-w3:DEG-2. The ready-package fixture exists twice.** `src/review/complete-head-gate.test.ts`, in the diff. Fix: import it from `close-gates.test-helpers.ts`.
- **review-testing-practices-w1:F-001. "`--head` does not loosen the gate" passes on the relabel refusal, not the head gate.** `src/review/complete-head-gate.test.ts`, in the diff. Fix: pass `headReason` and assert the `--waive head` refusal.
- **review-testing-practices-w2:TP-1. The `reviewers`, `files-covered` and `blast-radius` tags have no test.** Mutants w2-M-10..M-13 survived. Fix: one waive-and-close case per tag.
- **review-testing-practices-w2:TP-2. The verifier fixture uses `verification: { verdict }`, a shape the producer cannot emit.** `src/review/readiness.test.ts`, in the diff. Fix: follows SEC-1 — a verification must name a method and evidence.
- **review-testing-practices-w2:TP-3. Two of the four host-question notice sources are untested.** `src/review/publish.ts`, in the diff; mutants w2-M-17/M-18 survived. Fix: cover the premise and top-level coverage-waiver sources.
- **review-logic-w4:F-001. Packages closed through the removed escapes now read NOT READY and publish refuses them.** `src/review/readiness.ts`, in the diff. Operator decision: keep the behaviour, note the break and its repair in the CHANGELOG.

</details>

<details><summary><b>Pre-existing (not blocking)</b></summary>

- **review-security-code-w3:SEC-1 (major). The operator-only gates trust agent-writable package JSON.** A `readiness_waivers` entry written into `manifest.json`, a rewritten `target.head`, or `"verification": {}` in `findings.json` lets a plain `review complete` close READY (probe: `research-evidence/verify-SEC-1-1.txt`, 4 pass). Present at base `66ee001`; this PR narrows it. Operator decision: close it in this PR (scope widened in flow 488).

</details>

<details><summary><b>Refuted and narrowed</b></summary>

- **review-architecture-w2:F-001. Challenged** — the tier→`model_class` mapping in prose was a deliberate plan choice; moving rules into code is flow 490's outcome. Operator: flow 490.
- **review-security-code-w2:F-001. Challenged** — with no recorded head, item `head` already passes without `--head`; filling it is the flow 448 recovery the operator kept. Operator: flow 490 (record `head_override` with `from: null` there).

</details>

<details><summary><b>Verified clean</b></summary>

- Regression (blast radius, cap dropped nothing): every caller of `completeHeadGate`, `ReadinessOptions`, the tagged research errors and the publish gate traced and holding (review-regression w1–w3).
- Highload and performance: no hot-path or allocation change of note (one info on the always-run research gate).
- Injection, secrets, path traversal, digest binding of the host question: clean (review-security-code).

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`, managed package `2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166`.
- **Scope:** `66ee001..e9ac9253fde7`, round 1, PR #1166. Unchecked commits: `274174521` (lint fix, after the round).
- **Models:** claude-opus-5-5 — all reviewers, verifier and premise judge.
- **Subagents:** review-architecture, review-degradation, review-highload, review-logic, review-performance, review-regression, review-security-code, review-testing-practices (24 dispatches over 4 slices); review-verifier ×2; review-premise ×1.
- **Fallback:** every reviewer via `general-purpose` because Claude Code has no bundled keryx agent types.
- **Not run:** none.
- **Verification:** annotate. Confirmed 2, refuted 0, unverifiable 0.
- **Premise:** 17 claims over 21 findings — 13 upheld, 2 challenged, 2 owner-decision; operator answered all four held findings.
- **Mutation:** 32 mutants, 19 killed, 13 survived (`research-evidence/mutation-1.md`).

</details>

```json keryx:findings
[
  {
    "id": "review-architecture-w1:F-001",
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": null,
    "quote": "7. `head` — the report's head is the PR head.",
    "problem": "The PR moves the moved-head escape out of report text: SKILL.md now says the report's first line 'unlocks nothing' and only an operator waiver of `head` passes. In the same readiness checklist, the PR rewrote item 4 to say report text no longer passes it, but item 7 still defines `head` as 'the report's head is the PR head'. That reads as a property the agent can satisfy by editing report.md, which is the exact path this flow removes. Plan T5 lists 'items 4 and 7' for update; only item 4 changed.",
    "impact": "Two parts of the same skill contract disagree about what satisfies the `head` gate. An agent reading the checklist alone is pointed back at the report line, so it hits a refusal it was told it could avoid. The code gate holds, so there is no bypass. The cost is one wasted close attempt and wording that drifts from the code.",
    "suggested_fix": "Rewrite item 7 in the same style as item 4, for example: '7. `head` — the PR head has not moved or merged since the reviewed SHA, or the operator waived the item; the report's first line informs readers but no longer passes it.' Apply the same edit to the bundled copy under src/gdskills/bundled/skills/review/review-orchestrator/ so both copies stay byte-identical.",
    "evidence": "slice-02 SKILL.detail.md hunk: the item 4 line is replaced (diff lines 1040-1041) and item 7 is unchanged context (diff line 1045). SKILL.md:131 (new) and templates/review-report.md (new lines) both say the report line no longer unlocks the gate. flows/488 plan.md T5: 'Update the guide checklist (... items 4 and 7 ...)'. The feature commit 7684b3dce changes SKILL.detail.md by one line in each copy (git show --stat), which confirms item 7 was not touched.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:776",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md (byte-identical copy)"
      ],
      "enumeration_method": "Read the readiness checklist items 1-12 in the slice hunk. Only item 7 names report content as the pass condition. The bundled copy is byte-identical under the document:build-parity rule cited in flows/488 context.md. I did not read docs/docs/guides/review-with-a-record.md items 4/7 because they are outside this slice."
    }
  },
  {
    "id": "review-architecture-w1:F-002",
    "severity": "info",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": null,
    "quote": "complex reviewers and `review-premise` `expert` (tier `deep`; `keryx review tier --premise`)",
    "problem": "The new dispatch line maps tier `deep` to model_class `expert`. Step 6 in the same file still tells the orchestrator that `deep` means 'your runtime's lighter/most capable class if its dispatch tool offers one'. spawn_subagent accepts light|standard|expert|frontier (spawn-subagent-tool.ts:1130), so its most capable class is `frontier`, not `expert`. The two instructions name different classes for the same tier on the same host.",
    "impact": "Observation only: the plan picked deep->expert on purpose (flows/488 plan.md T9), and model_class is a recommendation capped by the configured subagents category. The open question is which instruction wins when the two disagree on keryx shell.",
    "suggested_fix": "Either have Step 6 note that keryx shell maps deep to `expert`, or add the reason for expert over frontier to the dispatch line. Both are possible without adding a line, which respects the line ceiling.",
    "evidence": "SKILL.md:105 (context, unchanged) vs SKILL.md:118 (changed). Accepted values per the spawn_subagent tool description at src/harness/tool/builtin/spawn-subagent-tool.ts:1129-1130. The plan's mapping is in flows/488 plan.md item 5.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w2:F-001",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": null,
    "quote": "On `spawn_subagent` pass its tier as `model_class` on every reviewer",
    "problem": "The rule that maps a review tier to a spawn model class (light->light, standard->standard, deep->expert) is written only as orchestrator prose. `keryx review tier` (src/commands/review.ts ~1792-1845) still emits `tier: light|standard|deep` with no `model_class`, and nothing in src/review maps tier to model_class (keryx ctx rg for model_class over src/review returns no match). The orchestrator is told to paste the tier block from the command, then translate one of its values by hand into a different vocabulary. This is the same 'rule in prose, not in code' duplication the PR's own audit (docs/analysis/review-process-audit-2026-11-12.md, Architecture section) names as the root architectural defect.",
    "impact": "An orchestrator that passes the printed tier verbatim (`model_class: deep`) is refused by spawn_subagent ('model_class must be light, standard, expert, or frontier'), so the failure is loud, not silent; but the contract test only checks the field NAME, so a future change to MODEL_CLASSES or the tier set can drift from the prose without any test failing, and `keryx review tier` / plan cost estimates still describe a vocabulary the dispatch does not use.",
    "suggested_fix": "Have `keryx review tier` print a `model_class` field derived in code from the tier (one mapping function next to the tier decision, deep->expert), make SKILL.md say 'pass the printed model_class', and extend review-spawn-field-contract.test.ts (or a unit test of the mapping) to assert every tier maps into MODEL_CLASSES.",
    "evidence": "SKILL.md:118 (head) carries the mapping in prose; spawn-subagent-tool.ts rejects non-MODEL_CLASSES values; src/commands/review.ts tier output (tier_reasons at 1792, 1833, 1845) has no model_class; rg 'model_class' in src/review: 0 matches.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w2:F-002",
    "severity": "minor",
    "file": "src/harness/tool/builtin/spawn-subagent-tool.ts",
    "line": null,
    "quote": "const legacyTierMigrationNotice = input[SPAWN_SUBAGENT_IGNORED_FIELDS[0]] !== undefined",
    "problem": "SPAWN_SUBAGENT_IGNORED_FIELDS is exported as the list of fields the tool accepts and ignores, and the contract test treats every entry as ignored. But the tool's only consumer indexes `[0]` and the next line still hard-codes `input.model_tier` in the message. The constant is a list in its contract and a single name in its use (OCP: adding a second ignored field to the list changes the test's judgment but not the tool's behaviour, so the new field gets no migration notice).",
    "impact": "The constant and the tool can diverge silently: the list grows, the test passes, and callers of the new ignored field get no notice that their field was dropped, which is exactly the silent no-op flow 488 set out to remove.",
    "suggested_fix": "Iterate the list: compute the ignored fields actually present (`SPAWN_SUBAGENT_IGNORED_FIELDS.filter((f) => input[f] !== undefined)`) and emit one notice naming each, or make the constant a single named field (`SPAWN_SUBAGENT_IGNORED_TIER_FIELD`) if only one is ever intended.",
    "evidence": "spawn-subagent-tool.ts:1073 export; :1504-1505 uses index 0 and `input.model_tier`; review-spawn-field-contract.test.ts reads the full list as IGNORED.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w2:F-003",
    "severity": "info",
    "file": "docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json",
    "line": null,
    "quote": "The operator's act of relabelling the reviewed head at `review complete --head`",
    "problem": "head_override.confirmedVia enumerates tui-card, remote-card and host-question, but the only writer (src/review/managed.ts:1063) sets host-question or omits the field (terminal), and the review_complete card (src/commands/operator-confirm-review.ts ~741, 841) closes against the recorded head so it can never produce a head_override. Two enum values have no producer.",
    "impact": "None at runtime; a reader of the schema infers a card path for relabelling the head that does not exist. Would be settled by either a card that accepts a head relabel or dropping the two values.",
    "suggested_fix": "Restrict the enum to [\"host-question\"] (terminal = absent), or document that card values are reserved.",
    "evidence": "managed.ts:1063 headOverride construction; operator-confirm-review.ts prepared.head is the recorded head.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w2:F-004",
    "severity": "info",
    "file": "src/harness/tool/builtin/spawn-subagent-tool.ts",
    "line": null,
    "quote": "export const SPAWN_SUBAGENT_IGNORED_FIELDS = [\"model_tier\"] as const;",
    "problem": "The new JSDoc + constant were inserted between the existing 'Create the `spawn_subagent` tool bound to a live shell host.' JSDoc (line 1059) and createSpawnSubagentTool, so that doc block now precedes the constant instead of the exported factory; the factory loses its API documentation.",
    "impact": "Documentation only; editor hover on createSpawnSubagentTool shows nothing and the constant shows two unrelated blocks. Readability concern (review-style lane).",
    "suggested_fix": "Move the constant and its JSDoc above the factory's JSDoc block.",
    "evidence": "slice-03 hunk @@ 1048,1094 @@ shows the insertion point.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w3:ARCH-1",
    "severity": "major",
    "file": "src/review/close-gates.ts",
    "line": null,
    "quote": "await input.beforeReadiness?.();",
    "problem": "The shared close gate does not hold all of the close refusals. close-gates.ts says 'Both commands now get their refusals from here', but the research-error gate runs inside the `beforeReadiness` callback that only `review complete` passes (managed.ts: `const researchProblems = (await packageResearchErrorsTagged(packageDir, manifest.artifacts, researchFindings))`). That gate covers the untagged integrity errors research.ts documents as 'an integrity failure no waiver covers': an invalid research or dispatch artifact locator, and research.json recording a dispatch the manifest does not declare. `publishReview` calls `evaluateCloseGates` with no hook, so it never evaluates them. `computeReadiness` does not replace that gate either: it reads `research.json` by a fixed path (readiness.ts:448), and `ledgerCheck` runs only `researchErrors(ctx.research, ctx.findings)` (readiness.ts:316). Neither checks `manifest.artifacts` locators or the manifest/dispatch mismatch. The hook is a caller-specific side door into a function whose contract is 'one evaluation for both callers'.",
    "impact": "A concrete path exists. complete-waiver-scope.test.ts sets `manifest.artifacts.research = \"elsewhere.json\"` (or deletes `artifacts.reviewerDispatch`) and asserts that `review complete` refuses, whatever is waived. The same package passes `keryx review publish` without `--partial`, because publish does not require a closed package (commands/review.ts runPublish) and its readiness never sees those errors. This is the same complete-refuses / publish-posts asymmetry that AC5 and this module were written to remove, now for the errors the PR itself classes as unwaivable.",
    "suggested_fix": "Move the research-error evaluation into `evaluateCloseGates`, after `beforeReadiness` and before `computeReadiness`. Call `packageResearchErrorsTagged(packageDir, manifest.artifacts, findings)` on the manifest re-read from disk, filter by `manifest.readiness_waivers`, and always throw on untagged errors. With `relaxReadiness`, publish may skip the tagged ones, because those are also failing readiness items, but never the untagged ones. Reduce the complete-only hook to recording the operator's waivers (a write), so the shared function owns every refusal. Then add a publish case to complete-waiver-scope.test.ts or publish-gate-parity.test.ts for the invalid-locator and undeclared-dispatch packages.",
    "evidence": "Read close-gates.ts:1-45 (head), managed.ts:1105-1130 (the beforeReadiness body with packageResearchErrorsTagged), publish.ts:165-180 (evaluateCloseGates call with no beforeReadiness), research.ts:120-160 (untagged locator/mismatch/unreadable errors), readiness.ts:313-319 and 445-463 (ledgerCheck and computeReadiness read research.json directly and never inspect manifest.artifacts), commands/review.ts:4881-4917 (runPublish has no closed-status precondition).",
    "confidence": "high",
    "reviewer": "review-architecture",
    "class_scope": {
      "sites": [
        "src/review/close-gates.ts:41",
        "src/review/managed.ts:1113",
        "src/review/managed.ts:1120",
        "src/review/publish.ts:177"
      ],
      "enumeration_method": "keryx ctx rg 'publishReview\\(' src (2 production callers: commands/review.ts:4911 and operator-confirm-review.ts:210/245, all through publishReview, which is the one evaluateCloseGates call without a hook); keryx ctx rg 'beforeReadiness' (one producer, managed.ts:1113); keryx ctx rg 'artifacts|packageResearchErrors|researchErrors\\(' over readiness.ts/publish.ts (no locator or mismatch check on the publish path)"
    }
  },
  {
    "id": "review-architecture-w3:ARCH-2",
    "severity": "minor",
    "file": "src/review/research.ts",
    "line": null,
    "quote": "...tagged(completeness, [\"files-covered\", \"blast-radius\"]),",
    "problem": "research.ts now encodes readiness item ids (`ledger`, `reviewers`, `files-covered`, `blast-radius`) as untyped `readonly string[]` in `TaggedResearchError.items`. The ids are owned by `READINESS_ITEMS` / `ReadinessItemId` in readiness.ts, so this is a second, unchecked copy of a closed set. A renamed or split readiness item compiles cleanly and leaves its research errors permanently unwaivable. This fails closed, but nothing tells the author.",
    "impact": "Maintainability: the coupling between the research gate and the readiness checklist that the PR introduces is invisible to the type checker.",
    "suggested_fix": "Type the tags: `items: readonly ReadinessItemId[]` via `import type { ReadinessItemId } from \"./readiness\"`. The import is type-only, so readiness.ts importing research.ts at runtime creates no cycle. Alternatively, export the item-to-error mapping from readiness.ts next to READINESS_ITEMS.",
    "evidence": "research.ts:128-160 (TaggedResearchError, tagged(...) call sites); readiness.ts:694-710 (READINESS_ITEMS and ReadinessItemId); readiness.ts imports from ./research, so a value import back would cycle and a type import would not.",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "review-architecture-w3:ARCH-3",
    "severity": "info",
    "file": "src/review/publish.ts",
    "line": null,
    "quote": "if ((research?.dispatch?.coverageWaiver ?? research?.coverageWaiver)?.confirmedVia === \"host-question\") named.push(\"coverage waiver\");",
    "problem": "`hostQuestionNotice` re-implements the research.json coverage-waiver lookup (`dispatch.coverageWaiver ?? coverageWaiver`) inline. completion-host.ts:24 already does the same lookup with its own ad-hoc cast. These are two readers of one storage shape, and neither goes through coverage-complete, which writes it.",
    "impact": "If the waiver's storage location changes, both readers need the edit. Today they agree.",
    "suggested_fix": "Export a `readCoverageWaiver(research)` from coverage-complete.ts (the writer) and use it in both publish.ts and completion-host.ts.",
    "evidence": "keryx ctx rg 'dispatch\\?\\.coverageWaiver' src: exactly 2 sites, completion-host.ts:24 and publish.ts:72.",
    "confidence": "medium",
    "reviewer": "review-architecture"
  },
  {
    "id": "review-degradation-w1:F-001",
    "severity": "info",
    "publication": "question",
    "degradation_class": "behaviour-delta",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": null,
    "quote": "On `spawn_subagent` pass its tier as `model_class` on every reviewer",
    "problem": "Step 6 (SKILL.md:104, unchanged) defines the review tier as relative: '`standard` = your session model'. Line 118 now passes the same tier as the ABSOLUTE `model_class` `standard`. In src/harness/routing/resolver.ts:104-110 an agent recommendation becomes `assignment: { mode: \"class\", modelClass }` when the subagents category is `auto`, replacing the per-task classifier. On a session whose own model ranks above the standard class (this round's payload: tier `standard`, model `claude-opus-5-5`, which model-profile.ts:257 profiles as tier `deep`), a normal reviewer would be routed to a standard-class model, not the session model `keryx review tier` printed. If true: minor, normal reviewers run on a smaller model than the tier command named, contradicting the flow's outcome 'the reviewer model class chosen by keryx review tier is the one the keryx shell child actually runs on'.",
    "impact": "Reviewer quality may drop silently on keryx shell in auto routing mode; non-auto modes ignore the recommendation (resolver.ts:93-103), so they are unaffected.",
    "suggested_fix": "Check: on keryx shell with routing category `subagents` in mode `auto` and an Opus session, dispatch one reviewer with `model_class: \"standard\"` and read the routing journal's resolved model for that child. If it is not the session model, map tier `standard` to the session model's own class (or omit model_class for `standard`) and align Step 6's wording.",
    "evidence": "consumer-trace (partial): SKILL.md:118 -> spawn-subagent-tool.ts:1606-1608 (recommendation {modelClass, source: agent}) -> resolver.ts:104-110 (auto mode: class assignment). Not traced: how a class assignment selects a concrete model for the anthropic provider and which class claude-opus-5-5 holds (model-profile.ts records tier `deep`, not a class). Refute attempt: on base model_tier was ignored and auto mode ran the classifier, which could also pick `standard`, so base did not guarantee the session model either; the change is required by frozen AC7 and the operator. Hence a question, not a finding.",
    "confidence": "low",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-degradation-w2:F-001",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "src/commands/review.ts",
    "line": null,
    "quote": "  is not the pull request's head still needs the report's first line to name it\n  and say the PR moved.",
    "problem": "`keryx review --help` (the `--head:` block, directly below the help lines this slice edits for --head-reason) still says a head that is not the PR's head is accepted when the report's first line names it and says the PR moved. That is the escape this PR removes. On head, completeHeadGate (src/review/complete-head-gate.ts:33-54) no longer reads report.md at all, and only an operator waiver of `head` lifts the refusal. The help also never mentions --head-reason, which a differing --head now requires. The JSDoc of CompleteManagedReviewOptions.head says the same thing (src/review/managed.ts:959-963: \"a head that is not the PR's head still needs the report to name it and say the PR moved\"). On base both texts matched the code; on head they describe a removed path.",
    "impact": "An agent or operator who follows `keryx review --help` writes the first-line attestation, runs complete, and is refused. The error does name `--waive head`, so no result is lost. But the top-level help now teaches the agent-writable escape the PR set out to retire, and it hides the new operator step.",
    "suggested_fix": "Rewrite the paragraph to match printCompleteHelp and cli-reference.md: a head that is not the PR's head fails readiness item `head` and is lifted only by the operator's `--waive head \"<quote>\"`. A --head that differs from the recorded head needs --head-reason. Update the managed.ts:959-963 JSDoc the same way.",
    "evidence": "base-diff: complete-head-gate.ts on head (lines 22-54) returns `refusal` for a merged or moved PR with no report input. The slice's own diff removes the first-line exemption from the cli-reference.md, guide, SKILL.md and report-template texts but not from review.ts:5681-5685 or managed.ts:959-963. Read with keryx ctx rg \"first line|say the PR moved\" over src/commands, src/review, docs and the orchestrator skill: these two sites are the only stale ones left. Refute: printCompleteHelp (review.ts, in this slice) is updated, which shows the omission is not deliberate.",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/commands/review.ts:5683-5685",
        "src/review/managed.ts:959-963"
      ],
      "enumeration_method": "keryx ctx rg -n --all \"first line|names it and say|say the PR moved|says so\" over src/commands/review.ts, src/review/managed.ts, src/review/readiness.ts, the review-orchestrator skill dir, cli-reference.md and review-with-a-record.md; each hit was read, and only these two still describe the report first-line escape as live."
    }
  },
  {
    "id": "review-degradation-w2:F-002",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "src/harness/tool/builtin/spawn-subagent-tool.ts",
    "line": null,
    "quote": "export const SPAWN_SUBAGENT_IGNORED_FIELDS = [\"model_tier\"] as const;",
    "problem": "The new export and its JSDoc sit between the existing JSDoc \"Create the `spawn_subagent` tool bound to a live shell host…\" (the per-turn ledger contract) and `export function createSpawnSubagentTool`. That orphans the factory's doc. TypeScript attaches every leading /** */ block to the next declaration, so both comments now document SPAWN_SUBAGENT_IGNORED_FIELDS, and createSpawnSubagentTool has none. On base the comment was directly above the function.",
    "impact": "Editor hover and generated docs lose the description of the factory's per-turn ledger/resetBudget contract and show it on an unrelated constant. Nothing breaks at runtime.",
    "suggested_fix": "Move `SPAWN_SUBAGENT_IGNORED_FIELDS` and its JSDoc above the \"Create the `spawn_subagent` tool…\" comment, for example next to the other module constants, so the factory's JSDoc is directly above `createSpawnSubagentTool` again.",
    "evidence": "base-diff: the slice hunk @@ 1048,1094 @@ shows the `+/** Schema fields … */` and `+export const SPAWN_SUBAGENT_IGNORED_FIELDS` lines inserted after the closing ` */` of the factory JSDoc and before `export function createSpawnSubagentTool`. On head, the factory JSDoc starts at line 1059 and the export is at line 1073 (keryx ctx rg).",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-degradation-w2:F-003",
    "severity": "info",
    "degradation_class": "debt",
    "file": "src/gdskills/bundled/rules/core/model-selection.mdc",
    "line": null,
    "quote": "  optional `model_tier` input and does the rest in code: it builds the tier map",
    "problem": "Pre-existing: the bundled rule model-selection.mdc still says `spawn_subagent` takes a `model_tier` input and resolves it in code (lines 201-206). That is the same wrong instruction this PR fixes in the orchestrator skill, but here it is in a rule. The new contract test scans only src/gdskills/bundled/skills/review, so it does not see rules. Even with a wider root it would miss this one: `spawn_subagent` is on line 201 and `model_tier` on line 202, and the scanner matches per line.",
    "impact": "An agent that reads the rule (the orchestrator tells it not to for tiering, but other skills load it) can still pass the ignored field. Not caused by this PR.",
    "suggested_fix": "In a follow-up, update model-selection.mdc lines 201-206 to model_class, widen the contract test's root to src/gdskills/bundled (rules included), and match by paragraph instead of by line.",
    "evidence": "Read model-selection.mdc:198-210 on head; it is not in the PR diff (git diff --stat base..head -- src lists no rules file).",
    "confidence": "medium",
    "reviewer": "review-degradation",
    "location_class": "pre-existing"
  },
  {
    "id": "review-degradation-w3:DEG-1",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "src/review/readiness.ts",
    "line": null,
    "quote": "export const withoutPartialHeader = (report: string): string => report.split(/\\r?\\n/).filter((line) => !PARTIAL_LINE.test(line)).join(\"\\n\");",
    "problem": "The change removed both callers of `withoutPartialHeader`: managed.ts no longer passes `report: withoutPartialHeader(reportText)` to completeHeadGate, and readiness.ts headCheck no longer does either. The function is still exported, and its doc comment ('for checks that read the report's own first line') describes a check that no longer exists. A search of src/ finds only the definition.",
    "impact": "Dead export left over from the removed first-line escape. A later reader may take it for a live part of the head gate.",
    "suggested_fix": "Delete `withoutPartialHeader` and its comment from readiness.ts. Keep `PARTIAL_LINE`, which writePartialHeader still uses.",
    "evidence": "base-diff: at base, managed.ts:416 and readiness.ts headCheck called withoutPartialHeader(...). The slice-04 hunks remove both calls and drop the import in managed.ts. `keryx ctx rg withoutPartialHeader src/` on head finds only readiness.ts:551.",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-degradation-w3:DEG-2",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "src/review/complete-head-gate.test.ts",
    "line": null,
    "quote": "function lookup(pr: { state?: string; headSha?: string } | null): PrLookup & { calls: string[] } {",
    "problem": "The diff adds src/review/close-gates.test-helpers.ts, which exports HEAD, MOVED, PR, EVIDENCE, the `ready` research ledger, `ingestReady` and `lookup`. complete-head-gate.test.ts, which the same diff edits heavily, keeps its own private copies of each one: HEAD, MOVED, EVIDENCE, PR, `ready`, `ingest` and the same `lookup` body. The fixture now exists twice.",
    "impact": "If the ready-package shape changes (for example a new readiness item that the fixture must satisfy), both copies need the same edit. If one is missed, one test file silently tests a different package than the other.",
    "suggested_fix": "Have complete-head-gate.test.ts import HEAD, MOVED, PR and lookup from ./close-gates.test-helpers. Replace its `ingest` with `ingestReady(dir, report, target, \"head-gate\")`.",
    "evidence": "base-diff: close-gates.test-helpers.ts is new in this diff (lines 11-39: HEAD, MOVED, PR, EVIDENCE, ready, ingestReady, lookup). complete-head-gate.test.ts on head, lines 10-32, still defines `ready`, HEAD, MOVED, EVIDENCE, PR, `ingest` and `lookup` with identical bodies.",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w1:F-001",
    "severity": "info",
    "reviewer": "review-logic",
    "file": ".metaproject/flows/488-2026-11-12-review-audit-p0-gates/flow.json",
    "line": 116,
    "quote": "\"title\": \"review complete --head accepts only the recorded head or its ancestor\",",
    "problem": "T6's title still states the ancestor rule, but the operator decision (journal: A-03 answered 'Operator act if different') replaced it. T6's own dispositionReason says 'ancestor rule from the title dropped'. The task is marked done under a title that describes behaviour the code does not have.",
    "impact": "No runtime effect. Anyone reading the flow, the governance report or the closure PR without opening dispositionReason will think `review complete --head` refuses a non-ancestor head, when it actually accepts any differing head once an operator quote is given.",
    "suggested_fix": "Retitle T6 to match the decision, for example 'review complete --head that differs from the recorded head needs an operator act (head_override)', or leave it and accept the dispositionReason as the record.",
    "evidence": "slice-01 flow.json T6 entry: title vs dispositionReason ('operator chose 'operator act if different' ... ancestor rule from the title dropped'). Head journal (git show e9ac9253fde7:.../journal.md) records the A-03 operator decision.",
    "confidence": "high"
  },
  {
    "id": "review-logic-w2:F-001",
    "severity": "minor",
    "title": "Readiness item 7 still describes the head check as a report-text check",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md",
    "line": 776,
    "quote": "7. `head` — the report's head is the PR head.",
    "problem": "This diff rewrote item 4 to say a report line no longer passes it, but left item 7 unchanged. After flow 488, `headCheck` (src/review/readiness.ts:347-359) compares the head recorded in the manifest at `review start` with the PR head through `completeHeadGate`, and nothing in report.md lifts it (complete-head-gate.ts:22-30). The item text still says the check is about 'the report's head', which is the escape this flow removed.",
    "why_it_matters": "An agent reading the checklist is pointed at report.md as the thing to align, the exact behaviour AC2 retires; the same file's SKILL.md (line 131 of the hunk) and the report template already say the first line unlocks nothing, so the three texts disagree.",
    "suggested_fix": "Reword item 7 to: \"`head` — the head recorded at `review start` is still the PR head and the PR is not merged; otherwise the operator waives `head`.\" Mirror it in src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md to keep the copies byte-identical.",
    "evidence": "readiness.ts:347-359 headCheck uses options.headGate / completeHeadGate on ctx.manifest; complete-head-gate.ts:52-53 returns a refusal on merged/moved with no report input.",
    "confidence": "high",
    "location_class": "in-diff",
    "reviewer": "review-logic",
    "impact": "An agent reading the checklist is pointed at report.md as the thing to align, the exact behaviour AC2 retires; the same file's SKILL.md (line 131 of the hunk) and the report template already say the first line unlocks nothing, so the three texts disagree."
  },
  {
    "id": "review-logic-w2:F-002",
    "severity": "info",
    "title": "'An omitted tier runs the child on your own model' holds only when subagent routing is not auto",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": 118,
    "quote": "an omitted tier runs the child on your own model.",
    "problem": "With `model_class` omitted, spawn-subagent-tool.ts:1610-1612 runs `runProductionRoutingClassification` when `routingConfig.categories.subagents.mode === \"auto\"`, so the child's model is chosen by the classifier, not inherited. In this project the subagents category is not pinned, so today the sentence is true here; it is not true for a project that sets subagents routing to auto.",
    "why_it_matters": "No observable defect in this repo; it would mislead an operator of a project with auto subagent routing about what an omitted model_class does.",
    "suggested_fix": "Optional: 'an omitted model_class leaves the child to the project's subagent routing (your own model unless that category is auto)'. Settled by reading routing.config.json of a target project.",
    "evidence": "spawn-subagent-tool.ts:1606-1612",
    "confidence": "medium",
    "location_class": "in-diff",
    "reviewer": "review-logic",
    "impact": "No observable defect in this repo; it would mislead an operator of a project with auto subagent routing about what an omitted model_class does."
  },
  {
    "id": "review-logic-w3:F-001",
    "severity": "minor",
    "file": "src/commands/review.ts",
    "line": null,
    "quote": "  if (headReason !== undefined && hostQuestion === undefined && !isTerminal()) {",
    "problem": "runComplete validates --head-reason only for an empty value and for a missing TTY; it never checks that --head was also passed, and completeManagedReviewLocked reads options.headReason only inside the branch where --head differs from the recorded head. So `keryx review complete <pkg> --head-reason \"the round ran on the PR head\"` (no --head), or --head equal to the recorded head plus --head-reason, closes successfully and the operator's words are recorded nowhere. The JSDoc on CompleteManagedReviewOptions.headReason says the quote is 'Required then, and refused otherwise', and the CLI help states the principle 'An unrecognised option is REFUSED, not ignored. A flag that is silently dropped writes nothing and still reports success'.",
    "impact": "An operator who believes they relabelled the head (forgetting --head, or passing the recorded head) gets status: closed with no head_override and no warning; the stated contract ('refused otherwise') does not hold.",
    "suggested_fix": "In runComplete, refuse --head-reason when headFlag is undefined (\"--head-reason applies only with --head <sha>\"). In completeManagedReviewLocked, when options.headReason is set but no override was recorded (head equals the recorded head, or none was recorded), either refuse or push a warning that the quote was not needed and not recorded.",
    "evidence": "src/commands/review.ts:4940-4956 (headReason parsed, only empty/TTY checks); src/review/managed.ts:1056-1066 (headReason read only inside the recordedHead-differs branch); src/review/managed.ts:966-968 JSDoc 'Required then, and refused otherwise'. keryx ctx rg 'headReason|head-reason' over src/review and src/commands/review.ts: no other reader.",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w3:F-002",
    "severity": "minor",
    "file": "src/commands/review.ts",
    "line": null,
    "quote": "  is not the pull request's head still needs the report's first line to name it",
    "problem": "Flow 488 removed the report-first-line escape from the head gate (complete-head-gate.ts no longer matches it; the guide, cli-reference, SKILL.md and the report template in this slice were updated to say nothing in report.md lifts item `head`). Two siblings still state the old rule: the `--head:` block of the `keryx review --help` text (src/commands/review.ts:5683-5685) and the JSDoc of CompleteManagedReviewOptions.head (src/review/managed.ts:961-962, 'a head that is not the PR's head still needs the report to name it and say the PR moved').",
    "impact": "An agent or operator following `keryx review --help` writes the first line and expects completion; it is refused with item `head` failing, and the help points at a repair that no longer exists.",
    "suggested_fix": "Replace both passages with the new rule: a head that is not the PR's head fails readiness item `head`, which only the operator waives (`--waive head \"<quote>\"` or the review_waive_readiness card).",
    "evidence": "keryx ctx rg 'first line|say the PR moved|says the PR moved' over complete-head-gate.ts, managed.ts and commands/review.ts: hits only review.ts:5684-5685 and managed.ts:962; complete-head-gate.ts has none.",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w4:F-001",
    "severity": "minor",
    "file": "src/review/readiness.ts",
    "line": null,
    "quote": "function verifierCheck(ctx: Context): Verdict {",
    "problem": "Items 4 (verifier) and 7 (head) used to accept an agent-written escape: a `Not verified: N` line, or a first line naming the SHA and saying the PR moved. Both checks now fail with no regard to `manifest.status`. Items 3 and 6 deliberately do not re-derive on a closed package (Context.liveCoverageGate / coverageMdGated). So a package that ≤0.4.26 closed legitimately through one of those escapes now reads NOT READY in `review readiness`, `review status` and the panel. `review publish` refuses it too: it now runs evaluateCloseGates, so the readiness checklist is computed again on the closed package.",
    "impact": "Trigger: a package closed before this release with unverified blocker/major findings and a `Not verified: N` line, or closed on a moved or merged PR through the first-line wording, then published after the upgrade. Outcome: publish is refused. The way through is `--partial` (the page is labelled \"Partial review\") or a fresh operator waiver. Status surfaces call a completed round NOT READY. Nothing is lost and the refusal names its repair, so this is minor.",
    "suggested_fix": "Decide this deliberately and say so. One option is to grandfather closed packages the way liveCoverageGate does: on a closed package whose report still holds the `Not verified: N` line, item 4 reports the recorded close, and item 7 likewise for a closed package. The other is to state the break in the CHANGELOG/release notes, together with the repair (`review_waive_readiness` card, or `--partial`).",
    "evidence": "readiness.ts verifierCheck: no status branch; it fails whenever any blocker/major lacks `verification`. headCheck: no status branch either; it fails on gate.refusal. computeReadiness gates only items 3 and 6 by status (`liveCoverageGate: manifest.status !== \"closed\"`, `coverageMdGated`). publish.ts: `evaluateCloseGates(packageDir, { manifest, report: reportText, readiness: options.readiness, action: \"publish\", relaxReadiness: options.partial === true })`. Base readiness.ts accepted `NOT_VERIFIED = /not\\s+verified\\s*[:=]?\\s*(\\d+)/i`, and base completeHeadGate accepted the first line via `SAYS_SO`.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:236 verifierCheck",
        "src/review/readiness.ts:348 headCheck"
      ],
      "enumeration_method": "Every readiness check the diff tightened by removing a report-text escape. The diff removes exactly two: NOT_VERIFIED in verifierCheck and SAYS_SO/first-line in completeHeadGate (consumed by headCheck). Checked computeReadiness for status-based carve-outs: only liveCoverageGate (item 3) and coverageMdGated (item 6) exist."
    }
  },
  {
    "id": "review-logic-w4:F-002",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": null,
    "quote": "const quote = (options.headReason ?? \"\").replace(/-{0,2}head-reason/gi, \"\").trim();",
    "problem": "`headReason` is read only inside the branch where the recorded head is a non-empty string different from `--head`. When `--head` equals the recorded head (by prefix), or the recorded head is absent, a supplied `--head-reason` is dropped without a warning, and no `head_override` is written. The same happens to a `--head-reason` given without `--head`, if the CLI passes it through.",
    "impact": "No gate is loosened: filling an absent head or repeating the recorded one cannot make the head gate pass that would otherwise fail. The cost is that an operator's stated words vanish from the record without a word to them.",
    "suggested_fix": "Push a warning when headReason is given and no relabel happened (\"--head-reason ignored: --head matches the recorded head\"), or reject it in the CLI.",
    "evidence": "managed.ts completeManagedReviewLocked: the quote is computed only under `typeof recordedHead === \"string\" && recordedHead !== \"\" && !recordedHead.toLowerCase().startsWith(head) && !head.startsWith(recordedHead.toLowerCase())`. The complete-head-relabel.test cases \"a --head equal to the recorded head ... records no override\" and \"a recorded head that is absent is filled without a quote\" cover the no-quote path but not a supplied-and-ignored quote.",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff"
  },
  {
    "id": "review-performance-w3:PERF-001",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": null,
    "quote": "const researchProblems = (await packageResearchErrorsTagged(packageDir, manifest.artifacts, researchFindings))",
    "problem": "Before flow 488, a waiver of files-covered/blast-radius/reviewers/ledger skipped packageResearchErrors entirely (`waivedRadius ? [] : ...`). Now packageResearchErrorsTagged always runs, including packageCoverageErrors and coverageGateErrors (scope files, changed lines, blast radius, pending mutants, layer/chunk completeness), and the result is filtered afterwards. computeReadiness then recomputes overlapping coverage checks (reviewersCheck -> coverageGateOf).",
    "impact": "One extra coverage computation per `review complete` that carries a waiver; runs once per close on one package, so no hot path. The change is required for correctness (integrity errors must survive a waiver), so this is noted only, not a defect.",
    "suggested_fix": "None needed. If close latency on large packages ever matters, compute the coverage errors once and share them between the research gate and computeReadiness.",
    "evidence": "slice-04 managed.ts @@ 1025,1149: removed `const researchProblems = waivedRadius ? [] : await packageResearchErrors(...)`, added the unconditional packageResearchErrorsTagged call inside beforeReadiness; research.ts packageResearchErrorsTagged computes coverage and completeness whenever the dispatch is recorded.",
    "confidence": "high",
    "reviewer": "review-performance",
    "location_class": "in-diff",
    "degradation_class": "performance",
    "publication": "omit"
  },
  {
    "id": "review-security-code-w1:F-001",
    "severity": "info",
    "file": ".metaproject/flows/488-2026-11-12-review-audit-p0-gates/description.md",
    "line": null,
    "quote": "no completion or publish gate of a managed review can be satisfied by text the reviewing agent wrote without an operator card or a TTY",
    "problem": "The Effect criterion states that no completion or publish gate can be satisfied by agent-written text without an operator card or a TTY, but AC1, AC2 and AC3 accept the waiver channels `--waive` accepts, which include `--answered-by` on a non-TTY host. Both the `--answered-by` source and the quote are strings the reviewing agent can pass itself.",
    "impact": "No exploitable path is introduced: the host-question channel is a deliberate, documented limit (completion-host.ts 'reported provenance, not a cryptographic attestation'; Out of Scope excludes cryptographic verification; AC6 marks such decisions unverified in the published body). The risk is only that a reader of the flow believes the agent-text bypass is fully closed on Claude Code/Codex hosts when it is moved to a recorded, disclosed channel.",
    "suggested_fix": "Reword the Effect line to name the third channel, e.g. 'without an operator card, a TTY, or a recorded host-question answer (unverified by keryx and marked so in the published body)'.",
    "evidence": "description.md Effect line vs acceptance-criteria.md AC1 ('card, TTY or `--answered-by`, as `--waive` accepts'), AC3 (same channels), AC6 (host-question marked unverified); context.md cites runComplete refusing --waive without a TTY 'unless --answered-by is given'.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "review-security-code-w2:F-001",
    "severity": "minor",
    "file": "src/review/managed.ts",
    "line": null,
    "quote": "    if (typeof recordedHead === \"string\" && recordedHead !== \"\" && !recordedHead.toLowerCase().startsWith(head) && !head.startsWith(recordedHead.toLowerCase())) {",
    "problem": "The operator-reason requirement for `review complete --head` applies only when a head was recorded at start. When `stored.target.head` is absent or empty, any well-formed `--head` is written to `manifest.target.head` with no `--head-reason`, no TTY check and no `head_override` record. `completeHeadGate` then compares that agent-supplied value with the PR head (`reviewed !== null && prHead !== null && !sameCommit(...)`), so passing the PR's current head makes item `head` pass whatever tree the reviewers actually read.",
    "impact": "Attack vector: an agent (non-TTY, no operator) closing a PR-bound package whose start recorded no head (start ran with no checkout and no readable PR head, per the documented `--head` fallback) runs `keryx review complete <pkg> --head $(gh pr view --json headRefOid -q .headRefOid)`; the head gate and readiness item `head` pass and the closed manifest claims the round reviewed the PR head, with no operator act recorded. Precondition (no recorded head) is not established by this diff and is rare, hence minor: the relabel gate added by flow 488 is bypassable only on that path.",
    "suggested_fix": "Treat a missing recorded head like a differing one: require `--head-reason` (TTY or host question) whenever `options.head` is set and `recordedHead` is absent, and record `head_override` with `from: null` (or `\"not recorded\"`). Alternatively refuse `--head` when nothing was recorded and send the operator to `--waive head`.",
    "evidence": "src/review/managed.ts:1056-1066 (head override only built inside the recordedHead-present branch; `manifest = { ...stored, target: { ...stored.target, head } }` runs unconditionally); src/review/complete-head-gate.ts:44-50 (gate trusts `target.head`); docs/docs/cli-reference.md in this slice: 'Omitted ... with neither, the head is left off'.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "location_class": "in-diff"
  },
  {
    "id": "review-security-code-w2:F-002",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": null,
    "quote": "      headOverride = { from: recordedHead, to: head, operator_quote: quote, time: (options.now ?? new Date()).toISOString(), ...(options.hostQuestion === undefined ? {} : { confirmedVia: \"host-question\" as const }) };",
    "problem": "On the host-question path the operator answers only a plain `yes` (validateCompletionHost); the `--head-reason` text is written by the agent and embedded in the question, yet it is stored as `operator_quote`. The record does carry `confirmedVia: host-question` and publish names it as unverified, so this is labelling, not a bypass.",
    "impact": "A reader of manifest.json may take `operator_quote` as the operator's verbatim words when on this path it is agent text the operator said yes to. No attack beyond the already-documented host-question limitation.",
    "suggested_fix": "On the host-question path store the quote as `requested_reason` (or add `quoteAuthor: \"agent\"`), or require the operator's answer text itself to carry the reason.",
    "evidence": "src/review/completion-host.ts:34 (`/^(yes|y|да)$/iu` is the only accepted answer); src/review/managed.ts:1059-1063; src/review/publish.ts:70 names host-question head changes.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "location_class": "in-diff"
  },
  {
    "id": "review-security-code-w3:SEC-1",
    "severity": "major",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "file": "src/review/readiness.ts",
    "line": null,
    "quote": "if (waiver !== undefined) return { ...spec, status: \"waived\", evidence: verdict.evidence, repair: verdict.repair, waiver: { operatorQuote: waiver.operator_quote, time: waiver.time } };",
    "problem": "The operator-only gates this PR introduces are enforced only at the CLI-flag layer. The checks that decide the close read the operator's decision back from package files the agent can write itself, and nothing establishes where an entry came from. (1) computeReadiness marks any item `waived` when manifest.json `readiness_waivers` holds an entry for it. It does not look at confirmedVia, a card press or a host question, and terminal waivers carry no confirmedVia either, so a hand-written entry cannot be told apart from a TTY one. (2) managed.ts filters research errors by the same unauthenticated list: `const waivedItems = new Set((manifest.readiness_waivers ?? []).map((waiver) => waiver.item));`. (3) The new `--head-reason` requirement applies only on the `options.head` path (`const quote = (options.headReason ?? \"\").replace(/-{0,2}head-reason/gi, \"\").trim();`). The head gate compares whatever `target.head` manifest.json holds (`const moved = reviewed !== null && prHead !== null && !sameCommit(reviewed, prHead);`), and roundRecordTampered hashes only round.json and prior_findings.json, not `target`. (4) verifierCheck accepts any object as a verifier's result: `const unverified = heavy.filter((finding) => record(finding.verification) === undefined);`, so `\"verification\": {}` in findings.json passes item 4. The new doc comment says the opposite: 'only the verifier's result, or the operator's waiver, lifts it'.",
    "impact": "Attack vector: an agent in the session (attacker = the agent that the operator-only gates are meant to bind) uses its file-write tool on .metaproject/reviews/<pkg>/. It appends {\"item\":\"head\",\"operator_quote\":\"operator accepts the moved head\",\"time\":\"...\"} (or item verifier / ledger / reviewers / files-covered) to manifest.json readiness_waivers. Or it sets target.head to the PR's current head, or adds \"verification\":{} to each blocker/major in findings.json. It then runs plain `keryx review complete <pkg>` or `keryx review publish <pkg>`. No TTY, card or --answered-by is involved, so none of the new refusals in runComplete fire. The round closes as READY, or publishes to the PR as a full review with no 'Partial review' header, even though the PR moved or the blocker/major findings were never verified. hostQuestionNotice names only confirmedVia === \"host-question\" entries, so the forged decision reaches GitHub without any provenance notice. The edit is the same kind of agent write the PR removes from report.md, moved to manifest.json/findings.json, and AC1/AC3 as described ('relabelling the reviewed head is the operator's act, not the agent's') do not hold.",
    "suggested_fix": "Bind operator decisions to a record the agent cannot write as plain package JSON, and verify it in evaluateCloseGates, which complete and publish now share. (a) Stamp every waiver and head_override with an explicit confirmedVia, including a new \"terminal\" value for the TTY path. Then treat an entry without a known confirmedVia, or without its card press or host question, as not waived, and name it as unprovenanced. (b) Record each operator decision in the local round registry outside the repository (as round-registry.ts already does for finished rounds), keyed by package and the sha256 of its entry, and have computeReadiness count a waiver only when the registry holds it. (c) Add `target` (with head) to the round stamp written at `review start`, and refuse in roundRecordTampered when it changes other than through the `--head`/`--head-reason` path that records head_override. (d) Make verifierCheck require a verification whose verifier and verdict match a result the verifier dispatch actually produced (a raw/ file or a dispatch run), not any object.",
    "evidence": "Head reads: src/review/readiness.ts:479-485 (waivers map → status waived, no provenance check); src/review/managed.ts:1119 (waivedItems from manifest filters research errors); src/review/managed.ts:1059 (head-reason enforced only when options.head is set); src/review/complete-head-gate.ts:48-49 (gate uses manifest target.head); src/review/round-record.ts:104-145 (stamp hashes round.json and prior_findings.json only; MANIFEST_IDENTITY_FIELDS at :156 is for the post-close registry and explicitly excludes readiness waivers); src/review/readiness.ts:238 (verification = any record); src/commands/review.ts:4950-4960 (the TTY refusals key off CLI flags only, so a direct file edit never reaches them); src/review/publish.ts:69-72 (notice only for host-question entries). Test round-trip.test.ts in this slice writes `verification` into findings.json by hand to pass item 4, which is the same move an agent would make.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:484 (readiness_waivers → waived, any entry)",
        "src/review/managed.ts:1119 (research-error filter from readiness_waivers)",
        "src/review/complete-head-gate.ts:49 (head gate trusts manifest target.head; relabel reason enforced only at managed.ts:1059 for the --head flag)",
        "src/review/readiness.ts:238 (verifier item accepts any verification object in findings.json)",
        "src/review/publish.ts:69 (provenance notice keys off confirmedVia === host-question, so a forged entry with no confirmedVia is silent)",
        "src/commands/operator-confirm-review.ts:373 (card path writes the same manifest list; correct writer, but the reader cannot tell it from a forged entry)"
      ],
      "enumeration_method": "keryx ctx rg -l readiness_waivers over src (non-test): 6 files (completion-host, publish, managed, readiness, types, operator-confirm-review), each read for readers versus writers. keryx ctx rg for waiveReadiness( callers (3) and for the head-reason/isTerminal refusals in src/commands/review.ts. Read roundRecordTampered/writeRoundRecord for which manifest fields are hashed at start."
    }
  },
  {
    "id": "review-security-code-w3:SEC-2",
    "severity": "info",
    "reviewer": "review-security-code",
    "location_class": "pre-existing",
    "publication": "question",
    "file": "src/review/managed.ts",
    "line": null,
    "quote": "if (process.env[\"KERYX_TOOL_CALL\"] === \"1\" || process.env[\"KERYX_UNATTENDED\"] === \"1\" || isAutonomousEnv(process.env) || readRunProfile(packageDir)?.mode === \"unattended\") {",
    "problem": "Outside keryx shell (for example a Claude Code or Codex Bash tool, where none of these env markers is set and the run profile is attended), `--answered-by` lets the agent satisfy `--waive head`, `--waive verifier` and `--head-reason` alone. It passes `--answer-text yes` and a `--question-text` that validateCompletionHost prints verbatim in its own refusal ('ask the current question verbatim'). This is the flow 467 design ('reported provenance, not a cryptographic attestation'), and this PR's AC6 notice discloses it in the published body, so by law 4 it is not reported as a defect. The residual gap: the notice appears only in the published body, not in `review complete` output or report.md. Dispositions recorded under a host-question completion (completionConfirmations) are not named either.",
    "impact": "No new path beyond the documented design. A reader of a closed but unpublished package, or of the flow-complete review gate, sees host-question waivers only by inspecting confirmedVia in manifest.json.",
    "suggested_fix": "Optional: print the same host-question notice in `review complete` output and in the report.md partial header. Settle whether a known agent-shell marker (for example the host's own env variable) should be treated like KERYX_TOOL_CALL for --answered-by.",
    "evidence": "src/commands/review-operator.ts:575-584 (reviewCompletionHostAnswer builds the HostQuestion from CLI flags); src/review/completion-host.ts validateCompletionHost (plain yes plus verbatim question, question echoed in the refusal); src/commands/review.ts:4954 (head-reason TTY refusal skipped when hostQuestion is present); src/review/run-profile.ts:41-43 (isAutonomousEnv = answers-file env only).",
    "confidence": "high"
  },
  {
    "id": "review-testing-practices-w1:F-001",
    "severity": "minor",
    "title": "Head-gate test now fails on the relabel quote, not on the PR-head gate it names",
    "path": "src/review/complete-head-gate.test.ts",
    "line": 177,
    "quote": "test(\"--head does not loosen the gate: a head that is not the PR's head still fails, and the manifest stays as it was\", async () => {",
    "problem": "After flow 488, `completeManagedReview(..., { head: MOVED })` with recorded head HEAD and no `headReason` is refused at managed.ts:1060-1061 (the relabel-quote check) before readiness item `head` is ever evaluated; the test's new assertion `toContain(\"--head-reason\")` confirms it rides that path. The test's name claims the PR-head gate is not loosened, but deleting the PR-head readiness check would leave this test green. It now duplicates complete-head-relabel.test.ts:17 instead of pinning its titled behaviour. The claim is pinned only at the CLI layer (review.test.ts:250-254) and by the waiver-positive test at line 189, which never shows a refusal at the managed layer.",
    "impact": "Reads as managed-layer coverage of 'a non-PR head still fails' that it no longer provides; the next edit to the head readiness item is protected only by the CLI test.",
    "suggested_fix": "Pass `headReason: REASON` in this test so it clears the relabel check and reaches readiness, and assert the refusal names item `head` / `--waive head` (as review.test.ts:254 does), keeping the manifest-unchanged assertions.",
    "evidence": "complete-head-gate.test.ts:178-186 (no headReason; asserts \"--head-reason\"); managed.ts:1057-1061 throws on quote.length < 8 before any readiness evaluation; complete-head-relabel.test.ts:17-28 asserts the same refusal.",
    "confidence": "high",
    "location_class": "in-diff",
    "reviewer": "review-testing-practices",
    "file": "src/review/complete-head-gate.test.ts"
  },
  {
    "id": "review-testing-practices-w1:F-002",
    "severity": "info",
    "title": "Host-question path for --head-reason is not driven by any test; publish fixture is hand-built",
    "path": "src/commands/review.ts",
    "line": 4954,
    "quote": "if (headReason !== undefined && hostQuestion === undefined && !isTerminal()) {",
    "problem": "The docs added in this slice say a head relabel may come from `--answered-by` (cli-reference, review-with-a-record 'Relabelled head'), and the producer records `confirmedVia: \"host-question\"` only when `options.hostQuestion` is set (managed.ts:1063). No test found runs `complete --head <other> --head-reason ... --answered-by ...`: the tests that mention `head_override` either use a terminal (complete-head-relabel.test.ts:68-76, review.test.ts:243) or hand-build the manifest (publish.test.ts:134 sets `confirmedVia: \"host-question\"` directly). By reading, deleting the `hostQuestion === undefined &&` conjunct, or the confirmedVia spread at managed.ts:1063, would leave the suite green. This is a prediction (no suite was run), so it is info.",
    "impact": "The provenance marking that publish.ts:70 surfaces for host-question relabels is exercised only from a fixture, not from the producer that must emit it.",
    "suggested_fix": "Add one CLI test with `isTerminal: () => false` and a valid `--answered-by claude-code:<id> --answer-text ... --question-text ...` plus `--head <other> --head-reason ...`, asserting the close succeeds and the manifest's `head_override.confirmedVia` is `host-question`. Running mutants M-03 and M-08 settles whether it is needed.",
    "evidence": "keryx ctx rg for head-reason|head_override across src: only publish.test.ts:134 carries confirmedVia on head_override; no test file combines --answered-by with --head-reason.",
    "confidence": "medium",
    "location_class": "in-diff",
    "reviewer": "review-testing-practices",
    "file": "src/commands/review.ts"
  },
  {
    "id": "review-testing-practices-w1:F-003",
    "severity": "info",
    "title": "Spawn-field contract test scans review skills only; a user guide still names model_tier as a spawn_subagent input",
    "path": "docs/docs/guides/agent-catalog.md",
    "line": 16,
    "quote": "into ordinary `spawn_subagent` inputs (`task`, `mode`, `model_tier`, ...).",
    "problem": "review-spawn-field-contract.test.ts scans `src/gdskills/bundled/skills/review` (REVIEW_SKILLS_ROOT) only, which matches AC7's stated scope. The same ignored field is still documented as a spawn input at docs/docs/guides/agent-catalog.md:16 and :145 (and docs/requirements/.../W2-agent-catalog.md:215). Not a skill instruction, so not the AC7 defect class; noted so the scope boundary is a stated choice.",
    "impact": "None at runtime; a reader of the guide is told to pass a field the tool ignores.",
    "suggested_fix": "Either update the guide to `model_class`, or widen the scanner's root to the docs guides if that is in scope for a later flow.",
    "evidence": "keryx ctx rg 'spawn_subagent.*model_tier|model_tier.*spawn_subagent' over src/gdskills and docs; all other `model_tier` hits under bundled review skills are frontmatter (line 3, 27 files).",
    "confidence": "high",
    "location_class": "pre-existing",
    "reviewer": "review-testing-practices",
    "file": "docs/docs/guides/agent-catalog.md"
  },
  {
    "id": "review-testing-practices-w2:TP-1",
    "severity": "minor",
    "file": "src/review/research.ts",
    "line": null,
    "quote": "      ...tagged(dispatch, [\"reviewers\"]),\n      ...tagged(coverage, [\"reviewers\"]),\n      ...tagged(completeness, [\"files-covered\", \"blast-radius\"]),",
    "problem": "AC4 scopes each research error to the readiness items that can waive it. Tests pin only the `ledger` tag and the untagged integrity errors (complete-waiver-scope.test.ts). No fixture builds a dispatch, coverage or completeness research error and waives `reviewers`, `files-covered` or `blast-radius` at `completeManagedReview`. No test waives one item while another item's research error stays open, which is the case the scoping exists for. A repo-wide search finds no complete-level waiver of those three items. readiness.test.ts:373 calls `waiveReadiness` directly and never reaches the research filter in managed.ts.",
    "impact": "Three of the five tag groups are unpinned. Before flow 488, waiving blast-radius or files-covered lifted the coverage-completeness errors (`waivedRadius`). That behaviour now survives only through the `[\"files-covered\", \"blast-radius\"]` tag. Changing it to `untagged` would make those waivers unable to close a package they closed before, and no test in the slice builds the input that would catch it. The same holds if the filter is loosened to drop every tagged error whenever any waiver is present.",
    "suggested_fix": "In complete-waiver-scope.test.ts, add three cases. (a) A package with a coverage-completeness error (a chunk plan with an undone chunk, or a blast-radius cap drop) closes with `waive(\"blast-radius\")` and is refused without it. (b) A dispatch error (an unfinished run) closes with `waive(\"reviewers\")`. (c) A package with both an open obligation and a dispatch error, waiving only `ledger`, is refused with the dispatch message: the research gate throws before the checklist runs.",
    "evidence": "slice-04 complete-waiver-scope.test.ts builds only `openObligation` (ledger), the `reviewerDispatch` deletion (untagged mismatch) and the `research = \"elsewhere.json\"` locator (untagged). `keryx ctx rg 'waive.{0,20}(blast-radius|files-covered|reviewers)' src --glob '*.test.ts' --all` gives 8 matches: none is a complete-level waiver of these items, and readiness.test.ts:373 is a direct waiveReadiness call. Mutation not run (read-only payload); see mutant_candidates M-10..M-13.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/review/research.ts (tagged dispatch/coverage/completeness)",
        "src/review/managed.ts (beforeReadiness waivedItems filter)",
        "src/review/complete-waiver-scope.test.ts"
      ],
      "enumeration_method": "every `tagged(`/`untagged(` call in packageResearchErrorsTagged (5 tag groups) set against the fixtures in complete-waiver-scope.test.ts, plus `keryx ctx rg` for test waivers of the three items"
    }
  },
  {
    "id": "review-testing-practices-w2:TP-2",
    "severity": "minor",
    "file": "src/review/readiness.test.ts",
    "line": null,
    "quote": "    { id: \"f-1\", severity: \"major\", title: \"raw finding\", verification: { verdict: \"confirmed\" } },",
    "problem": "`verifyHeavyFindings` is the fixture that makes item 4 pass without a waiver, and its verification records are `{ verdict: \"confirmed\" }` only. The producer type `ReviewFindingVerification` (types.ts:405) requires `method` and `evidence`, and its doc comment says the writer always fills `verifier`. So the producer cannot emit this shape. The fixture passes only because `verifierCheck` accepts any record: `record(finding.verification) === undefined` is the whole test. No test in the slice pins that an empty or partial verification still fails item 4.",
    "impact": "Flow 488's point is that agent-written text no longer lifts item 4. The suite pins that for a report.md line. It does not pin it for a findings.json `verification: {}`, and its own READY fixture relies on that leniency, so it reads as coverage of verified findings while covering a shape the verifier never writes. Tightening verifierCheck later would turn these fixtures red for the wrong reason.",
    "suggested_fix": "Build the fixture with the producer's shape: `{ verdict: \"confirmed\", method: \"site-check\", evidence: \"...\", verifier: \"review-verifier\" }`, as readiness-verifier-waiver.test.ts and round-trip.test.ts already do. Add one test asserting how item 4 treats `verification: {}`. If the intended answer is fail, that test is red today; see the follow-up.",
    "evidence": "types.ts:405-410 `verdict`, `method` and `evidence` are required; readiness.ts verifierCheck: `const unverified = heavy.filter((finding) => record(finding.verification) === undefined);`. The sibling fixtures (readiness-verifier-waiver.test.ts, round-trip.test.ts) use the full shape.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "review-testing-practices-w2:TP-3",
    "severity": "minor",
    "file": "src/review/publish.ts",
    "line": null,
    "quote": "  if (premiseCount > 0) named.push(`${premiseCount} premise decision(s)`);",
    "problem": "hostQuestionNotice (AC6) has four sources. The publish.test.ts AC6 block drives the readiness waiver, `head_override` and `research.dispatch.coverageWaiver`. It never drives a premise decision with `confirmedVia: \"host-question\"`, or a top-level `research.coverageWaiver` (the `?? research?.coverageWaiver` fallback). The search for `premiseCount` finds only the two lines in publish.ts.",
    "impact": "Two of the four branches are unpinned. A premise answer recorded from the agent's own host question could be posted to GitHub without the not-verified notice, and the suite would stay green.",
    "suggested_fix": "In the AC6 describe block, add a case that writes a premise decision with `confirmedVia: \"host-question\"`, for example through the operator-decisions file `premiseRecords` reads, and asserts that the body contains `1 premise decision(s)`. Add another with `research.json = { coverageWaiver: { confirmedVia: \"host-question\", ... } }` at top level that asserts `coverage waiver`.",
    "evidence": "slice-04 publish.test.ts AC6 tests write readiness_waivers, head_override and dispatch.coverageWaiver only. `keryx ctx rg premiseCount src/review` matches publish.ts:74-75 only. Mutation not run; see M-17, M-18.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "review-testing-practices-w2:TP-4",
    "severity": "info",
    "file": "src/review/complete-head-gate.test.ts",
    "line": null,
    "quote": "  expect((error as Error).message).toContain(\"head\");",
    "problem": "This test is named \"a first line that names the reviewed SHA and says the PR moved no longer lets it through\". The only text assertion on the refusal is `toContain(\"head\")`, and any readiness refusal containing \"--head\" or the item id meets it. The not-closed check proves a refusal happened but not that item `head` caused it. This is the same loose-source shape as the known wave-1 issue at :177, at a different site.",
    "impact": "If another gate starts refusing this fixture, the test still passes, and the claim in its name goes unverified.",
    "suggested_fix": "Assert the head item's evidence: `toContain(MOVED.slice(0, 7))` and `toContain(\"merged\")`, or compute readiness and assert `items.find(i => i.id === \"head\").status === \"fail\"` with every other item passing.",
    "evidence": "slice-04 complete-head-gate.test.ts hunk. The fixture is MERGED with headSha MOVED, so the refusal text contains both SHAs, but the test does not check them.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  }
]
```

## Token spend

token spend: unknown (24 dispatch(es), none reported usage)
