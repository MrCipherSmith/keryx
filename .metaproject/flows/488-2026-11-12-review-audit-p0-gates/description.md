# Review gates: close the agent-text and waiver bypasses (audit P0)

Status: draft
Source: docs/analysis/review-process-audit-2026-11-12.md, sections "Критичные находки" 1-4 (origin: agent-finding)

## Problem

On hosts without operator cards (Claude Code, Codex, other AGENTS.md hosts) an agent can close or publish a managed review round without a human, because several completion gates accept text the agent itself writes.

- The verifier gate passes when `report.md` contains `Not verified: N` (`src/review/readiness.ts:228-235`). The refusal message tells the agent which line to add.
- The moved-head gate passes when the report's first line names a SHA and says the PR moved (`src/review/complete-head-gate.ts:56-58`).
- `review complete --head <sha>` replaces the reviewed head recorded at `review start` with only a warning (`src/review/managed.ts:1043-1055`), which makes the moved-head check false.
- A waiver of any one of `files-covered`, `blast-radius`, `reviewers`, `ledger` empties the whole research-error list (`src/review/managed.ts:1105-1107`).
- `publishReview` never reads `manifest.status`, takes no completion lock and skips the round-record tamper check and the evidence-level check that exist only on the `complete` path (`src/review/publish.ts:146-180`).
- The orchestrator skill tells keryx shell to pass `model_tier` on reviewer dispatches; `spawn_subagent` ignores that field (`src/harness/tool/builtin/spawn-subagent-tool.ts:1497-1498`). The accepted field is `model_class`, which no review skill names.

## Expected Outcome

A managed round cannot be closed or published on the strength of agent-written text alone, a waiver lifts only the item it names, publish and complete evaluate the same gates, and reviewer dispatches on keryx shell carry a model field the spawn tool honours.

## Outcome criteria

- Источник: docs/analysis/review-process-audit-2026-11-12.md
- Эффект (формализация агента): no completion or publish gate of a managed review can be satisfied by text the reviewing agent wrote without an operator card or a TTY, a readiness waiver removes only the errors of the waived item, and the reviewer model class chosen by `keryx review tier` is the one the keryx shell child actually runs on.
- Как наблюдать (предложение агента): the new regression tests named in the acceptance criteria fail on `66ee00117` and pass on the flow's head; `keryx review complete` on a fixture package with unverified majors and a `Not verified: N` line in `report.md` is refused when no operator proof is present.

## Out of Scope

- Verifying host-question answers cryptographically (`completion-host.ts`); this flow only marks them as unverified in the published body.
- Locking `ingest` and `ledger build`, and widening the completion snapshot (flow 490).
- Any change to which reviewers run or how findings are scored (flow 489).
