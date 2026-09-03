# Managed review — PR #438 (flow 221), prompt-audit skill surface

Target: branch `fix/prompt-audit-skill-surface`, head 66ba94e (merged as 4f8e95a; trees identical).
Scope: 56 files, 58 post-prefilter paths — code (skill-frontmatter.ts, metaproject-adapter.ts,
bundled-eval.ts + tests) and bundled skill texts (review/* triggers, feature-analyzer,
job-orchestrator Rules of Engagement 30→7, autodoc-orchestrator) plus their harness builds.

## Method

Three lenses, dispatched as read-only reviewers:

1. review-testing-practices — quality of the new tests (block-scalar regression, bundled-eval
   checks). Ran read-only over the diff and current tree.
2. review-skills-content (clean-code/architecture lens) — skill texts, triggers, description,
   Rules of Engagement 30→7, harness-build parity. Ran read-only.
3. review-parser-logic — parser correctness; child timed out, the parent re-checked the parser
   directly: read skill-frontmatter.ts and executed an 11-case edge probe against the real module.

Findings were screened against the changed-file scope; all findings below name the file and how
the claim was checked.

## Findings

## F-001 — block-scalar test coverage misses the `+` chomping variants

severity: minor

- **Location**: src/harness/tool/metaproject-adapter.test.ts (block-scalar test ~line 561)
- **Reviewer**: review-testing-practices
- **Problem**: The regression test for `parseSkillFrontmatter` exercises `|`, `>`, and `>-`, but
  the `|-`, `|+`, `>+` spellings AC1 names have zero coverage. A regression in the `+` (keep)
  or `-` (strip) chomping branch would pass the suite silently.
- **Impact**: The parser change is exactly the kind that a spelling-specific branch breaks;
  the criterion AC1 enumerates all six spellings, so the test should enumerate them too.
- **Evidence**: Read the test file; `bun run` edge probe against the real module confirms all six
  spellings currently parse correctly, so this is a coverage gap, not a live defect.
- **Suggested fix**: parametrized unit test over all six AC1 spellings plus termination/indentation
  edges, asserting folded prose.

## F-002 — `bundled-eval.test.ts` control fixture comment overstates its fixture

severity: minor

- **Location**: src/gdskills/bundled-eval.test.ts (~line 382)
- **Reviewer**: review-testing-practices
- **Problem**: A control-comment describing a fixture as a block-scalar case sits next to a
  fixture that is actually a plain scalar (`control-example`), so the comment promises more than
  the fixture exercises.
- **Impact**: A later reader may believe the block-scalar parse is negatively controlled when it
  is not; cosmetic, but the mismatch is the exact "looks recorded" shape this flow's other work
  removes.
- **Evidence**: Read the fixture and its comment in the current tree.
- **Suggested fix**: align the comment with the fixture, or give the control a real block scalar.

## F-003 — no direct unit-test file for `parseSkillFrontmatter` termination edges

severity: minor

- **Location**: src/gdskills/skill-frontmatter.ts
- **Reviewer**: review-testing-practices
- **Problem**: The parser's block-termination edges (first non-indented line ends the block; blank
  lines inside; chomping) are covered only indirectly through the adapter test and the real-tree
  gate, not by a unit file targeting the parser itself.
- **Impact**: Termination and indentation edges are the load-bearing part of the fix (F-1's "triggers
  swallowed by the block"); an indirect-only net can drift from the parser's actual contract.
- **Evidence**: Confirmed no `skill-frontmatter.test.ts` exists; edge probe against the real module
  passes all 11 cases today.
- **Suggested fix**: a unit file for `parseSkillFrontmatter` covering termination on first
  unindented line, blank-line handling, and the `+`/`-` chomping indicators.

## Verification

- Parser edge probe (11 cases, real module): all pass — six block-scalar spellings, inline quoted
  and plain, absent description, malformed/no-close → `{}`, empty → `{}`, `|` with no body → "".
- Harness builds: `diff` over the 8 changed build pairs (feature-analyzer + job-orchestrator ×
  codex/cursor/zed/opencode) shows 0 differing lines vs SKILL.md.
- Mirror: `diff` over 6 changed `.metaproject/skills/gdskills` mirrors shows 0 differing lines.
- Test suite: `bun test` on the three touched test files — 54 pass / 0 fail.
