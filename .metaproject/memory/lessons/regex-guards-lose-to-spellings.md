---
id: regex-guards-lose-to-spellings
kind: lesson
status: active
created: 2026-08-02
tags: [testing, source-guards, ast, false-green, review]
---

# A source guard loses one spelling per round — and matching the AST only slows it down

> **Corrected after round four.** The first version of this lesson ended with
> "match the tree" and the claim that **text has spellings and structure does
> not**. That is false. Structure has spellings too: `Object.assign`, a spread,
> `Object.fromEntries`, `Object.defineProperty`, a static class field and a
> chained `Map.set()` are six structures for a handful of semantic acts, and a
> matcher has to know each one. Twelve ordinary spellings defeated the AST
> rewrite in the round after it shipped. The corrected conclusion is at the
> bottom.

Four guards in this tree matched source TEXT. Over three review rounds, every
one was defeated, widened for the spelling that defeated it, and defeated again.
The pattern is not that the authors were careless. It is that **a pattern can
only ever enumerate the spellings someone has already thought of** — and that is
true of a node-shape pattern as well as a character one, which is the part the
first version of this lesson got wrong.

## The record

| guard | round 1 | round 2 | round 3 | round 4 (on the AST rewrite) |
|---|---|---|---|---|
| scanner importer | knew `from "…"` | + `require`, dynamic `import` | **a file extension** — `"./config-dir.scan.ts"` | **a non-literal specifier** — `"./config-dir" + ".scan"` |
| rank table | bare identifier keys | + quoted, multi-digit, array+`indexOf` | **computed keys, `new Map`, if-chain, ternary chain** | **row tables, named constants, static class fields, chained `.set()`** |
| profile literal | `requiredControls: {` | + a bare identifier value | **a call** — `requiredControls: buildControls()` | **a spread** — which the regex HAD caught |
| weakening seam | `name:` | + ES6 shorthand `{ name }` | **`o.name = value`** | **`defineProperty`, `fromEntries`, a computed key from a variable** |

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

## What replaced them, and what that did and did not buy

`src/lib/config-dir.ast.ts` — the same guards over the TypeScript AST. Two real
gains, and they are not nothing:

- **A declaration cannot be mistaken for a construction.** An interface member is
  not an `ObjectLiteralExpression`. The regex excluded it by looking for a `?`
  before the colon.
- **A read cannot be mistaken for a supply.** `const { seam } = opts` is an
  `ObjectBindingPattern`; `{ seam }` in a call is a
  `ShorthandPropertyAssignment`. Under a regex these are the same characters.

And one real loss, which is the part worth remembering: the AST version was
**weaker** than the regex for `{...base, requiredControls: c}`, because nobody
checked the replacement against the thing it replaced.

Then it was defeated by twelve spellings in the next round — a specifier built
with `+`, `createRequire` under another name, a template with a substitution, a
row table, named-constant values, static class fields, a chained `Map.set`,
`Object.assign`, a spread, `Object.defineProperty`, a computed key from a
variable, `Object.fromEntries`. And it produced three FALSE POSITIVES on
ordinary code, which is worse: a guard that fires on a validation set gets
switched off by whoever trips on it, and then it protects nothing.

## The rule, corrected

1. **Ask whether a real oracle exists.** For "does this module ship", it does:
   the bundler resolves the actual production module graph, and
   `src/lib/production-graph.test.ts` asks it. That is a closure, and it does not
   care how a specifier was spelled. Look for the oracle before writing a
   matcher.
2. **If there is no oracle, you are writing a heuristic. Say so.** Keep a live
   gap list in the guard, and make it executable — tests that assert the known
   misses are still missed. That is the only version of a self-check that cannot
   degenerate into a restatement of the implementation's own branch list, which
   is what three consecutive rounds of self-checks did.
3. **Fix false positives before misses.** A guard nobody trusts is deleted, and
   a deleted guard catches nothing at all.
4. **Never claim closure.** The claim propagates faster than the code: fifteen
   places asserted it within one round, across two modules, three test files,
   two memory documents, a flow record and three commit messages.

Related: [[code-blanks-string-literals]],
[[a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker]].
