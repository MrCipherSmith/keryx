# Implementation Plan

Status: ready

## Approach

Model the field on `owner`: optional in the flow types and JSON schema, written at creation, changed only by an explicit command that leaves a journal line, never inferred. Absent means `unknown`; reading never rewrites a file. Default at creation is `agent`, because a wrong `human` mark pollutes the only sample the product work exists for, while a wrong `agent` mark only shrinks it. The setter lives in `flow` (`flow outcome author`), so the product module keeps its four commands. The value reaches `product index` through the intent record (a new optional field, validated by `indexProblem` and included in the staleness fingerprint), and reaches the TUI through the same values.

Open decision, mine and overrulable: where the `agent` default is applied. Applied at `flow init` only, so old flows stay `unknown`.

## Steps

1. Types, schema, `flow init --outcome-author`, template rule for `human` (Outcome criteria section untouched), tests (AC1, AC3).
2. `flow outcome author` setter with journal line and validation (AC2).
3. `flow status` line, intent record field in `product index`, TUI inspector and `/product` view (AC4, AC5).
4. Docs: G1a in four cells, G1b by author, the 0.3.32 by-hand text replaced; CLI reference, command registry and pins, module page, README, CHANGELOG 0.3.33, version (AC7, AC8).
5. Review, CI, merge, release, install, smoke, stop (AC6, AC9).

## Risks

- The import-policy ratchet counts facade bypasses: route product's read of the field through `src/flow/service.ts`, as in 0.3.31.
- `flow.json` has a schema and possibly a checksum or parity test (`src/harness/flow/parity.test.ts`, `src/flow/schema.ts`): a new optional field must keep old files valid.
- The command registry (`src/standard/command-registry.ts`) and `src/cli.test.ts` list flow subcommands: a missed pin fails CI, not the feature.
- The setter must write the journal line and the field together, so a change is never silent.
