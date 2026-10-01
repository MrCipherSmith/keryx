# Implementation Plan

Status: ready

## Approach

Follow docs/requirements/keryx-acceptance-layer/implementation-plan.md W0 and W5
as written. One flow, one PR. Pure parser beside `parseAcceptanceCriteria`, read
only elsewhere, nothing new gates.

## Steps

1. Corpus test first (AC3): parse every criteria file in `.metaproject/flows/`,
   require zero errors and every unmarked criterion `unclassified`. Written before
   any parser code, red for the right reason.
2. Parser and records (AC1, AC2), pure, no imports beyond flow types.
3. `check-ac` receives text without the trailing marker (AC5).
4. `flow ac kinds <id> [--json]` (AC1, AC2).
5. `flow freeze` distribution block and derived `acKinds` (AC4). Never refuses.
6. `flow ac update` re-seal rewrites `acKinds` (AC6).
7. `governance report` coverage column; absent field reads fully unclassified (AC7).
8. TUI: the flow surface renders each criterion's kind and the distribution (AC13).
9. Rule change in `requirements-package-standard.mdc` (both copies) and the
   docpack Verify phase: per-requirement verification field (AC8), release vs
   outcome criteria (AC11). Docs: README, docs site, CHANGELOG, version bump.

Steps 1-5 are independently useful; stop there if anything blocks.

## Risks

- The marker changes the sealed text of frozen flows only when a flow edits
  itself; existing files carry no marker and must be byte-identical in behaviour.
- Criterion text with a backtick or the literal `[verify:` in prose: the parser
  anchors on the trailing marker only, and the corpus test covers real cases.
- Any code path that refuses on a kind is a scope violation (AC4 invariant).
