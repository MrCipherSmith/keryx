# Implementation Plan

Status: approved for freeze

The last phase of the agent bus. P0–P4 built it; this one makes it findable
and proves the two scenarios the PRD was written for actually work outside a
test harness.

## Steps

1. **T5 (sonnet), the evidence — first, because it is the only step that can
   still fail.** Everything else is writing. If a scenario does not hold on a
   real clone, the documentation written before it would be wrong.
   - Build a throwaway clone with two linked worktrees, each running its own
     `keryx shell` from the working tree.
   - **Scenario 1:** A holds a `git-publish` lease; B's `git push` requires
     approval under `auto`; A resumes; B's push no longer does.
   - **Scenario 2:** A sends B a message; it reaches B as a bus message with
     tool provenance; B replies; A sees the reply.
   - Record commands, observed output and event ids under
     `docs/requirements/keryx-agent-bus/evidence/`.
   - Anything that needs a model provider or a human at an approval prompt is
     labelled as such. A scenario proved only through the gate function rather
     than a live turn says so in the same sentence as the claim.
2. **T6 (sonnet), the wiki page** `architecture/agent-bus.md`, written from the
   specification and the evidence, cross-referencing RP-08 instead of
   restating it (D-01).
3. **T7 (haiku), cli-reference** — every `keryx bus` subcommand, its flags, its
   refusals by name, and the clone-wide rate limit.
4. **T8 (haiku), status** — the package README, implementation-plan and the
   roadmap row to P0–P5 implemented.
5. **Review:** opus for r1. Then CI green and merge.

## Risks

- The evidence step is the one that can discover a defect this late. If it
  does, the defect is the finding and the phase carries its fix.
- A scenario that needs a live model cannot run offline in CI. It is recorded
  as operator-run evidence with the limitation stated, never dressed up as an
  automated proof.
- `docs/cli-reference.md` is paired with the command registry by a coverage
  test; adding prose without the registry entry fails it.
