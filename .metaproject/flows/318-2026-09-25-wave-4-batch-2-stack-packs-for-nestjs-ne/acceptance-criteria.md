# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Five pack directories exist under `src/gdskills/bundled/stacks/{nestjs,nextjs-nuxt,vue,angular,mobx}/` each with `pack.json`, `agent-refs.json`, `rules/*.mdc`, and `skills/<name>/{SKILL.md,evals.json}`, and each rule file passes `lintStackRule` against `STACK_EXTENSIONS[<id>]` with zero error findings.
- AC2: Every new behavior scenario across all five packs is a judge scenario (grader "judge") carrying a non-empty rubric, at least one pass_criteria entry, and a calibration object with known_right/known_wrong/vague/subtle_wrong all non-empty and pairwise different, and passes every integrity rule I1-I10 in `src/gdskills/stack-pack-eval-integrity.test.ts`.
- AC3: For every new skill carrying a judge scenario, `keryx skills judge-check <pack>/<skill> --judge deepseek:deepseek-chat --scope bundled --samples 3 --record` exits 0 and its recording is committed under `src/gdskills/governance/judge-recordings/`.
- AC4: `install-manifest.json` contains new `<id>-rules`/`<id>-skills` modules for all five packs, extends the pre-existing `framework:nestjs` and `capability:mobx` components (no duplicate review-skill modules for review-backend/nestjs-dto.mdc/code-mobx-store-review/mobx-store-template.mdc), adds `framework:vue`/`framework:angular`/`framework:nextjs-nuxt` components, and the pack.json↔install-manifest stability guard test passes.
- AC5: One honest gate run per new skill (`skills eval --scope bundled --runner deepseek:deepseek-chat --judge deepseek:deepseek-chat --strictness high --trials 10 --json`, HEAD unchanged start to end) backs every pack's `governance/eval.json`, built verbatim from the raw run output.
- AC6: Only a pack whose every skill report clears `checkStablePackGate` is set to `stability: "stable"` in both `pack.json` and its `install-manifest.json` component/module entries, and gets a generated `<id>-code-auditor`/`<id>-build-fixer` pair via `agents generate --stack <id>`; every other pack stays `experimental` with the specific failing scenario(s) and passRate recorded in the journal.
- AC7: `docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md` gains an "Implementation notes: Wave 4 batch 2 (flow 318)" section documenting exactly which packs were authored, the honest gate results per pack, and the updated stack-coverage count, in the same style as the existing batch-1/flow-316/flow-317 sections; W2's status/coverage doc is updated for any generated agent pairs.
- AC8: A draft PR against `feat/agent-platform-expansion` merges after an adversarial review round finds 0 blocker and 0 major findings (minors may be deferred per the owner's standing rule), and CI is green at merge time.
