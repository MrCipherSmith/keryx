# Flow Journal

- 2026-09-25T07:06:08.133Z - flow created
- 2026-09-25 - runner: flow driven autonomously (completion_outcome create-pr-and-merge, operator_confirmed by MrCipherSmith in chat, base feat/agent-platform-expansion). Input: integration review of PR #700, ingested as review round 0 (reviews/2026-09-25-ingest-700; findings normalised with reviewer/problem/impact/confidence for the schema; the ingest cap truncated R700-12..18 from the recorded round but all are in scope).
- 2026-09-25 - decision (R700-03, observer default): KEEP `keryx.learning-observer` on by default. It is local, redacted, gitignored and documented, with opt-outs `keryx hooks disable keryx.learning-observer` and `KERYX_LEARNING=off`; after this flow it also writes only through contained helpers that refuse symlink escapes. Turning it off would silently change the self-learning feature's shipped behaviour; the risk the review found was the uncontained write, not the observation. Release-note item.
- 2026-09-25 - decision (R700-12): making team-scope learned patterns shareable through git needs a committed candidates path and a merge story; deferred. This flow documents team scope and the bundle ledger as local-only.
- 2026-09-25 - lanes dispatched: A design (opus), B contained writes (sonnet), C1 CLI help (sonnet), C2 update/labels/provenance (sonnet). Disjoint file ownership; no stash, no add -A, no commits by workers.
- 2026-09-25T07:11:10.883Z - task-done: T1: Collect remaining context
- 2026-09-25T07:11:23.442Z - task-added: T5: Lane A: project hook trust gate and tighten-only built-ins (R700-01/02, hooks.ts writes)
- 2026-09-25T07:11:23.577Z - task-added: T6: Lane B: contained observer/impact-evidence writes and ratchet coverage (R700-03/04)
- 2026-09-25T07:11:23.709Z - task-added: T7: Lane C1: CLI help, usage, registry and docs (R700-05/07/08/09/13/18)
- 2026-09-25T07:11:23.839Z - task-added: T8: Lane C2: update idempotence, labels, import provenance, update.ts (R700-06/10/11/12/14)
- 2026-09-25T07:11:23.972Z - task-added: T9: Verify: re-run the review's 12-step manual test plan in a scratch repo; step 12 must pass
- 2026-09-25T07:11:24.107Z - task-added: T10: PR review/fix loop and CI
- 2026-09-25T07:11:24.238Z - frozen: 13 criteria; checksum recorded
- 2026-09-25T07:11:24.371Z - started
- 2026-09-25T07:11:32.384Z - task-attempt: T6: started (attempt 1) — 319-T6 sonnet worker
- 2026-09-25T07:11:32.533Z - task-attempt: T7: started (attempt 1) — 319-T7 sonnet worker
- 2026-09-25T07:11:32.666Z - task-attempt: T8: started (attempt 1) — 319-T8 sonnet worker
