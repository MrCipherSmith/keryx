---
name: feature-dev
description: "7-phase feature development workflow: requirements → design → implement → test → review → fix → PR. Full cycle from idea or GitHub issue to merge-ready PR. Confirms requirements and design with user before autonomous execution."
triggers:
  - "/feature-dev"
  - "Develop feature"
  - "Build feature"
  - "Implement feature"
  - "Feature from scratch"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "workflow"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Feature Development (7-Phase)

End-to-end feature development workflow from idea to merge-ready PR.

## Arguments

- `/feature-dev <description>` — start from a text description
- `/feature-dev #<issue>` — start from a GitHub issue
- `/feature-dev --resume` — resume interrupted feature-dev (checks for existing worktree/branch)

## 7-Phase Architecture

### Phase 1: REQUIREMENTS
1. Parse input (description or GitHub issue via `gh issue view`)
2. Clarify ambiguities — ask the user up to 3 questions max
3. Produce a brief spec:
   - **What**: feature description in 2-3 sentences
   - **Why**: user value / business reason
   - **Scope**: what's in, what's explicitly out
   - **Acceptance criteria**: testable bullet points
4. **Get user confirmation before proceeding**

### Phase 2: DESIGN
1. Research the codebase:
   - Find related modules via search tools
   - Read neighboring implementations for patterns
   - Check existing tests for testing conventions
2. Produce implementation plan:
   - Files to create/modify (with brief description of changes)
   - Dependencies or packages needed
   - Data model changes if any
   - Estimated complexity: S / M / L
3. **Get user confirmation on the plan**

### Phase 3: PREPARE
1. Create a feature branch: `git checkout -b feat/<name>`
2. If large feature, consider `git worktree add` for isolation
3. Install any new dependencies

### Phase 4: IMPLEMENT
1. Implement changes file by file, following the plan
2. Follow existing code patterns discovered in Phase 2
3. After each logical chunk, run available checks:
   - Lint: `npm run lint` or equivalent
   - Type-check: `npx tsc --noEmit` or equivalent
   - Fix issues immediately before moving on

### Phase 5: TEST
1. Write tests matching the project's testing patterns
2. Unit tests for new functions/modules
3. Integration tests for API/data flow changes
4. Run full test suite
5. Fix failing tests (max 3 attempts per test)

### Phase 6: REVIEW (Self)
1. Launch `code-review` skill on own changes (if available)
2. Or run a focused self-review:
   - `git diff main...HEAD` — review the full diff
   - Check for: TODOs left behind, console.logs, hardcoded values
   - Verify all acceptance criteria from Phase 1
3. Fix any findings (max 2 review-fix cycles)

### Phase 7: DELIVER
1. Final checks: lint + type-check + tests all pass
2. Commit with conventional message: `feat(<scope>): <description>`
3. Push branch
4. Create PR:
   - Link to issue if applicable
   - Include acceptance criteria as checklist
   - Add test plan
5. Report PR URL to user

## Status Updates

At each phase transition, report progress:
```
✅ Phase 1: Requirements confirmed
🔄 Phase 2: Designing implementation...
```

## Rules

- ALWAYS get user confirmation after Phase 1 (requirements) and Phase 2 (design)
- Phases 4-6 are autonomous — no user interaction needed
- If stuck for >3 attempts on any step, report the blocker and ask user
- NEVER skip Phase 5 (testing) even if user says "skip tests"
- NEVER commit broken code (lint/type-check must pass)
- Keep commits atomic: one commit per logical change, not one giant commit
