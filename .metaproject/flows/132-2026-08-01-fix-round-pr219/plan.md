# Implementation Plan

## Approach

Three independent defects on one branch. Each is fixed at its class, in the
order that keeps the test suite interpretable: the parser first (it is the
smallest and it is what records the evidence for everything else), then the
session readers, then the AC8 guard.

### F-015 — positive heading identification (`src/review/managed.ts`)

`FINDING_HEADING` currently accepts any line that opens with an identifier after
optional heading/list markers. Position alone cannot separate a heading from a
wrapped reference, so identify a heading **positively**:

- a heading carries a markdown heading marker (`#…`) or a list marker
  (`-`/`*`/`+`), **or** a title separator after the identifier (`:`, `—`, `-`,
  `–`) followed by text;
- an identifier followed immediately by `,`, `)`, `.`, `;` or end-of-line with
  no separator is a **reference**.

`findingBlock` must use the same predicate — it currently ends the previous
finding's body at any line the regex matches, which is how a phantom also
truncates a real finding.

Trade-off considered and rejected: requiring `### F-NNN` exactly. The reviewer
skills emit three heading shapes and a bare `F-001 — summary` line is one of
them; tightening to markdown headings only would drop real findings, which is
worse than a phantom because the guard would then pass on an incomplete report.

### F-014 — the session reader class (`src/session/store.ts` + callers)

1. `loadArchive` catches `TranscriptUnreadableError` **from the archive read
   only** and falls back to `loadContext`. It does not catch a context failure —
   nothing readable at all is a real error and must keep throwing.
2. The degradation is returned, not logged and forgotten: `loadArchive` takes an
   optional `onDegraded` callback, `openSession` returns `archiveDegraded`, and
   `exportSessionMarkdown` writes the reason into the exported header. A caller
   can always tell "no archive" from "the archive could not be read".
3. The two unguarded callers are guarded in the way each surface can afford:
   `keryx sessions export` fails with the file and the reason and exit 1; the
   TUI `/resume` handler reports and keeps the current session (it must not drop
   into a new one — the operator asked to resume, and losing the live session as
   a side effect of a failed resume is a second bug).
4. A source-level guard enumerates the call sites from the tree and fails on an
   unguarded one, built from the `config-dir.readers.test.ts` template rather
   than from the two decorative guards the same review found on #220.

### F-013 — the whole instruction class (`src/commands/serve.recovery.test.ts`)

Widen the extractor from `keryx serve config …` to `keryx serve …` and give
every extracted span a disposition:

| Disposition | Rule | Treatment |
|---|---|---|
| `runnable` | has a subcommand, no `<placeholder>` | executed verbatim |
| `usageForm` | carries a `<placeholder>` | counted, asserted by value |
| `startsAListener` | no subcommand — bare `keryx serve` plus flags | asserted by value, covered by its own refusal test |

Two structural changes come with it:

- instructions printed together are one recovery **sequence**, executed in the
  order printed with the end state asserted once at the end. Executing them
  independently is why `token issue` could not be added: alone, in a state with
  no configuration, it correctly leaves the server stopped.
- `startsAListener` is not "skipped". `keryx serve --acknowledge-non-loopback`
  is printed only on the refusal path and legitimately still refuses when the
  stored acknowledgement is also missing; that refusal, and the reason printed
  with it, get their own test.

## Steps

1. T1 — read the three sites and their existing tests; record the enumeration
   method for each class in `context.md`.
2. T2 — `FINDING_HEADING` + `findingBlock` positive identification, with the
   report itself as a fixture.
3. T3 — `loadArchive` fallback + `onDegraded`, `openSession.archiveDegraded`,
   `exportSessionMarkdown` header line.
4. T4 — guard `sessions.ts` export and the TUI `/resume` handler.
5. T5 — the source-level caller guard, from the `config-dir.readers` template.
6. T6 — widen the AC8 extractor, sequence execution, disposition sets.
7. T7 — the refusal test for the bare `keryx serve` instruction.
8. T8 — correct flow 130's journal claim.
9. T9 — verify: focused tests, full `bun test`, typecheck, lint, health.
10. T10 — self-review the diff against the three findings, then the draft PR.

## Sequencing

The parser fix lands first so the fix-round review of this branch can itself be
ingested without phantoms.

## Risks

- Widening the extractor may surface instructions that genuinely fail today.
  That is the point of the finding; any such failure is fixed here rather than
  excluded by a narrower regex.
- `onDegraded` adds a parameter to a signature `src/session/index.ts` re-exports.
  It is optional, so no existing caller changes.
</content>
