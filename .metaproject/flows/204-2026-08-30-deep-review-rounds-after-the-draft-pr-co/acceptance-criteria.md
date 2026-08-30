# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A deep round dispatches under two scopes — `diff` (the change) and `blast-radius` (what the change can break) — and the round manifest records the blast-radius set, the depth used, and **every file dropped by the cap**. A silent truncation reads as "we checked everything".
- AC2: The blast-radius set is **computed** from `keryx gdgraph affected` over the changed files, ranked by edge distance, bounded by a depth and a file cap, with covering tests added. It is never a model's choice of files to open.
- AC3: A finding raised under `blast-radius` scope that is not a regression — style, naming or architecture in code the change did not touch — is rejected by the orchestrator in code, not discouraged in prose. Scope B asks whether the change breaks existing behaviour; the set is under regression check, not under review.
- AC4: The blast radius is recomputed whenever the changed-file set changes, and always on the final round. Otherwise a fix introduced in a later round gets no regression check at all.
- AC5: A `review` gate is added to `flow complete`. It passes only when: a managed review record exists with at least one **ingested** round; the latest round has zero findings without a terminal disposition at or above a configurable severity floor (default `minor`); the latest round ran against the **PR head commit**; there are no unanswered external comments; and the verifier ran with its stats recorded.
- AC6: "Clean" is defined positively, per finding, and never by absence. A finding marked `fixed` requires a commit SHA **and** a verifier verdict of `refuted` against that SHA. `refuted` requires method and evidence. `dismissed` requires one of the four taxonomy reasons **and** a recorded human decision — the orchestrator may not dismiss on its own authority.
- AC7: Reaching the round cap with the review gate unsatisfied leaves the flow `in-progress` and reports the blocker. It never completes. Forcing completion at the cap would reintroduce the exact leak this programme removed.
- AC8: External PR comments are collected every round from all three sources — inline review comments, review submissions, and PR-level discussion — with bot authors handled identically to humans.
- AC9: A collected comment becomes a finding with `source: external` and an `external_ref`. Severity is classified, never invented: a comment on a `CHANGES_REQUESTED` review starts at `major`, everything else at `minor`. The orchestrator may lower it only by assigning a terminal disposition with a reason, and may never silently drop it.
- AC10: An external finding cannot be `refuted` by the verifier alone. A human asked a question; a machine deciding the question was invalid is not an answer. The disposition is `answered-disagree` and still requires a reply.
- AC11: Replies are posted **once, at the end**, after the final round and before the completion gate — not per round. Each is **at most two sentences**, threaded, and carries a link when the explanation does not fit. Enforced in code, not advised.
- AC12: The orchestrator never resolves or hides a thread it did not open. Replying is ours; resolving is the reviewer's call.
- AC13: Every collected comment has exactly one reply and one disposition when the flow completes. Silence is not an acceptable outcome, and neither is a second reply saying the same thing. Comment handling is idempotent across a session restart.
- AC14: Skills declare a model **tier** (`light`/`standard`/`deep`), never a model name. A skill naming a concrete model fails a test.
- AC15: The tier resolves per provider family through configuration. An unrecognised or undetectable provider **inherits the session's model for every tier** — never a downgrade, never a dispatch failure. Degrading capability because detection failed is the worst of the three outcomes.
- AC16: Tier assignment is deterministic from signals the orchestrator already holds — scope, attempt count, verifier method, severity — and is recorded in the dispatch so a run can be explained afterwards. It is never produced by asking a model to rate its own difficulty.
- AC17: `.metaproject/rules/core/model-selection.mdc` is rewritten. It lists Codex model names that no longer match the environment, and its "Mandatory Behavior" requires asking the user before changing a sub-agent's model — which makes adaptive selection impossible by construction.
- AC18: A brevity rule governs every outward-facing GitHub artifact — PR bodies, comments, replies, issue comments. The detail lives in the flow package and is linked. No orchestrator-written PR comment exceeds two sentences without carrying a link to the artifact holding the detail.
- AC19: Every skill, rule and schema edit lands in BOTH `src/gdskills/bundled/` and `.metaproject/`, verified by diff. The bundled-rule guard and the review-mirror guard both still pass.
- AC20: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
