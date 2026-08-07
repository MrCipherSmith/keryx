# gdgraph counts `await import()` as an ordinary import edge

Benchmark finding **P1**. Full write-up:
[specification.md](../../../docs/requirements/keryx-shell-remediation-v2/specification.md#p1).

## Problem

`keryx gdgraph query cycles` on `helyx@bfad745b` reports **8 cycles**. Five run
through `bot/callbacks.ts → bot/commands/menu.ts`, and that edge is dynamic:

```ts
// bot/callbacks.ts:76
const { handleMenuCallback } = await import("./commands/menu.ts");
```

A dynamic import resolves at call time, not module-load time, so it is not the
load-order cycle the question asks about. Found by benchmark case A3, where
`opencode` on the *same model* as the keryx leg reported the distinction and
keryx reported the raw 8.

## Root cause — one line

`src/gdgraph/build.ts:230`. `Bun.Transpiler#scanImports` already returns the
kind — verified by running it:

```
[{"kind":"import-statement","path":"./static.ts"},
 {"kind":"dynamic-import","path":"./dyn.ts"}]
```

and the next line discards it: `.map((entry) => entry.path)`.
`extractImportSpecifiers` returns `string[]`, so by the time an edge is written
there is no kind left to filter on.

## Expected outcome

Edge records carry the import kind; cycle detection excludes dynamic-import
edges or reports them as a separate class, never folded silently into one count.

## Out of scope

- **Reclassifying edges the regex fallback found.** It has no kind; guessing one
  re-introduces the same class of error at a different layer. Fallback-only
  edges get an explicit unknown/static marker.
- **Changing `affected`/`orphans` semantics.** If dependant counts move, that is
  a separate decision with its own evidence.

## Why this flow goes first

It is also flow 139's regression fixture. Fixing the agent's disposition to
verify while the tool is still wrong means a passing test cannot distinguish
"the agent checked" from "the agent got lucky"; fixing the tool afterwards makes
that test start passing for the wrong reason. Flow 139 AC5 records the coupling.
