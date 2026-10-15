# T13 — independent review of PR #1022 (interim)

Reviewed head: `3cf3b2c65afe38621f6f1a60decfc6e457d57f9a`.
Date: 2026-10-15. Status: **incomplete; no approval or closure**.

## Method and limitations

Nine separately dispatched reviewer roles: logic, architecture, security-code,
highload, core-boundaries, performance, clean-code, style, testing-practices.
Five roles also have second-wave reports. Three separate verifier passes inspected
source and counterevidence. These are **static source assessments**, not executed
reproductions or applied runtime verification claims. Existing green CI does not
establish that the cases below are covered. No local tests or mutations were run.
Full reviewer-by-slice coverage and research/closure gates remain outstanding.

## Five substantial findings supported by static inspection

| Finding | Anchor | Trigger and consequence | Evidence |
|---|---|---|---|
| Result coverage conflates fallback with withholding | `src/evidence/projection.ts:41–42` | `semantic-fallback` alone makes coverage partial and suppresses the empty-corpus diagnostic, although no source was withheld. Separate withholding from informational diagnostics. | `raw/verifier-w1.txt`, logic F-001 |
| Production hybrid has no supplied embedding dependency | `src/evidence/runtime.ts:41–42,334–338`; CLI/tool/automatic composition | Hybrid is accepted, but shipped entrypoints do not supply the approved embedding owner. Intentional lexical fallback is not itself a defect; the composition and phase/documentation claims disagree. Wire an approved owner or explicitly gate unavailable hybrid. | `raw/verifier-w1.txt`, architecture F-001 |
| Conditional generic-file route bypasses session-store projection | `src/evidence/sources.ts:93–101`; `inventory.ts:46–53`; `source-owner.ts:98–102` | Requires configured session storage inside checkout, overlapping allowed file roots, scanner availability and explicit successful indexing. Raw archive files can enter via the file adapter independently of archive opt-in/ownership/closed-field projection. Not a default-install or arbitrary-file exploit. Exclude owned session-store subtrees throughout file admission/revalidation. | `raw/verifier-w1.txt`, SEC-W1-001 |
| Quadratic archive reuse validation | `src/evidence/archive-chunks.ts:103–119` | Each reused chunk decodes the entire preceding prefix. A supported 4 MiB single-line record gives about 10,486 chunks and approximately 22 billion cumulative prefix bytes. Work is synchronous; elapsed time was not measured. Use a forward newline cursor. | `raw/verifier-w1.txt`, HL-002; duplicated by highload wave 2 and deduplicated in `raw/verifier-w3.txt` |
| Transient writer contention poisons retained lifecycle | `src/evidence/lifecycle.ts:103,149`; `storage.ts:162` | Another process holding the nonblocking writer lease can make revoke/clear fail before mutation, but the catch permanently sets failed on this lifecycle. Distinguish pre-mutation contention from uncertain/partial mutation; preserve fail-closed handling for integrity failures. | `raw/verifier-w3.txt`, F-HL-W2-001 |

Reviewers classified these as major. Severity and static support do not constitute
executed verification, applied ingest verdicts, or an overall merge verdict.

## Additional gaps and counterevidence

- Restart automatic-recall test retains the closed original runtime in its closure;
  final negative delivery can pass without consulting the reopened tombstone.
- Timer-based drain/late-confirmation assertions lack deterministic completion barriers.
- Hybrid no-write test compares top-level filenames, not recursive persisted bytes.
- Foreign-project fixture also invalidates summary schema; it does not isolate the
  otherwise-valid foreign-project refusal. Other projection/traversal gaps and
  readability findings are retained in `raw/verifier-w2.txt` and raw role reports.
- Synchronous bulk I/O is a responsiveness investigation, not a measured major
  latency defect; synchronous final handoff is part of revocation ordering.

## Outstanding
