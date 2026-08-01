# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: An unreadable `archive.jsonl` no longer aborts a resume whose `context.jsonl` is readable — a test writes a real oversized/unreadable archive next to a readable context, calls `openSession` with `resumeId`, and asserts the session resumes with the context messages instead of throwing.
- AC2: The archive degradation is reported, not swallowed — `openSession` and `exportSessionMarkdown` surface the file and the reason when the archive was dropped, and a test asserts the reason reaches the caller. A degraded resume is never indistinguishable from a session that genuinely has no archive.
- AC3: Every caller of the throwing transcript readers (`openSession`, `loadContext`, `loadArchive`, `exportSessionMarkdown`) either guards the throw or provably does not load. `keryx sessions export` on an unreadable transcript exits non-zero naming the file and the reason with no stack trace, and the TUI `/resume` path reports the failure and keeps the current session rather than crashing or dropping it.
- AC4: The caller class is pinned by a source-level guard that enumerates call sites from the tree and fails on an unguarded one. The guard follows the `config-dir.readers.test.ts` template: its self-check drives the same seam as its tree assertion, it asserts the scan reached the tree, and it has a non-zero numerator control.
- AC5: The AC8 recovery guard extracts every `keryx serve …` instruction printed by the CLI, not only the `config` subset. Every extracted instruction carries an asserted disposition — executed, usage form, or refusal-by-design — and the disposition sets are asserted by value so no instruction can disappear silently.
- AC6: Instructions printed together are executed in the order printed, as one recovery sequence, and the end state is asserted after the whole sequence rather than after each instruction independently.
- AC7: The instructions that are not executed are covered rather than skipped — the bare `keryx serve --acknowledge-non-loopback` form has its own test asserting the refusal it is designed to produce and the reason given for it.
- AC8: `FINDING_HEADING` identifies a heading positively rather than by position alone: an identifier that opens a line and is followed by `,`, `)` or `.` is a reference; a heading carries a title separator or a markdown heading/list marker. Both directions are pinned by tests.
- AC9: Ingesting `.metaproject/reviews/2026-08-01-ingest-feat-r4c-turn-submission/report.md` through the parser yields exactly the fifteen real findings and zero phantoms, asserted by id.
- AC10: Flow 130's journal claim about what the readers guard reported is corrected to match the recorded scanner output (one offence per (file, call) pair, one entry recorded).
- AC11: `bun test` is green on the whole suite, and typecheck and lint are clean.
</content>
