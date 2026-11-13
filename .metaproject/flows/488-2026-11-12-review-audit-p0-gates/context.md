# Context — flow 488

Source: `docs/analysis/review-process-audit-2026-11-12.md` (audit of the review process at `66ee00117`, v0.4.26).

## Where each gate lives

- Readiness checklist, 12 items, one `computeReadiness` (`src/review/readiness.ts:440`). Item 4 `verifierCheck` accepts a `Not verified: N` line (`readiness.ts:228-239`). Item 7 `headCheck` calls `completeHeadGate` and its repair text tells the agent to edit report.md's first line (`readiness.ts:343-354`).
- Waivers: `waiveReadiness` (`readiness.ts:568-598`) writes `readiness_waivers` into the manifest and a `Partial review:` header into report.md. `premise-decisions` is the one item that cannot be waived.
- Waiver channels at the CLI: `runComplete` refuses `--waive` / `--waive-coverage` without a TTY unless `--answered-by` is given (`src/commands/review.ts:4946-4953`); in keryx shell the `review_waive_readiness` card.
- Close path: `completeReviewGated` (`src/review/complete-gated.ts`) → run-profile and routing refusals → `completeManagedReview` → `completeManagedReviewLocked` (`src/review/managed.ts:1023`): missing artifacts, round-record tamper (`:1039`), `--head` relabel (`:1043-1055`), host-question validation (`:1058-1072`), `completeHeadGate` (`:1074`), evidence level (`:1075-1082`), waivers, research errors with the blanket drop (`:1105-1107`), readiness.
- Head gate: `src/review/complete-head-gate.ts:34-62`; the report-line escape at `:56-58`.
- Research errors: `packageResearchErrors` (`src/review/research.ts:120-141`) concatenates ledger errors (`researchErrors`), dispatch-locator and dispatch errors, coverage-gate errors and coverage-completeness errors without saying which readiness item each belongs to.
- Publish: `publishReview` (`src/review/publish.ts:146-180`) — readiness only; no status, tamper or evidence-level check. CLI: `runPublish` (`src/commands/review.ts:4881-4926`).
- Host-question provenance: `src/review/completion-host.ts:28` ("reported provenance, not a cryptographic attestation"). `premiseDecisionsCheck` already names host-question decisions in its evidence (`readiness.ts:253-259`).
- Spawn field: `spawn_subagent` ignores `model_tier` and accepts `model_class` light|standard|expert|frontier (`src/harness/tool/builtin/spawn-subagent-tool.ts:1122-1124, 1219-1226, 1497-1503`). Skill text: `src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:118` (installed copy under `.metaproject/skills/gdskills/review/` is byte-identical).

## Existing tests to extend

`src/review/complete-head-gate.test.ts`, `src/review/readiness.test.ts`, `src/review/publish.test.ts`, `src/review/complete-head-gate.test.ts`, `src/gdskills/review-orchestrator-skill-parity.test.ts`, `src/gdskills/skill-length.test.ts` (the orchestrator sits exactly at its 1571-line ceiling; edits must not add lines).

## Constraints from memory

- CI, not local full suite; run only the touched test files locally.
- The orchestrator skill's line count must stay at or under its ceiling (ratchet).
- Bundled skill and installed copy must stay byte-identical (`document:build-parity`).
