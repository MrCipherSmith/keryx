---
id: code-blanks-string-literals
kind: constraint
status: active
created: 2026-08-02
tags: [testing, source-guards, config-dir-scan, false-green]
---

# `code()` blanks string literals, so a guard that matches one can never fire

`src/lib/config-dir.scan.ts` exports `code(raw)`, which strips comments **and
blanks every string literal** before a guard matches against it. That is correct
for its original purpose — stopping a mention inside a string from faking a hit —
and it is a trap for any guard whose subject IS a string.

A guard built on `code()` that looks for text which can only appear inside a
string literal matches **zero, always**, and its self-check passes because the
negative cases also match zero. It is a guard that cannot fail, which reads
exactly like a guard that has nothing to report.

## Two occurrences — and this note said four

Corrected after round three, verified against the pre-round blob. The headline
count was twice reality and two of the four rows named the wrong file. That
matters more than the count: this note is the artifact a future round will trust
instead of re-deriving, which is precisely the failure it was written about.

**Genuine:**

| guard | what it could not see |
|---|---|
| rank-table `RANK_LITERAL` (`profiles.test.ts`) | `{ "read-only": 0 }` — four of the five policy words cannot be bare identifiers |
| internal-error emitter count (`serve-server.test.ts`) | `` `keryx serve: request failed: …` `` — the counted thing is the literal |

**Not occurrences, and why:**

- *The scanner-importer guard.* It never used `code()`. `git show
  2b2e7fc2:src/lib/config-dir.readers.test.ts` carries the docstring "NOT
  through `code()`, and that is the interesting part… Comments are stripped
  locally instead", with a local `withoutComments`, and its companion test
  asserted a NON-EMPTY result — so it never matched zero. Its real defect was
  knowing only `from "…"`, which is a different failure entirely.
- *The switch-label rank guard.* Not a separate guard and not disabled:
  `RANK_SWITCH` is one pattern inside the single `RANK_TABLE` predicate, and it
  was written structurally BECAUSE of the blanking. It is the mitigation, not an
  instance.

One more claim in the same family, also false and also corrected in the source:
"a verbatim copy of the tables in `ranks.ts` was invisible by construction". Two
of the four tables — `OUTCOME_RANK` and `INPUT_TRUST_RANK` — are all bare
identifiers and the old guard saw them; its own self-check planted
`{ deny: 0, ask: 1, allow: 2 }` and expected it as an offender. Only
`ISOLATION_RANK` and `AUTHORITY_RANK` were hidden.

## What actually replaced these guards

Round three proved that widening a regex buys exactly one spelling: after every
fix above, a reviewer planted real production modules that the widened patterns
still could not see — an import with a `.ts` extension, a rank table on computed
keys, a `Map`, an if-chain. All four guards now go through
`src/lib/config-dir.ast.ts` and match the PARSE TREE. See
[[regex-guards-lose-to-spellings]].

`code()` is still the right tool for identifiers and call shapes in a
text-matching guard, and the rule below still holds for anyone writing one.

## The rule, for a text-matching guard

Prefer the AST. If a guard must match text, ask **can the thing I am matching be
written only inside a string literal?**

* **Yes** → strip comments locally, do not use `code()`:
  ```ts
  const stripComments = (raw: string): string =>
    raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ```
  Then make the pattern specific enough that prose cannot satisfy it — `: <digit>`,
  a module path, an exact sentence. Comments are gone, so only real code remains.
* **No** (an identifier, a call shape, a keyword) → `code()` is right, and it is
  what stops a mention in a docstring from being reported as a violation.

## The self-check that would have caught all four

A guard's self-check must plant **the real thing, verbatim, in the spelling
production uses** — not a paraphrase in the spelling the guard already knows.
Every one of these four passed a self-check that planted a bare identifier where
production wrote a quoted string.

See [[a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker]]
for the wider pattern: a guard that commemorates a bug rather than preventing it.
