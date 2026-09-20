# Implementation Plan

Status: formalized

## Approach

Three agents in parallel, on strictly disjoint file ownership, so no two ever
touch the same file:

| owner | files | work |
|---|---|---|
| A | `src/tui/**` | five seams: the capped-notice constant, join adoption, join callbacks, splash lifecycle, side-worker predicate |
| B | `src/commands/**`, `src/mcp-servers/**` | the `process.once` scan, the remaining `shell.test.ts` blocks, the approval-wiring seam |
| C | `.metaproject/**` | managed reviews for flows 276 and 277, which were both stuck at `implemented` |

Agents may edit production code **only inside their own ownership**, and never
run a git write command — the lead reviews and commits.

Agent B starts with the `process.once` scan deliberately. Every other audit in
this programme fails loudly when the code moves; that one goes quiet, so it has
to be fixed before P4 moves anything.

## Steps

1. Widen the `process.once` ban from a hardcoded file list to a directory
   scan, keeping the non-vacuity check so it cannot pass by scanning nothing.
2. Extract the named seams, rewire their call sites, unit-test the extracted
   modules, delete the audits they replace.
3. Rewrite whatever the moves break — anchored on the extracted symbol rather
   than on a sequence or an offset.
4. Regenerate the manifest from the live scan; correct anything the inventory
   got wrong.

## Risks

- **An agent claims green without checking everything.** Realised: agent B ran
  the tests but not `tsc`, and left a type error under
  `exactOptionalPropertyTypes`. Mitigation: the lead re-runs typecheck, lint
  and the suites, and reads every production diff rather than the report.
- **A convenient claim taken on trust.** Agent B reported 30 failures as
  "pre-existing". Verified independently: they are a git-identity hook
  rejecting fixture commits, environmental and unrelated.
- **A seam that looks neutral and is not.** `buildBusJoinCallbacks` takes every
  dependency as a getter, because `busWakeController` and
  `leaseHoldController` are assigned ~2,400 lines after the callbacks are
  built. Captured by value they would read `undefined` forever, and no test
  would say so. Checked by reading the interface.
- **The inventory is wrong in the direction that matters.** Realised: it
  claimed `decideJoinAdoption` unlocked four tests; extraction showed one.
  Corrected in place with the reason, because an estimate made by reading is
  exactly what this programme keeps finding to be unreliable.
