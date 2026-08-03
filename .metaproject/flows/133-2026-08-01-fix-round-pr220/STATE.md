# Flow 133 — state, for a cold start

Written so this work survives a context reset. Everything below is on disk; the
conversation holds nothing that this file does not.

## Where it stands

- **Branch** `feat/r4c-turn-submission`, clean, all work committed.
- **Suite** 2967 pass · 14 skip · 0 fail across 291 files. `bun run typecheck`
  clean. `bun run keryx -- health gate` → pass. `bun run test:guards` → 161 pass.
- **Acceptance criteria** frozen, **15 of 15 confirmed**, each verified by
  execution rather than by reading the plan.
- **Tasks** 12 of 13 done. The only open one is **T13 — update PR #220 and ready
  it.** PR #220 is OPEN and a DRAFT.
- **Reviews** six rounds, all closed, all recorded twice: as prose in
  `round3-review.md` … `round6-review.md`, and as managed packages under
  `.metaproject/reviews/2026-08-03-ingest-round{3,4,5,6}-review-md` — 31 findings,
  every one carrying `class_scope`.

## What the six rounds were about

Twelve blockers. Laid side by side they are **one** mistake repeated: branching
on a value whose domain was never written down. The full evidence table and the
counter-evidence — three total switches with no default arm, zero defects across
all six rounds — are in
`.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md`.

Two other durable lessons came out of it:

- `.metaproject/memory/lessons/regex-guards-lose-to-spellings.md` — a pattern
  guard loses one spelling per round, and matching the AST only slows it down.
  Corrected after round four, when the AST rewrite I had called a closure was
  defeated by twelve ordinary spellings.
- `.metaproject/memory/constraints/code-blanks-string-literals.md` — `code()`
  blanks string literals, so a guard whose subject is a string matches zero
  forever. Corrected twice; its own headline count was wrong.

## Open items, deliberately not closed

- **OQ-4** — cursor's empty-hook-response contract. The three-way decision in
  `src/commands/security.ts` is three-way on cursor and antigravity only; on
  claude, windsurf and generic-mcp `allowAction` is a bare `{exitCode: 0}`, so
  silence and approval are byte-identical. Nothing in this repository cites what
  an empty response means to cursor. Settling it needs a first-party source, and
  possibly an `askAction`.
- **`pii: { action: "allow" }` still redacts.** Found in round three while
  looking for a config knob that changes `redact()` output; a question about the
  resolver, outside this flow's scope, never chased.
- **The pattern-matching guards are capped.** `config-dir.ast.ts` is a heuristic
  with a written gap list, and the gaps are executable tests asserting `false`.
  No further widening without a planted, executed counter-example. The one guard
  with a real oracle is `production-graph.test.ts`, which asks the bundler.

## How to resume

```
bun run keryx -- flow status 133      # tasks and AC state
gh pr view 220                        # the remaining task
gh-whoami                             # ALWAYS before a mutating gh command
```

Round records read newest-first: `round6-review.md` carries the trend table and
the three process conclusions.
