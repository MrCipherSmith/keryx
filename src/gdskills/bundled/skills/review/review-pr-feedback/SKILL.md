---
name: review-pr-feedback
description: |
  Use when: a developer has received PR review comments and wants to understand them,
  act on them, or extract patterns from them. Covers "analyze PR comments",
  "review PR feedback", "what did reviewers say", "parse PR #N", "explain PR comments",
  or dispatched by review-orchestrator when a PR URL is provided.
  NOT for: reviewing code directly — this skill reads human or bot PR feedback and
  makes it actionable. To review code, use the domain review skills.
version: "1.0.0"
triggers:
  - "analyze PR comments"
  - "review PR feedback"
  - "what did reviewers say"
  - "parse PR #N"
  - "explain PR comments"
  - "PR feedback"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review — PR Feedback Analyzer

Analyzes existing GitHub PR review comments from human reviewers or bots. Parses,
explains, and prioritizes reviewer feedback so developers know exactly what to address
and in what order. This skill does **not** review code itself — it interprets what others said.

---

## Workflow

```
review-pr-feedback Progress:
- [ ] Step 1: Read Job Context (if CONTEXT_PATH provided)
- [ ] Step 2: Parse PR URL or identifier
- [ ] Step 3: Fetch review comments, general comments, and review verdicts via GitHub
- [ ] Step 4: Group comments by author
- [ ] Step 5: Classify comment types (blocker intent / suggestion / question / nitpick)
- [ ] Step 6: Explain each comment + suggest concrete fix with code example
- [ ] Step 7: Detect senior/boss reviewer comments — offer pattern extraction (with user consent)
- [ ] Step 8: Emit structured report with action items checklist
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pr_url` | string | YES | GitHub PR URL or shorthand identifier |
| `context_doc` | string | no | Path to job context document (e.g., `<JOBS_ROOT>/<job>/ai/context.md`). |

---

## Step 1: Job Context

If `context_doc` is provided and the file exists, read it before fetching PR comments.

Context path convention: `<JOBS_ROOT>/<JOB_NAME>/ai/context.md`

Use the context to:
- Understand the codebase's conventions and chosen libraries
- Interpret reviewer comments more accurately (e.g., "use the store" means the MobX pattern)
- Identify whether a reviewer's concern is already addressed by project convention

If absent, proceed without context — it is optional and non-blocking.

---

## Step 2: Parse PR URL

Extract `owner`, `repo`, and `pullNumber` from the provided identifier.

Accepted formats:
- `https://github.com/owner/repo/pull/123` → owner=`owner`, repo=`repo`, pullNumber=`123`
- `https://github.com/owner/repo/issues/123` → treat as PR if context confirms it
- `owner/repo#123` → owner=`owner`, repo=`repo`, pullNumber=`123`
- `#123` (when repository context is known from git remote) → resolve owner/repo from `git remote get-url origin`

If the URL cannot be parsed, respond with `STATUS: BLOCKED` and state the parsing failure.

---

## Step 3: Fetch Comments via GitHub

Use GitHub MCP tools or `gh` CLI. Prefer MCP when available.

**Line-specific review comments:**
```bash
gh api repos/{owner}/{repo}/pulls/{pullNumber}/comments
```

**General PR / issue-level comments:**
```bash
gh api repos/{owner}/{repo}/issues/{pullNumber}/comments
```

**Review verdicts (APPROVE / REQUEST_CHANGES / COMMENT):**
```bash
gh api repos/{owner}/{repo}/pulls/{pullNumber}/reviews
```

Collect all three. If any fetch fails, note it in the output and continue with what was retrieved.

For each comment, extract:
- `author.login`
- `body` (comment text)
- `path` (file path, if line-specific)
- `line` or `original_line` (line number, if line-specific)
- `created_at`
- `diff_hunk` (surrounding code context, if available)

---

## Step 4: Group by Author

Organize all comments under each author, distinguishing line-specific from general comments:

```markdown
## Author: <login> (N line comments, M general comments) — Verdict: APPROVE | REQUEST_CHANGES | COMMENT

### Line-specific
- `path/to/file.ts:42` — "comment text"
- `path/to/file.ts:78` — "comment text"

### General
- "general comment text"
```

---

## Step 5: Classify Comment Intent

For each comment, classify intent before explaining:

| Intent class | Description | Default severity mapping |
|---|---|---|
| `blocker` | Reviewer explicitly blocks or says "must fix", "won't approve until..." | blocker |
| `concern` | Reviewer raises a correctness, safety, or design issue without explicitly blocking | major |
| `suggestion` | Reviewer offers an improvement without implying it must be done | minor |
| `nitpick` | Reviewer flags style, wording, naming — usually low stakes | info |
| `question` | Reviewer asks for clarification; may hide a concern | classify after reading carefully |
| `praise` | Positive comment — no action required | — |

If a `question` contains an implied concern ("why did you use X here?" where X is suboptimal), treat it as `concern`.

---

## Step 6: Explain and Suggest Fix

For each comment:

```markdown
### [C-001] <Short title summarizing the comment>

- **Author**: <login>
- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line (or "General")
- **Reviewer said**: > verbatim quote of the comment
- **Explanation**: What the reviewer means, the underlying concern, the type of issue
  (e.g., architecture / type safety / naming / missing test / performance / style)
- **Suggested fix**:
  ```typescript
  // Corrected code example
  ```
- **Confidence**: High | Medium | Low
  - High: reviewer's intent is clear and the fix is straightforward
  - Medium: intent is clear but fix requires understanding more context
  - Low: comment is ambiguous; two or more reasonable interpretations
```

If confidence is Low, state both interpretations and ask the user which one applies.

---

## Step 7: Senior / Boss Reviewer Handling

**Detection**: if an author is identified as a senior or boss reviewer (by username, or by
review authority markers such as "REQUEST_CHANGES from `boss`"), trigger this flow:

1. Notify the user: "This PR has comments from a senior reviewer (`<login>`)."
2. **NEVER update rules, CLAUDE.md, or any configuration without explicit user consent.**
3. Ask: "Should I analyze `<login>`'s comments for patterns and suggest updates to review rules?"
4. If the user agrees:
   - Identify recurring patterns in that reviewer's feedback (not one-off edge cases)
   - Propose specific additions to `~/goodai-base/rules/core/code-review-boss-profile.mdc` or the relevant rule file
   - Present the proposed changes to the user for approval before writing anything
   - After approval, update the rule file and note it in the output
5. Extract generalizable patterns only — not personal phrasing or one-off opinions

---

## Step 8: Action Items

At the end of the report, produce a prioritized checklist:

```markdown
## Action Items

### Must address (blockers and concerns)
- [ ] [C-001] Fix DTO validation missing on `/users/update` endpoint — `src/users/users.controller.ts:42`
- [ ] [C-003] Add error handling to async `createOrder` method — `src/orders/orders.service.ts:87`

### Consider (suggestions)
- [ ] [C-005] Extract magic number `3600` to named constant — `src/auth/auth.service.ts:15`

### Optional / nitpicks
- [ ] [C-007] Rename `x` to `userId` for clarity — `src/users/users.service.ts:33`

### Clarifications needed (ambiguous comments)
- [ ] [C-009] Unclear: reviewer asked "why not use the cache here?" — two interpretations, see finding
```

---

## Output Contract

```yaml
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
summary: "N comments from N reviewers. Verdict: APPROVE | REQUEST_CHANGES | COMMENT. N blockers, N concerns."
action_items:
  - "fix X in path/to/file.ts:42"
  - "address question in path/to/file.ts:78"
rule_suggestions:
  - "pattern: always validate DTOs at controller boundary"  # only when senior reviewer patterns found
```

Full markdown report structure:

```markdown
# PR Feedback Analysis — <owner>/<repo>#<pullNumber>

## Overview
- **PR**: `<title>`
- **Reviewers**: <comma-separated list>
- **Verdict**: APPROVE | REQUEST_CHANGES | COMMENT
- **Total comments**: N (line-specific: N, general: N)

## Stats
- blocker: N
- major (concern): N
- minor (suggestion): N
- info (nitpick): N
- praise: N

## By Author

### <reviewer-login> (N comments — REQUEST_CHANGES)
<grouped findings for this author in C-NNN format>

### <reviewer-login-2> (N comments — COMMENT)
<grouped findings>

## Action Items

### Must address
- [ ] [C-NNN] ...

### Consider
- [ ] [C-NNN] ...

### Optional
- [ ] [C-NNN] ...

### Clarifications needed
- [ ] [C-NNN] ...

## Rule Suggestions (if senior reviewer patterns found)
<only present if user agreed to pattern extraction>
- Pattern: ...
- Proposed rule update: ...
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Parsing and explaining existing PR comments | YES | — |
| Suggesting fixes for reviewer feedback | YES | — |
| Extracting reviewer patterns into rules (with consent) | YES | — |
| Reviewing the code in the PR directly | NO | `review-logic`, `review-backend`, `review-frontend`, etc. |
| Creating PR descriptions | NO | `pr-issue-documenter` |
| Opening or updating the PR | NO | `pr` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

Context path resolution order:
1. Value passed explicitly in the dispatch prompt
2. `GOODAI_JOBS_ROOT` environment variable + `/<JOB_NAME>/ai/context.md`
3. `<PROJECT_DIR>/jobs/<JOB_NAME>/ai/context.md`

If provided and the file exists, read it before fetching PR comments. If absent, proceed normally.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "I'll update the rule file based on the boss's comments without asking" | NEVER auto-update rules; always ask first — rules affect all future reviews |
| "The reviewer's question is just curiosity, not a real concern" | Questions often hide concerns; classify carefully |
| "I'll skip the 'praise' comments — they're not actionable" | Positive patterns help developers understand what to repeat |
| "Confidence High for an ambiguous comment" | Low confidence is honest; false confidence leads to wrong fixes |
| "The diff_hunk gives enough context — I don't need to read the context doc" | Context doc explains intentional patterns that look wrong in isolation |


## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

