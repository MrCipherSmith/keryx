# Implementation Plan

Status: formalized

## Approach

Convert audits seam by seam, not file by file. Each seam is a small production
change that makes a behaviour observable; the audits it unlocks are then
converted and deleted in the same commit, so the diff shows what was traded
for what.

Order is by leverage: a seam that unlocks six audits across three files before
one that unlocks a single test.

Three rules held throughout:

1. **Zero production behaviour change.** Seams are an `export`, an optional
   injected dependency whose default reproduces the old behaviour, or code
   moved unchanged behind a new function.
2. **Structural audits are not converted.** "This file must never import the
   wrap-up composer" is a true statement about source structure. Those are
   rewritten to scan the module's directory so P3 widens them instead of
   breaking them.
3. **Every replacement must say something the substring could not.** If the new
   test only re-expresses the old assertion through a different door, the seam
   bought nothing.

## Steps

1. Export `runAgentRepl` and make its writer injectable. One keyword and one
   optional field; unlocks the whole `shell.test.ts` cluster.
2. Build a behavioural harness for it, with an isolated `configDir` — the
   default resolves to the operator's real config file.
3. Convert `/goal`, `/plan`, `/reasoning` and the configDir threading.
4. Extract the exit sequence, which four call sites duplicated and three test
   files each pinned separately.
5. Extract `buildNextStepPrompt` so AC12 is a property of a function.
6. Widen the structural audits to the module directory.
7. Record every audit left unconverted with the seam it waits on.

## Risks

- **A conversion that asserts less than the audit did.** A substring at least
  pinned something. Mitigation: every conversion carries a BOUNDARY test that
  fails against a trivial stub, and the comment states what the old audit
  could not tell.
- **Seams that leak test concerns into production.** Mitigation: every seam
  defaults to the existing behaviour, and production passes nothing new.
- **A harness that touches the operator's machine.** Realised, not
  hypothetical: the first draft resolved `configDir` to `undefined`, which is
  `~/.local/share/keryx/auth.json`. Caught by an assertion reading `(global)`
  instead of `(default)`; the real file was verified unmodified.
- **Stopping mid-programme leaves a confusing state.** Mitigation: the
  inventory carries the remaining seams and what each unlocks, so the next
  flow starts from a list.
