---
name: review-architecture
model_tier: deep
description: |
  Use when: reviewing code for architectural violations — layer violations, dependency direction
  mistakes, module boundary coupling, SOLID principle breaches, NestJS module/provider structure,
  React MVVM boundary violations, or MobX store layer misplacement.
  Dispatched by review-orchestrator with --architecture or --backend.
  NOT for: style/naming preferences, logic correctness bugs, or security vulnerabilities.
triggers:
  - "architecture review"
  - "boundary review"
  - "layering"
  - "check architecture"
  - "architectural review"
  - "check layers"
metadata:
  author: "MrCipherSmith"
  version: "1.2.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review Architecture

Specialized reviewer for **architectural patterns and structural decisions**.
Reviews only changes introduced in the current branch (merge-base to HEAD).
Focuses exclusively on verifiable structural violations — not style opinions or hypothetical concerns. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

---

## Workflow

```
Architecture Review Progress:
- [ ] Step 1: Read Job Context (if provided) — understand intentional stack choices
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Identify stack (NestJS, React+MobX, generic TS, mixed)
- [ ] Step 5: Check layer assignments and dependency direction
- [ ] Step 6: Check module/provider boundaries
- [ ] Step 7: Check design pattern correctness (Repository, DI, MVVM)
- [ ] Step 8: Check SOLID violations
- [ ] Step 9: Check framework-specific concerns (NestJS / React / MobX)
- [ ] Step 10: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document. Read before reviewing to understand intentional decisions. |
| `stack_hint` | string | no | Optional hint: `nestjs`, `react-mobx`, `generic-ts`. Reviewer auto-detects if absent. |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Review scope: **changes introduced in the current branch since merge-base only**.
Do not review pre-existing architectural problems unless they are directly touched by the diff.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

---

## Stack Auto-Detection

When `stack_hint` is not provided, infer from changed file paths:

| Signal | Detected stack |
|--------|---------------|
| `*.module.ts`, `*.controller.ts`, `*.provider.ts`, `@Injectable`, `@Module` | NestJS |
| `*.store.ts`, `makeObservable`, `observable`, `action`, `computed` (MobX) | React + MobX |
| `*.tsx` / `*.jsx` | React (check MVVM boundaries) |
| `prisma/`, `*.repository.ts`, `*.entity.ts` | Backend data layer |
| Mixed signals | fullstack — apply all relevant checks |

---

## Focus Areas and Checklist

### Layer Violations

A **layer violation** occurs when code belonging to one architectural layer is placed in another. The layers and what each may import are `.metaproject/rules/core/clean-architecture.mdc` (backend: controller, use case, repository, domain, infrastructure, each boundary mapping its own types) and `.metaproject/rules/core/code-style-patterns.mdc` Rule 2 (frontend: component renders, store holds logic, service does I/O only; derived state is `@computed` per `.metaproject/rules/core/mobx-store-template.mdc` Rule 1). Adapt to the project's actual layering and report a placement those rules forbid.

### Dependency Direction

Dependencies must flow **inward** (from infrastructure toward domain), never outward.

- [ ] Domain module importing from infrastructure (`.metaproject/rules/core/clean-architecture.mdc`)
- [ ] Core/shared module importing from feature module (inverted dependency)
- [ ] Circular import between modules (A imports B, B imports A)
- [ ] Barrel file (`index.ts`) that creates hidden circular references

### Module Boundary Violations

- [ ] Feature A reaching into feature B's internal files instead of its public exports (`.metaproject/rules/core/clean-architecture.mdc`)
- [ ] Shared `utils/` or `common/` module containing domain-specific business logic
- [ ] Cross-module data transformation happening in the wrong module

### Design Pattern Misuse

**Repository pattern** (`.metaproject/rules/core/clean-architecture.mdc`: the repository is the I/O boundary, business rules live in the domain):
- [ ] Multiple repositories doing the same data transformation independently

**Dependency Injection:**
- [ ] `new X()` for an I/O, network or clock dependency inside a class that should receive it (constructing a plain helper or value object inside a module is fine: `.metaproject/rules/core/solid-principles.mdc` section D)
- [ ] Service locator pattern used instead of constructor injection
- [ ] Singleton service holding request-scoped state

**CQRS / Use-case:**
- [ ] Command handler performing a query and returning domain data (mixed responsibility)
- [ ] Use-case importing another use-case (chain via domain events instead)

### SOLID Violations

SRP, OCP, LSP, ISP and DIP, their thresholds and their severities are `.metaproject/rules/core/solid-principles.mdc` (its Thresholds table). Below a threshold, report nothing. This lens adds only its calibration:

- SRP: name the two responsibilities the class holds; size alone is not a finding. A component that renders, fetches and derives is `.metaproject/rules/core/code-style-patterns.mdc` Rule 2.
- OCP: a finding only at the Thresholds branch-chain row (4 or more branches over a type discriminant, extended by this change, where the codebase already uses a map or strategy); a chain that merely might grow is not one.
- DIP: asks for an interface only at an I/O or substitution boundary; a single internal implementation gets none. An infrastructure class passed through several layers instead of behind an interface at that boundary is a finding.

### NestJS-Specific

- [ ] `@Injectable` service used across modules without being exported from its owning module
- [ ] `@Global()` overused — global providers for non-truly-global concerns
- [ ] Circular dependency between NestJS modules without `forwardRef`
- [ ] Provider scope mismatch: `REQUEST`-scoped service injected into `DEFAULT`-scoped service
- [ ] Controller fat with business logic that belongs in the service layer
- [ ] `@Module` imports array including modules it does not need (unnecessary coupling)

### React + MVVM (with MobX)

Logic in a component, effects that orchestrate state, and cleanup are `.metaproject/rules/core/code-style-patterns.mdc` Rules 2 and 5 with `.metaproject/rules/core/mobx-store-template.mdc` Rule 8. This lens adds:

- [ ] Component subscribing to raw observable fields instead of using computed/derived values
- [ ] View rendering based on multiple raw observable fields instead of a single computed boolean

### MobX Store Layer

Mutation outside an action, async resolution without `runInAction`, and inter-store callbacks left public are `.metaproject/rules/core/mobx-store-template.mdc` Rules 2 and 3 and their rows; a store importing another store's internal file is `.metaproject/rules/core/clean-architecture.mdc` (public exports only). This lens adds:

- [ ] `@computed` with side effects (computed must be pure)

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Layer violations, dependency direction, module coupling | YES | — |
| SOLID violations (SRP, DIP, OCP, LSP, ISP) | YES | — |
| NestJS module/provider/scope issues | YES | — |
| React MVVM boundary, MobX store layer | YES | — |
| Logic bugs, off-by-one, null safety | NO | `review-logic` |
| Security vulnerabilities (injection, auth bypass) | NO | `review-security-code` |
| Style, naming, import order | NO | `review-style` |
| Performance (bundle size, render cost, query plan) | NO | `review-performance` |
| MobX store internals deep-dive | surface violations only | `review-frontend` for full store audit |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what architectural rule is violated and how
- **Why it matters**: impact on testability / maintainability / correctness
- **Fix**: concrete structural change
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own; what follows is where its recurring
conditions land under that rubric, not a second rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Circular dependency that fails at runtime (an import resolves to `undefined` on a path the change reaches) | `blocker` | Crash |
| Module scope mismatch that produces wrong data across requests | `blocker` | Data corruption |
| Layer violation in the backend — business logic in a controller, domain importing infrastructure (a frontend component's layer violation is the `code-style-patterns.mdc` Rule 2 row) | `minor` — `major` only when a concrete defect it causes is named (trigger and outcome) or a stated project rule makes it one | Structural cost lands on the next editor. Identical to `review-backend` for the same condition |
| Cross-module coupling | `minor` — `major` under the same condition | Same |
| SOLID findings (SRP, ISP, DIP, OCP, LSP) take the `solid-principles.mdc` Thresholds severity; a component reading several raw observables instead of a computed | `minor` | The code is correct; the cost is to whoever restructures it next |
| Architectural opinion with no named violation | `info` | Shared laws 1 and 2 |

This lens owns circular imports: one that resolves cleanly is `minor`, not a
`blocker`; `review-style` and `review-clean-code` defer to this rating.

## Iron Laws

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot name the input, call, or condition that reaches the code, you have an observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code under review. Do not report a safe API because it could be misused, or a pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears at several sites, report it once and list every site. Ten findings that are one finding hide the other nine problems.
4. **A deliberate choice is not a defect until its reason is read and shown wrong.** An explicit override, suppression or exemption, a comment or commit giving a reason, or a sibling doing the same is a decision: read its reason (the comment, `git log -L` or `git blame`, the sibling) before you report it, and report it only when you can show that reason wrong. A project rule is checked against accepted platform practice and its known exceptions before a deviation from it is reported.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer does not restate them: `blocker` is the
four merge-blocking shapes named there and nothing else, and the `major`/`minor`
boundary is the trigger-and-outcome test.

### Architecture laws

- Only flag actual violations found **in the diff**, not pre-existing issues untouched by the change.
- Every finding MUST cite a specific `file:line` from the diff.
- Architecture opinions without a clear, named violation (layer, SOLID principle, pattern misuse) are `info` only — never `blocker` or `major`.
- Do not flag correct framework usage as a violation just because an alternative exists.

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

| Status | Meaning |
|--------|---------|
| `DONE` | No blockers or majors found; architecture is sound in this diff |
| `DONE_WITH_CONCERNS` | One or more blocker or major findings present |
| `NEEDS_CONTEXT` | Cannot determine correct layering without knowing the project's architecture decisions |
| `BLOCKED` | Cannot access diff or required files |

```markdown
## Architecture Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Stack detected: <NestJS | React+MobX | generic-ts | fullstack>

### Summary
<2-3 sentences: what structural changes were introduced, overall architectural verdict.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Layer Violations
<[F-NNN] findings or "None detected.">

### Dependency Direction
<[F-NNN] findings or "None detected.">

### Module Boundary Violations
<[F-NNN] findings or "None detected.">

### Design Pattern Misuse
<[F-NNN] findings or "None detected.">

### SOLID Violations
<[F-NNN] findings or "None detected.">

### Framework-Specific (NestJS / React+MobX)
<[F-NNN] findings or "None detected." or "N/A — not detected in stack.">

### Suggested Patches
<Minimal unified diffs for straightforward structural fixes. Omit if not warranted.>
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY carry `JOB_NAME` and `CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md`. If given and the file exists, read it before you start; use it for intentional design decisions (do not flag correct library usage), acceptance criteria when there is no `issue_url`, and the severity of edge cases the team accepted. If absent, proceed normally: context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "This class is large, so it must violate SRP" | Size alone is not a violation; cite what two unrelated responsibilities it holds |
| "I see a potential layer violation in a file not in the diff" | Scope is diff-only; pre-existing issues are out of scope unless the diff touches them |
| "This architecture opinion makes things cleaner, so it's a major" | Opinions without a named violation are `info` only |
| "I'll flag every cross-import as a boundary violation" | Not all cross-imports violate boundaries; check whether the dependency direction is correct |
| "The team probably didn't intend this pattern" | Unless the context doc or a clear rule says otherwise, assume intentional; use `info` if unsure |
| "NestJS global module is always wrong" | `@Global()` is a violation only when used for non-global concerns; framework-provided globals are fine |
| "I can't determine if this is wrong without knowing the full architecture" | Use `NEEDS_CONTEXT` status and ask one specific question |

<!-- keryx:layers-block:start -->
## Project layers: graph, tests, wiki, memory

Your payload may carry a `layers` block for your files: the files the graph says are affected, symbol neighbours, related tests, the wiki pages that describe the files and the memory entries for their module. It is bounded, and `truncated` names what was cut and the command that fetches the rest. When the diff alone does not settle a question, ask the project. Each command below is read-only and calls no model.

- `keryx gdgraph affected <file>`: who depends on the file. Use it before you call a change contained, and whenever a changed export, signature or behaviour may have callers outside your files.
- `keryx test related <file>`: the tests that cover the file. Use it before you say a behaviour is untested, and to judge whether a test would fail if the code broke.
- `keryx wiki ask "<q>"`: what the project wiki says a module is for and which rules bind it. Use it when the intent of the code is unclear and the diff does not state it.
- `keryx memory search "<q>"`: recorded lessons, decisions and known mistakes. Use it before you report a pattern the project may already have decided on, and when a failure looks like one it has seen.

In a review package, `keryx gdgraph affected <file> --data-dir <package>/layers/graph` reads the graph built at the PR head; the tracked graph may be from another commit. A finding still rests on the code you read: what a layer says is a lead, not evidence. If a layer is empty or a command fails, say so in the report instead of guessing.
<!-- keryx:layers-block:end -->
