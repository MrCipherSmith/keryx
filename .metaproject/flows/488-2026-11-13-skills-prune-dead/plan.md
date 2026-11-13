# Plan

Three removal groups, one commit each, all through one writer because every group edits the
same registries (`catalog.ts`, `skill-length-ceilings.ts`, `routing-corpus.ts`,
`bundled-eval.ts`, `install-manifest.json`, `.metaproject/skills/catalog.md`).

1. The seven planning-pipeline skills and `gproject-contracts.mdc`. These are the only
   skills that ship `SKILL.codex.md` / `SKILL.cursor.md` builds, so tests that use them as
   the runtime-variant fixture need a synthetic fixture instead of a shipped skill.
2. `job-documenter` and `feature-dev`, with the references to them in surviving skills and rules.
3. The seven catalog-rendered stubs.

Then the mirror, the ratchets (length ceilings, routing rank counts) and the targeted suites.
