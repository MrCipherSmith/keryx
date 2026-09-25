# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Four pack directories exist under `src/gdskills/bundled/stacks/{php-laravel,ruby-rails,c-cpp,sql-db}/`, each with `pack.json`, `rules/*.mdc` (coding-style, patterns, security, testing), `skills/*/SKILL.md` + `evals.json` for every skill the pack.json declares, `governance/scout.json`, and `agent-refs.json` with `"agents": []` and a note (gate not yet run in this flow).
- AC2: `bun test src/gdskills/stack-packs.test.ts` passes with all four new pack ids included in its real-tree checks.
- AC3: `bun test src/gdskills/governance/authoring-lint.test.ts src/gdskills/governance/authoring-lint-guard.test.ts` pass.
- AC4: `bun test src/gdskills/stack-pack-eval-integrity.test.ts` passes for every behavior scenario in the four new packs (I1-I10, including I6/I7/I7c anti_patterns agreement and I10 no negation-only fail criteria).
- AC5: `src/gdskills/bundled/install-manifest.json` declares `<id>-rules`/`<id>-skills` modules, a component, and a `stackDetectionAware` profile for each of the four packs, and `bun test src/gdskills/manifest/manifest.test.ts src/gdskills/manifest/plan.test.ts` still passes.
- AC6: `STACK_EXTENSIONS` in `src/gdskills/governance/authoring-lint.ts` carries entries for `php-laravel`, `ruby-rails`, `c-cpp`, `sql-db`.
- AC7: `docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md` and `W2-agent-catalog.md` carry a new "Implementation notes: Wave 4 batch 5 (flow 337)" section describing what landed, and any judgment calls (family/extends choices) recorded in this flow's plan.md.
- AC8: Each pack is committed separately (git history shows one commit per pack plus one for shared wiring), no `git stash`/`git add -A` used, `.metaproject/data/gdgraph` reverted after each commit, and the branch is pushed to origin.
