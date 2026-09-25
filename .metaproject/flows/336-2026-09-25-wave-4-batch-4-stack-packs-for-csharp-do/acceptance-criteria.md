# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/gdskills/bundled/stacks/{csharp-dotnet,swift-ios,kotlin-android,flutter-dart}/pack.json` each exist, parse, and carry `id`, `family`, `modules`, `detectionMarkers`, `provenance.origin: "authored"`, `stability: "experimental"` (Phase A), `skills`, and `agentProfile`.
- AC2: every rule file under each pack's `rules/` directory declares a `paths:` glob restricted to that stack's own file extensions (`.cs` for csharp-dotnet; `.swift` for swift-ios; `.kt`/`.kts` for kotlin-android; `.dart` for flutter-dart) and an `extends: common` marker (W1-AC8 shape).
- AC3: `STACK_EXTENSIONS` in `src/gdskills/governance/authoring-lint.ts` includes an entry for each of the four new stack ids with the matching extension list.
- AC4: every skill's `evals.json` under the four packs has at least one judge-format behavior scenario (rubric, pass_criteria, 4-way calibration: known_right/known_wrong/vague/subtle_wrong) satisfying the integrity rules in `docs/docs/guides/write-a-rubric-scenario.md` (I1-I10), plus trigger-accuracy prompts with at least 4 negative cases per skill, at least half of which are near-misses from sibling packs.
- AC5: each pack's `agent-refs.json` is `{"agents": [], "note": "<reason Phase A ships no gate result>"}` — no generated auditor/build-fixer pair ships before the honest gate runs.
- AC6: `src/gdskills/bundled/install-manifest.json` gains a module pair, a component, and a per-stack profile for each of the four packs, and each is added to the `full` profile's `modules`/`components` lists, following the existing python/go (standalone) or angular/vue (dependency-on-existing-base) wiring pattern as applicable.
- AC7: the offline integrity/lint/guard test suites scoped to the touched files (`stack-pack-eval-integrity.test.ts`, `stack-packs.test.ts`, `authoring-lint*.test.ts`, install-manifest schema test) pass locally against the four new packs.
- AC8: no shared file outside install-manifest.json/authoring-lint.ts/shared tests/W1&W2 docs is touched by a worker dispatch; no version bump or CHANGELOG release-section edit anywhere in the diff.
- AC9 (Phase B, added once gate runs): the honest 10-trial DeepSeek gate (`skills eval --scope bundled --runner deepseek:deepseek-chat --judge deepseek:deepseek-chat --strictness high --trials 10`) has run once per skill with HEAD unchanged start to end, and each pack's final `stability`/`agent-refs.json` reflects exactly what that recorded run showed — never inflated by a mid-run edit.
- AC10 (Phase B): W1-stack-catalog.md and W2-agent-catalog.md gain an "Implementation notes: Wave 4 batch 4 (flow 336)" section recording what landed, matching the style of the flow 314/316/317/318 sections already in W1.
- AC11 (Phase B): a PR is opened against `main`, an adversarial Opus review using the stack-pack-lessons.md checklist finds 0 blocker/major (minors may be deferred per the standing rule), and CI is green before merge.
