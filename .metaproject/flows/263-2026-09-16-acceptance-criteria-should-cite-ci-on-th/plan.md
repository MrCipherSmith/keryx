# Implementation Plan

Status: draft — small and mostly textual, but the enumeration is the work.

## Approach

The change is three lines of template and one script. What takes the time is
AC2: finding every place that teaches the old wording. Guessing the set is how
half of them stay behind, and a rule stated in four skills and corrected in one
is worse than the rule nobody wrote down — the round on flow 260 recorded
exactly that shape (one operator instruction of four corrected, the other three
silently made wrong).

So: enumerate first, edit second.

## Steps

1. **Enumerate.** Search the skills tree and the docs for gate wording — `bun
   test`, "full gate", "green on the branch head", `tsc --noEmit`, and the
   phrase the scaffold uses. Record the hit list AND the places checked that
   had nothing, because a set nobody can audit is a set nobody can trust.
2. **Template.** `renderAcceptanceCriteria` in `src/flow/templates.ts`. Keep the
   placeholder that `src/flow/service.ts` refuses to freeze — the scaffold
   should still be unusable until somebody writes a real criterion.
3. **Skills.** Apply the same wording everywhere step 1 found it. Mind the
   skill-length ratchet: a SKILL.md may not grow past its recorded ceiling, so
   an edit that adds a line has to remove one.
4. **The parity script.** One `package.json` entry mirroring the
   `typecheck-and-tests` job, plus the test AC3 asks for. The test is the point:
   without it the script drifts from the job and becomes a lie that reads like a
   guarantee.
5. **Say which is which.** One short passage distinguishing the working slice
   from the closing gate.

## Risks

- **The script and the job drift apart.** That is the whole reason AC3 demands a
  test rather than a comment. Both sides move; only a comparison notices.
- **Over-reach into "CI is the only gate".** It is not: the slice you run while
  working is still worth running, and the guidance has to keep saying so, or the
  next author reads this as permission to push untested.
- **The ratchet.** See step 3 — budget for rewriting, not appending.
