# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review jev-risk (--diff <ref>|--pr <n>) [--json]` builds a RISK MAP: for every retained hunk (`buildReviewScope`), deterministic facts first (path class: auth/permissions/crypto/migrations/schema/public API/config/concurrency primitives/IO, touched exported symbols, lines changed, test files touched nearby) and then one Jev `noul` per risk dimension (security-sensitive, data/migration, public-API/contract change, concurrency, error-handling) per hunk, bounded by a documented `--max-calls` budget with truncation reported; output ranks hunks by combined risk so a human reviewer knows where to look first.
- AC2: The risk map emits reviewer findings (`reviewer-finding.schema.json`, reviewer `review-jev-risk`) only for hunks above a documented threshold AND where no test in the diff touches the same module (a fact), severity `info`/`minor` (never higher — it flags attention, not a defect), prose synthesized deterministically by keryx (Jev writes none); and additionally feeds the orchestrator as a routing hint: hunks above threshold with a security/concurrency dimension are listed for `review-security-code`/`review-highload` dispatch (the orchestrator skill documents how the hint is used).
- AC3: `keryx review jev-scenarios (--diff <ref>|--pr <n>) [--json]` — FUNCTIONAL review: user scenarios are gathered deterministically from the project's knowledge (gdwiki pages of kind scenario/flow/user-journey, PRD `docs/requirements/**` requirement/scenario sections, README/docs "how to" sections), each with the code it links to (gdgraph/wiki links); for each scenario the facts (which of its linked files/symbols the diff touches) are computed, and scenarios with any touched link get one Jev `noul` "does this change alter the behaviour of this scenario?".
- AC4: The scenarios reviewer emits (reviewer `review-jev-scenarios`) a manual-check list — scenarios likely affected, ranked, each with the touched links as evidence — and a finding (`minor`) for each likely-affected scenario with no test in the diff covering it (fact); prose synthesized by keryx.
- AC5: Both commands are opt-in (`review.jev.risk`, `review.jev.scenarios` in `.metaproject/tasks.config.json`); without the opt-in they print the deterministic facts only and say Jev was not asked; redaction via `src/security/service.ts`.
- AC6: Shell: `/risk` and `/scenarios` (or tabs in an existing review modal) show the risk map (ranked hunks with per-dimension markers) and the affected-scenario checklist for the working diff; English UI; render tests.
- AC7: The reviewer is registered in the review orchestrator as an ADDITIONAL reviewer (never replacing any): `review-orchestrator/SKILL.md` (bundled + installed copy) dispatches it via the CLI when its opt-in key is set and Jev is reachable; `keryx review reviewers --json` lists it with `engine: jev`; its findings pass the same quality gate, dedup and Wave C verification. If flow 330 (review-jev-rules) has already landed on main when this is implemented, follow its registration pattern exactly.
- AC8: Tests: pure functions for fact gathering and finding synthesis, CLI tests with fixture diffs/docs/comments and recorded Jev answers, emitted findings validated against `reviewer-finding.schema.json`; hermetic, macOS-safe, revert-checked.
- AC9: Live check (run with `env -u OPENROUTER_API_KEY`) on 2 merged PRs of this repo: findings, Jev calls, cost, time, and 10 findings hand-labelled true/false positive, journaled honestly and added to `~/notes/jev-in-keryx.md` is NOT done by the agent (operator notes are written by the lead).
- AC10: Docs (cli-reference, orchestrator docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, import zones respected (redaction only via `src/security/service.ts`).
