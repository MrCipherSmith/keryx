# Acceptance Layer — Specification

Version: 0.2.0

## Module identity

W0 lives in the `tasks` module. It touches `src/flow/` only, plus one rule file
and one skill phase outside it. No new module, no new storage root, no new
command group.

## Storage structure

Unchanged. The kind lives inside `acceptance-criteria.md`, which is already
sealed by `flow.acChecksum`.

```text
.metaproject/flows/<id>-<date>-<slug>/
  acceptance-criteria.md      # criteria + kinds — sealed
  flow.json                   # gains acKinds (derived, see below)
  journal.md
```

`flow.json` gains one derived field:

```jsonc
"acKinds": {
  "AC1": { "kind": "exec",      "check": "bun test src/flow/ac-kind.test.ts" },
  "AC2": { "kind": "invariant", "check": "bun test src/flow/ac-no-gate.test.ts" },
  "AC3": { "kind": "judged" },
  "AC4": { "kind": "none",      "reason": "reads as prose to a human reviewer" },
  "AC5": { "kind": "unclassified" }
}
```

It is **derived**, not authoritative: the file is the source of truth and the
checksum protects it. `flow.json` may be regenerated from the file at any time,
and a disagreement between the two is a bug in the parser, never a decision.

## Manifest / config shape

None. W0 adds no configuration. The kind is a property of a criterion, not of a
project.

## Criterion format

The existing line rule is unchanged and stays exactly as
`acceptance-criteria.md` states it: `- ACn: <criterion>`. The kind is a trailing
marker inside that same line, so it falls under the seal:

```text
- AC1: <criterion text> [verify: exec `<command>`]
- AC2: <criterion text> [verify: invariant `<command>`]
- AC3: <criterion text> [verify: judged]
- AC4: <criterion text> [verify: none — <reason>]
```

Rules:

- The marker is the **last** thing on the line. Everything before it is the
  criterion text, unchanged, and is what `extractCriterionTokens` and
  `classifyNotCheckable` continue to receive.
- Exactly one marker per line. A second is a parse error naming the criterion.
- `exec` and `invariant` require a backticked command. A missing command is a
  parse error; an empty one is a parse error.
- `none` requires a reason after an em dash. A bare `none` is a parse error.
- A line with no marker parses as `unclassified`. This is not an error, and it
  is how all 2,705 existing criteria read.

The marker sits inside the criterion text as far as the checksum is concerned,
which is the intent: a change of kind is a change of criterion, re-seals the
file and voids prior signatures, exactly like a change of wording.

## CLI surface

```text
keryx flow freeze <id>              # unchanged; now prints the kind distribution
keryx flow ac kinds <id> [--json]   # the distribution and per-criterion kinds
```

`flow freeze` output gains one block:

```text
acceptance kinds: exec 4  invariant 1  judged 2  none 1  unclassified 0   (8 criteria)
coverage: 5/8 runnable (62%)  ·  1 accepted as unverifiable  ·  2 judged
```

`flow ac kinds` is read-only, exits zero on a parseable file and non-zero on a
parse error, and names the offending criterion.

No other command changes behaviour in W0. `ac confirm`, `complete`, `check`,
`check-ac` are untouched.

## Data contracts

```text
AcKind        = "exec" | "invariant" | "judged" | "none" | "unclassified"

AcKindRecord  = { kind: "exec" | "invariant", check: string }
              | { kind: "judged" }
              | { kind: "none", reason: string }
              | { kind: "unclassified" }

AcKindReport  = {
  flowId: string
  criteria: Record<string, AcKindRecord>   // keyed by ACn
  counts: Record<AcKind, number>
  runnable: number                          // exec + invariant
  total: number
}
```

Parsing is pure and lives beside `parseAcceptanceCriteria` in
`src/flow/check-ac.ts`, or in a sibling module importing nothing new. It makes
no model call, touches no network, and writes nothing.

## Integration points

| Point | Change |
|---|---|
| `src/flow/check-ac.ts` | Criterion text passed to token extraction and marker classification excludes the trailing `[verify: …]`. Behaviour on an unclassified criterion is byte-identical to today. |
| `flow freeze` (`src/commands/flow.ts`) | Parses kinds, writes `acKinds`, prints the distribution block. Never refuses. |
| `flow ac update` | Re-parses kinds and rewrites `acKinds` after re-sealing. |
| `governance report` | Reads `acKinds` and adds acceptance coverage per flow. Absent field reads as fully `unclassified`, never as zero criteria. |
| `requirements-package-standard.mdc` | PRD contract gains a per-requirement verification field. |
| `docpack-orchestrator` Phase 4 | One rule: every requirement states its verification. Fails the package and names the requirement when it does not. |
| `keryx-p0-improvements` W3 | Owns transporting the report to a pull request. Nothing here. |

## Acceptance criteria

Written in the format this package introduces — see PRD R5. If any line below
was unpleasant to write, that is a finding about the format, and it belongs in
the implementing flow's journal.

- AC1: `flow ac kinds <id>` parses a criteria file containing all four markers plus one unmarked line and reports `exec`, `invariant`, `judged`, `none` and `unclassified` with the counts and the per-criterion records defined in Data contracts [verify: exec `bun test src/flow/ac-kinds.test.ts`]
- AC2: A second `[verify: …]` marker on one line, an `exec` or `invariant` marker without a backticked command, and a bare `none` without a reason are each a parse error that names the offending criterion id and exits non-zero [verify: exec `bun test src/flow/ac-kinds-errors.test.ts`]
- AC3: Every one of the acceptance-criteria files in `.metaproject/flows/` parses without error and reports every criterion as `unclassified`, with zero parse failures across the corpus [verify: exec `bun test src/flow/ac-kinds-corpus.test.ts`]
- AC4: `flow freeze` on a flow whose criteria are all `none` completes normally and prints the distribution; no code path refuses a freeze, a confirmation or a completion on the basis of a kind [verify: invariant `bun test src/flow/ac-kinds-never-gates.test.ts`]
- AC5: The text handed to `extractCriterionTokens` and `classifyNotCheckable` excludes the trailing marker, and a criterion carrying a marker produces byte-identical facts to the same criterion without one [verify: exec `bun test src/flow/check-ac.test.ts`]
- AC6: `flow ac update` re-seals the file and rewrites `acKinds` so the derived field and the sealed file never disagree; a test mutates a kind, re-updates, and asserts both the new checksum and the new record [verify: exec `bun test src/flow/ac-reseal.test.ts`]
- AC7: `governance report` shows acceptance coverage per flow, and a flow predating this package reads as fully `unclassified` rather than as zero criteria [verify: exec `bun test src/commands/governance.test.ts`]
- AC8: `requirements-package-standard.mdc` states the per-requirement verification field, and the docpack Verify phase fails a package whose requirement omits it, naming that requirement [verify: judged]
- AC9: The format proved workable in practice: the implementing flow's own criteria carry kinds, at least one is honestly `none`, and the journal records any line that was awkward to write [verify: none — a judgement about writing ergonomics, which no check can settle; the journal entry is the evidence and a human reads it]
- AC10: `bun run typecheck` is clean and the full `src/flow` suite passes on the branch [verify: exec `bun run typecheck && bun test src/flow`]
- AC11: `requirements-package-standard.mdc` splits the PRD success contract into release criteria and outcome criteria, states that an outcome criterion names its observation or declares `not measured — <reason>`, and the docpack Verify phase fails a package that has no outcome list while accepting one whose entries are all `not measured` [verify: judged]
- AC12: This package's own PRD carries both lists, and its outcome list contains at least one entry that is honestly `not measured` with a reason [verify: exec `grep -q 'not measured —' docs/requirements/keryx-acceptance-layer/prd.md`]
