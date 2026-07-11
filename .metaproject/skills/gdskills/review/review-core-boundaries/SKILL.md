---
name: review-core-boundaries
description: |
  Use when reviewing shared core/infrastructure module changes for dependency
  direction, feature-boundary leakage, abstraction stability, composition,
  and blast-radius risks. Dispatched by review-orchestrator for
  --core-boundaries, --project-conventions, --all, or src/core/** changes.
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# Review — Core Boundaries

Reviewer for shared infrastructure modules. A core module should provide stable foundations
used by feature modules; it should not accumulate feature-specific behaviour.

---

## Scope

Applicable to folders such as `src/core/**`, `core/**`, `shared/**`, `foundation/**`,
or whatever the repository documents as its shared infrastructure layer.

If a more specific module reviewer also applies, run both.

---

## Checklist

- Shared/core modules contain reusable utilities, base components, base stores, primitives, and
  infrastructure.
- Feature-specific code does not move into core just to avoid imports.
- Core does not import feature/domain modules.
- Dependencies stay minimal and point inward: feature modules depend on core, not the reverse.
- Prefer composition through interfaces, base classes, adapters, or callbacks over hard-coded
  feature knowledge.
- Public core APIs remain stable and domain-neutral.
- New exports are added only when there is a real shared consumer need.
- Changes are conservative because core has broad blast radius.
- Generic helpers remain generic; names, types, and state do not leak a single feature's language.
- Resource-owning utilities document and test cleanup semantics.

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/core/file.ts:line
- **Problem**: core boundary or stability rule violated
- **Why it matters**: blast radius across modules
- **Fix**: move to domain module, invert dependency, or extract a truly shared abstraction
```

Severity guidance: importing feature code into core or adding feature-specific public API is
usually `major`; broad shared API breakage can be `blocker`.

