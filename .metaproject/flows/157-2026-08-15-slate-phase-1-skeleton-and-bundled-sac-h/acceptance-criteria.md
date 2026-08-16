# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `writeSlate` in `src/session/slate.ts` writes are lock-protected via
  `withFileLock`; a second writer's update function is applied to the
  first writer's already-committed value (read happens inside the same
  lock hold as the write), so two same-turn writers never lose data to a
  read-modify-write race — proven by a test that runs two overlapping
  `writeSlate` calls against the same session dir and asserts both
  updates are present in the final file.
- AC2: A re-open in the same session dir (a second archive call against a
  session dir whose `slate.json` was never explicitly removed) archives
  the prior `slate.json` to `slate-archive/<attemptId>.json` before any
  subsequent write establishes a new one — never a silent overwrite;
  proven by a test that writes a slate, archives it under an attempt id,
  then writes a fresh slate and asserts the archived file's content
  matches the pre-archive slate and the live `slate.json` reflects only
  the new attempt's data.
- AC3: Every proposal created via `ProposalLifecycleService.create()`
  (`src/sac/proposal-lifecycle.ts`) has a `security.gate` value computed
  from a real `detectSecrets`/`detectPii` scan of its evidence content —
  never the literal `"pass"` with no scan behind it; proven by a test
  where evidence content contains a detectable secret/PII pattern and the
  resulting proposal's `security.gate` is `"needs-approval"`, and a
  second test where clean evidence content still legitimately resolves to
  `"pass"` (via the scan, not a bypassed literal).
- AC4: No comment or docstring in `src/sac/proposal-lifecycle.ts` claims a
  self-accept protection that the real CLI/MCP `propose`/`review` code
  paths (`src/commands/workspace.ts`, `src/mcp/tools.ts`) do not actually
  provide — both call sites exclusively use
  `createHarnessProposalLifecycleService`, never
  `createLocalProposalLifecycleService`; the corrected comment states this
  accurately.
- AC5: A flow-read failure inside `createLocalFwkReadService`'s `source`
  composition (`src/sac/fwk-service.ts`) — deleted/malformed/
  permission-denied flow resource — always yields `work` state `unbound`
  in the resulting `FwkReadResult`, never an uncaught exception that
  breaks the surrounding `overview`/`read` call; proven by a test that
  makes the flow resource read or its `JSON.parse` fail and asserts the
  call resolves normally with `work.state === "unbound"` instead of
  rejecting.
