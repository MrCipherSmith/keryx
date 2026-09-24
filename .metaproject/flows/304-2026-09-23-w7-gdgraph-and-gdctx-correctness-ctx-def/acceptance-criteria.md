# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: (W7-AC1) `keryx ctx run -- <command>` with exit code 0 and zero stderr bytes never places a stdout line matching only FAILURE_STEMS into "Errors / Warnings"; stderr lines and non-zero exits still classify by stem, and REPO_FAILURE_MARKERS glyphs still classify on stdout — covered by unit tests and the `git log --oneline` "refuse" golden fixture.
- AC2: (W7-AC2) `keryx ctx read` on a trusted-project file leaves an `<img src>`/markdown-image URL with no credential-shaped query string unredacted, while the same URL with a `?token=`/`?key=`/`?auth=` query string is still redacted, and untrusted sources are unchanged; the override is configuration data a project can disable — covered by README-badge and synthetic-token fixtures.
- AC3: (W7-AC3) `keryx ctx rg` accepts a bundled short-flag token made only of RG_SAFE_FLAGS letters with argv identical to the split form; a bundle containing any value-flag or unknown letter is rejected whole with a reason naming the offending letter.
- AC4: (W7-AC4 / R7.7) Every gdgraph subcommand that presents graph results as fact calls the freshness check; fixtures prove no note on a fresh build, STALE_NOTE naming the mutated file after an unrebuilt edit, and not-fresh when provenance is missing.
- AC5: (W7-AC5) A gdgraph golden-edge fixture test passes with exact edge-set equality for a barrel `export *`, a type-only `export { type X } from` re-export, and a runtime `import()`, and records the current behavior for a tsconfig `extends` + `paths` alias.
- AC6: (W7-AC6) `fixtures/benchmark/keryx/gdctx-fact-preservation.json` carries golden correctness entries (including the GDCTX-1 and GDCTX-2 regressions) that a `bun test` file under a `test:core` directory recomputes live and requires at 100% fact agreement; the generator script preserves them.
- AC7: (W7-AC7) `keryx memory search "gdctx"` and `"gdgraph"` return the four known-mistake entries for the closed defects.
- AC8: (W7-AC8 / R7.8) The index hard gate is a pointer-only table within a 400-token budget (chars/4), enforced by a test on both the template render and the live `.metaproject/index.md`, and the template is the source so `keryx update` preserves it.
- AC9: (W7-AC9 / R7.3) `git status`, `git blame`, `git branch`, `git tag`, bounded `git log --oneline -N` and `git diff --stat` are allowed by the ctx hook without routing or an escape marker via GIT_READONLY_ALLOW checked before GIT_ROUTABLE, with a test asserting allow for each (zero false blocks); plain `git diff`, unbounded `git log` and `git show` stay routed.
- AC10: (Wave 0 exit) All new regression tests live in `test:core` directories so PR CI runs them, and the PR's CI checks are green.
