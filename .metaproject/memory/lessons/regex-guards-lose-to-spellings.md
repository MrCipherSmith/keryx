---
id: regex-guards-lose-to-spellings
kind: lesson
status: active
created: 2026-08-02
tags: [testing, source-guards, ast, false-green, review]
---

# A source guard written as a regex loses, one spelling per round

Four guards in this tree matched source TEXT. Over three review rounds, every
one was defeated, widened for the spelling that defeated it, and defeated again.
The pattern is not that the authors were careless. It is that **text has
spellings and structure does not**, and a regex can only ever enumerate the
spellings someone has already thought of.

## The record

| guard | round 1 | round 2 | round 3 |
|---|---|---|---|
| scanner importer | knew `from "…"` | + `require`, dynamic `import` | **a file extension** — `"./config-dir.scan.ts"` |
| rank table | bare identifier keys | + quoted, multi-digit, array+`indexOf` | **computed keys, `new Map`, if-chain, ternary chain** |
| profile literal | `requiredControls: {` | + a bare identifier value | **a call** — `requiredControls: buildControls()` |
| weakening seam | `name:` | + ES6 shorthand `{ name }` | **`o.name = value`** |

Two details make this worse than a list of misses.

**The extension case was the file's own idiom.** `config-dir.readers.test.ts`
writes `await import("…/shell-config.ts")` in four places. The guard living in
that file could not see the way that file writes imports.

**The call case was the widening's own stated purpose.** Round two widened the
profile guard specifically to catch controls "built separately and referenced by
name" — and building something separately is most naturally a function call,
which the widened pattern still missed.

## How it was proven, and why that method matters

A reviewer copied the tree to a sandbox and planted **real production modules**:
`src/lib/scanner-user.ts` importing the scanner with a `.ts` extension,
`src/harness/policy/ranks-duplicate.ts` holding a verbatim duplicate of the rank
tables on computed keys and a `Map`. Sixty tests stayed green.

Describing an evasion is an argument. Planting it and watching the suite pass is
a fact. Any claim that a guard covers a class should be settled this way.

## The self-check inversion — written down, then violated four times

`.metaproject/memory/constraints/code-blanks-string-literals.md` already said a
self-check must plant the spelling **production uses**, not one the guard
already knows. In the very commit that recorded it, all four rewritten
self-checks planted only shapes the new regex had just learned. Every one passed
and none of them tested anything.

**A self-check that plants what the current predicate already matches is a
restatement of the predicate.** The planted set must contain at least one form
the predicate has never been shown to catch — which means writing the self-check
before believing the fix, not after.

## What replaced them

`src/lib/config-dir.ast.ts` — the same guards over the TypeScript AST.
`{ untrusted: 2 }`, `{ "untrusted": 2 }` and `{ ["untrusted"]: 2 }` are three
strings and one `PropertyAssignment`. Two things fall out that no amount of
widening bought:

- **A declaration cannot be mistaken for a construction.** An interface member
  is not an `ObjectLiteralExpression`. The regex excluded it by looking for a
  `?` before the colon.
- **A read cannot be mistaken for a supply.** `const { seam } = opts` is an
  `ObjectBindingPattern`; `{ seam }` in a call is a
  `ShorthandPropertyAssignment`. Under a regex these are the same characters.

Stated limits, in the module: no type checking and no module resolution, so an
alias through an intermediate re-export is still invisible. Say what a guard
cannot do, in the guard.

## The rule

Before writing a source-level guard, ask **is the thing I am forbidding a shape
a program can have, or a string a file can contain?** It is almost always the
first. Match the tree.

Reach for text only when the subject genuinely is text — a message, a log line —
and then see [[code-blanks-string-literals]] for the trap waiting there.

Related: [[a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker]].
