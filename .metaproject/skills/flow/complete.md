# flow-complete Skill

Finish a flow whose PR has passed review, been merged into the base branch, and
whose status is `implemented`.

## Workflow

1. Re-verify the package: description matches the result; plan followed or
   deviations journaled; all tasks done.
2. Confirm every acceptance criterion after actually checking it:
   `keryx flow ac confirm <id> ACn --note "<evidence>"`. This appends a
   signature (who, when, what was confirmed); pass `--signed-by "<name>"` to
   name the signer explicitly - otherwise it falls back to `KERYX_ACTOR`, then
   local git identity, and is recorded with that weaker basis.
3. Verify that the PR was merged into the base branch recorded for the flow,
   then run `keryx flow complete <id> [--signed-by "<name>"]`. Gates: AC
   confirmed + checksum intact; merged PR exists with green checks; code-health
   gate passes; and, for a flow that opted in (`flow init --owner` set the
   flag), an owner recorded - fails naming
   `keryx flow owner set <id> --owner "<name>" --reason "<why>"` if not. A
   flow created with `--require-confirmation` needs one more gate: run
   `keryx flow confirm <id>` in your own terminal first (a typed challenge
   mints a short-lived, single-use token - it proves an interactive step ran
   outside the agent's tool roster, not that a human did), then pass it as
   `--confirm-token <token>`. On pass this also appends a completion
   signature.
4. Gates fail -> flow auto-returns to in-progress with fix notes:
   - small fixes: run a fix agent, then re-run the review/fix loop from step 2;
   - large fixes: describe what is wrong in the journal and relaunch the
     implementor/orchestrator against the updated plan.
   - a flow left stuck in `completing` (a crash or an interrupted attempt,
     never a normal gate failure) is moved back with
     `keryx flow recover <id> --reason "<why>"`.
5. Gates pass -> flow is done:
   - source was an issue: `keryx flow complete <id> --comment` posts a
     short, factual summary comment to the issue;
   - no issue: ask the user whether to create a ticket for the record.
