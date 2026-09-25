# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx stack detect --json` on a fixture repo whose only manifest is a `package.json` declaring `react` returns `tags.react: true`, `uncertain: false`, and `matched` containing `"react"` (W1-AC1).
- AC2: On a fixture whose only manifest is an unparseable `package.json`, `keryx stack detect --json` returns `uncertain: true`, every JS/TS-family tag `true`, non-JS tags `false`, and a `reason` naming the parse failure; a broken `pyproject.toml` beside a clean `package.json` marks only Python-family tags uncertain (per-signal contribution) (W1-AC2).
- AC3: On a workspace-root `package.json` (declares `workspaces`, no leaf dependency matching a tag), `keryx stack detect --json` returns `uncertain: true` for every JS/TS-family tag with `reason` naming the workspace globs (W1-AC3).
- AC4: Wave-2 exit criterion: a test runs `keryx stack detect --json` twice on the same fixture repo with network access disabled and asserts byte-identical stdout and an identical persisted `.metaproject/data/stack/stack.json`; detection makes no network or model call.
- AC5: The bundled install manifest and a test example containing `minimal`, `core`, one per-stack and `full` profiles validate against `install-manifest.schema.json` (JSON Schema 2020-12) in a test; an invalid manifest is refused with the schema error (W1-AC4).
- AC6: A `hook-runtime` module whose `targets` include a harness the W5 capability matrix does not mark `native` or `adapter` makes the install plan fail with a named reason instead of installing (W1-AC5).
- AC7: `keryx skills install --profile <stack-profile> --dry-run --json` is byte-identical across runs for the same profile and `stack.json`, includes every module the resolved component set requires (dependencies included) with no module twice, and honors `--with`/`--without`; the legacy `--profile recommended` path without new flags is unchanged (W1-AC6).
- AC8: Apply writes the planned files and `.metaproject/data/skills/install-state/<target>.json` (valid against the schema's `installState` def, sha256 per written path); `keryx skills doctor` reports `ok`/`drifted`/`missing`/`orphaned`, reporting an edited file as `drifted`; `keryx skills uninstall` removes only recorded hash-matching files and refuses a drifted file without `--force` (W1-AC7).
- AC9: `keryx skills scout <query>` returns `{decision, matches[{skillId, overlapScore, reason}]}` over the local catalog, returning `use` or `fork` (never `create`) when overlap exceeds the documented threshold, and can record its result for a stack-pack skill; a guard test fails a stack-pack skill without a recorded scout result (W1-AC9).
- AC10: `keryx skills eval <skill-id>` runs trigger evals including should-not-trigger negatives and behavior evals graded by deterministic graders first (model grader only behind an explicit capability), reports `triggerAccuracy {truePositive, falsePositive}` and per-scenario `passRate` plus pass@k; at `--strictness high` fewer than 3 trials fails contract validation (W1-AC10).
- AC11: `keryx skills stocktake` emits a `keep|improve|update|retire|merge` verdict per skill, each with a non-empty skill-specific reason (guard test rejects a reason reused verbatim across skills in one run), writes `.metaproject/data/skills/stocktake/<date>.json`, and reuses cached results for unchanged skills (W1-AC11).
- AC12: An authoring-standard lint (name ≤64 lowercase-hyphen, description ≤1024 with "Use when", body ≤500 lines, references one level deep, `metadata.origin` in `authored|generated|imported|learned`) runs from the existing guard tests: strict for stack-pack skills/rules, and a stack rule must declare `extends: common` and a `paths:` glob restricted to that stack's extensions (W1-AC8, W1-AC12).
- AC13: `keryx skills export --runtime claude` (or its translation function) on the stack-pack skill yields a SKILL.md whose `name` ≤64 and `description` ≤1024 chars (W1-AC13).
- AC14: Wave-2 governance exit: `keryx skills scout`, `keryx skills eval` (at least one bundled skill per category) and `keryx skills stocktake --scope bundled` run to completion on the existing bundled catalog; the outputs are recorded in the flow journal.
- AC15: Targeted tests for every new module pass, typecheck and eslint are clean on changed files, and PR CI is green.
