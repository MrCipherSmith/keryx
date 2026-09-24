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
- AC3: `keryx skills eval <id> --runner ollama:llama3.1:latest --strictness high --trials 5` reports verdict pass with evidence authored, all positives selected, zero false positives and every behavior scenario passRate >= 0.8 for every pack skill; the reports are stored in each pack's governance/eval.json, those packs are marked stable and checkStablePackGate returns pass for them.
- AC4: `keryx skills eval --runner <provider>[:<model>]` runs behavior scenarios through a real single-turn provider call (unit-tested with an injected provider); without --runner behavior scenarios still report not-run.
- AC5: Eight generated agents (<stack>-code-auditor and <stack>-build-fixer for each pack) exist in src/gdskills/bundled/agents with origin.kind generated, origin.sourceRef = pack id and stacks [pack id]; auditors are read-only with no write/shell tools, fixers are workspace-write with worktree isolation; a test proves each file equals the generator's output; each pack's agent-refs.json lists its pair; `keryx agents verify` reports ok.
- AC6: `keryx agents verify` default resolvers accept stack-pack skill names and fail closed with a named reason for a generated agent whose pack is not gate-cleared (not stable with a passing eval gate, or deprecated), covered by tests.
- AC7: install-manifest.json registers separate rule and skill modules plus a component and a stack profile for each of the four packs; `keryx skills install --profile <stack> --dry-run --json` plans each pack's files with no duplicate module and the full profile includes them.
- AC8: `keryx skills stocktake --scope bundled` gives no pack skill a merge verdict and adds no merge verdict for any pre-existing skill versus the recorded baseline (autodoc-writer, consistency-checker, docpack-review, spec-writer, metaproject-security, pr).
- AC9: `keryx security audit-harness` over a temporary project with the four packs installed for claude and the eight agents exported for claude reports no findings.
- AC10: src/gdskills/stack-packs.test.ts, governance tests and src/agents tests pass, and typecheck plus eslint are clean on changed files.
- AC11: The W2 spec's per-stack table names the pair <stack>-code-auditor / <stack>-build-fixer with its Version bumped, the W1 spec records batch 1, and the journal records the stack-coverage count increase only after the gate passed.
