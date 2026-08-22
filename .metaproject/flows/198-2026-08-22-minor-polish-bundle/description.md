# Minor polish: [destructive] audit tag, headless SIGINT exit, SESSCLI-04 spec correction

Status: formalized
Source: no GitHub issue filed — findings from the 0.2.55 live-testing campaign,
`docs/verification/fix-plan.md` (P3 section)

## Problem

Three small, independent findings from the campaign, none rising to a filed
issue on their own:

1. **PERM-05.** `/mode auto`'s auto-approval line for a destructive
   `shell_exec` command (confirmed live, session `b0fda96f`, `rm -rf ...`)
   is functionally correct but never shows the documented `[destructive]`
   audit tag, weakening audit-trail legibility.
2. **SESS-09.** `SIGTERM` sent to a headless/piped `keryx shell` process
   exits immediately (exit 143, confirmed twice). `SIGINT` does not — the
   process was still alive 15+ seconds later in a real test, consistent
   with an interactive "press again to confirm exit" trap that a non-TTY
   process can never satisfy.
3. **SESSCLI-04.** `keryx sessions export` on a corrupted `transcript.jsonl`
   (confirmed with three corruption modes: trailing garbage, mid-JSON
   truncation, full binary overwrite) recovers gracefully — line-tolerant
   JSONL parsing, exit 0 — instead of the test catalog's originally
   documented "named refusal" expectation. This is a spec-vs-implementation
   mismatch, not a functional bug; graceful recovery is arguably the more
   useful behavior.

## Expected Outcome

1. Add the `[destructive]` tag to the auto-approval line whenever the
   command is classified destructive, in every permission mode
   (`ask`/`trust`/`auto`), not just `auto`.
2. Make a non-TTY `keryx shell` process treat a single `SIGINT` as an
   immediate, unconditional exit (default direction — this is a real
   scripted/CI gotcha worth fixing, not just documenting).
3. Update `docs/verification/keryx-shell-tui-test-catalog.md`'s SESSCLI-04
   row to describe the actual (graceful line-tolerant recovery) expected
   behavior instead of a named refusal — Option B from the fix plan; no
   product/code change to the export command itself.

## Out of Scope

Adding a `--strict` export flag (Option C from the fix plan) — not
requested, skip unless separately asked. Any other catalog corrections
beyond the SESSCLI-04 row.
