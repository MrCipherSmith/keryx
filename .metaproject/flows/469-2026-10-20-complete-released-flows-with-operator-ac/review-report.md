# Flow 469 — final working-tree review

Evidence level: ran — focused regression (187 passed), typecheck, lint; see .metaproject/data/flow469-checks/closure-tests.log and closure-exits.log.

## Verdict
No current runtime defect established after fixes and independent reconciliation. All nine required reviewer roles ran. This review covers the supplied working-tree diff at the recorded branch HEAD, not a committed release. PR and release are not published.

## Evidence and limitations
The 19 raw obligations and their evidence are preserved in closure-dispositions.json and research.json. Eleven are refuted by current source/tests; eight are narrowed, not silently dismissed.
Focused tests, typecheck and lint passed. Targeted mutation execution is recorded in research-evidence/mutation-*.json and .metaproject/data/flow469-checks/rollback-mutation-final.log. Do not interpret historical anchors as proof for later tracked-writer branches or claim exhaustive mutation coverage. The rollback guard mutant survives because another identity guard rejects the same stale rollback; the survivor is retained in the record.
Residual proof limitations: exact real flow-command long-question execution and direct-main independent-review end-to-end coverage are not established by service/helper tests. Static reconciliation and focused integration tests do not establish OS-level compare-and-swap against arbitrary external writers, a live Telegram exchange, live GitHub publication, or a full repository test run.

## Reconciliation

### review-architecture-w1:ARCH-001 — refuted
The authoritative schema accepts completion host provenance, and actual managed completion persists it successfully.

Evidence: ['src/review/managed.test.ts:2070: authoritative-schema validation of completionConfirmations and host-question readiness provenance.', 'src/review/managed.test.ts:2141 onward: API and real reviewCommand completion reload manifest, research and findings and assert dispositions plus both waiver provenances.', '.metaproject/data/flow469-checks/closure-tests.log: these tests pass.']

### review-architecture-w1:ARCH-002 — refuted
The strict runtime schema declares replacement-PR lineage; the generated persisted record is reloaded, schema-validated and checked through the flow-check service.

Evidence: ['src/flow/schema.ts:167: pr.previous declares closed objects requiring url and fixOf.', 'src/flow/completion-attempts.test.ts:272 onward: replacement PR24 retains PR23 lineage; persisted.pr equals returned.pr; persisted record validates; service.check reports no issues.', '.metaproject/data/flow469-checks/closure-tests.log: lineage test and runtime/docpack consistency test pass.']

### review-clean-code-w1:CC-001 — refuted
Independent current-source inspection confirms the three protocol-bearing renderers use one shared formatter.

Evidence: ['src/flow/completion-exceptions.ts:10: formatCompletionException owns the gate/condition/detail/reason template.', 'src/commands/flow-completion-confirm.ts:50: selected.map(formatCompletionException).', 'src/commands/operator-confirm-flow-exceptions.ts:27: choice.exceptions.map(formatCompletionException).', 'src/commands/review-operator.ts:562: selected.map(formatCompletionException).']

### review-clean-code-w1:CC-002 — refuted
Independent current-source inspection confirms the attempt JSDoc immediately precedes FlowCompletionAttempt, after the separate CompletionException declaration.

Evidence: ['src/flow/types.ts:420-434.']

### review-highload-w1:F-001 — refuted
Completion calls serialize replay; current host-confirmed writes fence all five bound artifacts immediately before each rename without an intervening await.

Evidence: ['src/review/managed.ts:956 onward: .completion.lock covers completeManagedReviewLocked; host completion constructs and injects completionWriter.', 'src/review/completion-write.ts:15-65: exact per-artifact expected contents, final synchronous fence and rename.', 'src/review/managed.test.ts:2080 onward: changed-report and concurrent-replay integration regressions.', '.metaproject/data/flow469-checks/closure-tests.log: those regressions pass.']

### review-logic-w1:F-001 — narrowed
The reported 2000-character restriction is fixed. Long review-command completion and flow-answer helper boundaries now pass; full production-generated flow-command integration is not established.

Evidence: ['src/commands/flow-completion-question.test.ts: long canonical question preservation and exact 100000/100001-character acceptance/refusal tests.', 'src/review/managed.test.ts:2141 onward: generated question exceeds 2000 characters and passes through real reviewCommand to persisted closure.', '.metaproject/data/flow469-checks/closure-tests.log: long helper, both boundaries and real review-command integration pass.']

Remains: No inspected fixture takes a production-generated long flow-completion question through the real flow-complete command to persisted exception completion. This is an integration-proof limitation, not evidence of a remaining parser defect.

### review-regression-w1:REG-001 — refuted
The producer/schema mismatch is fixed, including persisted-record validation and the flow-check consumer.

Evidence: ['src/flow/schema.ts:167: strict pr.previous schema.', 'src/flow/completion-attempts.test.ts:272 onward: reload generated lineage, validate persisted record, and assert service.check issues equal [].', '.metaproject/data/flow469-checks/closure-tests.log: lineage, every on-disk flow validation and runtime/docpack equality pass.']

### review-security-code-w1:SEC-469-001 — refuted
Identity-sensitive regressions establish refusal of a changed implementation head even when rendered gate outcomes remain identical.

Evidence: ['src/flow/completion-attempts.test.ts: moved-head-with-identical-gates regression.', 'src/flow/completion-attempts.test.ts: independent head/detail changes require a failing confirmation gate and no completion signature.', '.metaproject/data/flow469-checks/closure-tests.log: all three regressions pass.', 'research-evidence/mutation-2.json: removing the evaluated-head comparison independently is killed.']

### review-security-code-w1:SEC-469-002 — refuted
Tracked writes no longer rebaseline unrelated edits, and failure rollback preserves externally modified artifacts rather than unconditionally restoring backups.

Evidence: ['src/review/managed.ts: host completion injects the tracked writer into coverage, readiness, dispositions and final manifest writes; its catch invokes writer.rollback instead of legacy unconditional backups.', 'src/review/completion-write.ts: rollback only considers successfully written artifacts and restores only content still matching its own last authorized write.', 'src/review/managed.test.ts: mutation during waiver/disposition/readiness asserts full manifest equality, research/findings byte equality and preservation of external report text.', '.metaproject/data/flow469-checks/closure-tests.log: mutation regressions pass.', '.metaproject/data/flow469-checks/rollback-unit.log: both rollback tests pass.', 'research-evidence/mutation-4.json: removing both rollback comparisons is killed.']

### review-style-w1:F-001 — refuted
The misplaced attempt JSDoc is fixed; this duplicates CC-002.

Evidence: ['src/flow/types.ts:420-434: CompletionException ends before the JSDoc immediately attached to FlowCompletionAttempt.']

### review-testing-practices-w1:TP-001 — narrowed
Replacement-head consumption, persisted exception provenance and corrected-base-only recovery now have passing executable coverage. The exact independently reviewed direct-main scenario remains unestablished.

Evidence: ['src/flow/completion-attempts.test.ts: four released-case fixtures call checkComplete and complete, distinguish PR24 head, retain failed review gates and reload exception reason/operator words.', 'The isolated base-correction fixture observes tracker base main, changes only the recorded base, preserves PR/AC/tasks/review manifest, and completes cleanly.', '.metaproject/data/flow469-checks/closure-tests.log: all four scenarios and isolated base correction pass.']

Remains: The direct-main fixture supplies no independent-review artifact; it demonstrates no-PR completion with explicit managed-review exceptions, not the exact independently reviewed direct-push scenario.

### review-testing-practices-w1:TP-002 — refuted
Actual host completion now exercises nonempty dispositions, both waiver forms, persisted provenance, forbidden contexts and mutation rollback.

Evidence: ['src/review/managed.test.ts:2078 onward: real-package nested/unattended refusal and unchanged-artifact assertions.', 'src/review/managed.test.ts:2141 onward: API and CLI completion persist disposition and coverage/readiness host provenance.', 'src/review/managed.test.ts: subsequent mutation regressions assert complete manifest equality and preserved external report changes.', '.metaproject/data/flow469-checks/closure-tests.log: these tests pass.']

### review-testing-practices-w2:TP-001 — narrowed
The metadata-only characterization is obsolete: operational replacement-head and corrected-base recovery fixtures now pass. Exact direct-main independent-review fidelity remains incomplete.

Evidence: ['src/flow/completion-attempts.test.ts: isolated corrected-base clean completion preserves existing review manifest.', 'Four released-case fixtures exercise actual completion, replacement-head refusal and persisted exception provenance.', '.metaproject/data/flow469-checks/closure-tests.log: all relevant fixtures pass.']

Remains: No independently reviewed direct-main fixture was found. Existing direct-main coverage should not be described as proving that additional scenario fact.

### review-testing-practices-w2:TP-002 — refuted
A real reviewCommand fixture now completes a real generated package noninteractively with a bound long question, disposition and both waivers, then reloads persisted provenance.

Evidence: ['src/review/managed.test.ts: host completion persists dispositions and both waiver provenances atomically (CLI=true).', '.metaproject/data/flow469-checks/closure-tests.log: CLI=true passes.']

### review-testing-practices-w2:fu1 — refuted
The requested relevant verification has recorded successful execution, superseding the stale isolated-base failure.

Evidence: ['.metaproject/data/flow469-checks/closure-tests.log: 187 pass, 0 fail across 9 files.', '.metaproject/data/flow469-checks/closure-exits.log: tests=0 types=0 lint=0.', '.metaproject/data/flow469-checks/rollback-unit.log: 2 pass, 0 fail.']

### review-testing-practices-w2:fu2 — narrowed
All eight raw w2 proposals now have semantic mappings to individually recorded mutations, but historical identity and restoration audit limitations remain.

Evidence: ['research-evidence/mutation-2.json: baseline exit 0; ten individual results.', 'research-evidence/mutation-3.json: baseline exit 0; four killed and one surviving individual result, including the three previously unmapped w2 proposals.', 'research-evidence/mutation-4.json and rollback-mutation-final.log: baseline exit 0; combined rollback-guard removal killed.']

Remains: The inspected mutation JSON does not provide explicit per-run restored-source hashes or a complete current changed-branch inventory. Do not count mutation-2's obsolete managed.ts snapshot anchors as current tracked-writer coverage. mutation-3 CW-ROLLBACK survived; removing only its first comparison leaves the second protective comparison intact. mutation-4 kills removal of both comparisons, not the individual survivor.

### review-testing-practices-w2:fu3 — narrowed
Real-package command wiring, waiver provenance and isolated corrected-base recovery are now passing; one scenario-fidelity limitation remains.

Evidence: ['src/review/managed.test.ts: real reviewCommand completion and mutation/forbidden-context integration fixtures.', 'src/flow/completion-attempts.test.ts: corrected-base-only recovery and replacement-head operational fixtures.', '.metaproject/data/flow469-checks/closure-tests.log: these fixtures pass.']

Remains: The direct-main scenario does not include independent-review evidence.

### review-testing-practices-w1:fu1 — narrowed
Individual mutation execution is evidenced, including current tracked-write fencing and combined rollback protection; exhaustive inventory and restoration audit are not established.

Evidence: ['research-evidence/mutation-2.json: 10 killed, baseline exit 0; includes historical anchors.', 'research-evidence/mutation-3.json: current CW-FENCE killed, CW-ROLLBACK survived, and W2-M06/M09/M10 killed.', 'research-evidence/mutation-4.json: CW-ROLLBACK-BOTH killed with passing baseline.', '.metaproject/data/flow469-checks/rollback-unit.log: restored current behavior passes both rollback unit tests.']

Remains: No complete changed-branch mutation inventory or explicit per-mutant restoration verification was found in the inspected evidence. Preserve the recorded survivor and historical-anchor qualifications rather than reporting universal current mutation coverage.

### review-testing-practices-w1:fu2 — narrowed
Operational four-case reconciliation is substantially complete, including the previously failing corrected-base-only recovery and replacement-head targeting.

Evidence: ['009 / merged-before-review: PR23 review evidence becomes incompatible with distinct PR24 head; completion selects explicit review exceptions.', '010 / retargeted-stack: separate isolated fixture shows base correction alone enables clean completion without replacing PR or review manifest.', '011 / direct-main: no PR and mergedCommit path completes through explicit individual review exceptions.', '008 / review-declined: absent managed review produces explicit review conditions; omitted selection blocks and full explicit selection permits exception closure.', '.metaproject/data/flow469-checks/closure-tests.log: all these operational fixtures pass.']

Remains: Scenario 011 does not establish its independent-review fact. These are service-level fixtures with tracker/main-merge seams, not end-to-end GitHub or real remote-merge integrations.

## Token spend

token spend: 3666200 in, 30299 out over 11 dispatch(es)
