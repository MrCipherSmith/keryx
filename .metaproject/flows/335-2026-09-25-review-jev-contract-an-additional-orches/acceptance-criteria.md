# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/review/jev-contract.ts` implements an additional CLI-engine reviewer `review-jev-contract` (`engine: jev`), registered in the orchestrator alongside `review-jev-rules`/`-risk`/`-docs`/`-scenarios` using the same config/registration pattern (each with a matching `jev-contract-config.ts`), verified by unit tests.
- AC2: `keryx review jev-contract (--pr <n> | --diff <ref>) [--flow <id>] [--json]` runs standalone from the CLI, accepts exactly one of `--pr`/`--diff`, and both flag forms produce a findings report.
- AC3: PR-description claim extraction is deterministic: bullets and sentences containing verb cues (adds, fixes, removes, does not change, tests) are split into discrete claims, covered by unit tests with fixture descriptions including no-claim and multi-claim cases.
- AC4: When `--flow <id>` (or a PR-linked flow) resolves to a flow with frozen acceptance criteria, `review-jev-contract` reuses `src/flow/check-ac.ts` via `src/flow/service.ts` for AC-vs-diff checks, with no criterion-checking logic duplicated in `jev-contract.ts`.
- AC5: For each claim, deterministic facts are computed before any model call: named files/symbols/flags checked for presence in the diff, "tests added" claims checked against test files touched in the diff, and "no API change" claims checked against exported-symbol changes in the diff; these facts are present in the JSON output per claim.
- AC6: Exactly one `noul` call is made per claim ("does the diff support this claim?"), and findings are classified as minor (unsupported claim) or major with `class_scope` (claim contradicted by deterministic facts, e.g. "no API change" with exported-symbol changes) with schema-valid prose, verified by unit tests covering both severities.
- AC7: The opt-in flag `review.jev.contract` gates `review-jev-contract`; with the opt-in off, the review orchestrator's Stage 1 "description vs diff" judgement falls back to the existing LLM by-eye check unchanged, verified by a test asserting no jev-contract call happens when the opt-in is off.
- AC8: All content sent to Jev/`noul` by `review-jev-contract` is redacted exclusively via `src/security/service.ts` (no ad hoc redaction), verified by a test that a planted secret in a PR description or diff is redacted before the model call.
- AC9: `review-jev-contract` reports its Jev-call budget and any truncation applied, in both prose and `--json` output, matching the field shape used by `review-jev-risk`/`review-jev-docs`.
- AC10: `docs/cli-reference` (or equivalent generated doc), `HELP_GROUPS`, the regenerated commands-by-task doc, the skill catalogs, `skill-length-ceilings`, the routing-corpus case, and bundled skill counts are updated for `jev-contract`; the orchestrator `SKILL.md` stays at or under 1723 lines with `review-jev-contract` details moved into `SKILL.detail.md`, the bundled (`src/gdskills/bundled/...`) and installed (`.metaproject/skills/...`) copies of both files are byte-identical, `/contract` is wired as a shell command, and `src/commands/review.ts` help/USAGE text gains `jev-risk`, `jev-scenarios`, and `jev-contract` lines.
