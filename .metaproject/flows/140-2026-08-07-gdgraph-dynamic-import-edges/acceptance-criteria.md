# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every edge the transpiler produced carries an import kind whose value is one of the kinds `Bun.Transpiler#scanImports` actually returns; a unit test asserts the kind survives from `scanImports` to the written edge record.
- AC2: `keryx gdgraph query cycles` on a fixture reproducing the target's shape no longer presents cycles formed through a dynamic import as load-order cycles — they are excluded or explicitly labelled.
- AC3: A fixture asserts the classification both ways: a two-file cycle formed by a static import IS reported; the same cycle formed by `await import()` is NOT reported as a load-order cycle.
- AC4: Edges contributed only by `extractImportSpecifiersFallback` are recorded with an explicit unknown/static marker and are never labelled dynamic by inference; a test covers a fallback-only edge.
- AC5: `keryx gdgraph query orphans` and `keryx gdgraph affected` return the same results as before this change on the fixture, or every difference is recorded in the journal with its cause.
- AC6: The changelog states that previously reported cycle counts on lazy-loading codebases were inflated.
