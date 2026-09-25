<!--
Flow 308 fixture (AC10): an INVENTED reference document, written for this
repository's tests only. No wording, structure detail, name or path is
copied from any real reference document. Shape only: numbered rules under
headings about one concern per PR, a size budget, named PR-body sections,
a scope-freeze rule, an author gate, a reviewer contract with a severity
ladder, and an exit criterion.
-->

# Invented Review Doctrine (fixture)

## Scope

1. Each pull request addresses exactly one concern. [not-checkable: no artefact records what the author considered in scope before opening the PR]
2. Hand-written code in one PR stays under a 600 lines budget. [state:pr]
3. The PR body names an explicit Out of Scope section. [state:pr]

## Review rounds

1. Scope freezes after the first review round: no new files enter the diff afterward. [not-checkable: verified by the human moderating the round, not recorded by any artefact this reviewer reads]
2. A change to test coverage is answered in the PR body's Testing section. [state:pr]

## Reviewer contract

1. Every finding names a severity, evidence and a location class. [state:report]
2. Findings appear in fixed lanes, blockers before majors before minors before info. [state:report]
3. Pre-existing issues are kept in a section separate from this round's findings. [state:report]

## Code and test hunks

1. A new test asserts on a return value or an observable side effect, not solely on a mock having been called. [state:hunk]
2. A raw hue class is never hand-written in component code. [state:hunk]

## Exit criterion

1. The round closes only once every blocker and major finding has a recorded disposition. [not-checkable: an obligation on the review process itself, not something a single artefact records]
