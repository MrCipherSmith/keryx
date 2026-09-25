# Wave 4 batch 2: stack packs for nestjs, nextjs-nuxt, vue, angular, mobx

Status: in-progress
Source: user description (agent-platform-expansion program, flow runner dispatch)

## Problem

W1 (stack-aware skills & rules catalog) defines the stack-pack content shape,
the judge-based governance eval gate, and the stable-pack criteria. Wave 4
batch 1 (flows 314/316/317) authored and gated four packs (ts-js-node, react,
python, go); ts-js-node was DEMOTED after the trials=10 honest re-run, so
current stable coverage is python + go only, with pre-existing review-only
coverage for NestJS/Prisma and React/MobX.

This flow authors the next five packs per the W1 batch-2 list:
**nestjs, nextjs-nuxt, vue, angular, mobx**, brings each through the honest
judge-based gate at the current policy (`PACK_MIN_TRIALS=10`, DeepSeek
`deepseek-chat` runner+judge, `PACK_BEHAVIOR_PASS_FLOOR=0.8`), and promotes
only the packs that actually clear it to `stability: stable` with a generated
agent pair.

## Expected Outcome

- Five new pack directories under `src/gdskills/bundled/stacks/<id>/`
  (`nestjs`, `nextjs-nuxt`, `vue`, `angular`, `mobx`), each with `pack.json`,
  `agent-refs.json`, `rules/*.mdc` (extends: common, paths-scoped), and
  `skills/<name>/{SKILL.md,evals.json}` using the judge grading format
  (rubric + pass/fail criteria + 4-way calibration + anti_patterns).
- `nestjs` extends `ts-js-node`; `mobx` extends `react`; `vue` and `angular`
  are standalone frameworks extending `ts-js-node`; `nextjs-nuxt` extends
  both `react` and `vue` (meta-framework covering both Next.js and Nuxt) —
  recorded as a design decision since `pack.json`'s informal `extends` field
  is not schema-typed.
- `install-manifest.json` gains modules/components for all five packs,
  reusing/extending the pre-existing `framework:nestjs` and `capability:mobx`
  components rather than duplicating the existing review-only content
  (`review-backend`, `nestjs-dto.mdc`, `code-mobx-store-review`,
  `mobx-store-template.mdc`), which stay as-is per W1's "cross-reference,
  don't duplicate" rule for existing tool packs.
- `STACK_EXTENSIONS` (`src/gdskills/governance/authoring-lint.ts`) extended
  for the five new ids.
- Every new skill's judge scenarios calibrated green via
  `skills judge-check --record` (AG rules), then run once through the real
  honest gate (`skills eval --runner deepseek:deepseek-chat --judge
  deepseek:deepseek-chat --strictness high --trials 10 --scope bundled
  --json`), with `governance/eval.json` built verbatim from that run's raw
  output — no content edited mid-run.
- Only packs that clear `checkStablePackGate` are promoted to
  `stability: stable` and get a generated `<id>-code-auditor`/
  `<id>-build-fixer` pair (`agents generate --stack <id>`); every pack that
  fails stays `experimental` with the specific failing scenario(s) and
  passRate recorded, exactly as batch 1's precedent.
- W1 and W2 docs updated: implementation notes section for this flow (packs
  authored, honest gate results per pack, stack coverage count), CLI
  reference if anything changed, ACs.

## Out of Scope

- Any of the other batch-2/3/4 stacks not in this list (python/django/
  fastapi/rust/java-kotlin-spring/csharp-dotnet/swift-ios/kotlin-android/
  flutter-dart/php-laravel/ruby-rails/c-cpp/sql-db/docker-k8s-terraform/
  ci-github-gitlab).
- Changing the judge/gate machinery itself (`src/gdskills/governance/judge.ts`,
  `eval.ts`, `gate-policy.ts`) — those are flow 316/317's delivered contract;
  this flow only authors content against them.
- Re-litigating batch 1's ts-js-node/react outcomes.
- `keryx stack detect` signal changes — nestjs/react/vue/angular/nextjs/nuxt/
  mobx tags already exist in `src/stack/detect.ts`'s `STACK_DETECT_TAGS`.
