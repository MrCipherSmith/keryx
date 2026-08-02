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

## Four occurrences, all found by review rather than by the guard

| guard | what it could not see |
|---|---|
| scanner-importer (`config-dir.readers.test.ts`) | `from "./config-dir.scan"` — an import specifier IS a string |
| rank-table (`profiles.test.ts`) | `{ "read-only": 0 }` — three of five policy words cannot be bare identifiers, so a verbatim copy of `ranks.ts` was invisible |
| switch-label rank guard | `case "untrusted":` — the label is blanked, so it had to match structurally |
| internal-error emitter count (`serve-server.test.ts`) | `` `keryx serve: request failed: …` `` — the counted thing is the literal |

## The rule

Before writing a source-level guard, ask **can the thing I am matching be
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
