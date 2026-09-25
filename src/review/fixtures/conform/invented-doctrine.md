<!--
Flow 308 fixture (AC10): an INVENTED reference document, written for this
repository's tests only. No wording, structure detail, name or path is
copied from any real reference document. Shape only: numbered rules mixed
across headings about opening a change, a change-size limit, a per-pass
review record with a priority field, code/test hunks, and a sign-off
condition — grouped by workflow stage rather than by artefact kind.
-->

# Data Pipeline Contribution Policy (fixture)

## Before you open a change

1. A single contribution changes at most one pipeline stage end-to-end. [not-checkable: no artefact records what the author considered in scope before opening the change]
2. The change description names a Rollback plan. [state:pr]

## Change size

1. A contribution changes no more than 900 lines in total, tests included. [state:pr]
2. The pipeline was run once against the staging dataset before sign-off. [not-checkable: no artefact records a staging run for this reviewer]

## Review pass

1. A reviewer records each finding with a priority, evidence and a reproduction step. [state:report]
2. A finding that predates this pass stays listed apart from one raised in it. [state:report]
3. A change to validation coverage is described in the change description's Validation section. [state:pr]

## Code and test hunks

1. A new test asserts on a materialized output, not solely that a mock was invoked. [state:hunk]
2. A raw connection string is never hand-written in pipeline code. [state:hunk]

## Sign-off

1. The pass closes only once every high-priority finding has a recorded disposition. [not-checkable: a judgment call the reviewer makes personally, not read back from any artefact]
