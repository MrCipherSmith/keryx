# Context — Flow 006 (W4 contracts)

Collected by `keryx flow init` and enriched for W4. (T1 context.)

## Baseline (pre-change, verified)
- `bun test` = 554 pass / 0 fail; `tsc --noEmit` clean. Branch @ 39a884b.

## Frozen source of truth (read/cite, never edit)
- `docs/requirements/keryx-project-agent-harness/schemas/` — 35 schemas + `schema-version-registry.json`.
- `docs/requirements/keryx-project-agent-harness/schemas/fixtures/` — `fixture-matrix.json` (family → positive/negative JSON-Pointer), `positive-contract-catalog.json`, `negative-contract-catalog.json`, `fixture-index.json`, `README.md`.
- `implementation-plan.md` §W4 (C-01/C-02/C-03 rows); `specification.md`.
- ADR-0004 (D-04 schema links), TM-01 (schemaVersion strategy) — consistency references only; do not edit.

## Schema family map (35)
- harness-* (10): envelope, event, run-input, run-output, context-manifest, policy-decision, tool-call, child-contract-extension, config, agent-task (DEPRECATED).
- model/provider (4): model-request, model-response, model-error, provider-descriptor.
- tool-* (4): tool-definition, tool-registry-snapshot, tool-result, tool-execution-state.
- session-* (2): session-manifest, session-entry.
- evidence/completion (4): evidence-ledger, evidence-record, completion-gate-result, execution-receipt.
- policy/approval (3): policy-profile, approval-request, approval-result.
- branch/checkpoint (3): branch-metadata, checkpoint, compaction-entry.
- replay (2): replay-fixture, replay-mismatch.
- rpc/transcript (2): rpc-jsonl-envelope, fake-provider-transcript.
- registry (1): schema-version-registry.json (version/migration registry, not a validation schema).

## EXACT used-keyword set (extracted from all 35 schemas — authoritative)
- Core: `type`, `$ref`, `$id`, `$defs` (only harness-envelope), `required`, `properties`, `additionalProperties` (boolean only — 0 as schema), `enum`, `const`, `items`.
- String: `minLength`, `maxLength`, `pattern`, `format` (only `date-time`).
- Number: `minimum`, `maximum`.
- Array: `minItems`, `maxItems`, `uniqueItems`.
- Applicators: `allOf` (10), `oneOf` (2), `if`/`then` (18; NO `else`).
- Meta (non-validating): `$schema`, `title`, `description`.
- NOT used: anyOf, not, else, exclusiveMin/Max, patternProperties, dependentRequired/Schemas, contains, multipleOf, propertyNames, additionalProperties-as-schema.

## Existing deterministic validators (extend, do not add a dependency)
- `src/gdskills/contracts.ts` `validateValue` — covers: type, enum, minimum, minLength, pattern, required, properties, additionalProperties(bool), items, $ref.
- `src/standard/validate.ts` — "draft 2020-12 subset", adds `anyOf` (not needed) + `format: date-time` (needed); synchronous, no I/O, resolves named refs via a registry. Good pattern reference.

### C-02 keyword gap to close (used − already-covered)
`const`, `maximum`, `maxLength`, `minItems`, `maxItems`, `uniqueItems`, `allOf`, `oneOf`, `if`/`then`, `format:date-time`, local `$defs` pointer resolution (`#/$defs/…`), cross-file `$ref` resolution (e.g. `harness-envelope.schema.json#/$defs/schemaVersion`).

## Chosen structure — new module `src/contracts/`
- `validator.ts` — deterministic validator over the used-keyword set.
- `resolver.ts` — load 35 schemas + `$id`/`$ref`/`$defs` resolution via a DI'd schemas-dir path.
- `keyword-coverage.ts` — `SUPPORTED_KEYWORDS` + proof `used ⊆ supported`.
- `validator.test.ts`, `fixtures.test.ts` — C-03 matrices.
`src/harness/` NOT touched (reserved for W5+ runtime).

## Decisions (user-approved)
- Validator in `src/contracts/` (new module).
- C-02 = extend the existing deterministic validator; NO external Draft 2020-12 dependency; prove keyword coverage.
- Schema loading: DI path to the frozen `schemas/` dir (single source, no duplication); bundling deferred to W5+.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install` first. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- TDD order: C-01 docs → C-03 RED → C-02 GREEN → verify.
