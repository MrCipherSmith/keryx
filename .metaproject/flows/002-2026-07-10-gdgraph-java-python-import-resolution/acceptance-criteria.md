# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Frozen from specification.md (7 spec AC) + prd.md success criteria + the three
mandatory invariants.

## Criteria

- AC1: Build of a fixture Maven Java project resolves `a.b.C` imports to files and emits `imports` edges (> 0), including a spot-checked FQN → file edge.
- AC2: Build of a fixture Python project resolves absolute and relative imports, including `__init__.py` packages, emitting `imports` edges (> 0).
- AC3: A `keryx gdgraph build` on `back4/example-backend` reports > 0 import edges and a resolution rate not derived from `0/0`; the import `com.example.admin.dto.FixReplicaRequest` resolves to `src/main/java/com/example/admin/dto/FixReplicaRequest.java`.
- AC4: A TS/JS-only project graph is byte-identical before and after the change (`nodes.jsonl` and `edges.jsonl`), enforced by a dedicated regression test.
- AC5: The summary reports `n/a` (not `100%`) when zero imports are extracted, and every non-relative import that fails to resolve is recorded as an `unresolved` edge rather than silently dropped.
- AC6: New projects receive Java and Python tree-sitter grammars via `src/assets/seed.ts` (`GRAMMAR_ASSETS` includes `tree-sitter-java` and `tree-sitter-python` with real pinned sha256/size; present in `assets.lock.json` after seeding).
- AC7: Unit tests exist for Maven and Gradle source-root parsing, plus build-level tests asserting resolved edges for the Java and Python fixtures.
- AC8: Import resolution is language-aware — dispatched by the importing file's language; TS/JS keeps the existing tsconfig/relative logic unchanged, Java uses the Maven/Gradle resolver, Python uses the Python resolver.
- AC9: At least 80% of extractable in-repo Java/Python imports resolve to real files on the example-backend build, and the reported rate equals actual `resolved / extracted`.
- AC10: Verification gate passes — lint clean, `bunx tsc --noEmit` reports 0 errors, full `bun test` is green, and the `detectSupportedLanguages` / `renderGdgraphConfig` dead code is resolved (wired into init or removed).
