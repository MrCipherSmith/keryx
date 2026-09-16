# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `renderAcceptanceCriteria` in `src/flow/templates.ts` scaffolds a gate criterion that names CI on the PR head as the evidence — the check run — rather than a local `bun test`. The scaffold still refuses to pass `flow freeze` unfilled, so the placeholder guard in `src/flow/service.ts` keeps working.
- AC2: Every skill that tells an author how to word a gate criterion says the same thing, and the set was enumerated rather than guessed: the search that found them and its result are recorded in the flow, including skills checked and found not to mention it.
- AC3: `package.json` gains one script that runs exactly what the `typecheck-and-tests` job runs, so local parity is a command rather than a reconstruction. Asserted by a test that compares the script's contents against the job's, and fails when either moves.
- AC4: The guidance distinguishes the two cases explicitly — the slice you run locally while working (`test:core`, `test:client:*`, `keryx test related <file>`) and the gate that closes a flow (CI on the PR head). A reader must not have to infer which is which.
- AC5: Nothing in this flow changes what CI runs, adds a job, or touches the `pre-push` hook. Asserted by the diff: `.github/workflows/` and the hook are untouched.
- AC6: No closed flow's recorded criteria are rewritten. A criterion that was satisfied by a local run keeps saying so — substituting a check run nobody consulted would be a worse record than the one it replaced.
- AC7: CI green on the PR head. (Written this way deliberately: this flow's own gate is the first instance of the wording it introduces.)
