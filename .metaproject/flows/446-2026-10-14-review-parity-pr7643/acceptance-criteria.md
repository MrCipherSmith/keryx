# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review dispatch-check` accepts a payload whose `model` block carries `routed: true` (the field the generator emits); `reviewer-input.schema.json` and, if it has the same gap, `subagent-dispatch.schema.json` declare it as a boolean. A test fails before the change and passes after. [verify: exec `bun test src/review/dispatch-check.test.ts`]
- AC2: A new opt-in scope setting keeps a comment-only hunk when the repository has a comment rule (`CLAUDE.md` or `.metaproject/rules/**` mention a comment limit): the block is retained with the reason `kept:comment-rule`, and with the setting off the drop is byte-identical to today. A synthetic fixture of a two-line `//` comment in a page file is retained with the rule on and dropped with it off. [verify: exec `bun test src/review/scope-comment-rule.test.ts`]
- AC3: The testing reviewer contract requires `mutant_candidates` for every changed branch, including code downstream of the diff; the main session writes them to `research-evidence/mutants.json` unchanged. `MutationRecord` records `cap` and `not_reached`, and `renderMutationTable` and `report.md` print `Not run: N candidates` whenever `not_reached` is above zero. A pending candidate still blocks the coverage gate. [verify: exec `bun test src/review/mutate-not-reached.test.ts`]
- AC4: A mutant spec can carry `kind: "behavior" | "presentation"` (default `behavior`). The severity audit raises a survivor to major only for `behavior`; for `presentation` it keeps the severity and records a `severity_audit.held` note that the report shows. Records written before the field behave as before. [verify: exec `bun test src/review/severity-audit.test.ts`]
- AC5: A `Parent follow-up:` line or a `follow_ups` entry in a raw reply becomes an obligation `<raw>:fu<N>` with status `unresolved`. It closes only through a disposition (including `narrowed` with a "what remains" text); otherwise `rawReconciled` is false and `report.md` lists it as not verified. [verify: exec `bun test src/review/ledger-follow-ups.test.ts`]
- AC6: A bundled reviewer `review-pr-contract` exists: it compares the PR-body checklist from `pr-context.md` with the diff and looks for documentation outside the diff that describes the changed behavior (gdgraph, gdwiki). It is listed in the reviewer catalog, is selected when `pr-context.md` is present, passes `dispatch-check`, and satisfies the review-skills iron-law tests. On the synthetic replay fixture the unticked "Documentation needed" box with a user-visible new row yields a finding. [verify: exec `bun test src/review/reviewers.test.ts src/gdskills/review-skills-iron-laws.test.ts`]
- AC7: On a shell host the review-orchestrator skill tells the main session to run the browser measurements for review-layout first and pass them as `context_files` in the first dispatch; supplied measurements count as evidence when the command and viewport are named. A second NEEDS_CONTEXT for the same role yields `notRun` ("layout: no engine"), not another refill. [verify: exec `bun test src/review/retry-plan.test.ts`]
- AC8: The `Not run` count, the held-severity notes and the open follow-ups are visible in the shell: the `/review` view and the sidebar show them, and `keryx review status` prints them. [verify: exec `bun test src/tui/review-parity-visibility.test.ts`]
- AC9: Replay on a stored synthetic PR diff: with the new code the pre-filter keeps the comment hunk, the ledger holds the follow-up open until it is disposed, and the severity of a presentation-labelled survivor stays minor. The test uses the committed fixture, not the network. [verify: exec `bun test src/review/pr-replay.test.ts`]
- AC10: The review-orchestrator skill grows by at most five lines in `SKILL.md` (details go to `SKILL.detail.md`) and stays under the skill-length ceiling. [verify: exec `bun test src/gdskills/skill-length.test.ts`]
- AC11: `bun run check` passes; README, `docs/docs/cli-reference.md`, the review guides, the wiki review pages and the CHANGELOG `[Unreleased]` describe AC1 to AC8; the version is bumped. [verify: exec `bun run check`]
- AC12: On the next real PR the operator runs the AC8 procedure of flow 419 again and compares with the reference; keryx raises or reports as not run every reference finding. Operator-owned. [verify: judged]
