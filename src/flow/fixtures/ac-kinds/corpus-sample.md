# Acceptance Criteria

Fixture for `src/flow/ac-kinds-corpus.test.ts`: representative criteria lines
copied verbatim from flows 327 and 328 of this repository's own corpus (backticks,
brackets, pipes, quotes, semicolons), plus two that were written for the purpose:
the words `verify:` in prose, without the bracket that would make them a marker.
None of these carries a `[verify: ...]` marker, so every one must parse as
`unclassified`. CI runs where `.metaproject/flows/` may be absent; this keeps the
format's backward-compatibility claim exercised there too.

## Criteria

- AC1: `keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json]` reads the flow's FROZEN acceptance criteria (refuses when not frozen) and the change (default: the flow worktree's diff against its base / merge-base with origin/main), and reports per criterion: `likely-met`, `not-evident`, or `not-checkable`, with the Jev probability and the evidence used; ADVISORY header; never changes flow state or confirms an AC.
- AC2: Deterministic evidence is computed first, per criterion, and placed above the diff in Jev's state: files/symbols/CLI flags/paths the criterion names (backticked tokens, file paths, command names) and whether each appears in the diff or the tree; tests changed or added that mention those tokens; a criterion whose named artefacts are all absent is flagged by the facts alone. Pure core functions, unit-tested.
- AC3: `not-checkable` is assigned without a model when a criterion is about something no diff records (live checks, CI green, health passing, docs published — explicit marker list, documented), and is always listed, never sent to Jev.
- AC4: Docs (cli-reference, flow docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, hermetic macOS-safe tests, import zones respected.
- AC5: `keryx routing profile list [--json]` (extends `src/commands/routing.ts` from Flow A) prints every stored profile — including catalogue-grown (non-seed) entries — with its fields, sources, `available` status, and `priority`; `keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>` writes an operator correction, storing that field with `source: "operator"`; a subsequent refresh (AC2) leaves every `operator`-sourced field on that profile untouched while updating the rest.
- AC6: The `/connect` `[Test]` result and `keryx providers test`'s output mention when the refresh updated stored model profiles, with counts (e.g. "3 added, 1 changed, 1 now unavailable").
- AC7: `src/harness/routing/model-profile.ts` (new) defines `ModelProfile`/ `ProfileSource`/`PrioritySource` (PRD §6.1): `strengthTier`, `priceInputPerMillion`, `priceOutputPerMillion`, `contextLength` (each `{value, source}`, `source` one of `reported`/`curated`/`guessed`/ `operator`/`unknown`), `priority` (`{value, source: "auto"|"operator"}`), `available` (boolean), `lastSeenAt`, `refreshedAt`.
- AC8: A price or context-length field with no `reported`/`curated`/ `operator` source is `{value:"unknown", source:"unknown"}` — NEVER `0` or a fabricated number — verified by a test.
- AC9: The report says verify: nothing here and prints the word verify: again in prose, once; a reader must not mistake either for a marker.
- AC10: An old criterion that mentions a `[verify` fragment in code, and a bare `verify:` before a `command`, is still just prose.
