<!--
PR title must follow Conventional Commits, e.g.:
  feat(gdgraph): add ranked affected output
  fix(security): stop redaction from leaking mask width
-->

## What & Why

<!-- What does this change do, and why is it needed? -->

## Checklist

- [ ] PR title follows Conventional Commits (`type(scope): summary`)
- [ ] `bun run check` passes (typecheck + tests)
- [ ] Tests added or updated (co-located `*.test.ts` under `src/`)
- [ ] Docs updated if behavior changed (`README.md` / `docs/`)
- [ ] Keeps zero runtime dependencies and the offline-first, deterministic core intact
