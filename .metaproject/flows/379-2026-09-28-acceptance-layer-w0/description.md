# Acceptance layer W0: verification kind per criterion

Status: formalized
Source: docs/requirements/keryx-acceptance-layer/ (prd.md, specification.md, implementation-plan.md)

## Problem

A confirmed-but-unverifiable acceptance criterion and a confirmed-and-tested one
are rendered, gated and signed identically. Roughly a quarter of the 2,705 frozen
criteria cannot be verified in principle, and nothing distinguishes them. The
habit of claiming verification emerged unprompted; the habit of naming the check
did not, because no field exists for it.

## Expected Outcome

Each criterion may carry a trailing `[verify: exec|invariant|judged|none]` marker
inside the sealed `acceptance-criteria.md`. A pure parser, `flow ac kinds`, a
distribution at `flow freeze`, a derived `acKinds` in `flow.json`, a re-seal path
in `ac update`, and a coverage column in `governance report` exist. The PRD
contract gains a per-requirement verification field and the outcome-criteria
split (W5). Old criteria read as `unclassified`.

## Out of Scope

W1 (runner and gating), W2 (`keryx eval`), W3 (portable report), W4 (docpack to
flow loop). Nothing gates: not freeze, confirm, complete or flow creation. No
subagents, no model calls in the parser or the commands, no migration of the
existing 2,705 criteria.
