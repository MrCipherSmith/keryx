# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Packs ts-js-node, react (pack.json declares it extends ts-js-node), python and go exist under src/gdskills/bundled/stacks/<id>/ with rules coding-style/patterns/security/testing.mdc that pass strict lintStackRule (extends common, paths within STACK_EXTENSIONS, metadata.origin) and implement/test/review/build-fix skills (migrate for ts-js-node and react, explicit empty migrate list for python and go) that pass strict lintSkill.
- AC2: Every pack skill has an authored evals.json beside its SKILL.md with at least 10 trigger prompts including at least 4 negatives and at least one behavior scenario graded only by deterministic graders, and a governance/scout.json entry recorded by the real `keryx skills scout --record` (create, or fork/use with a justification).
- AC3: Every one of the 18 batch-1 pack skills was evaluated once through the real CLI with `keryx skills eval <id> --scope bundled --runner deepseek:deepseek-chat --strictness high --trials 5` (DeepSeek deepseek-chat, the owner-chosen gate model), with no content edits during the run. Each pack's governance/eval.json holds those reports verbatim, bound by digest to the current SKILL.md and evals.json and stamped with runner, model, scope and recordedAt. checkStablePackGate decides stability: a pack is stable only if every skill passes and every behavior scenario is at or above 0.8. The recorded outcome for this batch is that all four packs (ts-js-node, react, python, go) stay experimental, with the failing scenarios named in the W1 spec and in each pack's agent-refs.json note.
- AC4: `keryx skills eval --runner <provider>[:<model>]` runs behavior scenarios through a real single-turn provider call (unit-tested with an injected provider); without --runner behavior scenarios still report not-run.
- AC5: Per-stack agent pairs (<stack>-code-auditor, read-only; <stack>-build-fixer, workspace-write with worktree isolation) are produced only by the deterministic generator through `keryx agents generate --stack <id>`. The generator refuses a pack that is not gate-cleared, refuses a pack.json id that differs from its directory, quotes every frontmatter value, validates identifiers, and checks containment and symlinks for both targets before writing, all covered by tests. Because no batch-1 pack cleared the gate, no generated pair ships, every pack's agent-refs.json is empty with a note naming the failing scenario, and `keryx agents verify` reports ok.
- AC6: `keryx agents verify` default resolvers accept stack-pack skill names and fail closed with a named reason for a generated agent whose pack is not gate-cleared (not stable with a passing eval gate, or deprecated), covered by tests.
- AC7: install-manifest.json registers separate rule and skill modules plus a component and a stack profile for each of the four packs; `keryx skills install --profile <stack> --dry-run --json` plans each pack's files with no duplicate module and the full profile includes them.
- AC8: `keryx skills stocktake --scope bundled` gives no pack skill a merge verdict and adds no merge verdict for any pre-existing skill versus the recorded baseline (autodoc-writer, consistency-checker, docpack-review, spec-writer, metaproject-security, pr).
- AC9: `keryx security audit-harness` over a temporary project with the four packs installed for claude and the eight agents exported for claude reports no findings.
- AC10: src/gdskills/stack-packs.test.ts, governance tests and src/agents tests pass, and typecheck plus eslint are clean on changed files.
- AC11: The W2 spec's per-stack table names the pair <stack>-code-auditor / <stack>-build-fixer, with a bumped Version and a batch-1 status of no pair shipped. The W1 spec records batch 1: the DeepSeek gate model, the per-pack results with the failing scenarios, and the llama3.1 run as a supplementary signal. The journal records that the stack-coverage count stays at 2, because no batch-1 pack cleared the gate, and corrects the earlier premature 2 -> 5 entry.
