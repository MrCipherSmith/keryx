# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Draft — reconcile counts and names with the re-verified context map before freeze.

## Criteria

- AC1: Every file-backed bundled skill has one description and one trigger list: its `BUNDLED_GDSKILLS` catalog entry (which the router scores) carries the same description and triggers as its `SKILL.md` frontmatter (a test fails on any difference), rendered-only skills keep an explicit description, and the `Use when ${purpose}` fallback — which today yields "Use when <imperative>" for all 67 entries that use it — no longer exists in `src/gdskills/catalog.ts`.
- AC2: `bundled-eval` reports a `description:*` finding for a description with no trigger phrase, one that reads "Use when <bare imperative verb>", and one longer than 1024 characters; each has a failing fixture and a passing control; the shipped tree has zero such findings.
- AC3: `bundled-eval` reports an `anatomy:sections` finding for a non-exempt skill missing a trigger with a "NOT for" clause, a Red Flags / rationalization table, or a Verification / exit-criteria / STATUS section; exemptions live in a reason-carrying map that a test asserts is non-empty with a reason per entry; fixtures cover each missing section; the shipped tree has zero findings.
- AC4: `bundled-eval` reports an `anatomy:length` finding for a skill over its ceiling in a checked-in per-skill ceiling file, or a skill with no ceiling over 500 lines; ceilings equal today's line counts when introduced; `skills-storage-workflow.mdc` states that ceilings only move down; fixtures prove both findings.
- AC5: A routing corpus covers every bundled skill, rendered ones included, with at least three positive prompts (expected skill within the shipped scorer's top 3) and at least two negative prompts that each name the skill that must outrank it; a test runs `scoreBundledSkillRoute` over the corpus, and a checked-in rank-1 accuracy baseline fails the test when accuracy drops below it.
- AC6: `bundled-eval` reports a `description:collision` finding for two skills whose descriptions reach a similarity of 0.75 or more on the scorer's own tokenisation; fixtures prove it; the shipped tree has zero findings.
- AC7: Ambiguous queries between overlapping skills rank their owner first through the shipped scorer, with a corpus case each: at least "clarify requirements" (interviewer), "write tests" and "generate tests" (test-gen), "create tests first" (tests-creator), "review my code" and "full review" (review-orchestrator), "implement this issue" (the orchestrator the corpus names as owner, with the other two as negatives), and "check performance" — today a three-way tie between perf-check, review-performance and review-flow-graph — resolved to one owner.
- AC8: `SKILL.<runtime>.md` files byte-identical to `SKILL.md` are removed from the bundled and installed trees, only builds that genuinely differ remain, export and install treat the `SKILL.md` fallback as the normal case without a warning, and build-parity, status-contract, round-bound, agent-catalogue-xref and bundled-eval pass with updated denominators.
- AC9: Every workflow skill carries a Red Flags table naming failures specific to that skill and a Verification / exit-criteria section, so `anatomy:sections` needs no exemption for any workflow skill.
- AC10: `bundled-eval` sweeps `orchestrator-prompt.md` files for dead references, reads frontmatter values through `parseSkillFrontmatter`, and no longer captures a trailing sentence period in a path; `feature-dev`, `hookify` and `deploy` no longer hardcode `npx tsc`.
- AC11: A rejected-change ledger exists, and `skills-storage-workflow.mdc` requires checking it before proposing a skill change and appending to it when a change is rejected.
- AC12: Mirrored bundled and installed files are byte-identical, `bun ./src/cli.ts skills verify --bundled` exits 0, typecheck and eslint pass, and the full `bun test` suite has no failure absent from the pre-change baseline recorded in `journal.md`.
- AC13: The final review round against the PR head ends with zero open blocker, major or minor findings, every finding at or above minor carries a terminal disposition backed by verifier claims, and `keryx flow complete` passes its review gate.
